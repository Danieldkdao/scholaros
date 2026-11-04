import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as databaseSchema from '../src/db/schema';
import { academicTasks } from '../src/features/onboarding/services/academic-tasks';
import {
  createLearningLifecycle,
  notificationOutcomeId,
  registerLearningActions,
  loadLearningActionModules,
  type LearningActionModule,
} from '../src/services/academic/learning-actions';
import {
  internalOfflineReadMethods,
  rendererAcademicMethods,
} from '../src/services/academic/contracts';
import type { OnboardingState } from '../src/features/onboarding/types';
import type { AcademicActivityAdapter } from '../src/services/academic/activity-adapter';

const activityRequest = () => ({
  sessionId: 'session-a',
  artifactId: 'artifact-a',
  versionId: 'version-a',
  attemptId: 'attempt-a',
  requestId: '00000000-0000-4000-8000-000000000003',
});

const activityAuthorization = (
  request = activityRequest(),
): Awaited<ReturnType<AcademicActivityAdapter['authorizeActivityRun']>> => ({
  runtimeVersion: 'activity-runtime-v1',
  sessionId: request.sessionId,
  artifactId: request.artifactId,
  versionId: request.versionId,
  attemptId: request.attemptId,
  runId: 'run-a',
  contentDigest: 'a'.repeat(64),
  runtimeDigest: 'b'.repeat(64),
  initialState: null,
  stateRevision: 0,
  html: '<p>Test activity</p>',
  css: '',
  javascript: '',
  sdk: '',
});

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
  realDb: null as ReturnType<typeof drizzle<typeof databaseSchema>> | null,
  directory: '',
  closeWorkspace: vi.fn<() => Promise<void>>(async () => undefined),
  waitForWorkspaceStops: vi.fn(async () => undefined),
  publish: vi.fn(),
  state: { settings: { consent: true, localSetupCompletedAt: null } },
}));
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  mocks.directory = mkdtempSync(join(tmpdir(), 'scholaros-ipc-cleanup-'));
  return {
    net: { fetch: mocks.authFetch },
    app: {
      getPath: () => mocks.directory,
      getAppPath: () => process.cwd(),
      hasSingleInstanceLock: () => true,
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
  };
});
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
vi.mock('../src/db', () => {
  const fakeDb = {
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
  };
  return {
    get db() {
      return mocks.realDb ?? fakeDb;
    },
  };
});
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
  closeWorkspace: mocks.closeWorkspace,
  stageWorkspaceReplacement: mocks.stageReplacement,
  commitWorkspaceReplacement: mocks.commitReplacement,
  cancelWorkspaceReplacement: mocks.cancelReplacement,
  createWorkspace: vi.fn(),
  openAcademicPage: vi.fn(),
  waitForWorkspaceStops: mocks.waitForWorkspaceStops,
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
    publish: mocks.publish,
    learningModules,
  });

