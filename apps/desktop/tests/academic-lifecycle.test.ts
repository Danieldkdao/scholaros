import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  serviceMode: false,
  authCookie: 'test-session-a',
  windows: 0,
  listeners: new Map<string, ((event?: unknown) => void)[]>(),
  ipcHandlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  ready: vi.fn(),
  register: vi.fn(),
  request: vi.fn(),
  stop: vi.fn(),
  disconnect: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
  errorBox: vi.fn(),
  chooseFiles: vi.fn(async () => ({
    canceled: false,
    filePaths: ['/tmp/a.pdf'],
  })),
  notificationIsSupported: vi.fn(() => true),
  askForMicrophone: vi.fn(async () => true),
  setupAuth: vi.fn(),
  setupAuthMain: vi.fn(),
  registerActivityScheme: vi.fn(),
  requestAuth: vi.fn(async () => undefined),
  getTrustedWindow: vi.fn(() => ({ id: 'trusted-window' })),
  installTrustedFocusedWebContentsGuard: vi.fn(),
  requireTrustedSender: vi.fn((event: { trusted?: boolean }) => {
    if (!event.trusted) throw new Error('Untrusted application frame.');
    return event;
  }),
  runService: vi.fn(),
  loadLearningModules: vi.fn(async () => [vi.fn()]),
}));
vi.mock('electron', () => ({
  app: {
    commandLine: {
      hasSwitch: (name: string) =>
        name === 'academic-service' && mocks.serviceMode,
      getSwitchValue: () => '',
    },
    getPath: () => '/tmp/scholaros-lifecycle',
    setPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: mocks.ready,
    on: (name: string, callback: (event?: unknown) => void) =>
      mocks.listeners.set(name, [
        ...(mocks.listeners.get(name) ?? []),
        callback,
      ]),
    quit: mocks.quit,
    exit: mocks.exit,
    isPackaged: true,
    isReady: () => true,
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    webContents = {};
    constructor() {
      mocks.windows++;
    }
    loadFile() {}
    loadURL() {}
  },
  dialog: { showErrorBox: mocks.errorBox, showOpenDialog: mocks.chooseFiles },
  Notification: { isSupported: mocks.notificationIsSupported },
  systemPreferences: { askForMediaAccess: mocks.askForMicrophone },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, input?: unknown) => unknown,
    ) => mocks.ipcHandlers.set(channel, handler),
  },
  webContents: { getFocusedWebContents: () => null },
}));
vi.mock('electron-squirrel-startup', () => ({ default: false }));
vi.mock('../src/lib/auth/client', () => ({
  authClient: {
    setupMain: mocks.setupAuth,
    requestAuth: mocks.requestAuth,
    getCookie: () => mocks.authCookie,
  },
}));
vi.mock('../src/lib/auth/main', () => ({
  setupAuthMain: mocks.setupAuthMain,
  isAccountSessionCurrent: (cookie: string) => cookie === mocks.authCookie,
}));
vi.mock('../src/features/study/services/activity-protocol', () => ({
  registerActivitySchemeBeforeReady: (register: (schemes: unknown[]) => void) =>
    register([{ scheme: 'scholar-activity', privileges: {} }]),
}));
vi.mock('../src/lib/window-navigation', () => ({
  protectWindowNavigation: vi.fn(),
}));
vi.mock('../src/lib/trusted-windows', () => ({
  getTrustedWindow: mocks.getTrustedWindow,
  installTrustedFocusedWebContentsGuard:
    mocks.installTrustedFocusedWebContentsGuard,
  registerTrustedWindow: vi.fn(() => vi.fn()),
  requireTrustedSender: mocks.requireTrustedSender,
}));
vi.mock('../src/services/academic/client', () => ({
  registerAcademicClient: mocks.register,
  requestAcademicService: mocks.request,
  stopAcademicService: mocks.stop,
  disconnectAcademicService: mocks.disconnect,
}));
vi.mock('../src/services/academic/runtime', () => ({
  runAcademicService: mocks.runService,
}));
vi.mock(
  '../src/services/academic/learning-actions',
  async (importOriginal) => ({
    ...(await importOriginal()),
    loadLearningActionModules: mocks.loadLearningModules,
  }),
);
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.listeners.clear();
  mocks.ipcHandlers.clear();
  mocks.windows = 0;
  mocks.serviceMode = false;
  mocks.authCookie = 'test-session-a';
  mocks.ready.mockResolvedValue(undefined);
  mocks.register.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.runService.mockResolvedValue(undefined);
  mocks.setupAuthMain.mockImplementation(
    ({
      getWindow,
      registerActivityScheme,
    }: {
      getWindow: () => unknown;
      registerActivityScheme: (register: (schemes: unknown[]) => void) => void;
    }) => {
      mocks.setupAuth({
        csp: true,
        scheme: true,
        bridges: false,
        getWindow,
      });
      registerActivityScheme(mocks.registerActivityScheme);
    },
  );
  mocks.registerActivityScheme.mockImplementation(() => undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', '');
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
});
const emit = (name: string, event?: unknown) => {
  for (const callback of mocks.listeners.get(name) ?? []) callback(event);
};
const activeStudySnapshot = () => ({
  session: {
    id: 'session-a',
    courseId: 'course-a',
    title: 'Study',
    activity: 'understand-topic',
    targetAssignmentId: null,
    topic: null,
    status: 'in-progress',
    revision: 1,
    generationEpoch: 0,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    lastOpenedAt: '2026-11-03T00:00:00.000Z',
    draft: { text: '', revision: 0 },
    timer: {
      deadlineAt: null,
      revision: 0,
      expiredRevision: null,
      resolvedExpiredRevision: null,
      finishedAt: null,
    },
  },
  messages: [],
  hasMoreBefore: false,
  activeTurn: null,
  sourceReferences: [],
  revision: 1,
});
it('runs the service without a desktop window or renderer authentication bridges', async () => {
  mocks.serviceMode = true;
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.runService).toHaveBeenCalledOnce());
  expect(mocks.loadLearningModules).toHaveBeenCalledOnce();
  expect(mocks.runService).toHaveBeenCalledWith({
    learningModules: expect.arrayContaining([expect.any(Function)]),
  });
  expect(mocks.windows).toBe(0);
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.setupAuth).not.toHaveBeenCalled();
});
it.each([
  { backgroundSync: true, watchEnabled: false, keepsAlive: true },
  { backgroundSync: false, watchEnabled: true, keepsAlive: true },
  { backgroundSync: false, watchEnabled: false, keepsAlive: false },
])(
  'keeps the service alive only for enabled background features: %o',
  async ({ backgroundSync, watchEnabled, keepsAlive }) => {
    mocks.request.mockResolvedValue({
      settings: { backgroundSync },
      watch: {
        enabled: watchEnabled,
        status: watchEnabled ? 'watching' : 'off',
      },
    });
    await import('../src/main');
    await vi.waitFor(() => expect(mocks.windows).toBe(1));
    emit('window-all-closed');
    await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
    emit('before-quit', { preventDefault: vi.fn() });
    await vi.waitFor(() =>
      expect(keepsAlive ? mocks.disconnect : mocks.stop).toHaveBeenCalledOnce(),
    );
    expect(keepsAlive ? mocks.stop : mocks.disconnect).not.toHaveBeenCalled();
  },
);
it('stops the service on explicit Quit even when background syncing is enabled', async () => {
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  emit('before-quit', { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
  expect(mocks.disconnect).not.toHaveBeenCalled();
});
it('uses only trusted authentication windows and guards the user-initiated auth bridge', async () => {
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));

  const authConfig = mocks.setupAuth.mock.calls[0]?.[0] as {
    bridges?: boolean;
    getWindow?: () => unknown;
  };
  expect(authConfig.bridges).toBe(false);
  expect(authConfig.getWindow?.()).toEqual({ id: 'trusted-window' });
  expect(mocks.setupAuthMain).toHaveBeenCalledOnce();
  expect(mocks.registerActivityScheme).toHaveBeenCalledOnce();
  expect(mocks.setupAuthMain.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.ready.mock.invocationCallOrder[0]!,
  );
  expect(mocks.installTrustedFocusedWebContentsGuard).toHaveBeenCalledOnce();

  const requestAuth = mocks.ipcHandlers.get('better-auth:requestAuth');
  expect(requestAuth).toBeTypeOf('function');
  await expect(
    Promise.resolve().then(() => requestAuth?.({ trusted: false })),
  ).rejects.toThrow('Untrusted');
  expect(mocks.requestAuth).not.toHaveBeenCalled();
  await expect(requestAuth?.({ trusted: true })).resolves.toBeUndefined();
  expect(mocks.requestAuth).toHaveBeenCalledOnce();
});

