import { academicTasks } from '../../onboarding/services/academic-tasks';
import { getOnboardingState } from '../../onboarding/services/store';
import {
  getWorkspace,
  type ActiveWorkspace,
} from '../../onboarding/services/browser-workspace';
import { createMissionNavigator } from '../../onboarding/services/mission-navigation';
import { openBackgroundPage } from '../../onboarding/services/background-page';
import { protectMissionPage } from '../../onboarding/services/mission-request-guard';
import * as courseRefreshApi from '../../courses/services/refresh';
import type {
  CourseCollectionKind,
  CourseScanStatus,
} from '../../courses/types';
import { createWatchBrowserSession, settleWatchPage } from './browser-session';
import { createWatchController } from './controller';
import { createWatchLifecycle } from './lifecycle';
import {
  getWatchSettings,
  getWatchTargets,
  getWatchHealthSummary,
  markWatchTargetProcessed,
  recordWatchFailure,
  recordWatchObservation,
  resetWatchTargetsAfterReconnect,
  scheduleWatchTargetCheck,
  synchronizeWatchTargets,
  getLastWatchReconciledAt,
  recordWatchReconciledAt,
} from './store';
import { getEffectiveWatchTargetInputs, parseWatchUrl } from '../lib/watch-url';
import {
  installPageObserver,
  readPageMutationState,
  readWatchPageSnapshot,
  disconnectPageObserver,
} from './page-observer';
import { createWatchRefreshProcessor, isTaskRunnerBusy } from './refresh';
import type {
  InternalWatchExecutionCoverageReceipt,
  WatchRuntimeStatus,
} from '../types';
import type { WatchTargetSelectData } from '../../../db/schema';

type ActiveWatchWorkspace = {
  userId: string;
  workspace: ActiveWorkspace;
  isCurrent: () => boolean;
  sessionEpoch: number;
};

type CourseRefreshExecutionReceipt = {
  runId: string;
  sessionEpoch: number;
  coveredRevisions: Readonly<Record<string, string>>;
  status: 'complete' | 'partial' | 'sign-in-required';
  collections: Array<{
    courseId: string | null;
    kind: CourseCollectionKind;
    status: CourseScanStatus;
  }>;
};
type CourseRefreshExecution<TResult> = {
  result: TResult;
  receipt: CourseRefreshExecutionReceipt;
};
type CaptureRefreshScope = () => {
  sessionEpoch: number;
  coveredRevisions: Readonly<Record<string, string>>;
};
type P06ReceiptApi = {
  refreshSingleCourseWithReceipt?: (
    userId: string,
    courseId: string,
    captureExecutionScope: CaptureRefreshScope,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ) => Promise<CourseRefreshExecution<unknown>>;
  startConnectionRefreshWithReceipt?: (
    userId: string,
    connectionId: string,
    captureExecutionScope: CaptureRefreshScope,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ) => Promise<CourseRefreshExecution<unknown>>;
};

// P06's receipt exports arrive in the sibling integration commit.
const p06ReceiptApi = courseRefreshApi as unknown as P06ReceiptApi;

const toWatchCoverageReceipt = (
  receipt: CourseRefreshExecutionReceipt,
): InternalWatchExecutionCoverageReceipt => ({
  runId: receipt.runId,
  sessionEpoch: receipt.sessionEpoch,
  coveredRevisions: Object.entries(receipt.coveredRevisions).map(
    ([targetId, fingerprint]) => ({ targetId, fingerprint }),
  ),
  collectionCoverage: receipt.collections.flatMap((collection) =>
    collection.courseId
      ? [
          {
            courseId: collection.courseId,
            collectionKind: collection.kind,
            status: collection.status,
          },
        ]
      : [],
  ),
});

type WatchRuntimeOptions = {
  onStatus: (
    userId: string,
    enabled: boolean,
    status: WatchRuntimeStatus,
    revision: number,
  ) => void;
};

