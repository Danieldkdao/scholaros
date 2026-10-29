import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, input?: unknown) => Promise<unknown>
  >(),
  getCurrentUser: vi.fn(),
  startPreview: vi.fn(),
  getPreview: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => [] },
  ipcMain: {
    handle: (
      channel: string,
      callback: (event: unknown, input: unknown) => Promise<unknown>,
    ) => mocks.handlers.set(channel, callback),
  },
}));
vi.mock('../src/lib/auth/client', () => ({
  authClient: { signOut: vi.fn(async () => undefined) },
}));
vi.mock('../src/lib/auth/main', () => ({
  getCurrentUser: mocks.getCurrentUser,
  accountRequest: vi.fn(),
  markLocalSignOut: vi.fn(),
}));
vi.mock('../src/db', () => ({ db: {} }));
vi.mock('../src/features/onboarding/services/store', () => ({
  getOnboardingState: () => ({ settings: { consent: true } }),
  removeAcademicConnection: vi.fn(),
  saveOnboardingSettings: vi.fn(),
}));
vi.mock('../src/features/onboarding/services/browser-discovery', () => ({
  chooseBrowser: vi.fn(),
  findBrowsers: vi.fn(),
}));
vi.mock('../src/features/onboarding/services/browser-workspace', () => ({
  closeWorkspace: vi.fn(async () => undefined),
  createWorkspace: vi.fn(),
  openAcademicPage: vi.fn(),
  waitForWorkspaceStops: vi.fn(),
}));
vi.mock('../src/features/onboarding/services/connections', () => ({
  captureResource: vi.fn(),
  confirmResource: vi.fn(),
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
  applyLaunchAtLogin: vi.fn(),
  getLaunchAtLoginState: vi.fn(),
}));
vi.mock('../src/features/onboarding/services/discovery', () => ({
  discoverAcademicContext: vi.fn(),
}));
const { registerOnboardingIpc } =
  await import('../src/features/onboarding/services/ipc');
const frame = {};
const event = { sender: { mainFrame: frame }, senderFrame: frame };
const invoke = (method: string, input?: unknown) =>
  mocks.handlers.get(`scholar:${method}`)!(event, input);
beforeEach(async () => {
  vi.clearAllMocks();
  if (!mocks.handlers.size) registerOnboardingIpc();
  await invoke('signOut');
});

describe('main-process IPC session boundaries', () => {
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
});

it('does not expose the removed onboarding course-map scan before setup is complete', async () => {
  mocks.getCurrentUser.mockResolvedValue({ id: 'student-a' });
  await expect(invoke('discoverContext')).rejects.toThrow('after setup');
  const { discoverAcademicContext } =
    await import('../src/features/onboarding/services/discovery');
  expect(discoverAcademicContext).not.toHaveBeenCalled();
});