it('does not settle authentication IPC after the trusted frame changes', async () => {
  let resolveAuth: ((value: undefined) => void) | undefined;
  mocks.requestAuth.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        resolveAuth = resolve;
      }),
  );
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestAuth = mocks.ipcHandlers.get('better-auth:requestAuth');
  const event = { trusted: true };
  const pendingAuth = requestAuth?.(event);
  await vi.waitFor(() => expect(mocks.requestAuth).toHaveBeenCalledOnce());
  event.trusted = false;
  resolveAuth?.(undefined);

  await expect(pendingAuth).rejects.toThrow('Untrusted');
});

it('keeps native file selection behind the trusted host and service boundary', async () => {
  mocks.request.mockImplementation(async (method) =>
    method === 'getCurrentUser'
      ? { id: 'student-a', authMode: 'online' }
      : {
          items: [
            {
              itemId: 'item-a',
              operationId: 'operation-a',
              status: 'queued',
            },
          ],
          cancelled: false,
        },
  );
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));

  const chooseContextFiles = mocks.ipcHandlers.get(
    'scholar:native:chooseContextFiles',
  );
  expect(chooseContextFiles).toBeTypeOf('function');
  await expect(
    chooseContextFiles?.({ trusted: false }, { saveToLibrary: true }),
  ).rejects.toThrow('Untrusted');
  expect(mocks.chooseFiles).not.toHaveBeenCalled();

  await expect(
    chooseContextFiles?.({ trusted: true }, { saveToLibrary: true }),
  ).resolves.toMatchObject({ cancelled: false, items: [{ itemId: 'item-a' }] });
  expect(mocks.chooseFiles).toHaveBeenCalledOnce();
  expect(mocks.request).toHaveBeenCalledWith('registerSelectedContextFiles', {
    filePaths: ['/tmp/a.pdf'],
    saveToLibrary: true,
  });
});

