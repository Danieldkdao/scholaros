import { clientEnv } from '../../../data/env/client';
import {
  courseRecordSchema,
  createCourseRecordSchema,
  listCourseRecordSuppressionsSchema,
  restoreCourseRecordSuppressionSchema,
  updateCourseRecordSchema,
} from '../../courses/schemas';
import { academicTasks } from './academic-tasks';
import { createConnectRuntime } from './connect-runtime';
import { createConnectWorkspace } from './connect-workspace';
import { acquireConnectOwnership } from './connect-ownership';
import { protectMissionPage } from './mission-request-guard';
import { createConnectionApprovalStore } from './connection-approval';
import { resolveConnectionCandidates } from './connection-resolver';
import { app, powerMonitor } from 'electron';
import {
  internalLearningInputSchemas,
  internalOfflineReadMethods,
  offlineReadMethods,
  workspaceReplacementCancelInputSchema,
  workspaceReplacementCommitInputSchema,
  workspaceReplacementInputSchema,
} from '../../../services/academic/contracts';
import type {
  AcademicAction,
  AcademicEventChannel,
  AuthMode,
  LearningActionRegistrar,
  OfflineDeviceReadiness,
} from '../../../services/academic/contracts';
import {
  createLearningLifecycle,
  createProductNotificationProducer,
  notificationOutcomeId,
  registerLearningActions,
  type LearningActionModule,
} from '../../../services/academic/learning-actions';
import { ArtifactStoreError } from '../../study/services/artifact-store';
import type { NotificationOutcome } from '../../notifications/services/notification-actions';
import { createOriginalStore } from '../../context/services/original-store';
import {
  createLocalDataCleanup,
  LocalDataCleanupError,
} from '../../../services/academic/local-data-cleanup';
import type {
  ActionCleanup,
  AuthorizedContext,
} from '@scholaros/services/learning/product-contracts';
import { productEventResources } from '@scholaros/services/learning/product-contracts';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { authClient } from '../../../lib/auth/client';
import { clearOfflineAccountGrant } from '../../../lib/offline-account';
import {
  accountRequest,
  getCurrentUser,
  markLocalSignOut,
  isAccountSessionCurrent,
} from '../../../lib/auth/main';
import {
  createSessionGuard,
  runSessionAction,
} from '../../../lib/session-guard';
import { tearDownSession } from '../../../lib/session-teardown';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  BrowserWorkspaceTable,
  CourseTable,
  SettingTable,
} from '../../../db/schema';
import { academicResources } from '../constants';
import { previewPromptSchema, settingsUpdateSchema } from '../schemas';
import {
  getOnboardingState,
  removeAcademicConnection,
  saveOnboardingSettings,
  settleLocalSetup,
} from './store';
import { chooseBrowser, findBrowsers } from './browser-discovery';
import {
  closeWorkspace,
  stageWorkspaceReplacement,
  commitWorkspaceReplacement,
  cancelWorkspaceReplacement,
  createWorkspace,
  openAcademicPage,
  waitForWorkspaceStops,
  getWorkspace,
} from './browser-workspace';
import {
  captureResource,
  captureResourcePage,
  confirmResource,
  previewResource,
  saveConnectionNotes,
  setCourseResource,
  setPrimaryLms,
} from './connections';
import {
  cancelPreview,
  getPreview,
  resetPreview,
  startPreview,
  subscribePreview,
} from './preview';
import { isAcademicUrl, isReadNavigation } from '../lib/browser-policy';
import { courseRefreshFailureMessage } from '../lib/discovery-outcomes';
import { applyLaunchAtLogin, getLaunchAtLoginState } from './preferences';
import { completeOnboarding } from './completion';
import { discoverAcademicContext } from './discovery';
import { createBackgroundSyncController } from './background-sync';
import { createWatchRuntime } from '../../watch/services/runtime';
import {
  getWatchSettings,
  saveWatchSettings,
} from '../../watch/services/store';
import { watchSettingsSchema } from '../../watch/schemas';
import {
  updateCourseRecord,
  createCourseRecord,
  deleteCourseRecord,
  listCourseRecordSuppressions,
  restoreCourseRecordSuppression,
  subscribeCourseChanges,
} from '../../courses/services/store';
import {
  getCourseAction,
  getCoursesAction,
} from '../../courses/services/read-actions';
import {
  cancelCourseRefresh,
  startCourseRefresh,
  refreshSingleCourse,
  type CourseRefreshResult,
} from '../../courses/services/refresh';
import type {
  CourseRefreshActivity,
  CoursesSnapshot,
} from '../../courses/types';
import type { LaunchAtLoginPreference, OnboardingState } from '../types';

const isOfflineDeviceReady = (userId: string) => {
  const settings = db
    .select({ localSetupCompletedAt: SettingTable.localSetupCompletedAt })
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get();
  const workspace = db
    .select({ verifiedAt: BrowserWorkspaceTable.verifiedAt })
    .from(BrowserWorkspaceTable)
    .where(eq(BrowserWorkspaceTable.userId, userId))
    .get();
  return Boolean(settings?.localSetupCompletedAt && workspace?.verifiedAt);
};

const idSchema = z.string().min(1).max(300);
const sessionGuard = createSessionGuard();
const learningLifecycle = createLearningLifecycle();
const connectionApprovals = createConnectionApprovalStore();
let resolutionEpoch = 0;
let stoppingBackgroundSync: Promise<void> | null = null;
let broadcastingPreview = false;
let watchPowerEventsRegistered = false;
let systemSuspended = false;
let pendingSystemWatchSuspend: Promise<void> | null = null;
let releaseSystemBackgroundSuspend: (() => void) | null = null;
let releaseSystemWatchSuspend: (() => Promise<void>) | null = null;
let manualCourseRefresh: {
  userId: string;
  completion: Promise<CoursesSnapshot>;
} | null = null;
let boundAccountId: string | null = null;
let accountAccessRevision = 0;
let cleanupAdmissionRevision = 0;
let boundAuthMode: AuthMode | null = null;
let boundCookie: string | null = null;
let boundOnboardingComplete = false;
let learningActionRegistrar: LearningActionRegistrar | null = null;
let learningActionModules: readonly LearningActionModule[] = [];
let learningActionRebind: Promise<void> = Promise.resolve();
let learningRequestSequence = 0;
let learningActionsCleanup: ActionCleanup | null = null;
let taskNotificationProducer: ReturnType<
  typeof createProductNotificationProducer