describe('real account-local cleanup composition', () => {
  let sqlite: Database.Database;
  let readEpoch = () => -1;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    mocks.realDb = drizzle({ client: sqlite, schema: databaseSchema });
    migrate(mocks.realDb, {
      migrationsFolder: join(process.cwd(), 'src/db/migrations'),
    });
    const timestamp = new Date().toISOString();
    for (const suffix of ['a', 'b'])
      mocks.realDb
        .insert(databaseSchema.CourseTable)
        .values({
          id: `cleanup-course-${suffix}`,
          userId: `student-${suffix}`,
          connectionId: null,
          sourceKey: `manual:cleanup-${suffix}`,
          sourceName: 'Manual',
          sourceHost: '',
          name: 'Fixture physics',
          url: '',
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
        })
        .run();
    mocks.state = readyState();
    mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
    await registerTestAcademicActions([
      ...(await loadLearningActionModules()),
      (registrar) => {
        readEpoch = () => registrar.lifecycle.epoch;
      },
    ]);
    await invoke('getCurrentUser');
    mocks.publish.mockClear();
  });

  afterEach(async () => {
    await registerTestAcademicActions();
    await invoke('signOut');
    vi.restoreAllMocks();
    mocks.realDb = null;
    sqlite.close();
  });

  it('holds account admission until actual tutor and replacement work settle without waiting on its own delete invoke', async () => {
    expect(mocks.handlers.has('scholar:deleteLocalAcademicData')).toBe(true);
    let finishFetch!: (response: Response) => void;
    mocks.authFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFetch = resolve;
        }),
    );
    const session = (await invoke('createStudySession', {
      requestId: randomUUID(),
      courseId: 'cleanup-course-a',
      activity: 'understand-topic',
      targetAssignmentId: null,
      contextItemIds: [],
      durationMinutes: null,
      title: 'Pending fixture',
    })) as { id: string };
    await invoke('sendStudyTurn', {
      sessionId: session.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain waves conceptually.',
      attachmentIds: [],
    });
    await vi.waitFor(() => expect(finishFetch).toBeTypeOf('function'));
    let finishReplacement!: () => void;
    let replacementIsCurrent!: () => boolean;
    mocks.stageReplacement.mockImplementationOnce(
      async (_userId, input, isCurrent) => {
        replacementIsCurrent = isCurrent;
        await new Promise<void>((resolve) => {
          finishReplacement = resolve;
        });
        return {
          operationId: input.requestId,
          state: 'cancelled',
          browserId: input.browserId,
          errorCode: 'cancelled',
          revision: 1,
        };
      },
    );
    const replacement = invoke('stageWorkspaceReplacement', {
      requestId: randomUUID(),
      browserId: 'fixture-browser',
    }).catch((error) => error);
    await vi.waitFor(() => expect(finishReplacement).toBeTypeOf('function'));
    let settled = false;
    const deletion = invoke('deleteLocalAcademicData', {
      requestId: randomUUID(),
      scope: 'account-local',
    }).then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() =>
        expect(mocks.authFetch.mock.calls.at(-1)![1].signal.aborted).toBe(true),
      );
      expect(replacementIsCurrent()).toBe(false);
      await expect(
        invoke('createContextNote', {
          requestId: randomUUID(),
          title: 'Late note',
          text: 'Must not be admitted.',
          kind: 'note',
          courseId: 'cleanup-course-a',
        }),
      ).rejects.toMatchObject({ code: 'busy' });
      await expect(
        invoke('releaseActivityRun', { requestId: randomUUID() }),
      ).resolves.toBeUndefined();
      expect(
        sqlite
          .prepare('SELECT COUNT(*) AS count FROM courses WHERE user_id = ?')
          .get('student-a'),
      ).toEqual({ count: 1 });
      expect(settled).toBe(false);
      finishReplacement();
      await expect(replacement).resolves.toBeInstanceOf(Error);
      expect(settled).toBe(false);
    } finally {
      finishReplacement();
      finishFetch(Response.json({}));
      await deletion;
    }
    expect(settled).toBe(true);
    expect(sqlite.prepare('SELECT user_id FROM courses').all()).toEqual([
      { user_id: 'student-b' },
    ]);
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM study_messages WHERE user_id = ?',
        )
        .get('student-a'),
    ).toEqual({ count: 0 });
  });

  it('rejects a newly detected account replacement before the pending deletion can commit', async () => {
    let finishClose!: () => void;
    mocks.closeWorkspace.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const deletion = invoke('deleteLocalAcademicData', {
      requestId: randomUUID(),
      scope: 'account-local',
    }).catch((error) => error);
    await vi.waitFor(() => expect(finishClose).toBeTypeOf('function'));
    mocks.getCurrentUser.mockResolvedValue({ id: 'student-b' });
    const replacement = invoke('getCurrentUser');
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishClose();
    expect(await deletion).toBeInstanceOf(Error);
    await expect(replacement).resolves.toMatchObject({ id: 'student-b' });
    expect(
      sqlite.prepare('SELECT user_id FROM courses ORDER BY user_id').all(),
    ).toEqual([{ user_id: 'student-a' }, { user_id: 'student-b' }]);
    expect(
      mocks.publish.mock.calls.some(
        ([channel, value]) =>
          channel === 'scholar:productEvent' && value.resource === 'device',
      ),
    ).toBe(false);
  });

  it('rolls back a failed SQLite cleanup without invalidation and permits a real retry', async () => {
    const epoch = readEpoch();
    sqlite.exec(
      "CREATE TEMP TRIGGER fail_fixture_cleanup BEFORE DELETE ON courses WHEN OLD.user_id = 'student-a' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;",
    );
    await expect(
      invoke('deleteLocalAcademicData', {
        requestId: randomUUID(),
        scope: 'account-local',
      }),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(readEpoch()).toBe(epoch);
    expect(
      sqlite.prepare('SELECT user_id FROM courses ORDER BY user_id').all(),
    ).toEqual([{ user_id: 'student-a' }, { user_id: 'student-b' }]);
    expect(
      mocks.publish.mock.calls.some(
        ([channel, value]) =>
          channel === 'scholar:productEvent' && value.resource === 'device',
      ),
    ).toBe(false);
    sqlite.exec('DROP TRIGGER fail_fixture_cleanup;');
    await expect(
      invoke('deleteLocalAcademicData', {
        requestId: randomUUID(),
        scope: 'account-local',
      }),
    ).resolves.toBeUndefined();
    expect(readEpoch()).toBe(epoch + 1);
  });

  it('rejects caller-selected cleanup accounts and offline deletion before touching stores', async () => {
    mocks.closeWorkspace.mockClear();
    await expect(
      invoke('deleteLocalAcademicData', {
        requestId: randomUUID(),
        scope: 'account-local',
        userId: 'student-b',
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      authMode: 'offline-local',
    });
    await expect(
      invoke('deleteLocalAcademicData', {
        requestId: randomUUID(),
        scope: 'account-local',
      }),
    ).rejects.toThrow('Reconnect');
    expect(mocks.closeWorkspace).not.toHaveBeenCalled();
    expect(
      sqlite.prepare('SELECT user_id FROM courses ORDER BY user_id').all(),
    ).toHaveLength(2);
  });

  it('routes typed notification commands to the actual registered leaf and rejects cross-account authority', async () => {
    await expect(
      invoke('claimDueNotifications', {
        operation: 'set-permission',
        userId: 'student-a',
        permission: 'granted',
      }),
    ).resolves.toBeUndefined();
    await expect(
      invoke('claimDueNotifications', {
        operation: 'get-permission',
        userId: 'student-a',
      }),
    ).resolves.toBe('granted');
    await expect(
      invoke('claimDueNotifications', {
        operation: 'set-focus',
        userId: 'student-b',
        isFocused: true,
      }),
    ).rejects.toMatchObject({ code: 'session-changed' });
    await expect(
      invoke('claimDueNotifications', {
        operation: 'set-focus',
        userId: 'student-a',
        isFocused: true,
        path: '/untrusted',
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  const enableRealNotifications = async () => {
    await invoke('claimDueNotifications', {
      operation: 'set-permission',
      userId: 'student-a',
      permission: 'granted',
    });
    const { revision, ...settings } = (await invoke(
      'getNotificationSettings',
    )) as import('@scholaros/services/learning/notification-contracts').NotificationSettings;
    await invoke('saveNotificationSettings', {
      settings: {
        ...settings,
        enabled: true,
        categories: Object.fromEntries(
          Object.keys(settings.categories).map((category) => [category, true]),
        ),
        quietHours: { ...settings.quietHours, enabled: false },
      },
      expectedRevision: revision,
    });
  };

  it('enqueues a real terminal refresh failure once without notifying running progress or leaking task errors', async () => {
    await enableRealNotifications();
    const completion = academicTasks.run(
      'student-a',
      async (signal) => {
        academicTasks.report(signal, 'PRIVATE_FIXTURE_ACADEMIC_PROGRESS');
        expect(
          sqlite.prepare('SELECT * FROM notification_events').all(),
        ).toEqual([]);
        throw new Error('PRIVATE_FIXTURE_PROVIDER_FAILURE');
      },
      undefined,
      'cleanup-course-a',
    );
    await expect(completion).rejects.toThrow(
      'PRIVATE_FIXTURE_PROVIDER_FAILURE',
    );
    await vi.waitFor(() =>
      expect(
        sqlite
          .prepare(
            'SELECT category, target_id, status FROM notification_events',
          )
          .all(),
      ).toEqual([
        {
          category: 'sync-failed',
          target_id: 'cleanup-course-a',
          status: 'queued',
        },
      ]),
    );
    await invoke('getCourses');
    await invoke('getCourses');
    const rows = sqlite.prepare('SELECT * FROM notification_events').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_FIXTURE');
    expect(mocks.publish).toHaveBeenCalledWith(
      'scholar:productEvent',
      expect.objectContaining({
        accountId: 'student-a',
        resource: 'notifications',
      }),
    );
  });

  it.each(['cleanup-course-a', 'connection:terminal-connection-a'])(
    'enqueues connection attention only after a real sign-in-required task settles for an owned persisted connection via %s',
    async (key) => {
      await enableRealNotifications();
      mocks
        .realDb!.insert(databaseSchema.AcademicConnectionTable)
        .values({
          id: 'terminal-connection-a',
          userId: 'student-a',
          name: 'Fixture source',
          host: 'fixture.invalid',
          url: 'https://fixture.invalid/courses',
          kind: 'canvas',
          status: 'confirmed',
          isCourseResource: true,
        })
        .run();
      sqlite
        .prepare('UPDATE courses SET connection_id = ? WHERE id = ?')
        .run('terminal-connection-a', 'cleanup-course-a');
      await academicTasks.run(
        'student-a',
        async (signal) => {
          sqlite
            .prepare('UPDATE academic_connections SET status = ? WHERE id = ?')
            .run('needs-sign-in', 'terminal-connection-a');
          academicTasks.reportSignInRequired(
            signal,
            'PRIVATE_FIXTURE_SIGN_IN_URL',
          );
          expect(
            sqlite.prepare('SELECT * FROM notification_events').all(),
          ).toEqual([]);
        },
        undefined,
        key,
      );
      await vi.waitFor(() =>
        expect(
          sqlite
            .prepare(
              'SELECT category, target_id, status FROM notification_events',
            )
            .all(),
        ).toEqual([
          {
            category: 'connection-attention',
            target_id: 'terminal-connection-a',
            status: 'queued',
          },
        ]),
      );
      expect(
        JSON.stringify(
          sqlite.prepare('SELECT * FROM notification_events').all(),
        ),
      ).not.toContain('PRIVATE_FIXTURE');
    },
  );

  it('enqueues a connection-scoped refresh failure against the owned connection rather than a nonexistent course', async () => {
    await enableRealNotifications();
    mocks
      .realDb!.insert(databaseSchema.AcademicConnectionTable)
      .values({
        id: 'failed-connection-a',
        userId: 'student-a',
        name: 'Fixture source',
        host: 'fixture.invalid',
        url: 'https://fixture.invalid/courses',
        kind: 'canvas',
        status: 'confirmed',
        isCourseResource: true,
      })
      .run();
    await expect(
      academicTasks.run(
        'student-a',
        async () => {
          throw new Error('Fixture connection refresh failed.');
        },
        undefined,
        'connection:failed-connection-a',
        { exclusive: true },
      ),
    ).rejects.toThrow('Fixture connection refresh failed.');
    await vi.waitFor(() =>
      expect(
        sqlite
          .prepare(
            'SELECT category, target_kind, target_id FROM notification_events',
          )
          .all(),
      ).toEqual([
        {
          category: 'sync-failed',
          target_kind: 'connection',
          target_id: 'failed-connection-a',
        },
      ]),
    );
  });

  it('enqueues completed sync only from complete source and material results rather than task settlement', async () => {
    await enableRealNotifications();
    const timestamp = new Date().toISOString();
    const state = readyState() as unknown as OnboardingState;
    state.settings.localSetupCompletedAt = timestamp;
    state.discovery = {
      ...state.discovery,
      status: 'empty',
      discoveredAt: timestamp,
      coverage: { 'connection-a': 'empty' },
    };
    mocks.state = state as unknown as typeof mocks.state;
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      hasCompletedOnboarding: true,
    });
    let materialRefreshStatus = 'partial';
    mocks.startCourseRefresh.mockImplementation(
      async (userId, isCurrent, externalSignal) =>
        academicTasks.run(
          userId,
          async (signal) => {
            if (!isCurrent()) throw new Error('Stale fixture account.');
            academicTasks.report(signal, 'PRIVATE_FIXTURE_REFRESH_PROGRESS');
            return {
              state: mocks.state,
              snapshot: {
                courses: [],
                lastSuccessfulAt: timestamp,
                sources: [
                  {
                    connectionId: 'connection-a',
                    outcome: 'complete',
                    message: null,
                    lastAttemptedAt: timestamp,
                    lastSuccessfulAt: timestamp,
                  },
                ],
              },
              attemptedConnectionIds: ['connection-a'],
              materialRefreshStatus,
            };
          },
          externalSignal,
          'courses',
        ),
    );
    await invoke('refreshCourses');
    await vi.waitFor(() =>
      expect(
        sqlite.prepare('SELECT category FROM notification_events').all(),
      ).toEqual([{ category: 'sync-failed' }]),
    );
    materialRefreshStatus = 'complete';
    await invoke('refreshCourses');
    await vi.waitFor(() =>
      expect(
        sqlite
          .prepare('SELECT category FROM notification_events ORDER BY category')
          .all(),
      ).toEqual([{ category: 'sync-completed' }, { category: 'sync-failed' }]),
    );
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(DISTINCT outcome_id) AS count FROM notification_events',
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  it.each(['complete', 'partial'])(
    'enqueues the actual single-course material outcome %s after real task settlement',
    async (materialRefreshStatus) => {
      await enableRealNotifications();
      const timestamp = new Date().toISOString();
      const state = readyState() as unknown as OnboardingState;
      state.settings.localSetupCompletedAt = timestamp;
      mocks.state = state as unknown as typeof mocks.state;
      mocks.getCurrentUser.mockResolvedValue({
        id: 'student-a',
        hasCompletedOnboarding: true,
      });
      sqlite
        .prepare(
          'UPDATE courses SET overview_synced_at = ?, announcements_status = ?, assignments_status = ? WHERE id = ?',
        )
        .run(timestamp, 'complete', 'complete', 'cleanup-course-a');
      const courseStore = await vi.importActual<
        typeof import('../src/features/courses/services/store')
      >('../src/features/courses/services/store');
      mocks.refreshSingleCourse.mockImplementation(async (userId, courseId) =>
        academicTasks.run(
          userId,
          async () => {
            const course = courseStore.getCourseDetail(userId, courseId);
            expect(course).not.toBeNull();
            return { ...course, materialRefreshStatus };
          },
          undefined,
          courseId,
        ),
      );
      await invoke('refreshCourse', 'cleanup-course-a');
      await vi.waitFor(() =>
        expect(
          sqlite
            .prepare(
              'SELECT category, target_kind, target_id FROM notification_events',
            )
            .all(),
        ).toEqual([
          {
            category:
              materialRefreshStatus === 'complete'
                ? 'sync-completed'
                : 'sync-failed',
            target_kind: 'course',
            target_id: 'cleanup-course-a',
          },
        ]),
      );
    },
  );

  it('keeps a settled sync result tied to its actual run when a newer task replaces history', async () => {
    await enableRealNotifications();
    const timestamp = new Date().toISOString();
    const state = readyState() as unknown as OnboardingState;
    state.settings.localSetupCompletedAt = timestamp;
    state.discovery = {
      ...state.discovery,
      status: 'empty',
      discoveredAt: timestamp,
      coverage: { 'connection-a': 'empty' },
    };
    mocks.state = state as unknown as typeof mocks.state;
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      hasCompletedOnboarding: true,
    });
    let firstTaskId = '';
    let finish!: () => void;
    const mayReturn = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.startCourseRefresh.mockImplementationOnce(
      async (userId, _isCurrent, externalSignal) => {
        const result = await academicTasks.run(
          userId,
          async () => ({
            state,
            snapshot: {
              courses: [],
              lastSuccessfulAt: timestamp,
              sources: [
                {
                  connectionId: 'connection-a',
                  outcome: 'complete',
                  message: null,
                  lastAttemptedAt: timestamp,
                  lastSuccessfulAt: timestamp,
                },
              ],
            },
            attemptedConnectionIds: ['connection-a'],
            materialRefreshStatus: 'complete',
          }),
          externalSignal,
          'courses',
        );
        firstTaskId = academicTasks
          .getActivity(userId)
          .find((task) => task.key === 'courses')!.id;
        await mayReturn;
        return result;
      },
    );
    const refresh = invoke('refreshCourses');
    await vi.waitFor(() => expect(firstTaskId).not.toBe(''));
    try {
      await academicTasks.run(
        'student-a',
        async () => undefined,
        undefined,
        'courses',
      );
    } finally {
      finish();
    }
    await refresh;
    await vi.waitFor(() =>
      expect(
        sqlite.prepare('SELECT outcome_id FROM notification_events').all(),
      ).toEqual([{ outcome_id: notificationOutcomeId('sync', firstTaskId) }]),
    );
  });

  it('keeps an old running task fenced across same-account cookie reauthentication', async () => {
    await enableRealNotifications();
    let finish!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const completion = academicTasks.run(
      'student-a',
      async (signal) => {
        await mayFinish;
        academicTasks.report(signal, 'Late old-account progress');
        throw new Error('Old task failed.');
      },
      undefined,
      'cleanup-course-a',
    );
    void completion.catch(() => undefined);
    await Promise.resolve();
    mocks.getCookie.mockReturnValue('replacement-same-account-cookie');
    await invoke('getCurrentUser');
    await enableRealNotifications();
    finish();
    await expect(completion).rejects.toThrow('Old task failed.');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sqlite.prepare('SELECT * FROM notification_events').all()).toEqual(
      [],
    );
  });

  it('never treats a cancelled or merely resolved academic task as a completed sync', async () => {
    await enableRealNotifications();
    await academicTasks.run(
      'student-a',
      async () => undefined,
      undefined,
      'cleanup-course-a',
    );
    let finish!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const completion = academicTasks.run(
      'student-a',
      async () => mayFinish,
      undefined,
      'cleanup-course-a',
    );
    await Promise.resolve();
    academicTasks.cancel('student-a');
    finish();
    await completion;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sqlite.prepare('SELECT * FROM notification_events').all()).toEqual(
      [],
    );
  });

  it('drains an outstanding real notification producer before account-local deletion and never restores its row', async () => {
    await enableRealNotifications();
    const notifications =
      await import('../src/features/notifications/services/notification-actions');
    const original = notifications.enqueueProductNotification;
    let finish!: () => void;
    const mayEnqueue = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const enqueue = vi
      .spyOn(notifications, 'enqueueProductNotification')
      .mockImplementation(async (...args) => {
        await mayEnqueue;
        return original(...args);
      });
    await expect(
      academicTasks.run(
        'student-a',
        async () => {
          throw new Error('Fixture refresh failed.');
        },
        undefined,
        'cleanup-course-a',
      ),
    ).rejects.toThrow('Fixture refresh failed.');
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
    let deleted = false;
    const deletion = invoke('deleteLocalAcademicData', {
      requestId: randomUUID(),
      scope: 'account-local',
    }).then(() => {
      deleted = true;
    });
    void deletion.catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(deleted).toBe(false);
      expect(
        sqlite
          .prepare('SELECT id FROM courses WHERE user_id = ?')
          .all('student-a'),
      ).toHaveLength(1);
    } finally {
      finish();
      await deletion;
    }
    expect(deleted).toBe(true);
    expect(sqlite.prepare('SELECT * FROM notification_events').all()).toEqual(
      [],
    );
    expect(
      sqlite
        .prepare('SELECT id FROM courses WHERE user_id = ?')
        .all('student-a'),
    ).toEqual([]);
    expect(
      sqlite
        .prepare('SELECT id FROM courses WHERE user_id = ?')
        .all('student-b'),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sqlite.prepare('SELECT * FROM notification_events').all()).toEqual(
      [],
    );
  });

  it('fences an action still authenticating when local cleanup removes its account data', async () => {
    let finishAuthentication!: (value: unknown) => void;
    mocks.getCurrentUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAuthentication = resolve;
        }),
    );
    const lateAction = invoke('createContextNote', {
      requestId: randomUUID(),
      title: 'Late personal note',
      text: 'Must not resurrect deleted data.',
      kind: 'note',
    }).catch((error) => error);
    await vi.waitFor(() => expect(finishAuthentication).toBeTypeOf('function'));
    await invoke('deleteLocalAcademicData', {
      requestId: randomUUID(),
      scope: 'account-local',
    });
    finishAuthentication({ id: 'student-a' });
    expect(await lateAction).toBeInstanceOf(Error);
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM context_items WHERE user_id = ?',
        )
        .get('student-a'),
    ).toEqual({ count: 0 });
  });

  it('starts the default service with real learning modules and round-trips a persisted tutor turn over its private socket', async () => {
    await registerTestAcademicActions();
    await invoke('signOut');
    const { runAcademicService } =
      await import('../src/services/academic/runtime');
    const { academicRequest } =
      await import('../src/services/academic/transport');
    mocks.authFetch.mockImplementationOnce(async (_url, options) => {
      const request = JSON.parse(options.body);
      return Response.json({
        version: 1,
        requestId: request.requestId,
        generationId: randomUUID(),
        parts: [{ kind: 'text', text: 'Fixture socket tutor explanation.' }],
        citations: [],
        proposedEffects: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        configurationRevision: 'fixture-meta-only',
      });
    });
    const service = await runAcademicService();
    try {
      const session = (await academicRequest(
        service.endpoint,
        'createStudySession',
        {
          requestId: randomUUID(),
          courseId: 'cleanup-course-a',
          activity: 'understand-topic',
          targetAssignmentId: null,
          contextItemIds: [],
          durationMinutes: null,
          title: 'Socket fixture',
        },
      )) as { id: string };
      const admitted = (await academicRequest(
        service.endpoint,
        'sendStudyTurn',
        {
          sessionId: session.id,
          requestId: randomUUID(),
          expectedDraftRevision: 0,
          text: 'Explain waves conceptually.',
          attachmentIds: [],
        },
      )) as { turnId: string };
      await vi.waitFor(() =>
        expect(
          sqlite
            .prepare('SELECT status FROM study_turns WHERE id = ?')
            .get(admitted.turnId),
        ).toMatchObject({ status: 'complete' }),
      );
      await expect(
        academicRequest(service.endpoint, 'claimDueNotifications', {
          operation: 'get-permission',
          userId: 'student-a',
        }),
      ).resolves.toBe('unknown');
    } finally {
      mocks.appListeners.get('will-quit')!({ preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.appQuit).toHaveBeenCalled());
      await service.close();
    }
  });

  it('keeps the original preview drain when a duplicate preview admission fails', async () => {
    let finishPreview!: () => void;
    mocks.startPreview
      .mockImplementationOnce(async (_userId, _prompt, onSettled) => {
        finishPreview = onSettled;
      })
      .mockRejectedValueOnce(new Error('A preview is already running.'));
    await invoke('startPreview', 'courses');
    await expect(invoke('startPreview', 'courses')).rejects.toThrow();
    let settled = false;
    const deletion = invoke('deleteLocalAcademicData', {
      requestId: randomUUID(),
      scope: 'account-local',
    }).then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(mocks.closeWorkspace).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(
        sqlite
          .prepare('SELECT COUNT(*) AS count FROM courses WHERE user_id = ?')
          .get('student-a'),
      ).toEqual({ count: 1 });
    } finally {
      finishPreview();
      await deletion;
      mocks.startPreview.mockReset();
    }
  });

  it('deletes actual SQLite and original data for only the authenticated account and then invalidates', async () => {
    expect(mocks.handlers.has('scholar:deleteLocalAcademicData')).toBe(true);
    const { createOriginalStore } =
      await import('../src/features/context/services/original-store');
    const originals = createOriginalStore();
    const removed = await originals.write(
      'student-a',
      Buffer.from('fixture A'),
    );
    const retained = await originals.write(
      'student-b',
      Buffer.from('fixture B'),
    );
    await invoke('createContextNote', {
      requestId: randomUUID(),
      title: 'Fixture note',
      text: 'Test-owned course note.',
      kind: 'note',
      courseId: 'cleanup-course-a',
    });
    mocks.publish.mockClear();
    await expect(
      invoke('deleteLocalAcademicData', {
        requestId: randomUUID(),
        scope: 'account-local',
      }),
    ).resolves.toBeUndefined();
    expect(sqlite.prepare('SELECT user_id FROM courses').all()).toEqual([
      { user_id: 'student-b' },
    ]);
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM context_items WHERE user_id = ?',
        )
        .get('student-a'),
    ).toEqual({ count: 0 });
    expect(await originals.has('student-a', removed.storageKey)).toBe(false);
    expect(await originals.read('student-b', retained.storageKey)).toEqual(
      Buffer.from('fixture B'),
    );
    expect(mocks.closeWorkspace).toHaveBeenCalled();
    expect(mocks.waitForWorkspaceStops).toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith('scholar:coursesChange', {
      accountId: 'student-a',
      courseId: null,
    });
    expect(mocks.publish).toHaveBeenCalledWith(
      'scholar:productEvent',
      expect.objectContaining({ accountId: 'student-a', resource: 'device' }),
    );
  });
});

