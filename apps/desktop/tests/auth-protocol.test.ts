import { protocol } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  registerSchemes: vi.fn(),
  setupMain: vi.fn(),
  cookie: vi.fn(() => 'cookie'),
  clearGrant: vi.fn(async () => undefined),
  readGrant: vi.fn(async () => null),
  saveGrant: vi.fn(async () => true),
}));

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: mocks.registerSchemes },
}));
vi.mock('../src/lib/auth/client', () => ({
  authClient: {
    getCookie: mocks.cookie,
    setupMain: mocks.setupMain,
  },
}));
vi.mock('../src/lib/offline-account', () => ({
  clearOfflineAccountGrant: mocks.clearGrant,
  readOfflineAccountGrant: mocks.readGrant,
  saveOfflineAccountGrant: mocks.saveGrant,
}));
vi.mock('../src/data/env/client', () => ({
  clientEnv: { VITE_API_URL: 'https://api.scholaros.test' },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  mocks.setupMain.mockImplementation(() => {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'scholaros', privileges: { secure: true } },
    ]);
    protocol.registerSchemesAsPrivileged([
      { scheme: 'user-image', privileges: { secure: true } },
    ]);
  });
});

it('combines Better Auth and activity schemes in one pre-ready registration', async () => {
  const { setupAuthMain } = await import('../src/lib/auth/main');
  const getWindow = vi.fn(() => null);
  const registerActivityScheme = (
    register: typeof protocol.registerSchemesAsPrivileged,
  ) =>
    register([
      {
        scheme: 'scholar-activity',
        privileges: { standard: true, secure: true, bypassCSP: false },
      },
    ]);

  setupAuthMain({ getWindow, registerActivityScheme });

  expect(mocks.setupMain).toHaveBeenCalledWith({
    csp: true,
    scheme: true,
    bridges: false,
    getWindow,
  });
  expect(mocks.registerSchemes).toHaveBeenCalledOnce();
  expect(mocks.registerSchemes).toHaveBeenCalledWith([
    { scheme: 'scholaros', privileges: { secure: true } },
    { scheme: 'user-image', privileges: { secure: true } },
    {
      scheme: 'scholar-activity',
      privileges: { standard: true, secure: true, bypassCSP: false },
    },
  ]);
  expect(protocol.registerSchemesAsPrivileged).toBe(mocks.registerSchemes);
});

it('restores Electron scheme registration if Better Auth setup throws', async () => {
  const { setupAuthMain } = await import('../src/lib/auth/main');
  const registerActivityScheme = vi.fn();
  mocks.setupMain.mockImplementationOnce(() => {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'scholaros', privileges: { secure: true } },
    ]);
    throw new Error('auth setup failed');
  });

  expect(() =>
    setupAuthMain({ getWindow: () => null, registerActivityScheme }),
  ).toThrow('auth setup failed');
  expect(protocol.registerSchemesAsPrivileged).toBe(mocks.registerSchemes);
  expect(registerActivityScheme).not.toHaveBeenCalled();
  expect(mocks.registerSchemes).not.toHaveBeenCalled();
});