> | null = null;
const runningNotificationTasks = new Map<string, AuthorizedContext | null>();
const accountCleanupGates = new Map<
  string,
  { operationId: string; completion: Promise<void> }
>();
const accountRequests = new Map<
  string,
  { userId: string; controller: AbortController }
>();
const pendingPreviews = new Map<string, Promise<void>>();

const assertAccountAdmission = (userId: string) => {
  if (accountCleanupGates.has(userId))
    throw Object.assign(
      new Error('Local data is being removed; try again shortly.'),
      { code: 'busy' },
    );
};

const registerLearningActionModules = async () => {
  if (learningActionRegistrar)
    learningActionsCleanup = await registerLearningActions(
      learningActionRegistrar,
      [
        ...learningActionModules,
        (registrar) => {
          const producer = createProductNotificationProducer(registrar);
          taskNotificationProducer = producer;
          return async () => {
            if (taskNotificationProducer === producer)
              taskNotificationProducer = null;
            // Retain old running-task fences until settlement; never rebind them to a new epoch.
            await producer.dispose();
          };
        },
      ],
    );
};

const rebindLearningActionModules = async (excludedOperationId?: string) => {
  await Promise.all(
    [...accountCleanupGates.values()]
      .filter((gate) => gate.operationId !== excludedOperationId)
      .map((gate) => gate.completion),
  );
  const rebinding = learningActionRebind.then(async () => {
    await learningLifecycle.invalidate(excludedOperationId);
    await registerLearningActionModules();
  });
  learningActionRebind = rebinding.catch(() => undefined);
  return rebinding;
};