afterAll(() => rmSync(mocks.directory, { recursive: true, force: true }));

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

  it('authorizes cached activities and releases ephemeral runs offline without allowing checkpoints', async () => {
    const authorize = vi.fn<AcademicActivityAdapter['authorizeActivityRun']>(
      async (_context, input) => activityAuthorization(input),
    );
    const checkpoint =
      vi.fn<AcademicActivityAdapter['checkpointArtifactState']>();
    const release = vi.fn<AcademicActivityAdapter['releaseActivityRun']>(
      async () => undefined,
    );
    const module: LearningActionModule = (registrar) => {
      registrar.handleInternal('authorizeActivityRun', authorize);
      registrar.handleInternal('checkpointArtifactState', checkpoint);
      registrar.handleInternal('releaseActivityRun', (_context, input) =>
        release(input),
      );
    };
    for (const method of [
      'authorizeActivityRun',
      'checkpointArtifactState',
      'releaseActivityRun',
    ])
      expect(rendererAcademicMethods).not.toContain(method);
    expect(internalOfflineReadMethods).toContain('authorizeActivityRun');
    expect(internalOfflineReadMethods).toContain('releaseActivityRun');
    await registerTestAcademicActions([module]);
    mocks.getCurrentUser.mockResolvedValue({
      id: 'student-a',
      authMode: 'offline-local',
    });
    await invoke('getCurrentUser');

    const input = activityRequest();
    await expect(invoke('authorizeActivityRun', input)).resolves.toEqual(
      activityAuthorization(input),
    );
    const releaseInput = { runId: 'run-a', requestId: input.requestId };
    await expect(
      invoke('releaseActivityRun', releaseInput),
    ).resolves.toBeUndefined();
    await expect(
      invoke('checkpointArtifactState', {
        sessionId: input.sessionId,
        artifactId: input.artifactId,
        versionId: input.versionId,
        attemptId: input.attemptId,
        runId: 'run-a',
        sequence: 1,
        baseStateRevision: 0,
        state: { frequency: 2 },
      }),
    ).rejects.toThrow('Reconnect');
    await expect(invoke('openSource', 'https://school.edu')).rejects.toThrow(
      'Reconnect',
    );

    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'student-a',
        isCurrent: expect.any(Function),
      }),
      input,
    );
    expect(release).toHaveBeenCalledWith(releaseInput);
    expect(checkpoint).not.toHaveBeenCalled();
    await registerTestAcademicActions();
  });

  it('rejects malformed internal activity requests before calling their handlers', async () => {
    const authorize = vi.fn<AcademicActivityAdapter['authorizeActivityRun']>(
      async (_context, input) => activityAuthorization(input),
    );
    const checkpoint =
      vi.fn<AcademicActivityAdapter['checkpointArtifactState']>();
    const release = vi.fn<AcademicActivityAdapter['releaseActivityRun']>(
      async () => undefined,
    );
    await registerTestAcademicActions([
      (registrar) => {
        registrar.handleInternal('authorizeActivityRun', authorize);
        registrar.handleInternal('checkpointArtifactState', checkpoint);
        registrar.handleInternal('releaseActivityRun', (_context, input) =>
          release(input),
        );
      },
    ]);
    mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
    await invoke('getCurrentUser');
    const input = activityRequest();
    const proposal = {
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      versionId: input.versionId,
      attemptId: input.attemptId,
      runId: 'run-a',
      sequence: 1,
      baseStateRevision: 0,
      state: { frequency: 2 },
    };
    const invalidRequests: [string, unknown][] = [
      ['authorizeActivityRun', { ...input, userId: 'student-b' }],
      ['authorizeActivityRun', { ...input, runId: 'renderer-chosen' }],
      ['authorizeActivityRun', { ...input, requestId: 'not-a-uuid' }],
      ['authorizeActivityRun', { ...input, sessionId: 'x'.repeat(301) }],
      ['checkpointArtifactState', { ...proposal, expectedRevision: 0 }],
      ['checkpointArtifactState', { ...proposal, sequence: 0 }],
      ['checkpointArtifactState', { ...proposal, baseStateRevision: -1 }],
      ['checkpointArtifactState', { ...proposal, state: undefined }],
      ['checkpointArtifactState', { ...proposal, state: { value: Infinity } }],
      ['checkpointArtifactState', { ...proposal, state: 'x'.repeat(65537) }],
      ['releaseActivityRun', { runId: 'run-a' }],
      [
        'releaseActivityRun',
        { requestId: input.requestId, userId: 'student-b' },
      ],
      ['releaseActivityRun', { runId: '', requestId: input.requestId }],
    ];
    for (const [method, invalidInput] of invalidRequests)
      await expect(invoke(method, invalidInput)).rejects.toMatchObject({
        code: 'invalid-input',
      });
    expect(authorize).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await registerTestAcademicActions();
  });

  it('validates private notification commands without widening renderer authority', async () => {
    const deliver = vi.fn(async () => 'unknown' as const);
    await registerTestAcademicActions([
      (registrar) => registrar.handleInternal('claimDueNotifications', deliver),
    ]);
    mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
    try {
      expect(rendererAcademicMethods).not.toContain('claimDueNotifications');
      const command = { operation: 'get-permission', userId: 'student-a' };
      await expect(invoke('claimDueNotifications', command)).resolves.toBe(
        'unknown',
      );
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'student-a' }),
        command,
      );
      deliver.mockClear();
      for (const input of [
        { ...command, path: '/private' },
        { operation: 'set-permission', userId: 'student-a', permission: 'yes' },
        {
          operation: 'claim',
          userId: 'student-a',
          now: 'invalid',
          isFocused: false,
        },
        {
          operation: 'settle',
          userId: 'student-a',
          eventId: 'event-a',
          claimedAt: '2026-11-04T00:00:00.000Z',
          now: '2026-11-04T00:00:01.000Z',
          status: 'queued',
        },
      ])
        await expect(
          invoke('claimDueNotifications', input),
        ).rejects.toMatchObject({ code: 'invalid-input' });
      expect(deliver).not.toHaveBeenCalled();
      mocks.getCurrentUser.mockResolvedValue({
        id: 'student-a',
        authMode: 'offline-local',
      });
      await expect(invoke('claimDueNotifications', command)).rejects.toThrow(
        'Reconnect',
      );
    } finally {
      await registerTestAcademicActions();
    }
  });

  it('dispatches internal activity calls to the adapter registered by the authenticated account epoch', async () => {
    const usedEpochs: number[] = [];
    const module: LearningActionModule = (registrar) => {
      let disposed = false;
      const registeredEpoch = registrar.lifecycle.epoch;
      registrar.handleInternal(
        'authorizeActivityRun',
        async (context, input) => {
          if (disposed || context.epoch !== registeredEpoch)
            throw new Error('The retired activity adapter was invoked.');
          usedEpochs.push(context.epoch);
          return activityAuthorization(input);
        },
      );
      return async () => {
        disposed = true;
      };
    };
    await registerTestAcademicActions([module]);
    try {
      mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
      await expect(
        invoke('authorizeActivityRun', activityRequest()),
      ).resolves.toMatchObject({
        runId: 'run-a',
      });
      mocks.getCookie.mockReturnValue('offline-cookie');
      mocks.getCurrentUser.mockResolvedValue({
        id: 'student-a',
        authMode: 'offline-local',
      });
      await expect(
        invoke('authorizeActivityRun', activityRequest()),
      ).resolves.toMatchObject({
        runId: 'run-a',
      });
      mocks.getCookie.mockReturnValue('account-b-cookie');
      mocks.getCurrentUser.mockResolvedValue({ id: 'student-b' });
      await expect(
        invoke('authorizeActivityRun', activityRequest()),
      ).resolves.toMatchObject({
        runId: 'run-a',
      });
      expect(new Set(usedEpochs).size).toBe(3);
    } finally {
      await registerTestAcademicActions();
    }
  });

  it('authenticates internal activity calls and fences responses when the cookie changes', async () => {
    let finishAuthorization!: () => void;
    const authorize = vi.fn<AcademicActivityAdapter['authorizeActivityRun']>(
      async (_context, input) => {
        await new Promise<void>((resolve) => {
          finishAuthorization = resolve;
        });
        return activityAuthorization(input);
      },
    );
    await registerTestAcademicActions([
      (registrar) =>
        registrar.handleInternal('authorizeActivityRun', authorize),
    ]);
    mocks.getCurrentUser.mockResolvedValue(null);
    await expect(
      invoke('authorizeActivityRun', activityRequest()),
    ).rejects.toThrow('sign in');
    expect(authorize).not.toHaveBeenCalled();
    mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
    const pending = invoke('authorizeActivityRun', activityRequest());
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    const context = authorize.mock.calls[0]![0];
    expect(context.userId).toBe('student-a');
    expect(context.isCurrent()).toBe(true);
    mocks.getCookie.mockReturnValue('replacement-cookie');
    expect(context.isCurrent()).toBe(false);
    finishAuthorization();
    await expect(pending).rejects.toThrow('Your session changed');
    await registerTestAcademicActions();
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
      activity: academicTasks.getActivity('student-a'),
      courses: [],
      sources: [],
      lastSuccessfulAt: null,
    });
    expect(mocks.startCourseRefresh).toHaveBeenCalledTimes(2);
    expect(mocks.discoverAcademicContext).not.toHaveBeenCalled();
  });

  it('reads the saved catalog without touching the study browser', async () => {
    await expect(invoke('getCourses')).resolves.toEqual({
      activity: academicTasks.getActivity('student-a'),
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
          handleInternal: () => undefined,
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
      handleInternal: () => undefined,
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
