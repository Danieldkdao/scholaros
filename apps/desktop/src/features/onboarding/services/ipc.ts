import {
  courseRecordSchema,
  updateCourseRecordSchema,
  createCourseRecordSchema,
} from '../../courses/schemas';
import { academicTasks } from './academic-tasks';
import { createConnectRuntime } from './connect-runtime';
import { createConnectWorkspace } from './connect-workspace';
import { acquireConnectOwnership } from './connect-ownership';
import { protectMissionPage } from './mission-request-guard';
import { createConnectionApprovalStore } from './connection-approval';
import { resolveConnectionCandidates } from './connection-resolver';
import { app } from 'electron';
import type {
  AcademicAction,
  AcademicEventChannel,
} from '../../../services/academic/contracts';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { authClient } from '../../../lib/auth/client';
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
import { AcademicConnectionTable, SettingTable } from '../../../db/schema';
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
import {
  updateCourseRecord,
  createCourseRecord,
  deleteCourseRecord,
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
import type { CoursesSnapshot } from '../../courses/types';
import type { LaunchAtLoginPreference, OnboardingState } from '../types';

const idSchema = z.string().min(1).max(300);
const sessionGuard = createSessionGuard();
const connectionApprovals = createConnectionApprovalStore();
let resolutionEpoch = 0;
let stoppingBackgroundSync: Promise<void> | null = null;
let broadcastingPreview = false;
let manualCourseRefresh: {
  userId: string;
  completion: Promise<CoursesSnapshot>;
} | null = null;
let boundAccountId: string | null = null;
let boundOnboardingComplete = false;

type IpcContext = { userId: string; isCurrent: () => boolean };

let backgroundSyncAccountId: string | null = null;
let publish: (channel: AcademicEventChannel, value: unknown) => void = () =>
  undefined;
// Scheduled work runs the same pipeline as the manual button, so one set of
// protections, bounds and persistence rules covers both.
const backgroundSync = createBackgroundSyncController<CourseRefreshResult>({
  runDiscovery: async (userId, isCurrent, signal) => {
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const user = await getCurrentUser();
    if (!isCurrent() || user?.id !== userId)
      throw new Error('Please sign in again to resume background sync.');
    return startCourseRefresh(userId, isCurrent, signal);
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
  const settled = settleLocalSetup(state, {
    accountCompleted: boundOnboardingComplete,
  });
  backgroundSyncAccountId = settled.accountId;
  backgroundSync.configure({
    userId: settled.accountId,
    enabled:
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
  const release = backgroundSync.suspend();
  try {
    await cancelBrowserWork();
    return await action();
  } finally {
    release();
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
    const release = backgroundSync.suspend();
    try {
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

const bindAccount = (accountId: string | null) => {
  if (boundAccountId && boundAccountId !== accountId) {
    resolutionEpoch += 1;
    connectionApprovals.reset();
    connectRuntime.reset();
    academicTasks.cancel();
  }
  boundAccountId = accountId;
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
      resolutionEpoch += 1;
      connectionApprovals.reset();
      backgroundSyncAccountId = null;
      backgroundSync.stop();
      resetPreview();
      connectRuntime.reset();
      academicTasks.cancel();
      await closeWorkspace();
      await waitForWorkspaceStops();
      app.quit();
    })();
  });
};

export const registerAcademicActions = (service: {
  register: (method: string, action: AcademicAction) => void;
  publish: typeof publish;
}) => {
  publish = service.publish;
  const handle = (
    method: string,
    action: (context: IpcContext, input: unknown) => unknown,
    options: { requiresUser?: boolean } = {},
  ) => {
    const invoke = async (input: unknown) => {
      if (options.requiresUser === false)
        return action({ userId: '', isCurrent: () => true }, input);
      const cookie = authClient.getCookie();
      return runSessionAction(sessionGuard, async (sessionIsCurrent) => {
        const isCurrent = () =>
          sessionIsCurrent() && isAccountSessionCurrent(cookie);
        const user = await getCurrentUser();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        if (!user) throw new Error('Please sign in to ScholarOS.');
        bindAccount(user.id);
        boundOnboardingComplete = user.hasCompletedOnboarding === true;
        const accountIsCurrent = () =>
          isCurrent() && boundAccountId === user.id;
        const result = await action(
          { userId: user.id, isCurrent: accountIsCurrent },
          input,
        );
        if (!accountIsCurrent())
          throw new Error('Your session changed; sign in again.');
        return result;
      });
    };
    service.register(method, invoke);
  };
  if (!broadcastingPreview) {
    academicTasks.subscribe((accountId) =>
      publish('scholar:coursesChange', { accountId, courseId: null }),
    );
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
        const user = await getCurrentUser();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        bindAccount(user?.id ?? null);
        boundOnboardingComplete = user?.hasCompletedOnboarding === true;
        return user;
      }),
    { requiresUser: false },
  );
  handle(
    'signOut',
    async () => {
      boundAccountId = null;
      boundOnboardingComplete = false;
      markLocalSignOut();
      resolutionEpoch += 1;
      connectionApprovals.reset();
      await tearDownSession({
        invalidateSession: sessionGuard.invalidate,
        stopMissions: () => {
          backgroundSyncAccountId = null;
          backgroundSync.stop();
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
      applyLaunchAtLogin(false);
    },
    { requiresUser: false },
  );
  handle('getState', ({ userId, isCurrent }) => {
    const state = getOnboardingState(userId);
    const launchAtLogin = applyLaunchAtLogin(state.settings.launchAtLogin);
    return prepareState(state, launchAtLogin, isCurrent);
  });
  handle('saveSettings', async ({ userId, isCurrent }, input) => {
    const changes = settingsUpdateSchema.parse(input);
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const launchAtLogin =
      changes.launchAtLogin !== undefined
        ? applyLaunchAtLogin(changes.launchAtLogin)
        : undefined;
    if (changes.consent === false) {
      resolutionEpoch += 1;
      connectionApprovals.reset();
      backgroundSync.stop();
      await cancelBrowserWork();
    } else if (
      changes.backgroundSync === false &&
      backgroundSync.getState().status === 'syncing'
    ) {
      backgroundSync.pause();
      await academicTasks.cancelAndWait();
    }
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return prepareState(
      saveOnboardingSettings(userId, changes),
      launchAtLogin,
      isCurrent,
    );
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
  // A manual refresh takes the study browser over from a scheduled one, exactly
  // like every other foreground browser action.
  handle('refreshCourses', async ({ userId, isCurrent }) => {
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
      const refreshed = await startCourseRefresh(userId, isCurrent);
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
  handle('refreshCourse', async ({ userId, isCurrent }, input) => {
    const courseId = idSchema.parse(input);
    requireConsent(userId);
    if (
      !boundOnboardingComplete ||
      !getOnboardingState(userId).settings.localSetupCompletedAt
    )
      throw new Error('Courses are available from your dashboard after setup.');
    const wasSyncing = backgroundSync.getState().status === 'syncing';
    const release = backgroundSync.suspend();
    if (wasSyncing) {
      stoppingBackgroundSync = academicTasks.cancelAndWait().finally(() => {
        stoppingBackgroundSync = null;
      });
    }
    try {
      await stoppingBackgroundSync;
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      const course = await refreshSingleCourse(userId, courseId, isCurrent);
      return course
        ? {
            ...course,
            activity: academicTasks
              .getActivity(userId)
              .filter((run) => run.key === 'courses' || run.key === courseId),
          }
        : null;
    } finally {
      release();
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
    const release = backgroundSync.suspend();
    try {
      await cancelBrowserWork();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      // Starting acknowledges immediately; cleanup releases the browser later.
      await startPreview(userId, prompt, release);
    } catch (cause) {
      release();
      throw cause;
    }
  });
  handle(
    'getPreview',
    (_context, input) => {
      const accountId = idSchema.parse(input);
      if (!boundAccountId || accountId !== boundAccountId)
        throw new Error('Your session changed; sign in again.');
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
};
