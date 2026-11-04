import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { academicTasks } from '../src/features/onboarding/services/academic-tasks';
import {
  createLearningLifecycle,
  registerLearningActions,
  type LearningActionModule,
} from '../src/services/academic/learning-actions';
import {
  internalOfflineReadMethods,
  rendererAcademicMethods,
} from '../src/services/academic/contracts';
import type { OnboardingState } from '../src/features/onboarding/types';
const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, input?: unknown) => Promise<unknown>
  >(),
  appListeners: new Map<
    string,
    (event: { preventDefault: () => void }) => void
  >(),
  powerListeners: new Map<string, () => void>(),
  appQuit: vi.fn(),
  clearOfflineGrant: vi.fn(async () => undefined),
  clientSignOut: vi.fn(async () => undefined),
  getCurrentUser: vi.fn(),
  getOnboardingState: vi.fn(
    (_userId: string, _options?: { readOnly?: boolean }) => mocks.state,
  ),
  authFetch: vi.fn(),
  readGrant: vi.fn(),
  saveGrant: vi.fn(),
  getCookie: vi.fn(() => 'initial-cookie'),
  capturePage: vi.fn(async (_id, _page, check) => {
    if (!check()) throw new Error('Session changed');
  }),
  startPreview: vi.fn(),
  getPreview: vi.fn(),
  discoverAcademicContext: vi.fn(),
  startCourseRefresh: vi.fn(),
  refreshSingleCourse: vi.fn(),
  startConnectionRefresh: vi.fn(),
  getCoursesSnapshot: vi.fn(() => ({
    courses: [],
    sources: [],
    lastSuccessfulAt: null,
  })),
  listSuppressions: vi.fn(() => []),
  restoreSuppression: vi.fn(),
  getCourseDetail: vi.fn(() => null),
  subscribeCourseChanges: vi.fn(() => () => undefined),
  resolveConnections: vi.fn(),
  connectWorkspace: vi.fn(),
  workspace: vi.fn(),
  stageReplacement: vi.fn(),
  commitReplacement: vi.fn(),
  cancelReplacement: vi.fn(),
  invalidate: vi.fn(),
  watchRuntime: {
    configure: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    suspend: vi.fn(async () => vi.fn(async () => undefined)),
    stop: vi.fn(async () => undefined),
    getState: vi.fn(() => ({ enabled: false, status: 'off' })),
  },
  backgroundSyncConfigure: vi.fn(),
  applyLaunchAtLogin: vi.fn(),
  settleLocalSetup: vi.fn(),
  watchSettings: { watchEnabled: false, watchUrls: [] as string[] },
  getWatchSettings: vi.fn(() => mocks.watchSettings),
  saveWatchSettings: vi.fn((_userId, settings) => {
    mocks.watchSettings = settings;
    return settings;
  }),
  saveOnboardingSettings: vi.fn((_userId, changes) => {
    mocks.state = {
      ...mocks.state,
      settings: { ...mocks.state.settings, ...changes },
    };
    return mocks.state;
  }),
  offlineSettings: null as { localSetupCompletedAt: string | null } | null,
  offlineWorkspace: null as { verifiedAt: string } | null,
  offlineReadIndex: 0,
  databaseWrite: vi.fn(),
  state: { settings: { consent: true, localSetupCompletedAt: null } },
}));
vi.mock('electron', () => ({
  net: { fetch: mocks.authFetch },
  app: {
    on: (
      name: string,
      listener: (event: { preventDefault: () => void }) => void,
    ) => mocks.appListeners.set(name, listener),
    quit: mocks.appQuit,
  },
  powerMonitor: {
    on: (name: string, listener: () => void) =>
      mocks.powerListeners.set(name, listener),
  },
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => [] },
  ipcMain: {
    handle: (
      channel: string,
      callback: (event: unknown, input: unknown) => Promise<unknown>,
    ) => mocks.handlers.set(channel, callback),
  },
}));
vi.mock('../src/lib/auth/client', () => ({
  authClient: {
    signOut: mocks.clientSignOut,
    getCookie: mocks.getCookie,
  },
}));
vi.mock('../src/lib/auth/main', () => ({
  getCurrentUser: mocks.getCurrentUser,
  accountRequest: vi.fn(),
  markLocalSignOut: vi.fn(),
  isAccountSessionCurrent: (cookie: string) => cookie === mocks.getCookie(),
}));
vi.mock('../src/data/env/client', () => ({
  clientEnv: { VITE_API_URL: 'http://localhost:3000' },
}));
vi.mock('../src/lib/offline-account', () => ({
  clearOfflineAccountGrant: mocks.clearOfflineGrant,
  readOfflineAccountGrant: mocks.readGrant,
  saveOfflineAccountGrant: mocks.saveGrant,
}));
vi.mock('../src/db', () => ({
  db: {
    select: () => {
      const index = mocks.offlineReadIndex++;
      return {
        from: () => ({
          where: () => ({
            get: () =>
              index === 0 ? mocks.offlineSettings : mocks.offlineWorkspace,
          }),
        }),
      };
    },
    insert: mocks.databaseWrite,
    update: mocks.databaseWrite,
  },
}));
vi.mock('../src/features/onboarding/services/store', () => ({
  getOnboardingState: mocks.getOnboardingState,
  removeAcademicConnection: vi.fn(() => mocks.state),
  saveOnboardingSettings: mocks.saveOnboardingSettings,
  settleLocalSetup: (
    state: typeof mocks.state,
    options: { accountCompleted: boolean },
  ) => {
    mocks.settleLocalSetup(state, options);
    if (
      !options.accountCompleted ||
      state.settings.localSetupCompletedAt ||
      !state.settings.consent ||
      state.workspace?.ready !== true
    )
      return state;
    mocks.state = {
      ...state,
      settings: {
        ...state.settings,
        localSetupCompletedAt: '2026-10-28T12:00:00.000Z',
      },
    };
    return mocks.state;
  },
}));
vi.mock('../src/features/courses/services/refresh', () => ({
  startCourseRefresh: mocks.startCourseRefresh,
  refreshSingleCourse: mocks.refreshSingleCourse,
  startConnectionRefresh: mocks.startConnectionRefresh,
  cancelCourseRefresh: vi.fn(),
}));
vi.mock('../src/features/courses/services/store', () => ({
  getCoursesSnapshot: mocks.getCoursesSnapshot,
  getCourseDetail: mocks.getCourseDetail,
  listCourseRecordSuppressions: mocks.listSuppressions,
  restoreCourseRecordSuppression: mocks.restoreSuppression,
  subscribeCourseChanges: mocks.subscribeCourseChanges,
}));
vi.mock('../src/features/onboarding/services/browser-discovery', () => ({
  chooseBrowser: vi.fn(),
  findBrowsers: vi.fn(),
}));
vi.mock('../src/features/onboarding/services/browser-workspace', () => ({
  closeWorkspace: vi.fn(async () => undefined),
  stageWorkspaceReplacement: mocks.stageReplacement,
  commitWorkspaceReplacement: mocks.commitReplacement,
  cancelWorkspaceReplacement: mocks.cancelReplacement,
  createWorkspace: vi.fn(),
  openAcademicPage: vi.fn(),
  waitForWorkspaceStops: vi.fn(),
  getWorkspace: mocks.workspace,
}));
vi.mock('../src/features/onboarding/services/connections', () => ({
  captureResource: vi.fn(),
  captureResourcePage: mocks.capturePage,
  confirmResource: vi.fn(),
  previewResource: vi.fn(async () => null),
  setPrimaryLms: vi.fn(),
}));
vi.mock('../src/features/onboarding/services/preview', () => ({
  cancelPreview: vi.fn(async () => undefined),
  resetPreview: vi.fn(),
  subscribePreview: vi.fn(),
  startPreview: mocks.startPreview,
  getPreview: mocks.getPreview,
}));
vi.mock('../src/features/onboarding/services/preferences', () => ({
  applyLaunchAtLogin: mocks.applyLaunchAtLogin,
  getLaunchAtLoginState: vi.fn(),
}));
vi.mock(
  '../src/features/onboarding/services/background-sync',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../src/features/onboarding/services/background-sync')
      >();
    return {
      ...actual,
      createBackgroundSyncController: (
        options: Parameters<typeof actual.createBackgroundSyncController>[0],
      ) => {
        const controller = actual.createBackgroundSyncController(options);
        return {
          ...controller,
          configure: (
            configuration: Parameters<typeof controller.configure>[0],
          ) => {
            mocks.backgroundSyncConfigure(configuration);
            return controller.configure(configuration);
          },
        };
      },
    };
  },
);
vi.mock('../src/features/onboarding/services/connect-workspace', () => ({
  createConnectWorkspace: mocks.connectWorkspace,
}));
vi.mock('../src/features/onboarding/services/connection-resolver', () => ({
  resolveConnectionCandidates: mocks.resolveConnections,
}));
vi.mock('../src/features/onboarding/services/discovery', () => ({
  discoverAcademicContext: mocks.discoverAcademicContext,
}));
vi.mock('../src/features/watch/services/runtime', () => ({
  createWatchRuntime: () => mocks.watchRuntime,
}));
vi.mock('../src/features/watch/services/store', () => ({
  getWatchSettings: mocks.getWatchSettings,
  saveWatchSettings: mocks.saveWatchSettings,
}));
const { registerAcademicActions } =
  await import('../src/features/onboarding/services/ipc');