it('rejects file selection when the trusted frame changes during the native dialog', async () => {
  let resolveSelection:
    | ((selection: { canceled: boolean; filePaths: string[] }) => void)
    | undefined;
  mocks.chooseFiles.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSelection = resolve;
      }),
  );
  mocks.request.mockImplementation(async (method) =>
    method === 'getCurrentUser'
      ? { id: 'student-a', authMode: 'online' }
      : { items: [], cancelled: false },
  );
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));

  const chooseContextFiles = mocks.ipcHandlers.get(
    'scholar:native:chooseContextFiles',
  );
  const event = { trusted: true };
  const pendingSelection = chooseContextFiles?.(event, { saveToLibrary: true });
  await vi.waitFor(() => expect(mocks.chooseFiles).toHaveBeenCalledOnce());
  event.trusted = false;
  resolveSelection?.({ canceled: false, filePaths: ['/tmp/a.pdf'] });

  await expect(pendingSelection).rejects.toThrow('Untrusted');
  expect(mocks.request).not.toHaveBeenCalledWith(
    'registerSelectedContextFiles',
    expect.anything(),
  );
});

it('does not return file tickets after the trusted frame changes during registration', async () => {
  let resolveRegistration:
    | ((result: {
        items: { itemId: string; operationId: string; status: string }[];
        cancelled: boolean;
      }) => void)
    | undefined;
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser')
      return { id: 'student-a', authMode: 'online' };
    return new Promise((resolve) => {
      resolveRegistration = resolve;
    });
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));

  const chooseContextFiles = mocks.ipcHandlers.get(
    'scholar:native:chooseContextFiles',
  );
  const event = { trusted: true };
  const pendingSelection = chooseContextFiles?.(event, { saveToLibrary: true });
  await vi.waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      'registerSelectedContextFiles',
      expect.anything(),
    ),
  );
  event.trusted = false;
  resolveRegistration?.({
    items: [{ itemId: 'item-a', operationId: 'operation-a', status: 'queued' }],
    cancelled: false,
  });

  await expect(pendingSelection).rejects.toThrow('Untrusted');
});

it('does not return file tickets after the account changes during registration', async () => {
  let currentAccountId = 'student-a';
  let resolveRegistration:
    | ((result: {
        items: { itemId: string; operationId: string; status: string }[];
        cancelled: boolean;
      }) => void)
    | undefined;
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser')
      return { id: currentAccountId, authMode: 'online' };
    return new Promise((resolve) => {
      resolveRegistration = resolve;
    });
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));

  const chooseContextFiles = mocks.ipcHandlers.get(
    'scholar:native:chooseContextFiles',
  );
  const pendingSelection = chooseContextFiles?.(
    { trusted: true },
    { saveToLibrary: true },
  );
  await vi.waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      'registerSelectedContextFiles',
      expect.anything(),
    ),
  );
  currentAccountId = 'student-b';
  resolveRegistration?.({
    items: [{ itemId: 'item-a', operationId: 'operation-a', status: 'queued' }],
    cancelled: false,
  });

  await expect(pendingSelection).rejects.toThrow('Your session changed');
});

