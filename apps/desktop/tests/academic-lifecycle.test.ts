import { beforeEach, expect, it, vi } from 'vitest';
import { createActivityContentDigest } from '../src/features/study/services/activity-policy';
import type {
  ActivityManagerDependencies,
  ActivityMountInput,
  AuthorizedActivityRun as RuntimeAuthorizedActivityRun,
} from '../src/features/study/services/activity-runtime';
import type { DictationHostAdapterDependencies } from '../src/services/academic/dictation-host-adapter';
import type { NotificationHostAdapterDependencies } from '../src/services/academic/notification-host-adapter';
import type { AcademicClientLifecycle } from '../src/services/academic/client';
const mocks = vi.hoisted(() => ({
  serviceMode: false,
  authCookie: 'test-session-a',
  windows: 0,
  hostWindows: [] as {
    webContents: {
      id: number;
      mainFrame: { url: string };
      send: ReturnType<typeof vi.fn>;
      isDestroyed: () => boolean;
      getURL: () => string;
      executeJavaScript: ReturnType<typeof vi.fn>;
    };
    isDestroyed: () => boolean;
    close: ReturnType<typeof vi.fn>;
    isFocused: () => boolean;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    emit: (name: string, event?: unknown) => void;
  }[],
  activityDependencies: null as ActivityManagerDependencies | null,
  createActivityManager: vi.fn(),
  mountActivity: vi.fn(),
  updateActivityBounds: vi.fn(),
  hideActivity: vi.fn(),
  retryActivity: vi.fn(),
  closeActivity: vi.fn(),
  disposeActivities: vi.fn(),
  dictationDependencies: null as DictationHostAdapterDependencies | null,
  createDictationHost: vi.fn(),
  startDictation: vi.fn(),
  appendDictationAudio: vi.fn(),
  stopDictation: vi.fn(),
  cancelDictation: vi.fn(),
  disposeDictation: vi.fn(),
  cancelSessionDictation: vi.fn(),
  fetch: vi.fn(),
  notificationDependencies: null as NotificationHostAdapterDependencies | null,
  createNotificationHost: vi.fn(),
  deliverNotifications: vi.fn(),
  notificationClick: vi.fn(),
  notificationFocus: vi.fn(),
  notificationPermission: vi.fn(),
  disposeNotifications: vi.fn(),
  nativeNotifications: [] as {
    emit: (name: string) => void;
    close: ReturnType<typeof vi.fn>;
    options: unknown;
  }[],
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
  openExternal: vi.fn(async () => undefined),
  askForMicrophone: vi.fn(async () => true),
  setupAuth: vi.fn(),
  setupAuthMain: vi.fn(),
  registerActivityScheme: vi.fn(),
  requestAuth: vi.fn(async () => undefined),
  getTrustedWindow: vi.fn(() => ({ id: 'trusted-window' })),
  installTrustedFocusedWebContentsGuard: vi.fn(),
  requireTrustedSender: vi.fn(
    (event: { trusted?: boolean; window?: unknown }) => {
      if (!event.trusted) throw new Error('Untrusted application frame.');
      return event.window ?? mocks.hostWindows[0];
    },
  ),
  runService: vi.fn(),
  loadLearningModules: vi.fn(async () => [vi.fn()]),
}));
vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
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
    webContents = {
      id: mocks.windows + 1,
      mainFrame: { url: 'file:///scholaros/index.html' },
      send: vi.fn(),
      isDestroyed: () => false,
      getURL: () => 'file:///scholaros/index.html',
      executeJavaScript: vi.fn(async () => 'denied'),
    };
    windowListeners = new Map<string, ((event?: unknown) => void)[]>();
    isDestroyed = () => false;
    isFocused = () => false;
    show = vi.fn();
    focus = vi.fn();
    loadURL = vi.fn(async () => undefined);
    close = vi.fn();
    on(name: string, callback: (event?: unknown) => void) {
      this.windowListeners.set(name, [
        ...(this.windowListeners.get(name) ?? []),
        callback,
      ]);
    }
    once(name: string, callback: (event?: unknown) => void) {
      this.on(name, callback);
    }
    emit(name: string, event?: unknown) {
      for (const callback of this.windowListeners.get(name) ?? [])
        callback(event);
    }
    constructor() {
      mocks.windows++;
      mocks.hostWindows.push(this);
    }
    loadFile() {}
  },
  dialog: { showErrorBox: mocks.errorBox, showOpenDialog: mocks.chooseFiles },
  Notification: class {
    static isSupported = mocks.notificationIsSupported;
    listeners = new Map<string, (() => void)[]>();
    constructor(public options: unknown) {
      mocks.nativeNotifications.push(this);
    }
    on(name: string, listener: () => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    }
    once(name: string, listener: () => void) {
      return this.on(name, listener);
    }
    emit(name: string) {
      for (const listener of this.listeners.get(name) ?? []) listener();
    }
    show() {
      this.emit('show');
    }
    close = vi.fn(() => this.emit('close'));
  },
  systemPreferences: {
    askForMediaAccess: mocks.askForMicrophone,
    getMediaAccessStatus: () => 'granted',
  },
  net: { fetch: mocks.fetch },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, input?: unknown) => unknown,
    ) => mocks.ipcHandlers.set(channel, handler),
  },
  webContents: { getFocusedWebContents: () => null },
}));
vi.mock('electron-squirrel-startup', () => ({ default: false }));
vi.mock('../src/data/env/client', () => ({
  clientEnv: { VITE_API_URL: 'https://account.example' },
}));
vi.mock('../src/services/academic/dictation-host-adapter', () => ({
  createDictationHostAdapter: mocks.createDictationHost,
}));
vi.mock('../src/services/academic/notification-host-adapter', () => ({
  createNotificationHostAdapter: mocks.createNotificationHost,
}));
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
  getTrustedWindows: () => mocks.hostWindows,
  isTrustedWebContents: (contents: unknown) =>
    mocks.hostWindows.some((window) => window.webContents === contents),
  installTrustedFocusedWebContentsGuard:
    mocks.installTrustedFocusedWebContentsGuard,
  registerTrustedWindow: vi.fn(() => vi.fn()),
  requireTrustedSender: mocks.requireTrustedSender,
}));
vi.mock('../src/features/study/services/activity-runtime', () => ({
  createActivityManager: mocks.createActivityManager,
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
  mocks.hostWindows = [];
  mocks.activityDependencies = null;
  mocks.dictationDependencies = null;
  mocks.notificationDependencies = null;
  mocks.nativeNotifications = [];
  mocks.createNotificationHost.mockImplementation((dependencies) => {
    mocks.notificationDependencies = dependencies;
    return {
      deliverDueNotifications: mocks.deliverNotifications,
      handleClick: mocks.notificationClick,
      setFocus: mocks.notificationFocus,
      setPermission: mocks.notificationPermission,
      clearAccount: vi.fn(),
      dispose: mocks.disposeNotifications,
    };
  });
  mocks.deliverNotifications.mockResolvedValue(undefined);
  mocks.notificationFocus.mockResolvedValue(undefined);
  mocks.notificationPermission.mockResolvedValue(undefined);
  mocks.disposeNotifications.mockResolvedValue(undefined);
  mocks.createDictationHost.mockImplementation((dependencies) => {
    mocks.dictationDependencies = dependencies;
    return {
      startDictation: mocks.startDictation,
      appendDictationAudio: mocks.appendDictationAudio,
      stopDictation: mocks.stopDictation,
      cancelDictation: mocks.cancelDictation,
      cancelForSession: mocks.cancelSessionDictation,
      dispose: mocks.disposeDictation,
    };
  });
  mocks.startDictation.mockResolvedValue({ operationId: 'dictation-a' });
  mocks.appendDictationAudio.mockResolvedValue({ acceptedSequence: 0 });
  mocks.stopDictation.mockResolvedValue(undefined);
  mocks.cancelDictation.mockResolvedValue(undefined);
  mocks.cancelSessionDictation.mockResolvedValue(undefined);
  mocks.disposeDictation.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async () =>
    Response.json({ operationId: 'dictation-a' }),
  );
  mocks.createActivityManager.mockImplementation((dependencies) => {
    mocks.activityDependencies = dependencies;
    return {
      mount: mocks.mountActivity,
      updateBounds: mocks.updateActivityBounds,
      hide: mocks.hideActivity,
      retryCheckpoint: mocks.retryActivity,
      close: mocks.closeActivity,
      dispose: mocks.disposeActivities,
    };
  });
  mocks.mountActivity.mockImplementation(async (input: ActivityMountInput) => {
    const request = {
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      versionId: input.versionId,
      attemptId: input.attemptId,
      requestId: '11111111-1111-4111-8111-111111111111',
    };
    const run = await mocks
      .activityDependencies!.authorizeRun(request)
      .catch(async (error) => {
        await mocks.activityDependencies!.releaseRun({
          requestId: request.requestId,
        });
        throw error;
      });
    if (!run) throw new Error('Not authorized');
    mocks.activityDependencies!.onRuntimeReady?.(run.runId);
    return { runId: run.runId };
  });
  mocks.disposeActivities.mockResolvedValue(undefined);
  mocks.closeActivity.mockResolvedValue(undefined);
  mocks.retryActivity.mockResolvedValue(undefined);
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
const activityInput = () => ({
  sessionId: 'session-a',
  artifactId: 'artifact-a',
  versionId: 'version-a',
  attemptId: 'attempt-a',
  presentation: 'inline',
  readOnly: false,
  bounds: { x: 10, y: 20, width: 400, height: 300 },
});
const activityAuthorization = (): RuntimeAuthorizedActivityRun => {
  const bundle = {
    html: '<p>Explore</p>',
    css: 'p { display: block; }',
    sdk: 'globalThis.sdk = true;',
    javascript: 'globalThis.started = true;',
  };
  return {
    ...bundle,
    sessionId: 'session-a',
    artifactId: 'artifact-a',
    versionId: 'version-a',
    attemptId: 'attempt-a',
    runId: 'run-a',
    runtimeVersion: 'activity-runtime-v1',
    contentDigest: 'a'.repeat(64),
    runtimeDigest: createActivityContentDigest(bundle),
    stateRevision: 3,
    initialState: { answer: 2 },
  };
};
const mockActivityService = (authMode = 'online') => {
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser') return { id: 'student-a', authMode };
    if (method === 'getStudySession') return activeStudySnapshot();
    if (method === 'authorizeActivityRun') return activityAuthorization();
    if (method === 'releaseActivityRun') return undefined;
    throw new Error(`Unexpected service method: ${method}`);
  });
};
const activityEvent = (window = mocks.hostWindows[0]!) => ({
  trusted: true,
  window,
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});
const dictationInput = () => ({
  requestId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'session-a',
  composerRevision: 0,
});
it('binds one native notification owner and fences persisted events, safe clicks and teardown', async () => {
  mocks.request.mockImplementation(async (method) =>
    method === 'getStudySession'
      ? activeStudySnapshot()
      : { id: 'student-a', authMode: 'online' },
  );
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const lifecycle = mocks.register.mock.calls[0][0] as AcademicClientLifecycle;
  expect(lifecycle.onAccountReady).toBeTypeOf('function');
  await Promise.all([
    lifecycle.onAccountReady?.({ id: 'student-a', authMode: 'online' }),
    lifecycle.onAccountReady?.({ id: 'student-a', authMode: 'online' }),
  ]);
  expect(mocks.createNotificationHost).toHaveBeenCalledOnce();
  const context = mocks.deliverNotifications.mock.calls[0][0];
  expect(context.userId).toBe('student-a');
  const deps = mocks.notificationDependencies!;
  const onClick = vi.fn();
  await expect(
    deps.show({
      eventId: 'notification-a',
      title: 'ScholarOS',
      body: 'Your study response is ready.',
      onClick,
    }),
  ).resolves.toBe('shown');
  expect(mocks.nativeNotifications[0].options).toMatchObject({
    title: 'ScholarOS',
    body: 'Your study response is ready.',
  });
  mocks.nativeNotifications[0].emit('click');
  expect(onClick).toHaveBeenCalledOnce();
  await deps.route({ kind: 'study', sessionId: 'session-a' });
  expect(mocks.hostWindows[0].loadURL).toHaveBeenCalledWith(
    'file:///scholaros/index.html#/study/session-a',
  );
  await expect(
    Promise.resolve().then(() =>
      deps.route({ kind: 'external', url: 'https://hostile.example' } as never),
    ),
  ).rejects.toThrow();
  await lifecycle.onIdentityChange?.();
  expect(mocks.disposeNotifications).toHaveBeenCalledOnce();
  expect(context.isCurrent()).toBe(false);
  expect(mocks.nativeNotifications[0].close).toHaveBeenCalledOnce();
  const delivered = mocks.deliverNotifications.mock.calls.length;
  lifecycle.onServiceEvent?.('scholar:productEvent', {
    accountId: 'student-a',
  });
  await Promise.resolve();
  expect(mocks.deliverNotifications).toHaveBeenCalledTimes(delivered);
});

