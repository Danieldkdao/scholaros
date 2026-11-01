import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  directory: '',
  mkdir: vi.fn(),
  setPath: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    commandLine: { getSwitchValue: () => mocks.directory },
    setPath: mocks.setPath,
  },
}));
vi.mock('node:fs', () => ({ mkdirSync: mocks.mkdir }));
afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
it('sets an isolated directory before authentication storage is loaded', async () => {
  mocks.directory = '/tmp/scholar-runtime-check';
  await import('../src/lib/application-paths');
  expect(mocks.mkdir).toHaveBeenCalledWith(mocks.directory, {
    recursive: true,
    mode: 0o700,
  });
  expect(mocks.setPath).toHaveBeenCalledWith('userData', mocks.directory);
  expect(mocks.setPath).toHaveBeenCalledWith('sessionData', mocks.directory);
});
it('preserves the installed data location when no override was supplied', async () => {
  mocks.directory = '';
  await import('../src/lib/application-paths');
  expect(mocks.setPath).not.toHaveBeenCalled();
});