it('requests microphone access only for a trusted active study session', async () => {
  mocks.request.mockImplementation(async (method) =>
    method === 'getCurrentUser'
      ? { id: 'student-a', authMode: 'online' }
      : activeStudySnapshot(),
  );
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestMicrophonePermission',
  );

  await expect(
    requestPermission?.({ trusted: true }, { sessionId: 'session-a' }),
  ).resolves.toEqual({
    state: process.platform === 'darwin' ? 'granted' : 'unsupported',
  });
  if (process.platform === 'darwin')
    expect(mocks.askForMicrophone).toHaveBeenCalledWith('microphone');
  else expect(mocks.askForMicrophone).not.toHaveBeenCalled();
});

it('does not request microphone access when the account changes during session verification', async () => {
  let currentAccountId = 'student-a';
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser')
      return { id: currentAccountId, authMode: 'online' };
    currentAccountId = 'student-b';
    return activeStudySnapshot();
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestMicrophonePermission',
  );

  await expect(
    requestPermission?.({ trusted: true }, { sessionId: 'session-a' }),
  ).rejects.toThrow('Your session changed');
  expect(mocks.askForMicrophone).not.toHaveBeenCalled();
});

it('does not return microphone permission after the trusted frame changes during the OS prompt', async () => {
  let resolvePermission: ((granted: boolean) => void) | undefined;
  mocks.askForMicrophone.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
  );
  mocks.request.mockImplementation(async (method) =>
    method === 'getCurrentUser'
      ? { id: 'student-a', authMode: 'online' }
      : activeStudySnapshot(),
  );
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestMicrophonePermission',
  );
  const event = { trusted: true };
  const pendingPermission = requestPermission?.(event, {
    sessionId: 'session-a',
  });
  await vi.waitFor(() => expect(mocks.askForMicrophone).toHaveBeenCalledOnce());
  event.trusted = false;
  resolvePermission?.(true);

  await expect(pendingPermission).rejects.toThrow('Untrusted');
});

it('does not return microphone permission after the study session ends during the OS prompt', async () => {
  let resolvePermission: ((granted: boolean) => void) | undefined;
  mocks.askForMicrophone.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePermission = resolve;
      }),
  );
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser')
      return { id: 'student-a', authMode: 'online' };
    const snapshot = activeStudySnapshot();
    if (mocks.askForMicrophone.mock.calls.length > 0)
      snapshot.session.status = 'finished';
    return snapshot;
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestMicrophonePermission',
  );
  const pendingPermission = requestPermission?.(
    { trusted: true },
    { sessionId: 'session-a' },
  );
  await vi.waitFor(() => expect(mocks.askForMicrophone).toHaveBeenCalledOnce());
  resolvePermission?.(true);

  await expect(pendingPermission).rejects.toThrow(
    'Open an active study session',
  );
});

it('does not request microphone permission for an offline account', async () => {
  mocks.request.mockResolvedValue({
    id: 'student-a',
    authMode: 'offline-local',
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestMicrophonePermission',
  );

  await expect(
    requestPermission?.({ trusted: true }, { sessionId: 'session-a' }),
  ).rejects.toThrow('Reconnect');
  expect(mocks.askForMicrophone).not.toHaveBeenCalled();
});

it('reports notification permission as unknown rather than treating support as a grant', async () => {
  mocks.request.mockResolvedValue({ id: 'student-a', authMode: 'online' });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestNotificationPermission',
  );

  await expect(requestPermission?.({ trusted: true }, {})).resolves.toEqual({
    state: 'unknown',
  });
  expect(mocks.notificationIsSupported).toHaveBeenCalledOnce();
});

it('rejects notification permission lookup when the trusted frame changes during account verification', async () => {
  let event: { trusted: boolean } = { trusted: true };
  mocks.request.mockImplementation(async (_method) => {
    event.trusted = false;
    return { id: 'student-a', authMode: 'online' };
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestNotificationPermission',
  );

  await expect(requestPermission?.(event, {})).rejects.toThrow('Untrusted');
  expect(mocks.notificationIsSupported).not.toHaveBeenCalled();
});

it('rejects native IPC when the same account session changes during verification', async () => {
  mocks.request.mockImplementation(async (_method) => {
    mocks.authCookie = 'test-session-b';
    return { id: 'student-a', authMode: 'online' };
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestNotificationPermission',
  );

  await expect(requestPermission?.({ trusted: true }, {})).rejects.toThrow(
    'Your session changed',
  );
  expect(mocks.notificationIsSupported).not.toHaveBeenCalled();
});

it('shows a useful startup failure before exiting when storage ownership cannot be acquired', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.register.mockRejectedValueOnce(
    new Error('Close the previous ScholarOS instance.'),
  );
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1));
  expect(mocks.errorBox).toHaveBeenCalledWith(
    'ScholarOS could not start',
    'Close the previous ScholarOS instance.',
  );
  logged.mockRestore();
});