it('binds dictation to the exact trusted online document and originating owner', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const start = mocks.ipcHandlers.get('scholar:native:startDictation');
  expect(start).toBeTypeOf('function');
  await expect(start!({ trusted: false }, dictationInput())).rejects.toThrow(
    'Untrusted',
  );
  await expect(
    start!(activityEvent(), { ...dictationInput(), accountId: 'other' }),
  ).rejects.toThrow();
  const event = activityEvent();
  await expect(start!(event, dictationInput())).resolves.toEqual({
    operationId: 'dictation-a',
  });
  expect(mocks.startDictation).toHaveBeenCalledWith(dictationInput(), {
    accountId: 'student-a',
    senderId: 1,
  });
  const scope = {
    accountId: 'student-a',
    senderId: 1,
    sessionId: 'session-a',
    composerRevision: 0,
    operationId: 'dictation-a',
  };
  await expect(mocks.dictationDependencies!.isCurrent(scope)).resolves.toBe(
    true,
  );
  const dictationEvent = {
    version: 1 as const,
    operationId: 'dictation-a',
    sessionId: 'session-a',
    composerRevision: 0,
    sequence: 0,
    kind: 'ready' as const,
  };
  mocks.dictationDependencies!.publishEvent(1, dictationEvent);
  expect(event.sender.send).toHaveBeenCalledWith(
    'scholar:native:dictationEvent',
    dictationEvent,
  );
  event.sender.send.mockClear();
  event.sender.mainFrame = { url: 'https://outside.example' };
  await expect(mocks.dictationDependencies!.isCurrent(scope)).resolves.toBe(
    false,
  );
  mocks.dictationDependencies!.publishEvent(1, dictationEvent);
  expect(event.sender.send).not.toHaveBeenCalled();
});
it('admits only one pending dictation and fences a pre-delete authorization after the native gate reopens', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  let finish!: (value: ReturnType<typeof activeStudySnapshot>) => void;
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser') return { id: 'student-a' };
    if (method === 'getStudySession')
      return new Promise((resolve) => {
        finish = resolve;
      });
    throw new Error('Unexpected method');
  });
  const start = mocks.ipcHandlers.get('scholar:native:startDictation')!;
  const pending = Promise.resolve(start(activityEvent(), dictationInput()));
  const rejected = expect(pending).rejects.toThrow('session changed');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await expect(start(activityEvent(), dictationInput())).rejects.toThrow(
    'already active',
  );
  const lifecycle = mocks.register.mock.calls[0]![0] as {
    beforeLocalDataDelete: () => Promise<void>;
    afterLocalDataDelete: () => Promise<void>;
  };
  await lifecycle.beforeLocalDataDelete();
  await lifecycle.afterLocalDataDelete();
  mockActivityService();
  finish(activeStudySnapshot());
  await rejected;
  expect(mocks.createDictationHost).not.toHaveBeenCalled();
});
it('authenticates only fixed dictation routes and rejects offline or foreign native commands', async () => {
  mockActivityService('offline-local');
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const start = mocks.ipcHandlers.get('scholar:native:startDictation')!;
  expect(start).toBeTypeOf('function');
  await expect(start(activityEvent(), dictationInput())).rejects.toThrow(
    'Reconnect',
  );
  expect(mocks.startDictation).not.toHaveBeenCalled();
  mockActivityService();
  await start(activityEvent(), dictationInput());
  await mocks.dictationDependencies!.authorizedFetch('/api/dictation', {
    method: 'POST',
    body: '{}',
  });
  expect(mocks.fetch).toHaveBeenCalledWith(
    'https://account.example/api/dictation',
    expect.objectContaining({
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    }),
  );
  const request = mocks.fetch.mock.calls[0]![1] as RequestInit;
  expect(new Headers(request.headers).get('cookie')).toBe('test-session-a');
  await expect(
    mocks.dictationDependencies!.authorizedFetch(
      'https://outside.example' as never,
      { method: 'POST' },
    ),
  ).rejects.toThrow();
  const foreign = {
    ...activityEvent(),
    sender: { ...activityEvent().sender, id: 2 },
  };
  for (const method of [
    'appendDictationAudio',
    'stopDictation',
    'cancelDictation',
  ]) {
    const invoke = mocks.ipcHandlers.get(`scholar:native:${method}`)!;
    await expect(
      invoke(foreign, {
        operationId: 'dictation-a',
        sequence: 0,
        bytes: new Uint8Array(2),
      }),
    ).rejects.toThrow();
  }
});
it('awaits dictation settlement before local data deletion and closes native admission until released', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const start = mocks.ipcHandlers.get('scholar:native:startDictation')!;
  expect(start).toBeTypeOf('function');
  await start(activityEvent(), dictationInput());
  let finish!: () => void;
  mocks.disposeDictation.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const lifecycle = mocks.register.mock.calls[0]![0] as {
    beforeLocalDataDelete: () => Promise<void>;
    afterLocalDataDelete: () => Promise<void>;
  };
  let settled = false;
  const deleting = lifecycle.beforeLocalDataDelete().then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await expect(start(activityEvent(), dictationInput())).rejects.toThrow();
  expect(settled).toBe(false);
  finish();
  await deleting;
  await expect(start(activityEvent(), dictationInput())).rejects.toThrow();
  await lifecycle.afterLocalDataDelete();
  await expect(start(activityEvent(), dictationInput())).resolves.toEqual({
    operationId: 'dictation-a',
  });
});
it('mounts a native activity contract with host-derived offline read-only and rejects hostile senders', async () => {
  mockActivityService('offline-local');
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const mount = mocks.ipcHandlers.get('scholar:native:mountActivity');
  expect(mount).toBeTypeOf('function');
  await expect(mount!({ trusted: false }, activityInput())).rejects.toThrow(
    'Untrusted',
  );
  expect(mocks.mountActivity).not.toHaveBeenCalled();
  const event = activityEvent();
  await expect(mount!(event, activityInput())).resolves.toEqual({
    runId: 'run-a',
  });
  expect(mocks.createActivityManager).toHaveBeenCalledOnce();
  expect(mocks.mountActivity).toHaveBeenCalledWith({
    hostWindow: event.window,
    sessionId: 'session-a',
    artifactId: 'artifact-a',
    versionId: 'version-a',
    attemptId: 'attempt-a',
    readOnly: true,
    bounds: activityInput().bounds,
  });
  expect(mocks.request).toHaveBeenCalledWith('authorizeActivityRun', {
    sessionId: 'session-a',
    artifactId: 'artifact-a',
    versionId: 'version-a',
    attemptId: 'attempt-a',
    requestId: '11111111-1111-4111-8111-111111111111',
  });
  expect(
    mocks.activityDependencies!.requireTrustedSender(event.sender as never),
  ).toBe(true);
  expect(mocks.activityDependencies!.requireTrustedSender({} as never)).toBe(
    false,
  );
  expect(mocks.activityDependencies!.getTrustedRenderers()).toEqual([
    event.sender,
  ]);
  await vi.waitFor(() =>
    expect(event.sender.send).toHaveBeenCalledWith(
      'scholar:native:activityChange',
      {
        kind: 'ready',
        runId: 'run-a',
        sessionId: 'session-a',
        artifactId: 'artifact-a',
        versionId: 'version-a',
        attemptId: 'attempt-a',
        runtimeVersion: 'activity-runtime-v1',
        contentDigest: 'a'.repeat(64),
        stateRevision: 3,
      },
    ),
  );
});
it('projects validated artifact checkpoint revisions and routes host retry without renderer state', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const event = activityEvent();
  await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
    event,
    activityInput(),
  );
  const proposal = {
    sessionId: 'session-a',
    artifactId: 'artifact-a',
    versionId: 'version-a',
    attemptId: 'attempt-a',
    runId: 'run-a',
    sequence: 2,
    baseStateRevision: 3,
    state: { answer: 4 },
  };
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser') return { id: 'student-a' };
    if (method === 'getStudySession') return activeStudySnapshot();
    if (method === 'checkpointArtifactState')
      return {
        artifactId: 'artifact-a',
        versionId: 'version-a',
        attemptId: 'attempt-a',
        state: proposal.state,
        stateRevision: 4,
        updatedAt: '2026-11-03T00:00:00.000Z',
      };
    if (method === 'releaseActivityRun') return undefined;
    throw new Error(`Unexpected method: ${method}`);
  });
  await expect(
    mocks.activityDependencies!.persistState(proposal),
  ).resolves.toEqual({ revision: 4 });
  expect(mocks.request).toHaveBeenCalledWith(
    'checkpointArtifactState',
    proposal,
  );
  const retry = mocks.ipcHandlers.get('scholar:native:retryActivityCheckpoint');
  expect(retry).toBeTypeOf('function');
  await expect(retry!(event, { runId: 'run-a' })).resolves.toBeUndefined();
  expect(mocks.retryActivity).toHaveBeenCalledWith({ runId: 'run-a' });
  await expect(retry!(event, { runId: 'run-a', state: {} })).rejects.toThrow();
  mocks.activityDependencies!.onStateAcknowledged?.('run-a', 4);
  mocks.activityDependencies!.onStateFailure?.('run-a');
  await vi.waitFor(() =>
    expect(event.sender.send).toHaveBeenCalledWith(
      'scholar:native:activityChange',
      expect.objectContaining({
        kind: 'checkpoint-failed',
        runId: 'run-a',
        stateRevision: 4,
        errorCode: 'storage-failed',
      }),
    ),
  );
  await mocks.activityDependencies!.releaseRun({
    runId: 'run-a',
    requestId: '11111111-1111-4111-8111-111111111111',
  });
  expect(mocks.request).toHaveBeenCalledWith('releaseActivityRun', {
    runId: 'run-a',
    requestId: '11111111-1111-4111-8111-111111111111',
  });
});
it('fences bounds, hide, retry and close by originating window and exact run', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const event = activityEvent();
  await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
    event,
    activityInput(),
  );
  const other = {
    ...event.window,
    webContents: { ...event.sender, send: vi.fn() },
  };
  mocks.hostWindows.push(other);
  const otherEvent = activityEvent(other);
  for (const channel of [
    'updateActivityBounds',
    'retryActivityCheckpoint',
    'closeActivity',
  ]) {
    const invoke = mocks.ipcHandlers.get(`scholar:native:${channel}`);
    expect(invoke).toBeTypeOf('function');
    const input =
      channel === 'updateActivityBounds'
        ? { runId: 'run-a', bounds: activityInput().bounds, visible: true }
        : { runId: 'run-a' };
    await expect(invoke!(otherEvent, input)).rejects.toThrow('scope');
    await expect(
      invoke!(event, { ...input, runId: 'other-run' }),
    ).rejects.toThrow('scope');
    await expect(invoke!({ trusted: false }, input)).rejects.toThrow(
      'Untrusted',
    );
  }
  const bounds = mocks.ipcHandlers.get('scholar:native:updateActivityBounds')!;
  await bounds(event, {
    runId: 'run-a',
    bounds: activityInput().bounds,
    visible: true,
  });
  expect(mocks.updateActivityBounds).toHaveBeenCalledWith(
    'run-a',
    activityInput().bounds,
    true,
  );
  await bounds(event, {
    runId: 'run-a',
    bounds: activityInput().bounds,
    visible: false,
  });
  expect(mocks.hideActivity).toHaveBeenCalledWith('run-a');
  expect(mocks.mountActivity).toHaveBeenCalledOnce();
  await mocks.ipcHandlers.get('scholar:native:closeActivity')!(event, {
    runId: 'run-a',
  });
  expect(mocks.closeActivity).toHaveBeenCalledWith('run-a');
  expect(other.webContents.send).not.toHaveBeenCalled();
});
it.each([
  { stateRevision: -1 },
  { stateRevision: 1.5 },
  { stateRevision: Number.MAX_SAFE_INTEGER + 1 },
  { artifactId: 'other-artifact' },
  { versionId: 'other-version' },
  { attemptId: 'other-attempt' },
])(
  'rejects malformed or cross-scope checkpoint responses: %o',
  async (invalid) => {
    mockActivityService();
    await import('../src/main');
    await vi.waitFor(() => expect(mocks.windows).toBe(1));
    await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
      activityEvent(),
      activityInput(),
    );
    mocks.request.mockImplementation(async (method) => {
      if (method === 'getCurrentUser') return { id: 'student-a' };
      if (method === 'getStudySession') return activeStudySnapshot();
      return {
        artifactId: 'artifact-a',
        versionId: 'version-a',
        attemptId: 'attempt-a',
        state: {},
        stateRevision: 4,
        updatedAt: '2026-11-03T00:00:00.000Z',
        ...invalid,
      };
    });
    await expect(
      mocks.activityDependencies!.persistState({
        sessionId: 'session-a',
        artifactId: 'artifact-a',
        versionId: 'version-a',
        attemptId: 'attempt-a',
        runId: 'run-a',
        sequence: 2,
        baseStateRevision: 3,
        state: {},
      }),
    ).rejects.toThrow();
  },
);
it.each([
  'identity',
  'session-delete',
  'disconnect',
  'quit',
  'window-close',
  'window-destroyed',
])(
  'awaits activity disposal at the real %s lifecycle boundary',
  async (boundary) => {
    mockActivityService();
    await import('../src/main');
    await vi.waitFor(() => expect(mocks.windows).toBe(1));
    const event = activityEvent();
    await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
      event,
      activityInput(),
    );
    let finish!: () => void;
    mocks.disposeActivities.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const lifecycle = mocks.register.mock.calls[0]![0] as {
      onIdentityChange: () => Promise<void>;
      beforeSessionDelete: (sessionId: string) => Promise<void>;
      beforeDisconnect: () => Promise<void>;
    };
    const preventDefault = vi.fn();
    let operation: Promise<void> | undefined;
    if (boundary === 'identity') operation = lifecycle.onIdentityChange();
    if (boundary === 'session-delete')
      operation = lifecycle.beforeSessionDelete('session-a');
    if (boundary === 'disconnect') operation = lifecycle.beforeDisconnect();
    if (boundary === 'quit') emit('before-quit', { preventDefault });
    if (boundary === 'window-close')
      event.window.emit('close', { preventDefault });
    if (boundary === 'window-destroyed') {
      event.window.emit('closed');
      emit('window-all-closed');
    }
    await vi.waitFor(() =>
      expect(mocks.disposeActivities).toHaveBeenCalledOnce(),
    );
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(event.window.close).not.toHaveBeenCalled();
    if (boundary === 'quit' || boundary === 'window-close')
      expect(preventDefault).toHaveBeenCalledOnce();
    let settled = false;
    const settlement = operation?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    if (operation) expect(settled).toBe(false);
    finish();
    await settlement;
    if (boundary === 'quit')
      await vi.waitFor(() => expect(mocks.stop).toHaveBeenCalledOnce());
    if (boundary === 'window-close')
      await vi.waitFor(() => expect(event.window.close).toHaveBeenCalledOnce());
    if (boundary === 'window-destroyed')
      await vi.waitFor(() => expect(mocks.quit).toHaveBeenCalledOnce());
  },
);
it('does not stop the service or exit when activity release fails on Quit', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
    activityEvent(),
    activityInput(),
  );
  mocks.disposeActivities.mockRejectedValueOnce(new Error('Release failed'));
  emit('before-quit', { preventDefault: vi.fn() });
  await vi.waitFor(() => expect(mocks.errorBox).toHaveBeenCalled());
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.quit).not.toHaveBeenCalled();
});
it('rejects a cookie switched before queued mount authorization starts', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const mounting = mocks.ipcHandlers.get('scholar:native:mountActivity')!(
    activityEvent(),
    activityInput(),
  );
  mocks.authCookie = 'test-session-b';
  await expect(mounting).rejects.toThrow('session changed');
  expect(mocks.mountActivity).not.toHaveBeenCalled();
});
it('closes an asynchronously mounted run instead of returning it after the account changes during session revalidation', async () => {
  let accountId = 'student-a';
  let mounted = false;
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser') return { id: accountId };
    if (method === 'getStudySession') {
      if (mounted) accountId = 'student-b';
      return activeStudySnapshot();
    }
    if (method === 'authorizeActivityRun') return activityAuthorization();
    if (method === 'releaseActivityRun') return undefined;
    throw new Error(`Unexpected method: ${method}`);
  });
  mocks.mountActivity.mockImplementationOnce(async () => {
    await mocks.activityDependencies!.authorizeRun({
      sessionId: 'session-a',
      artifactId: 'artifact-a',
      versionId: 'version-a',
      attemptId: 'attempt-a',
      requestId: '11111111-1111-4111-8111-111111111111',
    });
    mounted = true;
    return { runId: 'run-a' };
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  await expect(
    mocks.ipcHandlers.get('scholar:native:mountActivity')!(
      activityEvent(),
      activityInput(),
    ),
  ).rejects.toThrow('session changed');
  expect(mocks.closeActivity).toHaveBeenCalledWith('run-a');
});
it('drops an event when the account changes while its scoped study snapshot is resolving', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const event = activityEvent();
  await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
    event,
    activityInput(),
  );
  await vi.waitFor(() => expect(event.sender.send).toHaveBeenCalled());
  event.sender.send.mockClear();
  let accountId = 'student-a';
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser') return { id: accountId };
    if (method === 'getStudySession') {
      accountId = 'student-b';
      return activeStudySnapshot();
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  mocks.activityDependencies!.onStateFailure?.('run-a');
  await vi.waitFor(() => expect(accountId).toBe('student-b'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(event.sender.send).not.toHaveBeenCalled();
});
it.each(['bundle', 'state'])(
  'rejects an oversized %s from the socket before binding a runtime',
  async (field) => {
    const authorization = activityAuthorization();
    if (field === 'bundle') {
      authorization.sdk = 'x'.repeat(512 * 1024);
      authorization.runtimeDigest = createActivityContentDigest(authorization);
    } else authorization.initialState = { answer: 'x'.repeat(64 * 1024) };
    mocks.request.mockImplementation(async (method) => {
      if (method === 'getCurrentUser') return { id: 'student-a' };
      if (method === 'getStudySession') return activeStudySnapshot();
      if (method === 'authorizeActivityRun') return authorization;
      if (method === 'releaseActivityRun') return undefined;
      throw new Error(`Unexpected method: ${method}`);
    });
    await import('../src/main');
    await vi.waitFor(() => expect(mocks.windows).toBe(1));
    await expect(
      mocks.ipcHandlers.get('scholar:native:mountActivity')!(
        activityEvent(),
        activityInput(),
      ),
    ).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledWith('releaseActivityRun', {
      requestId: '11111111-1111-4111-8111-111111111111',
    });
  },
);
it.each([
  { artifactId: 'other-artifact' },
  { versionId: 'other-version' },
  { sessionId: 'other-session' },
  { attemptId: 'other-attempt' },
  { runtimeVersion: 1 },
  { runtimeDigest: 'b'.repeat(64) },
  { contentDigest: 'invalid' },
  { stateRevision: -1 },
  { initialState: undefined },
])(
  'rejects unknown or cross-scope socket authorizations and releases the authorization request: %o',
  async (invalid) => {
    mocks.request.mockImplementation(async (method) => {
      if (method === 'getCurrentUser') return { id: 'student-a' };
      if (method === 'getStudySession') return activeStudySnapshot();
      if (method === 'authorizeActivityRun')
        return { ...activityAuthorization(), ...invalid };
      if (method === 'releaseActivityRun') return undefined;
      throw new Error(`Unexpected method: ${method}`);
    });
    await import('../src/main');
    await vi.waitFor(() => expect(mocks.windows).toBe(1));
    await expect(
      mocks.ipcHandlers.get('scholar:native:mountActivity')!(
        activityEvent(),
        activityInput(),
      ),
    ).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledWith('releaseActivityRun', {
      requestId: '11111111-1111-4111-8111-111111111111',
    });
  },
);
it.each(['account', 'cookie', 'document', 'session'])(
  'closes a pending mount instead of returning a stale run after its %s changes',
  async (changed) => {
    let accountId = 'student-a';
    let deleted = false;
    mocks.request.mockImplementation(async (method) => {
      if (method === 'getCurrentUser') return { id: accountId };
      if (method === 'getStudySession')
        return deleted ? null : activeStudySnapshot();
      if (method === 'authorizeActivityRun') return activityAuthorization();
      if (method === 'releaseActivityRun') return undefined;
      throw new Error(`Unexpected method: ${method}`);
    });
    let finish!: () => void;
    mocks.mountActivity.mockImplementationOnce(async () => {
      await mocks.activityDependencies!.authorizeRun({
        sessionId: 'session-a',
        artifactId: 'artifact-a',
        versionId: 'version-a',
        attemptId: 'attempt-a',
        requestId: '11111111-1111-4111-8111-111111111111',
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { runId: 'run-a' };
    });
    await import('../src/main');
    await vi.waitFor(() => expect(mocks.windows).toBe(1));
    const event = activityEvent();
    const mounting = mocks.ipcHandlers.get('scholar:native:mountActivity')!(
      event,
      activityInput(),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (changed === 'account') accountId = 'student-b';
    if (changed === 'cookie') mocks.authCookie = 'test-session-b';
    if (changed === 'document')
      event.sender.mainFrame = { url: 'file:///scholaros/index.html' };
    if (changed === 'session') deleted = true;
    const rejection = expect(mounting).rejects.toThrow();
    finish();
    await rejection;
    expect(mocks.closeActivity).toHaveBeenCalledWith('run-a');
    expect(event.sender.send).not.toHaveBeenCalled();
  },
);
it('does not return a runtime that closed before mount settled', async () => {
  mockActivityService();
  mocks.mountActivity.mockImplementationOnce(async () => {
    await mocks.activityDependencies!.authorizeRun({
      sessionId: 'session-a',
      artifactId: 'artifact-a',
      versionId: 'version-a',
      attemptId: 'attempt-a',
      requestId: '11111111-1111-4111-8111-111111111111',
    });
    mocks.activityDependencies!.onClosed?.({
      runId: 'run-a',
      reason: 'activity-bootstrap-timeout',
    });
    return { runId: 'run-a' };
  });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  await expect(
    mocks.ipcHandlers.get('scholar:native:mountActivity')!(
      activityEvent(),
      activityInput(),
    ),
  ).rejects.toThrow();
  expect(mocks.closeActivity).toHaveBeenCalledWith('run-a');
});
it('does not forward interaction payloads or changes from an unknown run', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const event = activityEvent();
  await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
    event,
    activityInput(),
  );
  await vi.waitFor(() => expect(event.sender.send).toHaveBeenCalled());
  event.sender.send.mockClear();
  mocks.activityDependencies!.onRuntimeReady?.('other-run');
  mocks.activityDependencies!.onStateAcknowledged?.('other-run', 4);
  mocks.activityDependencies!.onStateFailure?.('other-run');
  mocks.activityDependencies!.onClosed?.({
    runId: 'other-run',
    reason: 'closed',
  });
  await expect(
    mocks.activityDependencies!.onInteraction?.({
      runId: 'other-run',
      action: 'explore',
      value: 'private',
    }),
  ).rejects.toThrow('scope');
  await mocks.activityDependencies!.onInteraction?.({
    runId: 'run-a',
    action: 'explore',
    value: 'private',
  });
  expect(event.sender.send).not.toHaveBeenCalled();
});
it.each(['reply', 'cookie-error'])(
  'unwinds a pending authorization %s with the runtime cancellation contract before identity disposal settles',
  async (outcome) => {
    let finishAuthorization!: (run: RuntimeAuthorizedActivityRun) => void;
    let failAuthorization!: (error: Error) => void;
    mocks.request.mockImplementation(async (method) => {
      if (method === 'getCurrentUser') return { id: 'student-a' };
      if (method === 'getStudySession') return activeStudySnapshot();
      if (method === 'authorizeActivityRun')
        return new Promise<RuntimeAuthorizedActivityRun>((resolve, reject) => {
          finishAuthorization = resolve;
          failAuthorization = reject;
        });
      if (method === 'releaseActivityRun') return undefined;
      throw new Error(`Unexpected method: ${method}`);
    });
    await import('../src/main');
    await vi.waitFor(() => expect(mocks.windows).toBe(1));
    const mounting = Promise.resolve(
      mocks.ipcHandlers.get('scholar:native:mountActivity')!(
        activityEvent(),
        activityInput(),
      ),
    );
    const rejected = expect(mounting).rejects.toThrow(
      'The activity mount authorization became stale.',
    );
    await vi.waitFor(() => expect(finishAuthorization).toBeTypeOf('function'));
    mocks.disposeActivities.mockImplementationOnce(async () => {
      const error = await mounting.then(
        () => null,
        (cause: unknown) => cause,
      );
      if (
        !(error instanceof Error) ||
        error.message !== 'The activity mount authorization became stale.'
      )
        throw new Error(
          'The runtime would surface an unexpected pending-mount failure.',
        );
    });
    const lifecycle = mocks.register.mock.calls[0]![0] as {
      onIdentityChange: () => Promise<void>;
    };
    const disposing = lifecycle.onIdentityChange();
    const completed = Promise.all([
      rejected,
      expect(disposing).resolves.toBeUndefined(),
    ]);
    if (outcome === 'reply') finishAuthorization(activityAuthorization());
    else failAuthorization(new Error('Your session changed; sign in again.'));
    await completed;
    expect(mocks.request).toHaveBeenCalledWith('releaseActivityRun', {
      requestId: '11111111-1111-4111-8111-111111111111',
    });
  },
);
it('settles the scoped closed event before removing its run and returning native close', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const event = activityEvent();
  await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
    event,
    activityInput(),
  );
  await vi.waitFor(() => expect(event.sender.send).toHaveBeenCalled());
  event.sender.send.mockClear();
  let unblock!: (snapshot: ReturnType<typeof activeStudySnapshot>) => void;
  let sessionReads = 0;
  let closed = false;
  mocks.request.mockImplementation(async (method) => {
    if (method === 'getCurrentUser') return { id: 'student-a' };
    if (method === 'getStudySession') {
      if (closed && ++sessionReads === 1)
        return new Promise((resolve) => {
          unblock = resolve;
        });
      return activeStudySnapshot();
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  mocks.closeActivity.mockImplementationOnce(async () => {
    closed = true;
    mocks.activityDependencies!.onClosed?.({
      runId: 'run-a',
      reason: 'closed',
    });
  });
  let settled = false;
  const closing = Promise.resolve(
    mocks.ipcHandlers.get('scholar:native:closeActivity')!(event, {
      runId: 'run-a',
    }),
  ).then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const returnedBeforeEvent = settled;
  unblock(activeStudySnapshot());
  await closing;
  expect(returnedBeforeEvent).toBe(false);
  expect(event.sender.send).toHaveBeenCalledWith(
    'scholar:native:activityChange',
    expect.objectContaining({
      kind: 'closed',
      runId: 'run-a',
      errorCode: 'cancelled',
    }),
  );
});
it('does not close another session activity when unrelated session history is deleted', async () => {
  mockActivityService();
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  await mocks.ipcHandlers.get('scholar:native:mountActivity')!(
    activityEvent(),
    activityInput(),
  );
  const lifecycle = mocks.register.mock.calls[0]![0] as {
    beforeSessionDelete: (sessionId: string) => Promise<void>;
  };
  await lifecycle.beforeSessionDelete('other-session');
  expect(mocks.disposeActivities).not.toHaveBeenCalled();
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

it('opens microphone settings from a trusted window even without an active study session', async () => {
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const openSettings = mocks.ipcHandlers.get(
    'scholar:native:openMicrophoneSettings',
  );
  const initialRequests = mocks.request.mock.calls.length;
  await expect(openSettings?.({ trusted: true })).resolves.toBeUndefined();
  expect(mocks.request.mock.calls.length).toBe(initialRequests);
  expect(mocks.askForMicrophone).not.toHaveBeenCalled();
  if (process.platform === 'darwin')
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
  mocks.openExternal.mockClear();
  await expect(openSettings?.({ trusted: false })).rejects.toThrow('Untrusted');
  expect(mocks.openExternal).not.toHaveBeenCalled();
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

it('persists the actual notification permission decision without treating support as a grant', async () => {
  mocks.request.mockResolvedValue({ id: 'student-a', authMode: 'online' });
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.windows).toBe(1));
  const requestPermission = mocks.ipcHandlers.get(
    'scholar:native:requestNotificationPermission',
  );

  await expect(requestPermission?.({ trusted: true }, {})).resolves.toEqual({
    state: 'denied',
  });
  expect(
    mocks.hostWindows[0].webContents.executeJavaScript,
  ).toHaveBeenCalledWith('Notification.requestPermission()', true);
  expect(mocks.notificationPermission).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'student-a' }),
    'denied',
  );
  if (process.platform === 'darwin')
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
    );
  const lifecycle = mocks.register.mock.calls[0][0] as AcademicClientLifecycle;
  await lifecycle.beforeDisconnect?.();
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