export const createWatchRuntime = ({ onStatus }: WatchRuntimeOptions) => {
  let activeWorkspace: ActiveWatchWorkspace | null = null;
  let nextSessionEpoch = 0;
  let sessionGeneration = 0;
  let lastSessionCheck: { userId: string; isCurrent: () => boolean } | null =
    null;
  const statusRevisions = new Map<string, number>();
  const publishStatus = (
    userId: string,
    enabled: boolean,
    status: WatchRuntimeStatus,
  ) => {
    const revision = (statusRevisions.get(userId) ?? 0) + 1;
    statusRevisions.set(userId, revision);
    onStatus(userId, enabled, status, revision);
  };
  let controller: ReturnType<typeof createWatchController>;
  const assertTarget = (target: WatchTargetSelectData, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (
      !activeWorkspace ||
      activeWorkspace.userId !== target.userId ||
      !activeWorkspace.isCurrent()
    )
      throw new Error('Your session changed; sign in again.');
    const state = getOnboardingState(target.userId);
    if (
      !state.settings.consent ||
      !state.settings.localSetupCompletedAt ||
      !state.workspace?.ready
    )
      throw new Error('Complete setup and approve academic access first.');
    const savedTarget = getWatchTargets(target.userId).find(
      (item) => item.id === target.id,
    );
    if (
      !getWatchSettings(target.userId).watchEnabled ||
      !savedTarget ||
      savedTarget.status !== 'active'
    )
      throw new Error('Course page watching is no longer enabled.');
    const connection = state.connections.find(
      (item) =>
        item.id === target.connectionId &&
        item.isCourseResource &&
        item.status !== 'needs-sign-in',
    );
    if (!connection)
      throw new Error('Sign in to the course resource before watching it.');
    const parsedUrl = parseWatchUrl(target.verifiedUrl ?? target.requestedUrl, [
      connection,
    ]);
    if (parsedUrl.connectionId !== target.connectionId)
      throw new Error('The watched page no longer belongs to this connection.');
    return { connection, state, workspace: activeWorkspace.workspace };
  };
  const browser = createWatchBrowserSession({
    createPage: async (target, signal) => {
      const { workspace } = assertTarget(target, signal);
      return openBackgroundPage(workspace, signal);
    },
    protectPage: async (page, target, signal) => {
      const { connection, workspace } = assertTarget(target, signal);
      const protection = await protectMissionPage(page, workspace.cdpUrl, [
        connection.host,
      ]);
      return {
        release: protection,
        assertReadable: protection.assertReadable,
      };
    },
    navigate: async (page, target, signal, url) => {
      const { connection, workspace } = assertTarget(target, signal);
      const isCurrent = () =>
        activeWorkspace?.userId === target.userId &&
        activeWorkspace.isCurrent() &&
        !signal.aborted;
      const navigate = createMissionNavigator(
        () => workspace.browser.context,
        [connection.host],
        signal,
        isCurrent,
        { scopeId: target.userId },
      );
      await navigate(page, url);
    },
    readSnapshot: async (page, target, signal) => {
      const { connection } = assertTarget(target, signal);
      return readWatchPageSnapshot(page, {
        allowedHosts: [connection.host],
        recipeVersion: target.recipeVersion ?? 1,
        signal,
      });
    },
    installObserver: installPageObserver,
    readMutationState: readPageMutationState,
    disconnectObserver: disconnectPageObserver,
    settle: (page, signal) =>
      settleWatchPage(page, signal, {
        readMutationState: readPageMutationState,
      }),
  });
  const refreshConnection = async (
    userId: string,
    connectionId: string,
    signal: AbortSignal,
  ) => {
    const workspace = activeWorkspace;
    if (!workspace || workspace.userId !== userId)
      throw new Error('Your session changed; sign in again.');
    const sessionEpoch = workspace.sessionEpoch;
    const isCurrent = () =>
      activeWorkspace === workspace && workspace.isCurrent() && !signal.aborted;
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const refresh = p06ReceiptApi.startConnectionRefreshWithReceipt;
    if (!refresh)
      throw new Error('Exact academic refresh coverage is unavailable.');
    const execution = await refresh(
      userId,
      connectionId,
      () => {
        signal.throwIfAborted();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        return { sessionEpoch, coveredRevisions: {} };
      },
      isCurrent,
      signal,
    );
    signal.throwIfAborted();
    if (!isCurrent() || activeWorkspace?.sessionEpoch !== sessionEpoch)
      throw new Error('Your session changed; sign in again.');
    return { complete: execution.receipt.status === 'complete' };
  };
  const processChange = createWatchRefreshProcessor({
    startRefresh: async (target, fingerprint, signal) => {
      const workspace = activeWorkspace;
      if (!workspace || workspace.userId !== target.userId)
        throw new Error('Your session changed; sign in again.');
      const sessionEpoch = workspace.sessionEpoch;
      const isCurrent = () =>
        activeWorkspace === workspace &&
        workspace.isCurrent() &&
        !signal.aborted;
      const captureExecutionScope: CaptureRefreshScope = () => {
        signal.throwIfAborted();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        return {
          sessionEpoch,
          coveredRevisions: { [target.id]: fingerprint },
        };
      };
      const refresh = target.courseId
        ? p06ReceiptApi.refreshSingleCourseWithReceipt
        : p06ReceiptApi.startConnectionRefreshWithReceipt;
      if (!refresh)
        throw new Error('Exact academic refresh coverage is unavailable.');
      const execution = target.courseId
        ? await p06ReceiptApi.refreshSingleCourseWithReceipt!(
            target.userId,
            target.courseId,
            captureExecutionScope,
            isCurrent,
            signal,
          )
        : await p06ReceiptApi.startConnectionRefreshWithReceipt!(
            target.userId,
            target.connectionId,
            captureExecutionScope,
            isCurrent,
            signal,
          );
      signal.throwIfAborted();
      if (!isCurrent() || activeWorkspace?.sessionEpoch !== sessionEpoch)
        throw new Error('Your session changed; sign in again.');
      return {
        complete:
          execution.receipt.status === 'complete' &&
          (!target.courseId || execution.result !== null),
        failureCategory:
          execution.receipt.status === 'sign-in-required'
            ? 'needs-sign-in'
            : execution.receipt.status === 'partial'
              ? 'unknown'
              : undefined,
        receipt: toWatchCoverageReceipt(execution.receipt),
      };
    },
    markProcessed: (revision) => {
      const workspace = activeWorkspace;
      if (
        !workspace ||
        workspace.userId !== revision.userId ||
        revision.sessionEpoch === undefined ||
        workspace.sessionEpoch !== revision.sessionEpoch ||
        !workspace.isCurrent()
      )
        return null;
      return markWatchTargetProcessed(revision);
    },
  });
  controller = createWatchController({
    getSettings: getWatchSettings,
    getTargets: getWatchTargets,
    checkTarget: (target, signal, options) => {
      assertTarget(target, signal);
      return browser.checkTarget(target, signal, options);
    },
    recordObservation: recordWatchObservation,
    recordFailure: recordWatchFailure,
    scheduleCheck: scheduleWatchTargetCheck,
    processChange,
    reconcileCourses: {
      lastSuccessfulAt: getLastWatchReconciledAt,
      markSuccessful: recordWatchReconciledAt,
      run: async (userId, signal) => {
        const connections = getOnboardingState(userId).connections.filter(
          (connection) =>
            connection.isCourseResource &&
            connection.status !== 'needs-sign-in',
        );
        if (!connections.length) return false;
        try {
          for (const connection of connections) {
            signal.throwIfAborted();
            if (
              !(await refreshConnection(userId, connection.id, signal)).complete
            )
              return false;
          }
          return true;
        } catch (error) {
          if (isTaskRunnerBusy(error)) return 'busy';
          throw error;
        }
      },
    },
    subscribeCapacity: (userId, listener) =>
      academicTasks.subscribe((accountId) => {
        if (accountId === userId) listener();
      }),
    onStatus: (userId, status) =>
      publishStatus(userId, getWatchSettings(userId).watchEnabled, status),
  });
  browser.setMutationHandler((targetId) => {
    if (activeWorkspace)
      void controller.requestCheck(activeWorkspace.userId, targetId);
  });
  const lifecycle = createWatchLifecycle({
    start: async (userId, isCurrent, signal) => {
      signal.throwIfAborted();
      const workspace = await getWorkspace(
        userId,
        () => isCurrent() && !signal.aborted,
      );
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      activeWorkspace = {
        userId,
        workspace,
        isCurrent,
        sessionEpoch: ++nextSessionEpoch,
      };
      await browser.closeAll();
      signal.throwIfAborted();
      synchronizeWatchTargets(userId);
      await controller.start(userId, signal);
      signal.throwIfAborted();
      return controller.getStatus(userId);
    },
    stop: async (userId) => {
      await controller.stop(userId);
      await browser.closeAll();
      synchronizeWatchTargets(userId);
      if (activeWorkspace?.userId === userId) activeWorkspace = null;
    },
    onStatus: (userId, status) =>
      publishStatus(userId, getWatchSettings(userId).watchEnabled, status),
  });
  const configure = (
    userId: string,
    setupComplete: boolean,
    isCurrent: () => boolean,
  ) => {
    const sessionChanged =
      (lastSessionCheck?.userId === userId && !lastSessionCheck.isCurrent()) ||
      (activeWorkspace?.userId === userId && !activeWorkspace.isCurrent());
    if (sessionChanged) sessionGeneration += 1;
    if (activeWorkspace?.userId === userId) {
      if (sessionChanged) activeWorkspace = null;
      else activeWorkspace.isCurrent = isCurrent;
    }
    lastSessionCheck = { userId, isCurrent };
    const settings = getWatchSettings(userId);
    const state = getOnboardingState(userId);
    const effectiveTargets = getEffectiveWatchTargetInputs(
      settings,
      state.connections,
    );
    const hasCourseResource = effectiveTargets.length > 0;
    const needsSignIn =
      !hasCourseResource &&
      state.connections.some(
        (connection) =>
          connection.isCourseResource && connection.status === 'needs-sign-in',
      );
    return lifecycle.configure({
      userId,
      enabled: settings.watchEnabled,
      setupComplete: setupComplete && !!state.settings.localSetupCompletedAt,
      consent: state.settings.consent,
      workspaceReady: state.workspace?.ready === true,
      hasCourseResource,
      needsSignIn,
      key: JSON.stringify([
        settings.watchEnabled,
        settings.watchUrls,
        setupComplete,
        state.settings.consent,
        state.workspace?.ready,
        sessionGeneration,
        state.connections.map((connection) => [
          connection.id,
          connection.status,
          connection.isCourseResource,
        ]),
      ]),
      isCurrent,
    });
  };
  return {
    configure,
    pause: lifecycle.pause,
    resume: lifecycle.resume,
    suspend: lifecycle.suspend,
    stop: lifecycle.stop,
    reconnectSucceeded: async (userId: string, connectionId: string) => {
      const resetTargetIds = resetWatchTargetsAfterReconnect(
        userId,
        connectionId,
      );
      if (resetTargetIds.length && activeWorkspace?.userId === userId)
        await controller.tick(userId);
      return resetTargetIds;
    },
    getState: (userId: string) => {
      const lifecycleStatus = lifecycle.getStatus(userId);
      const status =
        activeWorkspace?.userId === userId &&
        (lifecycleStatus === 'watching' ||
          lifecycleStatus === 'checking' ||
          lifecycleStatus === 'updating')
          ? controller.getStatus(userId)
          : lifecycleStatus;
      const health = getWatchHealthSummary(userId, status);
      return {
        enabled: getWatchSettings(userId).watchEnabled,
        status: health.status,
        revision: statusRevisions.get(userId) ?? 0,
        health,
        metrics: controller.getMetrics(userId),
      };
    },
  };
};
