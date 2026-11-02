import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  serviceMode: false,
  windows: 0,
  listeners: new Map<string, ((event?: unknown) => void)[]>(),
  ready: vi.fn(),
  register: vi.fn(),
  request: vi.fn(),
  stop: vi.fn(),
  disconnect: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
  errorBox: vi.fn(),
  setupAuth: vi.fn(),
  runService: vi.fn(),
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
  dialog: { showErrorBox: mocks.errorBox },
}));
vi.mock('electron-squirrel-startup', () => ({ default: false }));
vi.mock('../src/lib/auth/client', () => ({
  authClient: { setupMain: mocks.setupAuth },
}));
vi.mock('../src/lib/window-navigation', () => ({
  protectWindowNavigation: vi.fn(),
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.listeners.clear();
  mocks.windows = 0;
  mocks.serviceMode = false;
  mocks.ready.mockResolvedValue(undefined);
  mocks.register.mockResolvedValue(undefined);
  mocks.stop.mockResolvedValue(undefined);
  mocks.runService.mockResolvedValue(undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', '');
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
});
const emit = (name: string, event?: unknown) => {
  for (const callback of mocks.listeners.get(name) ?? []) callback(event);
};
it('runs the service without a desktop window or renderer authentication bridges', async () => {
  mocks.serviceMode = true;
  await import('../src/main');
  await vi.waitFor(() => expect(mocks.runService).toHaveBeenCalledOnce());
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
