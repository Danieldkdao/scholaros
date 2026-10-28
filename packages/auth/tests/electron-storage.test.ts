import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { electronClient } from '@better-auth/electron/client';

const secure = vi.hoisted(() => ({
  ready: vi.fn(),
  available: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  default: {
    app: { whenReady: secure.ready, userAgentFallback: 'ScholarOS' },
    safeStorage: {
      isEncryptionAvailable: secure.available,
      encryptString: secure.encrypt,
      decryptString: secure.decrypt,
    },
    webContents: { getFocusedWebContents: () => null },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    'process',
    Object.assign(Object.create(process), { type: 'browser' }),
  );
  secure.ready.mockResolvedValue(undefined);
  secure.available.mockReturnValue(true);
  secure.encrypt.mockImplementation((value: string) =>
    Buffer.from(`encrypted:${value}`),
  );
  secure.decrypt.mockImplementation((value: Buffer) =>
    value.toString().replace('encrypted:', ''),
  );
});

afterEach(() => vi.unstubAllGlobals());

test('session persistence encrypts cookies and restores existing ciphertext', async () => {
  const values = new Map<string, unknown>();
  const plugin = electronClient({
    signInURL: 'http://localhost:3000/sign-in',
    protocol: 'ai.scholaros.desktop',
    storage: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
  });
  const fetchPlugin = plugin.fetchPlugins[0];
  // Exercise the runtime hooks rather than constructing Better Fetch internals.
  const hooks = fetchPlugin.hooks as unknown as {
    onSuccess: (context: unknown) => Promise<void>;
  };
  await hooks.onSuccess({
    response: new Response(null, {
      headers: {
        'set-cookie': 'better-auth.session_token=test-token; Path=/; HttpOnly',
      },
    }),
    request: { url: 'http://localhost:3000/api/auth/sign-in/email' },
    data: {},
  });
  expect(secure.encrypt).toHaveBeenCalled();
  expect(JSON.stringify([...values.values()])).not.toContain('test-token');
  const request = await fetchPlugin.init!(
    'http://localhost:3000/api/auth/get-session',
    {},
  );
  expect(
    (request?.options?.headers as Record<string, string>)?.cookie,
  ).toContain('better-auth.session_token=test-token');
  expect(secure.decrypt).toHaveBeenCalled();
});

test('unavailable secure storage never writes plaintext', async () => {
  secure.available.mockReturnValue(false);
  const setItem = vi.fn();
  const plugin = electronClient({
    signInURL: 'http://localhost:3000/sign-in',
    protocol: 'ai.scholaros.desktop',
    storage: { getItem: () => null, setItem },
  });
  const hooks = plugin.fetchPlugins[0].hooks as unknown as {
    onSuccess: (context: unknown) => Promise<void>;
  };
  await hooks.onSuccess({
    response: new Response(null, {
      headers: { 'set-cookie': 'better-auth.session_token=test-token; Path=/' },
    }),
    request: { url: 'http://localhost:3000/api/auth/sign-in/email' },
    data: {},
  });
  expect(setItem).not.toHaveBeenCalled();
});
