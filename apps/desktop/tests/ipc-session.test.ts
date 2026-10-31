import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { academicTasks } from '../src/features/onboarding/services/academic-tasks';
import type { OnboardingState } from '../src/features/onboarding/types';
const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, input?: unknown) => Promise<unknown>
  >(),
  getCurrentUser: vi.fn(),
  getCookie: vi.fn(() => 'initial-cookie'),
  capturePage: vi.fn(async (_id, _page, check) => {
    if (!check()) throw new Error('Session changed');
  }),
  startPreview: vi.fn(),
  getPreview: vi.fn(),
  discoverAcademicContext: vi.fn(),
  resolveConnections: vi.fn(),
  connectWorkspace: vi.fn(),
  workspace: vi.fn(),
  invalidate: vi.fn(),
  state: { settings: { consent: true, localSetupCompletedAt: null } },
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
  authClient: {
    signOut: vi.fn(async () => undefined),
    getCookie: mocks.getCookie,
  },
}));
vi.mock('../src/lib/auth/main', () => ({
  getCurrentUser: mocks.getCurrentUser,
  accountRequest: vi.fn(),
  markLocalSignOut: vi.fn(),
}));
vi.mock('../src/db', () => ({ db: {} }));
vi.mock('../src/features/onboarding/services/store', () => ({
  getOnboardingState: () => mocks.state,
  removeAcademicConnection: vi.fn(() => mocks.state),
  saveOnboardingSettings: vi.fn(() => mocks.state),
  settleLocalSetup: (
    state: typeof mocks.state,
    options: { accountCompleted: boolean },
  ) => {
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
vi.mock('../src/features/onboarding/services/browser-discovery', () => ({
  chooseBrowser: vi.fn(),
  findBrowsers: vi.fn(),
}));
vi.mock('../src/features/onboarding/services/browser-workspace', () => ({
  closeWorkspace: vi.fn(async () => undefined),
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
  applyLaunchAtLogin: vi.fn(),
  getLaunchAtLoginState: vi.fn(),
}));
vi.mock('../src/features/onboarding/services/connect-workspace', () => ({
  createConnectWorkspace: mocks.connectWorkspace,
}));
vi.mock('../src/features/onboarding/services/connection-resolver', () => ({
  resolveConnectionCandidates: mocks.resolveConnections,
}));
vi.mock('../src/features/onboarding/services/discovery', () => ({
  discoverAcademicContext: mocks.discoverAcademicContext,
}));
const { registerOnboardingIpc } =
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

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getCookie.mockReturnValue('initial-cookie');
  mocks.state = { settings: { consent: true, localSetupCompletedAt: null } };
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
  expect(mocks.discoverAcademicContext).not.toHaveBeenCalled();
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
    expect(mocks.discoverAcademicContext).toHaveBeenCalledOnce();
    finish(mocks.state);
    await expect(refreshing).resolves.toMatchObject({
      preferences: { backgroundSync: { status: 'waiting' } },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.discoverAcademicContext).toHaveBeenCalledTimes(2);
  });

  it('keeps sync suspended until the preview task settles', async () => {
    await invoke('startPreview', 'courses');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.discoverAcademicContext).not.toHaveBeenCalled();
    const onSettled = mocks.startPreview.mock.calls.at(-1)?.[2];
    expect(onSettled).toBeTypeOf('function');
    onSettled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.discoverAcademicContext).toHaveBeenCalledOnce();
  });

  it('waits for a paused refresh to persist cancellation before returning state', async () => {
    mocks.discoverAcademicContext.mockImplementationOnce(
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