type IpcContext = {
  userId: string;
  operationId: string;
  epoch: number;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

const captureTaskNotificationContext = (
  userId: string,
): AuthorizedContext | null => {
  const epoch = learningLifecycle.epoch;
  const signal = learningLifecycle.signal;
  const cookie = boundCookie;
  const accessRevision = accountAccessRevision;
  const admissionRevision = cleanupAdmissionRevision;
  const isCurrent = () =>
    !signal.aborted &&
    learningLifecycle.isCurrent(epoch) &&
    boundAccountId === userId &&
    boundAuthMode === 'online' &&
    accountAccessRevision === accessRevision &&
    cleanupAdmissionRevision === admissionRevision &&
    !accountCleanupGates.has(userId) &&
    cookie !== null &&
    isAccountSessionCurrent(cookie) &&
    getOnboardingState(userId).settings.consent;
  return isCurrent() ? { userId, epoch, signal, isCurrent } : null;
};

const observeAcademicTaskNotifications = (userId: string) => {
  for (const task of academicTasks.getActivity(userId)) {
    if (task.status === 'running') {
      if (!runningNotificationTasks.has(task.id))
        runningNotificationTasks.set(
          task.id,
          captureTaskNotificationContext(userId),
        );
      continue;
    }
    const context = runningNotificationTasks.get(task.id);
    runningNotificationTasks.delete(task.id);
    if (!context || !context.isCurrent()) continue;
    const connectionId = task.key.startsWith('connection:')
      ? task.key.slice('connection:'.length)
      : null;
    if (task.status === 'sign-in-required') {
      const course = db
        .select({ connectionId: CourseTable.connectionId })
        .from(CourseTable)
        .where(
          and(eq(CourseTable.userId, userId), eq(CourseTable.id, task.key)),
        )
        .get();
      const connections = db
        .select({ id: AcademicConnectionTable.id })
        .from(AcademicConnectionTable)
        .where(
          and(
            eq(AcademicConnectionTable.userId, userId),
            eq(AcademicConnectionTable.status, 'needs-sign-in'),
            ...(task.key === 'courses'
              ? []
              : [
                  eq(
                    AcademicConnectionTable.id,
                    course?.connectionId ?? connectionId ?? task.key,
                  ),
                ]),
          ),
        )
        .limit(50)
        .all();
      for (const connection of connections)
        void taskNotificationProducer?.enqueue(
          context,
          {
            category: 'connection-attention',
            outcome: 'attention',
            outcomeId: notificationOutcomeId(
              'connection',
              task.id,
              connection.id,
            ),
            targetKind: 'connection',
            targetId: connection.id,
            route: { kind: 'settings', section: 'connections' },
            expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          },
          learningLifecycle.now(),
        );
      continue;
    }
    if (task.status !== 'failed') continue;
    const target =
      task.key === 'courses'
        ? {
            targetKind: 'device' as const,
            targetId: null,
            route: { kind: 'today' as const },
          }
        : connectionId
          ? {
              targetKind: 'connection' as const,
              targetId: connectionId,
              route: {
                kind: 'settings' as const,
                section: 'connections' as const,
              },
            }
          : {
              targetKind: 'course' as const,
              targetId: task.key,
              route: { kind: 'course' as const, courseId: task.key },
            };
    void taskNotificationProducer?.enqueue(
      context,
      {
        category: 'sync-failed',
        outcome: 'failed',
        outcomeId: notificationOutcomeId('sync', task.id),
        ...target,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      },
      learningLifecycle.now(),
    );
  }
};

const enqueueSyncOutcome = (
  context: AuthorizedContext,
  task: CourseRefreshActivity,
  completed: boolean,
  target: Pick<NotificationOutcome, 'targetKind' | 'targetId' | 'route'>,
) =>
  void taskNotificationProducer?.enqueue(
    context,
    {
      category: completed ? 'sync-completed' : 'sync-failed',
      outcome: completed ? 'completed' : 'failed',
      outcomeId: notificationOutcomeId('sync', task.id),
      ...target,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    },
    learningLifecycle.now(),
  );

const notifySingleCourseOutcome = (
  context: AuthorizedContext,
  courseId: string,
  course: Awaited<ReturnType<typeof refreshSingleCourse>>,
  task: CourseRefreshActivity | undefined,
) => {
  try {
    if (
      !context.isCurrent() ||
      !task ||
      task.status !== 'complete' ||
      !course ||
      course.id !== courseId
    )
      return;
    const completed =
      course.active &&
      !!course.overviewSyncedAt &&
      course.materialRefreshStatus === 'complete' &&
      course.assignmentsStatus === 'complete' &&
      course.announcementsStatus === 'complete';
    enqueueSyncOutcome(context, task, completed, {
      targetKind: 'course',
      targetId: courseId,
      route: { kind: 'course', courseId },
    });
  } catch {
    // Notification storage does not own the committed course result.
  }
};

const notifyCourseRefreshOutcome = (
  context: AuthorizedContext,
  refreshed: CourseRefreshResult,
  task: CourseRefreshActivity | undefined,
) => {
  try {
    const attempted = refreshed.attemptedConnectionIds;
    if (
      !context.isCurrent() ||
      !task ||
      task.status !== 'complete' ||
      !attempted?.length ||
      ['pending', 'running', 'cancelled'].includes(
        refreshed.state.discovery.status,
      )
    )
      return;
    const completed =
      refreshed.materialRefreshStatus === 'complete' &&
      ['complete', 'empty'].includes(refreshed.state.discovery.status) &&
      attempted.every(
        (connectionId) =>
          refreshed.state.connections.some(
            (connection) => connection.id === connectionId,
          ) &&
          refreshed.snapshot.sources.some(
            (source) =>
              source.connectionId === connectionId &&
              source.outcome === 'complete',
          ),
      ) &&
      refreshed.snapshot.courses
        .filter(
          (course) =>
            course.connectionId !== null &&
            attempted.includes(course.connectionId),
        )
        .every(
          (course) =>
            course.assignmentsStatus === 'complete' &&
            course.announcementsStatus === 'complete',
        );
    enqueueSyncOutcome(context, task, completed, {
      targetKind: 'device',
      targetId: null,
      route: { kind: 'today' },
    });
  } catch {
    // Optional alerts never change refresh results or scheduler state.
  }
};

let backgroundSyncAccountId: string | null = null;
let publish: (channel: AcademicEventChannel, value: unknown) => void = () =>
  undefined;
const watchRuntime = createWatchRuntime({
  onStatus: (accountId, enabled, status) =>
    publish('scholar:watchChange', { accountId, enabled, status }),
});
// Scheduled work runs the same pipeline as the manual button, so one set of
// protections, bounds and persistence rules covers both.
const backgroundSync = createBackgroundSyncController<CourseRefreshResult>({
  runDiscovery: async (userId, isCurrent, signal) => {
    assertAccountAdmission(userId);
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return learningLifecycle.trackOperation(
      `background-${++learningRequestSequence}`,
      async () => {
        const user = await getCurrentUser(isOfflineDeviceReady);
        const accountIsCurrent = () =>
          !accountCleanupGates.has(userId) && isCurrent();
        if (signal.aborted || !accountIsCurrent() || user?.id !== userId)
          throw new Error('Please sign in again to resume background sync.');
        const context = captureTaskNotificationContext(userId);
        const refresh = startCourseRefresh(userId, accountIsCurrent, signal);
        const task = academicTasks
          .getActivity(userId)
          .find((task) => task.key === 'courses' && task.status === 'running');
        const refreshed = await refresh;
        if (context && !signal.aborted && accountIsCurrent())
          notifyCourseRefreshOutcome(context, refreshed, task);
        return refreshed;
      },
    );
  },
  syncFailure: (refreshed) =>
    courseRefreshFailureMessage({
      attemptedConnectionIds: refreshed.attemptedConnectionIds,
      connections: refreshed.state.connections,
      discovery: refreshed.state.discovery,
      courses: refreshed.snapshot.courses,
    }),
  onChange: (syncState, refreshed) => {
    publish('scholar:backgroundSyncChange', {
      accountId: backgroundSyncAccountId,
      state: syncState,
      discovery: refreshed?.state.discovery ?? null,
    });
  },
});

const requireConsent = (userId: string) => {
  if (!getOnboardingState(userId).settings.consent)
    throw new Error('Approve academic access first.');
};

const prepareState = (
  state: OnboardingState,
  launchAtLogin?: LaunchAtLoginPreference,
  isCurrent: () => boolean = () => true,
) => {
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  assertAccountAdmission(state.accountId);
  const settled = settleLocalSetup(state, {
    accountCompleted: boundOnboardingComplete,
  });
  backgroundSyncAccountId = settled.accountId;
  void watchRuntime.configure(
    settled.accountId,
    boundOnboardingComplete && boundAuthMode === 'online',
    isCurrent,
  );
  backgroundSync.configure({
    userId: settled.accountId,
    enabled:
      boundAuthMode === 'online' &&
      boundOnboardingComplete &&
      !!settled.settings.localSetupCompletedAt &&
      settled.settings.backgroundSync &&
      settled.settings.consent &&
      settled.workspace?.ready === true &&
      settled.connections.some(
        (connection) =>
          connection.isCourseResource && connection.status !== 'needs-sign-in',
      ),
    isCurrent,
  });
  const backgroundState =
    (!boundOnboardingComplete || !settled.settings.localSetupCompletedAt) &&
    settled.settings.backgroundSync
      ? {
          status: 'waiting' as const,
          message: 'Background sync starts after setup.',
          lastSyncedAt: null,
        }
      : backgroundSync.getState();
  return {
    ...settled,
    watch: watchRuntime.getState(settled.accountId),
    preferences: {
      launchAtLogin:
        launchAtLogin ?? getLaunchAtLoginState(settled.settings.launchAtLogin),
      backgroundSync: {
        ...backgroundState,
        lastSyncedAt:
          backgroundState.lastSyncedAt ?? settled.discovery.discoveredAt,
      },
    },
  };
};

const cancelBrowserWork = async () => {
  academicTasks.cancel();
  await cancelPreview();
  await academicTasks.cancelAndWait();
};

// Foreground browser work owns the study browser, so scheduled sync waits for it
// and picks up again afterwards instead of staying paused for the session.
const withBrowserWorkStopped = async <TResult>(
  action: () => Promise<TResult>,
): Promise<TResult> => {
  const releaseBackgroundSync = backgroundSync.suspend();
  let releaseWatch: (() => Promise<void>) | null = null;
  try {
    releaseWatch = await watchRuntime.suspend();
    await cancelBrowserWork();
    return await action();
  } finally {
    releaseBackgroundSync();
    await releaseWatch?.();
  }
};

let connectIsCurrent: () => boolean = () => false;
const connectRuntime = createConnectRuntime({
  approvals: connectionApprovals,
  noteForHost: (userId, host) =>
    getOnboardingState(userId).connections.find(
      (connection) => connection.host === host,
    )?.notes ?? null,
  acquire: async (userId) => {
    const releaseBackgroundSync = backgroundSync.suspend();
    let releaseWatch: (() => Promise<void>) | null = null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseBackgroundSync();
      void releaseWatch?.().catch(() => undefined);
    };
    try {
      releaseWatch = await watchRuntime.suspend();
      await cancelBrowserWork();
      if (!connectIsCurrent())
        throw new Error('Your session changed; sign in again.');
      return await acquireConnectOwnership(
        userId,
        academicTasks,
        () => release,
      );
    } catch (error) {
      release();
      await releaseWatch?.().catch(() => undefined);
      throw error;
    }
  },
  browser: async (userId, sites) => {
    const workspace = await getWorkspace(userId, connectIsCurrent);
    if (!connectIsCurrent())
      throw new Error('Your session changed; sign in again.');
    return createConnectWorkspace({
      context: workspace.browser.context,
      cdpUrl: workspace.cdpUrl,
      accountId: userId,
      sites,
      protect: protectMissionPage,
      terminateWorkspace: closeWorkspace,
      capture: (id, page, check, host, signal) =>
        captureResourcePage(
          id,
          page,
          () => connectIsCurrent() && check(),
          host,
          signal,
        ),
    });
  },
});