const frame = {};
const event = { sender: { mainFrame: frame }, senderFrame: frame };
const invoke = (method: string, input?: unknown) =>
  mocks.handlers.get(`scholar:${method}`)!(event, input);

const readyState = () =>
  ({
    accountId: 'student-a',
    settings: {
      step: 'review',
      consent: true,
      launchAtLogin: false,
      backgroundSync: true,
      notes: '',
      localSetupCompletedAt: null,
    },
    workspace: {
      browser: 'chrome',
      browserName: 'Google Chrome',
      ready: true,
      status: 'ready',
      verifiedAt: null,
    },
    connections: [
      {
        id: 'connection-a',
        name: 'Canvas',
        url: 'https://canvas.school.edu/courses',
        host: 'canvas.school.edu',
        kind: 'canvas',
        status: 'confirmed',
        verifiedAt: null,
        isCourseResource: true,
      },
    ],
    primaryLms: null,
    discovery: {
      status: 'pending',
      message: null,
      discoveredAt: null,
      coverage: {},
      entries: [],
    },
    preferences: {
      launchAtLogin: { requested: false, applied: true, message: null },
      backgroundSync: { status: 'off', message: null, lastSyncedAt: null },
    },
  }) as unknown as typeof mocks.state;

const refreshed = () => ({
  state: mocks.state as unknown as OnboardingState,
  snapshot: { courses: [], sources: [], lastSuccessfulAt: null },
});

const registerTestAcademicActions = async (
  learningModules: readonly LearningActionModule[] = [],
) =>
  registerAcademicActions({
    register: (method, action) =>
      mocks.handlers.set(`scholar:${method}`, async (_event, input) =>
        action(input),
      ),
    publish: () => undefined,
    learningModules,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getCookie.mockReturnValue('initial-cookie');
  mocks.watchSettings = { watchEnabled: false, watchUrls: [] };
  mocks.state = { settings: { consent: true, localSetupCompletedAt: null } };
  mocks.offlineSettings = {
    localSetupCompletedAt: '2026-11-01T12:00:00.000Z',
  };
  mocks.offlineWorkspace = { verifiedAt: '2026-11-01T12:00:00.000Z' };
  mocks.offlineReadIndex = 0;
  mocks.databaseWrite.mockClear();
  if (!mocks.handlers.size) await registerTestAcademicActions();
  await invoke('signOut');
});

