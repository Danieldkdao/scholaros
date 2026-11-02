import { academicTasks } from '../../onboarding/services/academic-tasks';
import { getOnboardingState } from '../../onboarding/services/store';
import {
  getWorkspace,
  type ActiveWorkspace,
} from '../../onboarding/services/browser-workspace';
import { createMissionNavigator } from '../../onboarding/services/mission-navigation';
import { openBackgroundPage } from '../../onboarding/services/background-page';
import { protectMissionPage } from '../../onboarding/services/mission-request-guard';
import { courseScanSucceeded } from '../../courses/types';
import {
  refreshSingleCourse,
  startConnectionRefresh,
} from '../../courses/services/refresh';
import { createWatchBrowserSession, settleWatchPage } from './browser-session';
import { createWatchController } from './controller';
import { createWatchLifecycle } from './lifecycle';
import {
  getWatchSettings,
  getWatchTargets,
  markWatchTargetProcessed,
  recordWatchFailure,
  recordWatchObservation,
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
import type { WatchRuntimeStatus } from '../types';
import type { WatchTargetSelectData } from '../../../db/schema';

type ActiveWatchWorkspace = {
  userId: string;
  workspace: ActiveWorkspace;
  isCurrent: () => boolean;
};

type WatchRuntimeOptions = {
  onStatus: (
    userId: string,
    enabled: boolean,
    status: WatchRuntimeStatus,
  ) => void;
};

export const createWatchRuntime = ({ onStatus }: WatchRuntimeOptions) => {
  let activeWorkspace: ActiveWatchWorkspace | null = null;
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
    const isCurrent = () =>
      activeWorkspace?.userId === userId &&
      activeWorkspace.isCurrent() &&
      !signal.aborted;
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const refreshedConnection = await startConnectionRefresh(
      userId,
      connectionId,
      isCurrent,
      signal,
    );
    const source = refreshedConnection.snapshot.sources.find(
      (item) => item.connectionId === connectionId,
    );
    return {
      complete:
        refreshedConnection.materialRefreshStatus === 'complete' &&
        source?.outcome === 'complete' &&
        refreshedConnection.snapshot.courses
          .filter(
            (course) => course.connectionId === connectionId && course.active,
          )
          .every(
            (course) =>
              course.overviewSyncedAt !== null &&
              courseScanSucceeded(course.assignmentsStatus) &&
              courseScanSucceeded(course.announcementsStatus),
          ),
    };
  };
  const processChange = createWatchRefreshProcessor({
    startRefresh: async (target, signal) => {
      const isCurrent = () =>
        activeWorkspace?.userId === target.userId &&
        activeWorkspace.isCurrent() &&
        !signal.aborted;
      if (target.courseId) {
        const refreshedCourse = await refreshSingleCourse(
          target.userId,
          target.courseId,
          isCurrent,
          signal,
        );
        return {
          complete:
            !!refreshedCourse &&
            refreshedCourse.materialRefreshStatus === 'complete' &&
            refreshedCourse.overviewSyncedAt !== null &&
            courseScanSucceeded(refreshedCourse.assignmentsStatus) &&
            courseScanSucceeded(refreshedCourse.announcementsStatus),
        };
      }
      return refreshConnection(target.userId, target.connectionId, signal);
    },
    markProcessed: markWatchTargetProcessed,
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
      onStatus(userId, getWatchSettings(userId).watchEnabled, status),
  });
  browser.setMutationHandler((targetId) => {
    if (activeWorkspace)
      void controller.requestCheck(activeWorkspace.userId, targetId);
  });
  const lifecycle = createWatchLifecycle({
    start: async (userId, isCurrent) => {
      const workspace = await getWorkspace(userId, isCurrent);
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      activeWorkspace = { userId, workspace, isCurrent };
      await browser.closeAll();
      synchronizeWatchTargets(userId);
      await controller.start(userId);
      return controller.getStatus(userId);
    },
    stop: async (userId) => {
      await controller.stop(userId);
      await browser.closeAll();
      synchronizeWatchTargets(userId);
      if (activeWorkspace?.userId === userId) activeWorkspace = null;
    },
    onStatus: (userId, status) =>
      onStatus(userId, getWatchSettings(userId).watchEnabled, status),
  });
  const configure = (
    userId: string,
    setupComplete: boolean,
    isCurrent: () => boolean,
  ) => {
    if (activeWorkspace?.userId === userId)
      activeWorkspace.isCurrent = isCurrent;
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
    getState: (userId: string) => {
      const status = lifecycle.getStatus(userId);
      return {
        enabled: getWatchSettings(userId).watchEnabled,
        status:
          activeWorkspace?.userId === userId &&
          (status === 'watching' ||
            status === 'checking' ||
            status === 'updating')
            ? controller.getStatus(userId)
            : status,
        metrics: controller.getMetrics(userId),
      };
    },
  };
};