const bindAccount = async (
  accountId: string | null,
  authMode: AuthMode | null,
  cookie: string | null,
) => {
  const accountChanged = boundAccountId !== accountId;
  const accessChanged =
    accountChanged || boundAuthMode !== authMode || boundCookie !== cookie;
  if (accessChanged) {
    accountAccessRevision += 1;
    await rebindLearningActionModules();
    if (boundAccountId && accountChanged) {
      resolutionEpoch += 1;
      connectionApprovals.reset();
      connectRuntime.reset();
      backgroundSync.stop();
      await watchRuntime.stop();
      await cancelBrowserWork();
    } else if (authMode === 'offline-local') {
      backgroundSync.stop();
      await watchRuntime.stop();
      await cancelBrowserWork();
    }
  }
  boundAccountId = accountId;
  boundAuthMode = authMode;
  boundCookie = cookie;
};

const stopBrowserWork = () => withBrowserWorkStopped(async () => undefined);

const registerQuitCleanup = () => {
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      sessionGuard.invalidate();
      try {
        try {
          await learningLifecycle.invalidate();
        } catch (error) {
          console.error('Learning cleanup failed before quit.', error);
        }
        resolutionEpoch += 1;
        connectionApprovals.reset();
        backgroundSyncAccountId = null;
        backgroundSync.stop();
        await watchRuntime.stop();
        resetPreview();
        connectRuntime.reset();
        academicTasks.cancel();
        await closeWorkspace();
        await waitForWorkspaceStops();
      } catch (error) {
        console.error('Academic shutdown cleanup failed.', error);
      } finally {
        app.quit();
      }
    })();
  });
};