describe('academic service session boundaries', () => {
  it('does not restore state when the service reauthenticates offline', async () => {
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      authMode: 'offline-local',
    });
    await expect(invoke('restoreOnlineState')).rejects.toThrow('Reconnect');
    expect(mocks.watchRuntime.configure).not.toHaveBeenCalled();
    expect(mocks.databaseWrite).not.toHaveBeenCalled();
  });
  it('runs real offline authentication through service-local readiness', async () => {
    const actual = await vi.importActual<typeof import('../src/lib/auth/main')>(
      '../src/lib/auth/main',
    );
    actual.invalidateAccountCache();
    mocks.getCurrentUser.mockImplementation(actual.getCurrentUser);
    mocks.authFetch.mockRejectedValueOnce(new Error('offline'));
    mocks.readGrant.mockResolvedValueOnce({
      id: 'student-a',
      name: 'Student',
      email: 's@example.edu',
      image: null,
      hasCompletedOnboarding: true,
      authMode: 'offline-local',
    });
    await expect(invoke('getCurrentUser')).resolves.toMatchObject({
      id: 'student-a',
      authMode: 'offline-local',
    });
    expect(mocks.offlineReadIndex).toBe(2);
    expect(mocks.databaseWrite).not.toHaveBeenCalled();
  });
  it('supplies the service-local readiness check during authentication', async () => {
    mocks.getCurrentUser.mockImplementation(async (readiness) => {
      expect(typeof readiness).toBe('function');
      expect(await readiness('student-a')).toBe(true);
      return { id: 'student-a', authMode: 'offline-local' };
    });
    await expect(invoke('getCurrentUser')).resolves.toMatchObject({
      id: 'student-a',
    });
    expect(mocks.databaseWrite).not.toHaveBeenCalled();
  });
  it('checks configured-device readiness without writes for an offline account', async () => {
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      authMode: 'offline-local',
    });

    await expect(invoke('getOfflineDeviceReadiness')).resolves.toEqual({
      configured: true,
    });

    expect(mocks.offlineReadIndex).toBe(2);
    expect(mocks.databaseWrite).not.toHaveBeenCalled();
    expect(mocks.saveOnboardingSettings).not.toHaveBeenCalled();
    expect(mocks.watchRuntime.configure).not.toHaveBeenCalled();
  });

  it('denies offline access when local setup was never completed', async () => {
    mocks.offlineSettings = { localSetupCompletedAt: null };
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      authMode: 'offline-local',
    });

    await expect(invoke('getOfflineDeviceReadiness')).resolves.toEqual({
      configured: false,
    });

    expect(mocks.offlineReadIndex).toBe(2);
    expect(mocks.databaseWrite).not.toHaveBeenCalled();
  });

  it('never starts an old-account preview when authentication resolves after sign-out', async () => {
    let release!: (value: unknown) => void;
    mocks.getCurrentUser.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = invoke('startPreview', 'courses');
    await invoke('signOut');
    release({ id: 'student-a' });
    await expect(pending).rejects.toThrow('Your session changed');
    expect(mocks.startPreview).not.toHaveBeenCalled();
  });
  it('does not expose preview data without a locally bound account', async () => {
    await expect(invoke('getPreview', 'student-a')).rejects.toThrow();
    expect(mocks.getPreview).not.toHaveBeenCalled();
  });
  it('does not let the renderer choose another account for local progress', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
    await invoke('getCurrentUser');
    await expect(invoke('getPreview', 'student-b')).rejects.toThrow();
    expect(mocks.getPreview).not.toHaveBeenCalled();
  });
  it('reads local progress for the bound account without another cloud lookup', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
    await invoke('getCurrentUser');
    mocks.getCurrentUser.mockClear();
    mocks.getPreview.mockReturnValue({
      accountId: 'student-a',
      status: 'idle',
    });
    await expect(invoke('getPreview', 'student-a')).resolves.toMatchObject({
      accountId: 'student-a',
    });
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });
  it('scopes hidden-record reads and restores to the current account', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
    mocks.listSuppressions.mockReturnValue([]);
    await expect(
      invoke('listCourseRecordSuppressions', { courseId: 'course-a' }),
    ).resolves.toEqual([]);
    expect(mocks.listSuppressions).toHaveBeenCalledWith('student-a', {
      courseId: 'course-a',
    });
    await expect(
      invoke('listCourseRecordSuppressions', { userId: 'other' }),
    ).resolves.toBeNull();
    expect(mocks.listSuppressions).toHaveBeenCalledOnce();

    const restoreInput = { scope: 'group', suppressionId: 'suppression-a' };
    await invoke('restoreCourseRecordSuppression', restoreInput);
    expect(mocks.restoreSuppression).toHaveBeenCalledWith(
      'student-a',
      restoreInput,
    );
  });

  it('keeps hidden-record listing read-only while offline', async () => {
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      authMode: 'offline-local',
    });
    await expect(
      invoke('listCourseRecordSuppressions', { courseId: 'course-a' }),
    ).resolves.toEqual([]);
    await expect(
      invoke('restoreCourseRecordSuppression', {
        scope: 'group',
        suppressionId: 'suppression-a',
      }),
    ).rejects.toThrow('Reconnect');
    expect(mocks.restoreSuppression).not.toHaveBeenCalled();
  });

  it('allows cached local reads but blocks background work for an offline grant', async () => {
    mocks.state = readyState();
    (
      mocks.state.settings as { localSetupCompletedAt: string | null }
    ).localSetupCompletedAt = '2026-11-01T12:00:00.000Z';
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      hasCompletedOnboarding: true,
      authMode: 'offline-local',
    });
    mocks.startCourseRefresh.mockResolvedValue(refreshed());
    mocks.startCourseRefresh.mockClear();
    await invoke('getCurrentUser');

    await expect(invoke('getCourses')).resolves.toMatchObject({ courses: [] });
    await expect(invoke('refreshCourses')).rejects.toThrow('Reconnect');
    expect(mocks.startCourseRefresh).not.toHaveBeenCalled();
  });

  it('keeps offline state reads from applying device or runtime settings', async () => {
    mocks.state = readyState();
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      hasCompletedOnboarding: true,
      authMode: 'offline-local',
    });
    await invoke('getCurrentUser');

    mocks.applyLaunchAtLogin.mockClear();
    mocks.backgroundSyncConfigure.mockClear();
    mocks.settleLocalSetup.mockClear();
    mocks.watchRuntime.configure.mockClear();
    mocks.workspace.mockClear();

    const state = await invoke('getState');

    expect(mocks.getOnboardingState).toHaveBeenLastCalledWith('student-a', {
      readOnly: true,
    });
    expect(mocks.applyLaunchAtLogin).not.toHaveBeenCalled();
    expect(mocks.backgroundSyncConfigure).not.toHaveBeenCalled();
    expect(mocks.settleLocalSetup).not.toHaveBeenCalled();
    expect(mocks.watchRuntime.configure).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(state).toBe(mocks.state);
    expect(mocks.state.settings.localSetupCompletedAt).toBeNull();
  });

  it('allows only internal activity-run authorization from the activity store offline', async () => {
    const authorize = vi.fn(
      async (context: { userId: string }, input: unknown) => ({
        accountId: context.userId,
        input,
      }),
    );
    const checkpoint = vi.fn(async () => undefined);
    const verifyGrade = vi.fn(async () => undefined);
    const inferTurn = vi.fn(async () => undefined);
    const openBrowser = vi.fn(async () => undefined);
    const module: LearningActionModule = (registrar) => {
      const registerInternal = registrar.handle as unknown as (
        method: string,
        action: (context: { userId: string }, input: unknown) => unknown,
      ) => void;
      registerInternal('authorizeActivityRun', authorize);
      registerInternal('checkpointArtifactState', checkpoint);
      registerInternal('verifyCoursework', verifyGrade);
      registerInternal('sendStudyTurn', inferTurn);
      registerInternal('openSource', openBrowser);
    };
    expect(internalOfflineReadMethods).toContain('authorizeActivityRun');
    expect(rendererAcademicMethods).not.toContain('authorizeActivityRun');
    await registerTestAcademicActions([module]);
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      authMode: 'offline-local',
    });
    await invoke('getCurrentUser');

    const input = {
      sessionId: 'session-a',
      artifactId: 'artifact-a',
      versionId: 'version-a',
      attemptId: 'attempt-a',
    };
    await expect(invoke('authorizeActivityRun', input)).resolves.toEqual({
      accountId: 'student-a',
      input,
    });
    await expect(invoke('checkpointArtifactState', input)).rejects.toThrow(
      'Reconnect',
    );
    await expect(invoke('verifyCoursework', input)).rejects.toThrow(
      'Reconnect',
    );
    await expect(invoke('sendStudyTurn', input)).rejects.toThrow('Reconnect');
    await expect(invoke('openSource', input)).rejects.toThrow('Reconnect');

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'student-a' }),
      input,
    );
    expect(checkpoint).not.toHaveBeenCalled();
    expect(verifyGrade).not.toHaveBeenCalled();
    expect(inferTurn).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

