import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(() => '/tmp/academic-runtime'),
  hasSingleInstanceLock: vi.fn(),
  hide: vi.fn(),
  on: vi.fn(),
  quit: vi.fn(),
  createAcademicServer: vi.fn(),
  registerAcademicActions: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    hasSingleInstanceLock: mocks.hasSingleInstanceLock,
    dock: { hide: mocks.hide },
    on: mocks.on,
    quit: mocks.quit,
  },
}));
vi.mock('../transport', () => ({
  createAcademicServer: mocks.createAcademicServer,
}));
vi.mock('../../../features/onboarding/services/ipc', () => ({
  registerAcademicActions: mocks.registerAcademicActions,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.createAcademicServer.mockResolvedValue({
    publish: vi.fn(),
    close: vi.fn(async () => undefined),
  });
  mocks.registerAcademicActions.mockImplementation(({ register }) => {
    register('getCurrentUser', async () => null);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

it('does not create the academic transport without Electron process ownership', async () => {
  mocks.hasSingleInstanceLock.mockReturnValue(false);
  const { runAcademicService } = await import('../runtime');

  await expect(runAcademicService()).rejects.toThrow(
    'requires the single-instance lock',
  );
  expect(mocks.createAcademicServer).not.toHaveBeenCalled();
});

it('restores through a service-only online-gated action', async () => {
  mocks.hasSingleInstanceLock.mockReturnValue(true);
  const restoreOnlineState = vi.fn();
  const getState = vi.fn();
  mocks.registerAcademicActions.mockImplementation(({ register }) => {
    register('getCurrentUser', async () => ({ id: 'student' }));
    register('getState', getState);
    register('restoreOnlineState', restoreOnlineState);
  });
  const { runAcademicService } = await import('../runtime');
  await runAcademicService({ learningModules: [] });
  expect(restoreOnlineState).toHaveBeenCalledOnce();
  expect(getState).not.toHaveBeenCalled();
  const willQuit = mocks.on.mock.calls.find(
    ([event]) => event === 'will-quit',
  )![1];
  willQuit({ preventDefault: vi.fn() });
});

it('does not restore scheduler state for an offline-local user', async () => {
  mocks.hasSingleInstanceLock.mockReturnValue(true);
  const restoreOnlineState = vi.fn();
  const getState = vi.fn();
  mocks.registerAcademicActions.mockImplementation(({ register }) => {
    register('getCurrentUser', async () => ({
      id: 'student',
      authMode: 'offline-local',
    }));
    register('getState', getState);
    register('restoreOnlineState', restoreOnlineState);
  });
  const { runAcademicService } = await import('../runtime');
  await runAcademicService({ learningModules: [] });
  expect(restoreOnlineState).not.toHaveBeenCalled();
  expect(getState).not.toHaveBeenCalled();
  const willQuit = mocks.on.mock.calls.find(
    ([event]) => event === 'will-quit',
  )![1];
  willQuit({ preventDefault: vi.fn() });
});

it('creates the transport only while the Electron process lock is held', async () => {
  mocks.hasSingleInstanceLock.mockReturnValue(true);
  const { runAcademicService } = await import('../runtime');
  const learningModules = [vi.fn()];

  const service = await runAcademicService({ learningModules });
  expect(mocks.createAcademicServer).toHaveBeenCalledOnce();
  expect(mocks.registerAcademicActions).toHaveBeenCalledOnce();
  expect(mocks.registerAcademicActions).toHaveBeenCalledWith(
    expect.objectContaining({ learningModules }),
  );
  expect(service).toBe(await mocks.createAcademicServer.mock.results[0]!.value);

  const willQuit = mocks.on.mock.calls.find(
    ([event]) => event === 'will-quit',
  )![1];
  willQuit({ preventDefault: vi.fn() });
  await vi.waitFor(() => expect(service.close).toHaveBeenCalledOnce());
});