export const registerAcademicActions = async (service: {
  register: (method: string, action: AcademicAction) => void;
  publish: typeof publish;
  learningModules?: readonly LearningActionModule[];
}) => {
  publish = service.publish;
  if (!watchPowerEventsRegistered) {
    powerMonitor.on('suspend', () => {
      systemSuspended = true;
      void learningLifecycle.cancelOperationsAndWait().catch(() => undefined);
      releaseSystemBackgroundSuspend ??= backgroundSync.suspend();
      if (!pendingSystemWatchSuspend && !releaseSystemWatchSuspend) {
        pendingSystemWatchSuspend = watchRuntime
          .suspend()
          .then((release) => {
            if (systemSuspended) releaseSystemWatchSuspend = release;
            else void release().catch(() => undefined);
          })
          .catch(() => undefined)
          .finally(() => {
            pendingSystemWatchSuspend = null;
          });
      }
    });
    powerMonitor.on('resume', () => {
      systemSuspended = false;
      releaseSystemBackgroundSuspend?.();
      releaseSystemBackgroundSuspend = null;
      const releaseWatch = releaseSystemWatchSuspend;
      releaseSystemWatchSuspend = null;
      if (releaseWatch) void releaseWatch().catch(() => undefined);
    });
    watchPowerEventsRegistered = true;
  }
  const registeredActions = new Map<
    string,
    (context: IpcContext, input: unknown) => unknown
  >();
  const handle = (
    method: string,
    action: (context: IpcContext, input: unknown) => unknown,
    options: { requiresUser?: boolean } = {},
  ) => {
    registeredActions.set(method, action);
    const invoke = async (input: unknown) => {
      if (options.requiresUser === false)
        return action(
          {
            userId: '',
            operationId: String(++learningRequestSequence),
            epoch: learningLifecycle.epoch,
            signal: learningLifecycle.signal,
            isCurrent: () => true,
          },
          input,
        );
      const cookie = authClient.getCookie();
      const operationId = String(++learningRequestSequence);
      const admissionRevision = cleanupAdmissionRevision;
      const authenticationAccessRevision = accountAccessRevision;
      return runSessionAction(sessionGuard, async (sessionIsCurrent) => {
        const authIsCurrent = () =>
          sessionIsCurrent() && isAccountSessionCurrent(cookie);
        const user = await getCurrentUser(isOfflineDeviceReady);
        if (
          !authIsCurrent() ||
          cleanupAdmissionRevision !== admissionRevision ||
          accountAccessRevision !== authenticationAccessRevision
        )
          throw new Error('Your session changed; sign in again.');
        if (!user) throw new Error('Please sign in to ScholarOS.');
        assertAccountAdmission(user.id);
        await bindAccount(user.id, user.authMode ?? 'online', cookie);
        if (!authIsCurrent())
          throw new Error('Your session changed; sign in again.');
        assertAccountAdmission(user.id);
        boundOnboardingComplete = user.hasCompletedOnboarding === true;
        if (
          user.authMode === 'offline-local' &&
          !offlineReadMethods.some(
            (offlineMethod) => offlineMethod === method,
          ) &&
          !internalOfflineReadMethods.some(
            (offlineMethod) => offlineMethod === method,
          )
        )
          throw new Error(
            `Reconnect to use this feature. ScholarOS is in saved offline mode because its API at ${new URL(clientEnv.VITE_API_URL).origin} could not be reached. Start that web service, then retry this action.`,
          );
        const epoch = learningLifecycle.epoch;
        const accessRevision = accountAccessRevision;
        const requestController = new AbortController();
        const signal = AbortSignal.any([
          learningLifecycle.signal,
          requestController.signal,
        ]);
        const accountIsCurrent = () =>
          authIsCurrent() &&
          !signal.aborted &&
          learningLifecycle.isCurrent(epoch) &&
          accountAccessRevision === accessRevision &&
          boundAccountId === user.id &&
          (!accountCleanupGates.has(user.id) ||
            accountCleanupGates.get(user.id)?.operationId === operationId);
        accountRequests.set(operationId, {
          userId: user.id,
          controller: requestController,
        });
        try {
          return await learningLifecycle.trackOperation(
            operationId,
            async () => {
              // Authentication may dispose and re-register a module during binding.
              const currentAction = registeredActions.get(method);
              if (!currentAction)
                throw new Error('The academic action is unavailable.');
              const result = await currentAction(
                {
                  userId: user.id,
                  operationId,
                  epoch,
                  signal,
                  isCurrent: accountIsCurrent,
                },
                input,
              );
              // Successful deletion deliberately retires this request's learning epoch.
              const current =
                method === 'deleteLocalAcademicData'
                  ? authIsCurrent() &&
                    boundAccountId === user.id &&
                    accountAccessRevision === accessRevision &&
                    learningLifecycle.epoch === epoch + 1
                  : accountIsCurrent();
              if (!current)
                throw new Error('Your session changed; sign in again.');
              return result;
            },
          );
        } finally {
          accountRequests.delete(operationId);
        }
      });
    };
    service.register(method, invoke);
  };
  const learningRegistrar: LearningActionRegistrar = {
    handle: (method, action) =>
      handle(method, (context, input) => action(context, input as never)),
    handleInternal: (method, action) =>
      handle(
        method,
        (context, input) => {
          const parsed = internalLearningInputSchemas[method].safeParse(input);
          if (!parsed.success) throw new ArtifactStoreError('invalid-input');
          return action(context, parsed.data);
        },
        // Private token-authenticated release must unwind old runs without rebinding.
        { requiresUser: method !== 'releaseActivityRun' },
      ),
    publish: (event) => publish('scholar:productEvent', event),
    lifecycle: learningLifecycle,
  };
  learningActionRegistrar = learningRegistrar;
  learningActionModules = service.learningModules ?? [];
  const localDataCleanup = createLocalDataCleanup({
    database: db,
    originalStore: createOriginalStore(),
    userDataPath: app.getPath('userData'),
    withAccountOperationsQuiesced: async (context, action) => {
      assertAccountAdmission(context.userId);
      cleanupAdmissionRevision += 1;
      let releaseGate!: () => void;
      const completion = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      accountCleanupGates.set(context.userId, {
        operationId: context.operationId,
        completion,
      });
      for (const [operationId, request] of accountRequests)
        if (
          request.userId === context.userId &&
          operationId !== context.operationId
        )
          request.controller.abort();
      let modulesDisposed = false;
      let rebound = false;
      try {
        return await learningLifecycle.withOperationsQuiesced(
          context.operationId,
          async () => {
            resolutionEpoch += 1;
            connectionApprovals.reset();
            backgroundSync.stop();
            academicTasks.cancel(context.userId);
            const stops = await Promise.allSettled([
              watchRuntime.stop(),
              cancelPreview(context.userId),
              connectRuntime.cancel(context.userId),
              closeWorkspace(),
              pendingPreviews.get(context.userId),
            ]);
            await waitForWorkspaceStops();
            if (stops.some((result) => result.status === 'rejected'))
              throw new LocalDataCleanupError('storage-failed');
            connectRuntime.reset();
          },
          async () => {
            if (context.signal.aborted || !context.isCurrent())
              throw new LocalDataCleanupError('session-changed');
            if (!learningActionsCleanup)
              throw new LocalDataCleanupError('storage-failed');
            await learningActionsCleanup();
            modulesDisposed = true;
            const result = await action();
            if (context.signal.aborted || !context.isCurrent())
              throw new LocalDataCleanupError('session-changed');
            await clearOfflineAccountGrant();
            if (context.signal.aborted || !context.isCurrent())
              throw new LocalDataCleanupError('session-changed');
            await rebindLearningActionModules(context.operationId);
            rebound = true;
            publish('scholar:coursesChange', {
              accountId: context.userId,
              courseId: null,
            });
            for (const resource of productEventResources)
              publish('scholar:productEvent', {
                version: 1,
                accountId: context.userId,
                revision: learningLifecycle.epoch,
                resource,
                targetId: null,
              });
            return result;
          },
        );
      } finally {
        try {
          if (modulesDisposed && !rebound && !learningLifecycle.signal.aborted)
            await registerLearningActionModules();
        } finally {
          accountCleanupGates.delete(context.userId);
          releaseGate();
        }
      }
    },
  });
  handle('deleteLocalAcademicData', async (context, input) => {
    await localDataCleanup.deleteLocalAcademicData(context, input);
  });
  if (!broadcastingPreview) {
    academicTasks.subscribe((accountId) => {
      try {
        publish('scholar:coursesChange', { accountId, courseId: null });
      } finally {
        observeAcademicTaskNotifications(accountId);
      }
    });
    subscribeCourseChanges((change) =>
      publish('scholar:coursesChange', change),
    );
    connectRuntime.subscribe((state) => {
      publish('scholar:connectChange', state);
    });
    broadcastingPreview = true;
    subscribePreview((state) => {
      publish('scholar:previewChange', state);
    });
  }
  handle(
    'getCurrentUser',
    () =>
      runSessionAction(sessionGuard, async (isCurrent) => {
        const cookie = authClient.getCookie();
        const user = await getCurrentUser(isOfflineDeviceReady);
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        if (user && !isAccountSessionCurrent(cookie))
          throw new Error('Your session changed; sign in again.');
        await bindAccount(
          user?.id ?? null,
          user ? (user.authMode ?? 'online') : null,
          cookie || null,
        );
        boundOnboardingComplete = user?.hasCompletedOnboarding === true;
        return user;
      }),
    { requiresUser: false },
  );
  handle(
    'signOut',
    async () => {
      boundAccountId = null;
      boundAuthMode = null;
      boundCookie = null;
      boundOnboardingComplete = false;
      markLocalSignOut();
      resolutionEpoch += 1;
      connectionApprovals.reset();
      await tearDownSession({
        invalidateSession: async () => {
          sessionGuard.invalidate();
          await rebindLearningActionModules();
        },
        stopMissions: async () => {
          backgroundSyncAccountId = null;
          backgroundSync.stop();
          await watchRuntime.stop();
          resetPreview();
          connectRuntime.reset();
          academicTasks.cancel();
        },
        // The electron client clears its stored cookie before the request.
        clearLocalSession: () =>
          authClient
            .signOut({
              fetchOptions: { signal: AbortSignal.timeout(1500) },
            })
            .catch(() => undefined)
            .then(() => undefined),
        closeBrowser: closeWorkspace,
      });
      await clearOfflineAccountGrant();
      applyLaunchAtLogin(false);
    },
    { requiresUser: false },
  );
  handle(
    'getOfflineDeviceReadiness',
    ({ userId }): OfflineDeviceReadiness => ({
      configured: isOfflineDeviceReady(userId),
    }),
  );
  // This action is service-local and absent from the transport method schema.
  handle('restoreOnlineState', ({ userId, isCurrent }) => {
    if (boundAuthMode !== 'online')
      throw new Error('Reconnect to use this feature.');
    const state = getOnboardingState(userId);
    const launchAtLogin = applyLaunchAtLogin(state.settings.launchAtLogin);
    return prepareState(state, launchAtLogin, isCurrent);
  });
  handle('getState', ({ userId, isCurrent }) => {
    if (boundAuthMode === 'offline-local')
      return getOnboardingState(userId, { readOnly: true });
    const state = getOnboardingState(userId);
    const launchAtLogin = applyLaunchAtLogin(state.settings.launchAtLogin);
    return prepareState(state, launchAtLogin, isCurrent);
  });
  handle('getWatchSettings', ({ userId }) => getWatchSettings(userId));
  handle('getWatchRuntimeState', ({ userId }) => watchRuntime.getState(userId));
  handle('saveWatchSettings', async ({ userId, isCurrent }, input) => {
    const settings = watchSettingsSchema.parse(input);
    const state = getOnboardingState(userId);
    if (settings.watchEnabled) {
      if (!boundOnboardingComplete || !state.settings.localSetupCompletedAt)
        throw new Error('Complete computer setup before enabling watching.');
      if (!state.settings.consent)
        throw new Error('Approve academic access before enabling watching.');
      if (!state.workspace?.ready)
        throw new Error('Set up a ready browser workspace before watching.');
      if (
        !state.connections.some(
          (connection) =>
            connection.isCourseResource &&
            connection.status !== 'needs-sign-in',
        )
      )
        throw new Error('Add a course resource connection to enable watching.');
    }
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const savedSettings = saveWatchSettings(userId, settings);
    await watchRuntime.configure(userId, boundOnboardingComplete, isCurrent);
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return savedSettings;
  });
  handle('saveSettings', async ({ userId, isCurrent }, input) => {
    const changes = settingsUpdateSchema.parse(input);
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const launchAtLogin =
      changes.launchAtLogin !== undefined
        ? applyLaunchAtLogin(changes.launchAtLogin)
        : undefined;
    const savedSettings = saveOnboardingSettings(userId, changes);
    if (changes.consent === false) {
      resolutionEpoch += 1;
      connectionApprovals.reset();
      await learningLifecycle.cancelOperationsAndWait();
      backgroundSync.stop();
      await watchRuntime.stop();
      await cancelBrowserWork();
    } else if (
      changes.backgroundSync === false &&
      backgroundSync.getState().status === 'syncing'
    ) {
      backgroundSync.pause();
      await academicTasks.cancelAndWait();
    }
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return prepareState(savedSettings, launchAtLogin, isCurrent);
  });
  handle('findBrowsers', () => findBrowsers());
  handle('chooseBrowser', () => chooseBrowser());
  handle('createWorkspace', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const installationId = idSchema.parse(input);
    await withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      await createWorkspace(userId, installationId, isCurrent);
    });
    return prepareState(getOnboardingState(userId), undefined, isCurrent);
  });
  handle('stageWorkspaceReplacement', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const replacementInput = workspaceReplacementInputSchema.parse(input);
    return withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      return stageWorkspaceReplacement(userId, replacementInput, isCurrent);
    });
  });
  handle('commitWorkspaceReplacement', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const replacementInput = workspaceReplacementCommitInputSchema.parse(input);
    return withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      return commitWorkspaceReplacement(userId, replacementInput, isCurrent);
    });
  });
  handle('cancelWorkspaceReplacement', ({ userId }, input) =>
    cancelWorkspaceReplacement(
      userId,
      workspaceReplacementCancelInputSchema.parse(input),
    ),
  );
  handle('resolveConnections', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const prompt = z.string().trim().min(1).max(500).parse(input);
    connectionApprovals.reset();
    const generation = ++resolutionEpoch;
    const candidates = await resolveConnectionCandidates(
      prompt,
      AbortSignal.timeout(25_000),
    );
    if (!isCurrent() || generation !== resolutionEpoch)
      throw new Error('Your connection request has changed; try again.');
    requireConsent(userId);
    return connectionApprovals.propose(userId, candidates);
  });
  handle('reviseConnectionProposal', ({ userId }, input) => {
    requireConsent(userId);
    const value = z
      .object({
        id: idSchema,
        candidates: z.unknown(),
      })
      .parse(input);
    return connectionApprovals.revise(userId, value.id, value.candidates);
  });
  handle('approveConnectionProposal', ({ userId }, input) => {
    requireConsent(userId);
    const value = z
      .object({
        id: idSchema,
        candidates: z.unknown(),
      })
      .parse(input);
    connectionApprovals.approve(userId, value.id, value.candidates);
  });
  handle('startConnectRun', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    if (connectRuntime.isBusy())
      throw new Error('A connection run is already active.');
    const proposalId = idSchema.parse(input);
    const cookie = authClient.getCookie();
    connectIsCurrent = () => {
      try {
        return (
          isCurrent() &&
          boundAccountId === userId &&
          cookie === authClient.getCookie()
        );
      } catch {
        return false;
      }
    };
    await connectRuntime.start(userId, proposalId);
  });
  handle('getConnectRun', ({ userId }) => connectRuntime.getState(userId));
  handle('resumeConnectRun', ({ userId }) => {
    requireConsent(userId);
    connectRuntime.resume(userId);
  });
  handle('cancelConnectRun', ({ userId }) => connectRuntime.cancel(userId));
  handle('openResource', ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const resource = academicResources.find(
      (item) => item.id === idSchema.parse(input),
    );
    if (!resource) throw new Error('Choose a listed resource.');
    return withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      await openAcademicPage(userId, resource.url, isCurrent);
    });
  });
  handle('captureResource', ({ userId, isCurrent }) => {
    requireConsent(userId);
    return withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      return captureResource(userId, isCurrent);
    });
  });
  // Read-only peek at the open tab so the button can name the site first. It
  // never starts the study browser, so it stays outside the browser-work lock.
  handle('previewResource', ({ userId, isCurrent }) => {
    requireConsent(userId);
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return previewResource(userId);
  });
  handle('saveConnectionNotes', ({ userId, isCurrent }, input) => {
    const data = z
      .object({ id: idSchema, notes: z.string().max(500) })
      .parse(input);
    return prepareState(
      saveConnectionNotes(userId, data.id, data.notes),
      undefined,
      isCurrent,
    );
  });
  handle('setCourseResource', ({ userId, isCurrent }, input) => {
    const data = z
      .object({ id: idSchema, isCourseResource: z.boolean() })
      .parse(input);
    return prepareState(
      setCourseResource(userId, data.id, data.isCourseResource),
      undefined,
      isCurrent,
    );
  });
  handle('confirmResource', ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    return prepareState(
      confirmResource(userId, idSchema.parse(input)),
      undefined,
      isCurrent,
    );
  });
  handle('removeResource', async ({ userId, isCurrent }, input) => {
    const connectionId = idSchema.parse(input);
    await learningLifecycle.cancelOperationsAndWait();
    const state = await withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      return removeAcademicConnection(userId, connectionId);
    });
    return prepareState(state, undefined, isCurrent);
  });
  handle('setPrimaryLms', ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    return prepareState(
      setPrimaryLms(userId, idSchema.parse(input)),
      undefined,
      isCurrent,
    );
  });
  handle('discoverContext', async ({ userId, isCurrent }) => {
    if (
      !boundOnboardingComplete ||
      !getOnboardingState(userId).settings.localSetupCompletedAt
    )
      throw new Error(
        'Course discovery is available from your dashboard after setup.',
      );
    requireConsent(userId);
    const state = await withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      return discoverAcademicContext(userId, isCurrent);
    });
    return prepareState(state, undefined, isCurrent);
  });
  const requireIdleCourse = (userId: string, courseId: string) => {
    const active = academicTasks.getRefreshState(userId);
    if (active.allCourses || active.courseIds.includes(courseId))
      throw new Error(
        'Stop refreshing this course before changing its saved records.',
      );
  };
  handle('createCourseRecord', ({ userId }, input) => {
    const data = createCourseRecordSchema.parse(input);
    requireIdleCourse(userId, data.kind === 'courses' ? '' : data.courseId);
    return createCourseRecord(userId, data);
  });
  handle('updateCourseRecord', ({ userId }, input) => {
    const data = updateCourseRecordSchema.parse(input);
    requireIdleCourse(userId, data.courseId);
    updateCourseRecord(userId, data);
  });
  handle('deleteCourseRecord', ({ userId }, input) => {
    const data = courseRecordSchema.parse(input);
    requireIdleCourse(userId, data.courseId);
    deleteCourseRecord(userId, data);
  });
  handle('getCourses', ({ userId }) => getCoursesAction(userId));
  handle('getCourse', ({ userId }, input) => getCourseAction(userId, input));
  handle('listCourseRecordSuppressions', ({ userId }, input) => {
    const parsed = listCourseRecordSuppressionsSchema.safeParse(input);
    if (!parsed.success) return null;
    return listCourseRecordSuppressions(userId, parsed.data);
  });
  handle('restoreCourseRecordSuppression', ({ userId }, input) => {
    const parsed = restoreCourseRecordSuppressionSchema.safeParse(input);
    if (!parsed.success)
      throw new Error('The hidden-record restore request is invalid.');
    return restoreCourseRecordSuppression(userId, parsed.data);
  });
  // A manual refresh takes the study browser over from a scheduled one, exactly
  // like every other foreground browser action.
  handle('refreshCourses', async (context) => {
    const { userId, isCurrent } = context;
    requireConsent(userId);
    if (
      !boundOnboardingComplete ||
      !getOnboardingState(userId).settings.localSetupCompletedAt
    )
      throw new Error('Courses are available from your dashboard after setup.');
    if (manualCourseRefresh?.userId === userId)
      return manualCourseRefresh.completion;
    const completion = withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      const refresh = startCourseRefresh(userId, isCurrent);
      const task = academicTasks
        .getActivity(userId)
        .find((task) => task.key === 'courses' && task.status === 'running');
      const refreshed = await refresh;
      notifyCourseRefreshOutcome(context, refreshed, task);
      // Re-evaluating eligibility keeps the scheduler honest after a scan.
      prepareState(refreshed.state, undefined, isCurrent);
      return {
        ...refreshed.snapshot,
        activity: academicTasks.getActivity(userId),
      };
    }).finally(() => {
      if (manualCourseRefresh?.completion === completion)
        manualCourseRefresh = null;
    });
    manualCourseRefresh = { userId, completion };
    return completion;
  });
  handle('refreshCourse', async (context, input) => {
    const { userId, isCurrent } = context;
    const courseId = idSchema.parse(input);
    requireConsent(userId);
    if (
      !boundOnboardingComplete ||
      !getOnboardingState(userId).settings.localSetupCompletedAt
    )
      throw new Error('Courses are available from your dashboard after setup.');
    const wasSyncing = backgroundSync.getState().status === 'syncing';
    const releaseBackgroundSync = backgroundSync.suspend();
    let releaseWatch: (() => Promise<void>) | null = null;
    try {
      releaseWatch = await watchRuntime.suspend();
      if (wasSyncing) {
        stoppingBackgroundSync = academicTasks.cancelAndWait().finally(() => {
          stoppingBackgroundSync = null;
        });
      }
      await stoppingBackgroundSync;
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      const refresh = refreshSingleCourse(userId, courseId, isCurrent);
      const task = academicTasks
        .getActivity(userId)
        .find((task) => task.key === courseId && task.status === 'running');
      const course = await refresh;
      notifySingleCourseOutcome(context, courseId, course, task);
      return course
        ? {
            ...course,
            activity: academicTasks
              .getActivity(userId)
              .filter((run) => run.key === 'courses' || run.key === courseId),
          }
        : null;
    } finally {
      releaseBackgroundSync();
      await releaseWatch?.();
    }
  });
  handle(
    'cancelCourseRefresh',
    (_context, input) => {
      const courseId = input === undefined ? undefined : idSchema.parse(input);
      const accountId = boundAccountId ?? undefined;
      const allCourses =
        accountId && academicTasks.getRefreshState(accountId).allCourses;
      cancelCourseRefresh(
        accountId,
        courseId && !allCourses ? courseId : undefined,
      );
    },
    { requiresUser: false },
  );
  handle('pauseBackgroundSync', async ({ userId, isCurrent }) => {
    const wasSyncing = backgroundSync.getState().status === 'syncing';
    backgroundSync.pause();
    if (wasSyncing) await academicTasks.cancelAndWait();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return prepareState(getOnboardingState(userId), undefined, isCurrent);
  });
  handle('resumeBackgroundSync', ({ userId, isCurrent }) => {
    backgroundSync.resume();
    return prepareState(getOnboardingState(userId), undefined, isCurrent);
  });
  handle('startPreview', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const prompt = previewPromptSchema.parse(input);
    if (pendingPreviews.has(userId))
      throw new Error('A preview is already running.');
    const releaseBackgroundSync = backgroundSync.suspend();
    let releaseWatch: (() => Promise<void>) | null = null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseBackgroundSync();
      void releaseWatch?.().catch(() => undefined);
    };
    let settlePreview!: () => void;
    const completion = new Promise<void>((resolve) => {
      settlePreview = resolve;
    });
    pendingPreviews.set(userId, completion);
    const finishPreview = () => {
      release();
      if (pendingPreviews.get(userId) === completion)
        pendingPreviews.delete(userId);
      settlePreview();
    };
    try {
      releaseWatch = await watchRuntime.suspend();
      await cancelBrowserWork();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      // Starting acknowledges immediately; cleanup releases the browser later.
      await startPreview(userId, prompt, finishPreview);
    } catch (cause) {
      finishPreview();
      await releaseWatch?.().catch(() => undefined);
      throw cause;
    }
  });
  handle(
    'getPreview',
    (_context, input) => {
      const accountId = idSchema.parse(input);
      if (!boundAccountId || accountId !== boundAccountId)
        throw new Error('Your session changed; sign in again.');
      assertAccountAdmission(boundAccountId);
      return getPreview(boundAccountId);
    },
    {
      requiresUser: false,
    },
  );
  handle(
    'cancelPreview',
    (_context, input) => cancelPreview(idSchema.optional().parse(input)),
    { requiresUser: false },
  );
  handle('openSource', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const url = idSchema.parse(input);
    if (!isAcademicUrl(url)) throw new Error('Invalid source.');
    const host = new URL(url).hostname;
    const existingConnection = db
      .select()
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.host, host),
        ),
      )
      .get();
    if (!existingConnection) throw new Error('Connect this resource first.');
    if (!isReadNavigation(url, [host]))
      throw new Error('This source is not a permitted read-only page.');
    return withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      await openAcademicPage(userId, url, isCurrent);
    });
  });
  handle('completeOnboarding', ({ userId, isCurrent }) =>
    completeOnboarding(userId, {
      getState: getOnboardingState,
      cancelPreview: stopBrowserWork,
      markLocalComplete: (id) => {
        db.update(SettingTable)
          .set({
            step: 'review',
            localSetupCompletedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(SettingTable.userId, id))
          .run();
      },
      updateCloud: () => accountRequest('/api/onboarding', {}),
      isCurrent,
    }),
  );
  registerQuitCleanup();
  await registerLearningActionModules();
};