it('does not expose the removed onboarding course-map scan before setup is complete', async () => {
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  await expect(invoke('discoverContext')).rejects.toThrow('after setup');
  expect(mocks.discoverAcademicContext).not.toHaveBeenCalled();
});

describe('course page watching IPC', () => {
  beforeEach(async () => {
    mocks.state = readyState();
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      hasCompletedOnboarding: true,
    });
    await invoke('getCurrentUser');
  });

  it('keeps watching disabled until local setup, consent, and a ready workspace exist', async () => {
    await expect(
      invoke('saveWatchSettings', { watchEnabled: true, watchUrls: [] }),
    ).rejects.toThrow('computer setup');
    expect(mocks.saveWatchSettings).not.toHaveBeenCalled();

    mocks.state.settings.localSetupCompletedAt = '2026-11-01T12:00:00.000Z';
    mocks.state.settings.consent = false;
    await expect(
      invoke('saveWatchSettings', { watchEnabled: true, watchUrls: [] }),
    ).rejects.toThrow('academic access');
    expect(mocks.saveWatchSettings).not.toHaveBeenCalled();
  });

  it('saves account-scoped settings and reconfigures the watcher', async () => {
    mocks.state.settings.localSetupCompletedAt = '2026-11-01T12:00:00.000Z';
    await expect(
      invoke('saveWatchSettings', { watchEnabled: true, watchUrls: [] }),
    ).resolves.toEqual({ watchEnabled: true, watchUrls: [] });
    expect(mocks.saveWatchSettings).toHaveBeenCalledWith('student-a', {
      watchEnabled: true,
      watchUrls: [],
    });
    expect(mocks.watchRuntime.configure).toHaveBeenCalled();
  });
});

describe('device setup for an account that already finished onboarding', () => {
  it('unlocks discovery once this computer is ready', async () => {
    mocks.state = readyState();
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      hasCompletedOnboarding: true,
    });
    mocks.discoverAcademicContext.mockImplementation(async () => mocks.state);
    await invoke('getCurrentUser');
    await expect(invoke('discoverContext')).rejects.toThrow('after setup');

    await invoke('createWorkspace', 'chrome');

    expect(mocks.state.settings.localSetupCompletedAt).not.toBeNull();
    await expect(invoke('discoverContext')).resolves.toBeDefined();
    expect(mocks.discoverAcademicContext).toHaveBeenCalledOnce();
  });

  it('keeps discovery locked for an account still onboarding', async () => {
    mocks.state = readyState();
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      hasCompletedOnboarding: false,
    });
    await invoke('getCurrentUser');

    await invoke('createWorkspace', 'chrome');

    expect(mocks.state.settings.localSetupCompletedAt).toBeNull();
    await expect(invoke('discoverContext')).rejects.toThrow('after setup');
    expect(mocks.discoverAcademicContext).not.toHaveBeenCalled();
  });
});

describe('foreground browser work and background sync', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    mocks.state = readyState();
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      hasCompletedOnboarding: true,
    });
    mocks.discoverAcademicContext.mockImplementation(async () => mocks.state);
    mocks.startCourseRefresh.mockImplementation(async () => refreshed());
    await invoke('getState');
  });

  afterEach(() => vi.useRealTimers());

  it.each(['createWorkspace', 'removeResource'])(
    'returns the released sync status after %s',
    async (method) => {
      const state = await invoke(method, 'chrome');
      expect(state).toMatchObject({
        preferences: { backgroundSync: { status: 'waiting' } },
      });
    },
  );

  it('suspends scheduled work throughout a manual refresh', async () => {
    let finish!: (state: unknown) => void;
    mocks.discoverAcademicContext.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refreshing = invoke('discoverContext');
    await vi.waitFor(() =>
      expect(mocks.discoverAcademicContext).toHaveBeenCalledOnce(),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startCourseRefresh).not.toHaveBeenCalled();
    finish(mocks.state);
    await expect(refreshing).resolves.toMatchObject({
      preferences: { backgroundSync: { status: 'waiting' } },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startCourseRefresh).toHaveBeenCalledOnce();
  });

  it('keeps sync suspended until the preview task settles', async () => {
    await invoke('startPreview', 'courses');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startCourseRefresh).not.toHaveBeenCalled();
    const onSettled = mocks.startPreview.mock.calls.at(-1)?.[2];
    expect(onSettled).toBeTypeOf('function');
    onSettled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startCourseRefresh).toHaveBeenCalledOnce();
  });

  it('pauses and resumes the watcher around a manual course refresh', async () => {
    const releaseWatch = vi.fn(async () => undefined);
    mocks.watchRuntime.suspend.mockResolvedValueOnce(releaseWatch);
    mocks.refreshSingleCourse.mockResolvedValue(null);
    await invoke('refreshCourse', 'course-a');
    expect(mocks.watchRuntime.suspend).toHaveBeenCalledOnce();
    expect(mocks.refreshSingleCourse).toHaveBeenCalledOnce();
    expect(releaseWatch).toHaveBeenCalledOnce();
  });

  it('leaves scheduled work off until a connection is a course resource', async () => {
    mocks.state.connections[0].isCourseResource = false;
    await expect(invoke('getState')).resolves.toMatchObject({
      preferences: { backgroundSync: { status: 'off' } },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startCourseRefresh).not.toHaveBeenCalled();
  });

  it('leaves scheduled work off when the marked resource needs sign-in', async () => {
    mocks.state.connections[0].status = 'needs-sign-in';
    await expect(invoke('getState')).resolves.toMatchObject({
      preferences: { backgroundSync: { status: 'off' } },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startCourseRefresh).not.toHaveBeenCalled();
  });

  it('runs one pipeline for both the schedule and the manual button', async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.startCourseRefresh).toHaveBeenCalledOnce();
    expect(mocks.startCourseRefresh.mock.calls[0]?.[0]).toBe('student-a');
    await expect(invoke('refreshCourses')).resolves.toEqual({
      activity: [],
      courses: [],
      sources: [],
      lastSuccessfulAt: null,
    });
    expect(mocks.startCourseRefresh).toHaveBeenCalledTimes(2);
    expect(mocks.discoverAcademicContext).not.toHaveBeenCalled();
  });

  it('reads the saved catalog without touching the study browser', async () => {
    await expect(invoke('getCourses')).resolves.toEqual({
      activity: [],
      refreshing: false,
      courses: [],
      sources: [],
      lastSuccessfulAt: null,
    });
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it('waits for a paused refresh to persist cancellation before returning state', async () => {
    mocks.startCourseRefresh.mockImplementationOnce(
      (userId: string, isCurrent: () => boolean, signal: AbortSignal) =>
        academicTasks.run(
          userId,
          async (taskSignal) => {
            const state = mocks.state as unknown as OnboardingState;
            state.discovery.status = 'running';
            await new Promise<void>((resolve) =>
              taskSignal.addEventListener(
                'abort',
                () => {
                  void Promise.resolve().then(resolve);
                },
                { once: true },
              ),
            );
            if (isCurrent()) state.discovery.status = 'cancelled';
            throw new Error('Refresh cancelled');
          },
          signal,
        ),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(invoke('pauseBackgroundSync')).resolves.toMatchObject({
      discovery: { status: 'cancelled' },
      preferences: { backgroundSync: { status: 'paused' } },
    });
  });
});

it('registers legacy and learning handlers before yielding during startup', async () => {
  const methods: string[] = [];
  const module: LearningActionModule = (registrar) => {
    registrar.handle('getTodayOverview', async () => ({}) as never);
  };
  const registration = registerAcademicActions({
    register: (method) => {
      methods.push(method);
    },
    publish: () => undefined,
    learningModules: [module],
  });

  try {
    expect(methods).toContain('getCurrentUser');
    expect(methods).toContain('getTodayOverview');
  } finally {
    await registration;
    await registerTestAcademicActions();
  }
});

it('persists consent revocation before waiting for registered learning work', async () => {
  mocks.state = readyState();
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  await invoke('getCurrentUser');
  const controller = new AbortController();
  let unregister!: () => void;
  const module: LearningActionModule = (registrar) => {
    unregister = registrar.lifecycle.registerOperation(
      'student-a',
      'active-turn',
      controller,
    );
  };
  await registerTestAcademicActions([module]);
  mocks.saveOnboardingSettings.mockClear();

  const revokeConsent = invoke('saveSettings', { consent: false });
  try {
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    expect(mocks.saveOnboardingSettings).toHaveBeenCalledWith('student-a', {
      consent: false,
    });
  } finally {
    unregister();
    await revokeConsent;
    await registerTestAcademicActions();
  }
});

it('stops course watching before academic consent is revoked', async () => {
  mocks.state = readyState();
  mocks.getCurrentUser.mockResolvedValue({
    id: 'student-a',
    hasCompletedOnboarding: true,
  });
  await invoke('getCurrentUser');
  mocks.state.settings.localSetupCompletedAt = '2026-11-01T12:00:00.000Z';
  mocks.state.settings.consent = false;
  mocks.watchRuntime.stop.mockClear();

  await invoke('saveSettings', { consent: false });

  expect(mocks.watchRuntime.stop).toHaveBeenCalledOnce();
});

it('releases only its system suspension token after resume and waits for watcher cleanup on Quit', async () => {
  const releaseSystemSuspend = vi.fn(async () => undefined);
  mocks.watchRuntime.suspend.mockResolvedValueOnce(releaseSystemSuspend);
  mocks.watchRuntime.pause.mockClear();
  mocks.watchRuntime.resume.mockClear();
  mocks.powerListeners.get('suspend')?.();
  await vi.waitFor(() => expect(mocks.watchRuntime.suspend).toHaveBeenCalled());
  expect(mocks.watchRuntime.pause).not.toHaveBeenCalled();

  let finishStop!: () => void;
  mocks.watchRuntime.stop.mockImplementationOnce(
    () => new Promise<void>((resolve) => (finishStop = resolve)),
  );
  mocks.watchRuntime.stop.mockClear();
  const preventDefault = vi.fn();
  mocks.appListeners.get('before-quit')!({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(mocks.watchRuntime.stop).toHaveBeenCalled());
  expect(mocks.appQuit).not.toHaveBeenCalled();
  finishStop();
  await vi.waitFor(() => expect(mocks.appQuit).toHaveBeenCalledOnce());

  mocks.powerListeners.get('resume')?.();
  await vi.waitFor(() => expect(releaseSystemSuspend).toHaveBeenCalledOnce());
  expect(mocks.watchRuntime.resume).not.toHaveBeenCalled();
});

it('finishes quitting after learning cleanup fails', async () => {
  const errorSpy = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  await registerTestAcademicActions([
    () => async () => {
      throw new Error('cleanup failed');
    },
  ]);
  const preventDefault = vi.fn();

  mocks.appListeners.get('before-quit')!({ preventDefault });

  try {
    await vi.waitFor(() => expect(mocks.appQuit).toHaveBeenCalledOnce());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(mocks.watchRuntime.stop).toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
    await registerTestAcademicActions();
  }
});

it('requires consent and an authenticated account to resolve sites', async () => {
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  mocks.resolveConnections.mockResolvedValue([
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  const proposal = (await invoke('resolveConnections', 'My school')) as {
    candidates: unknown[];
  };
  expect(proposal.candidates).toHaveLength(1);
  mocks.state.settings.consent = false;
  await expect(invoke('resolveConnections', 'My school')).rejects.toThrow();
  expect(mocks.resolveConnections).toHaveBeenCalledOnce();
});

it('binds edited connection proposals and approvals to the active account', async () => {
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  mocks.resolveConnections.mockResolvedValue([
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  const proposed = (await invoke('resolveConnections', 'My school')) as {
    id: string;
    candidates: unknown[];
  };
  const revised = (await invoke('reviseConnectionProposal', {
    id: proposed.id,
    candidates: proposed.candidates,
  })) as typeof proposed;
  await expect(
    invoke('approveConnectionProposal', { ...proposed }),
  ).rejects.toThrow();
  await expect(
    invoke('approveConnectionProposal', { ...revised, candidates: [] }),
  ).rejects.toThrow();
  await expect(
    invoke('approveConnectionProposal', revised),
  ).resolves.toBeUndefined();
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-b' });
  await expect(invoke('approveConnectionProposal', revised)).rejects.toThrow();
});

it('invalidates an old proposal when a new resolution fails', async () => {
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  mocks.resolveConnections
    .mockResolvedValueOnce([
      { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
    ])
    .mockRejectedValueOnce(new Error('offline'));
  const proposal = await invoke('resolveConnections', 'School');
  await invoke('approveConnectionProposal', proposal);
  await expect(invoke('resolveConnections', 'Another school')).rejects.toThrow(
    'offline',
  );
  await expect(invoke('approveConnectionProposal', proposal)).rejects.toThrow();
});

it('discards an older resolution that finishes after a newer request', async () => {
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  let finishOld!: (value: unknown) => void;
  mocks.resolveConnections
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce([
      { name: 'New', url: 'https://new.edu/', provider: 'unknown' },
    ]);
  const old = invoke('resolveConnections', 'Old');
  await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'));
  const latest = await invoke('resolveConnections', 'New');
  finishOld([{ name: 'Old', url: 'https://old.edu/', provider: 'unknown' }]);
  await expect(old).rejects.toThrow();
  await expect(
    invoke('approveConnectionProposal', latest),
  ).resolves.toBeUndefined();
});

it('starts only a main-process approved run and allows a human handoff', async () => {
  mocks.getCurrentUser.mockResolvedValue({
    id: 'student-a',
    hasCompletedOnboarding: true,
  });
  mocks.state = readyState();
  mocks.resolveConnections.mockResolvedValue([
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  mocks.workspace.mockResolvedValue({
    browser: { context: {} },
    cdpUrl: 'http://127.0.0.1:1',
  });
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ status: 'sign-in', host: 'school.edu' })
    .mockResolvedValueOnce({ status: 'readable', host: 'school.edu' });
  const capture = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  mocks.connectWorkspace.mockResolvedValue({ inspect, capture, close });
  const proposal = await invoke('resolveConnections', 'School');
  await expect(
    invoke('startConnectRun', (proposal as { id: string }).id),
  ).rejects.toThrow();
  await invoke('approveConnectionProposal', proposal);
  await invoke('startConnectRun', (proposal as { id: string }).id);
  await vi.waitFor(async () =>
    expect(((await invoke('getConnectRun')) as { status: string }).status).toBe(
      'awaiting-user',
    ),
  );
  expect(capture).not.toHaveBeenCalled();
  await invoke('resumeConnectRun');
  await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  await expect(
    invoke('startConnectRun', (proposal as { id: string }).id),
  ).rejects.toThrow();
});

it('cancels a paused connection run if the signed-in account changes', async () => {
  mocks.getCurrentUser.mockResolvedValue({
    id: 'student-a',
    hasCompletedOnboarding: true,
  });
  mocks.state = readyState();
  mocks.resolveConnections.mockResolvedValue([
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  mocks.workspace.mockResolvedValue({
    browser: { context: {} },
    cdpUrl: 'http://127.0.0.1:1',
  });
  const close = vi.fn(async () => undefined);
  mocks.connectWorkspace.mockResolvedValue({
    inspect: vi.fn(async () => ({ status: 'sign-in', host: 'school.edu' })),
    capture: vi.fn(),
    close,
  });
  const proposal = (await invoke('resolveConnections', 'School')) as {
    id: string;
  };
  await invoke('approveConnectionProposal', proposal);
  await invoke('startConnectRun', proposal.id);
  await vi.waitFor(async () =>
    expect(((await invoke('getConnectRun')) as { status: string }).status).toBe(
      'awaiting-user',
    ),
  );
  mocks.getCurrentUser.mockResolvedValue({
    id: 'student-b',
    hasCompletedOnboarding: true,
  });
  await invoke('getCurrentUser');
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(((await invoke('getConnectRun')) as { status: string }).status).toBe(
    'idle',
  );
});

it('does not capture for the previous account when its cookie changes during a run', async () => {
  const { authClient } = await import('../src/lib/auth/client');
  mocks.getCurrentUser.mockResolvedValue({
    id: 'student-a',
    hasCompletedOnboarding: true,
  });
  mocks.state = readyState();
  mocks.resolveConnections.mockResolvedValue([
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  mocks.workspace.mockResolvedValue({
    browser: { context: {} },
    cdpUrl: 'http://127.0.0.1:1',
  });
  let completeInspection!: (value: unknown) => void;
  const capture = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  mocks.connectWorkspace.mockImplementation(async (options) => ({
    inspect: () =>
      new Promise((resolve) => {
        completeInspection = resolve;
      }),
    capture: async () => {
      await (
        options as { capture: (...args: unknown[]) => Promise<unknown> }
      ).capture('student-a', {}, () => true, 'school.edu');
      await capture();
    },
    close,
  }));
  const proposal = (await invoke('resolveConnections', 'School')) as {
    id: string;
  };
  await invoke('approveConnectionProposal', proposal);
  await invoke('startConnectRun', proposal.id);
  await vi.waitFor(() => expect(completeInspection).toBeTypeOf('function'));
  vi.mocked(authClient.getCookie).mockReturnValue('different-cookie');
  completeInspection({ status: 'readable', host: 'school.edu' });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(capture).not.toHaveBeenCalled();
});

it('joins duplicate manual all-course refresh commands without cancelling the first', async () => {
  mocks.state = readyState();
  mocks.getCurrentUser.mockResolvedValue({
    id: 'student-a',
    hasCompletedOnboarding: true,
  });
  await invoke('getState');
  let resolve!: (value: unknown) => void;
  mocks.startCourseRefresh.mockReturnValueOnce(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const first = invoke('refreshCourses');
  await vi.waitFor(() =>
    expect(mocks.startCourseRefresh).toHaveBeenCalledOnce(),
  );
  const second = invoke('refreshCourses');
  await Promise.resolve();
  resolve({
    state: mocks.state,
    snapshot: { courses: [], sources: [], lastSuccessfulAt: null },
  });
  await Promise.all([first, second]);
  expect(mocks.startCourseRefresh).toHaveBeenCalledOnce();
});

it('can cancel academic work after cloud authentication expires', async () => {
  const { cancelCourseRefresh } =
    await import('../src/features/courses/services/refresh');
  mocks.getCurrentUser.mockResolvedValue(null);
  await expect(invoke('cancelCourseRefresh')).resolves.toBeUndefined();
  expect(cancelCourseRefresh).toHaveBeenCalledOnce();
});

it('re-registers learning modules after account and session teardown', async () => {
  const cleanup = vi.fn();
  const registerModule = vi.fn(() => cleanup);
  await registerAcademicActions({
    register: (method, action) =>
      mocks.handlers.set(`scholar:${method}`, async (_event, input) =>
        action(input),
      ),
    publish: () => undefined,
    learningModules: [registerModule],
  });
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });

  await invoke('getCurrentUser');
  expect(registerModule).toHaveBeenCalledTimes(2);
  expect(cleanup).toHaveBeenCalledOnce();

  mocks.getCookie.mockReturnValue('account-b-cookie');
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-b' });
  await invoke('getCurrentUser');
  expect(registerModule).toHaveBeenCalledTimes(3);
  expect(cleanup).toHaveBeenCalledTimes(2);

  await invoke('signOut');
  expect(registerModule).toHaveBeenCalledTimes(4);
  expect(cleanup).toHaveBeenCalledTimes(3);
});

it('registers account-scoped staged workspace replacement actions', async () => {
  const input = {
    requestId: '00000000-0000-4000-8000-000000000001',
    browserId: 'browser-a',
  };
  const replacement = {
    operationId: '00000000-0000-4000-8000-000000000002',
    state: 'ready',
    browserId: 'browser-a',
    errorCode: null,
    revision: 1,
  };
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  mocks.stageReplacement.mockResolvedValue(replacement);

  await expect(invoke('stageWorkspaceReplacement', input)).resolves.toEqual(
    replacement,
  );
  expect(mocks.stageReplacement).toHaveBeenCalledWith(
    'student-a',
    input,
    expect.any(Function),
  );
  expect(mocks.watchRuntime.suspend).toHaveBeenCalledOnce();

  await expect(
    invoke('stageWorkspaceReplacement', { ...input, userId: 'student-b' }),
  ).rejects.toThrow();
  expect(mocks.stageReplacement).toHaveBeenCalledOnce();
});

it('commits replacements with a scoped current-session barrier', async () => {
  const input = {
    operationId: '00000000-0000-4000-8000-000000000002',
    expectedRevision: 4,
  };
  const replacement = {
    operationId: input.operationId,
    state: 'committed',
    browserId: 'browser-a',
    errorCode: null,
    revision: 5,
  };
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  mocks.commitReplacement.mockResolvedValue(replacement);

  await expect(invoke('commitWorkspaceReplacement', input)).resolves.toEqual(
    replacement,
  );
  expect(mocks.commitReplacement).toHaveBeenCalledWith(
    'student-a',
    input,
    expect.any(Function),
  );
  expect(mocks.watchRuntime.suspend).toHaveBeenCalledOnce();
});

it('awaits partial module cleanup before propagating registration failure', async () => {
  const lifecycle = createLearningLifecycle();
  let finishCleanup!: () => void;
  const cleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }),
  );
  let registrationSettled = false;
  const registration = Promise.resolve()
    .then(() =>
      registerLearningActions(
        {
          handle: () => undefined,
          publish: () => undefined,
          lifecycle,
        },
        [
          () => cleanup,
          () => {
            throw new Error('module registration failed');
          },
        ],
      ),
    )
    .then(
      () => (registrationSettled = true),
      () => (registrationSettled = true),
    );

  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  expect(registrationSettled).toBe(false);
  finishCleanup();
  await registration;

  expect(registrationSettled).toBe(true);
});

it('aborts scoped work and waits for operation deregistration before invalidation', async () => {
  const lifecycle = createLearningLifecycle();
  const controller = new AbortController();
  const unregister = lifecycle.registerOperation(
    'student-a',
    'operation-a',
    controller,
  );
  let invalidated = false;
  const invalidation = lifecycle.invalidate().then(() => {
    invalidated = true;
  });

  expect(controller.signal.aborted).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(invalidated).toBe(false);
  unregister();
  await invalidation;

  expect(invalidated).toBe(true);
});

it('aborts new operation registrations while a cancellation barrier is active', async () => {
  const lifecycle = createLearningLifecycle();
  const activeController = new AbortController();
  const unregisterActive = lifecycle.registerOperation(
    'student-a',
    'active-operation',
    activeController,
  );
  const cancellation = lifecycle.cancelOperationsAndWait();
  const nextController = new AbortController();
  const unregisterNext = lifecycle.registerOperation(
    'student-a',
    'next-operation',
    nextController,
  );

  expect(activeController.signal.aborted).toBe(true);
  expect(nextController.signal.aborted).toBe(true);
  unregisterNext();
  unregisterActive();
  await cancellation;
});

it('keeps learning fenced after teardown failure until a clean recovery invalidation', async () => {
  const lifecycle = createLearningLifecycle();
  lifecycle.onTeardown(async () => {
    throw new Error('module cleanup failed');
  });

  await expect(lifecycle.invalidate()).rejects.toThrow(
    'Learning teardown failed.',
  );
  await expect(
    Promise.resolve().then(() =>
      lifecycle.trackOperation('stale', async () => 'stale'),
    ),
  ).rejects.toThrow('Learning work is being cancelled.');
  await lifecycle.invalidate();
  await expect(
    lifecycle.trackOperation('fresh', async () => 'fresh'),
  ).resolves.toBe('fresh');
});

it('runs learning module cleanup once when disposal overlaps lifecycle invalidation', async () => {
  const lifecycle = createLearningLifecycle();
  const cleanup = vi.fn(async () => undefined);
  const dispose = await registerLearningActions(
    {
      handle: () => undefined,
      publish: () => undefined,
      lifecycle,
    },
    [() => cleanup],
  );

  await dispose();
  await lifecycle.invalidate();
  await dispose();

  expect(cleanup).toHaveBeenCalledOnce();
});

it('waits for an active learning action before rebinding the account', async () => {
  let finishAction!: () => void;
  let announceStart!: () => void;
  const actionStarted = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  const actionMayFinish = new Promise<void>((resolve) => {
    finishAction = resolve;
  });
  const cleanup = vi.fn(async () => undefined);
  const module: LearningActionModule = (registrar) => {
    registrar.handle('getTodayOverview', async () => {
      announceStart();
      await actionMayFinish;
      return {} as never;
    });
    return cleanup;
  };
  await registerAcademicActions({
    register: (method, action) =>
      mocks.handlers.set(`scholar:${method}`, async (_event, input) =>
        action(input),
      ),
    publish: () => undefined,
    learningModules: [module],
  });
  mocks.getCurrentUser
    .mockResolvedValueOnce({ id: 'student-a' })
    .mockResolvedValueOnce({ id: 'student-a' })
    .mockResolvedValueOnce({ id: 'student-b' });
  await invoke('getCurrentUser');
  const activeAction = invoke('getTodayOverview', {});
  await actionStarted;
  cleanup.mockClear();
  mocks.clientSignOut.mockClear();
  const accountSwitch = invoke('getCurrentUser');
  let switchSettled = false;
  void accountSwitch.then(
    () => (switchSettled = true),
    () => (switchSettled = true),
  );
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(switchSettled).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(mocks.clientSignOut).not.toHaveBeenCalled();
  } finally {
    finishAction();
  }
  await expect(activeAction).rejects.toThrow('Your session changed');
  await expect(accountSwitch).resolves.toMatchObject({ id: 'student-b' });

  expect(cleanup).toHaveBeenCalledOnce();
});

it('cancels only the current account replacement without stopping its workspace', async () => {
  const input = { operationId: '00000000-0000-4000-8000-000000000002' };
  const replacement = {
    operationId: input.operationId,
    state: 'cancelled',
    browserId: 'browser-a',
    errorCode: null,
    revision: 2,
  };
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  mocks.cancelReplacement.mockResolvedValue(replacement);

  await expect(invoke('cancelWorkspaceReplacement', input)).resolves.toEqual(
    replacement,
  );
  expect(mocks.cancelReplacement).toHaveBeenCalledWith('student-a', input);
  expect(mocks.watchRuntime.suspend).not.toHaveBeenCalled();
});
