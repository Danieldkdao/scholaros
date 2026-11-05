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
  const restored = electronClient({
    signInURL: 'http://localhost:3000/sign-in',
    protocol: 'ai.scholaros.desktop',
    storage: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
  });
  const request = await restored.fetchPlugins[0].init!(
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

const storedCookie = (token: string) =>
  Buffer.from(
    `encrypted:${JSON.stringify({ 'better-auth.session_token': { value: token, expires: null } })}`,
  ).toString('base64');
const storedPlugin = (values: Map<string, unknown>) =>
  electronClient({
    signInURL: 'http://localhost:3000/sign-in',
    protocol: 'ai.scholaros.desktop',
    storage: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
  });
const readCookie = async (plugin: ReturnType<typeof storedPlugin>) => {
  const request = await plugin.fetchPlugins[0].init!(
    'http://localhost:3000/api/auth/get-session',
    {},
  );
  return (request?.options?.headers as Record<string, string>)?.cookie;
};
test('empty authentication storage never accesses the operating system keychain', async () => {
  const plugin = storedPlugin(new Map());
  expect(await readCookie(plugin)).toBe('');
  expect(await readCookie(plugin)).toBe('');
  expect(secure.available).not.toHaveBeenCalled();
  expect(secure.decrypt).not.toHaveBeenCalled();
});
test('unchanged ciphertext is decrypted once and foreign changes and sign-out are observed immediately', async () => {
  const values = new Map<string, unknown>([
    ['better-auth.cookie', storedCookie('first-token')],
  ]);
  const plugin = storedPlugin(values);
  expect(await readCookie(plugin)).toContain('first-token');
  expect(await readCookie(plugin)).toContain('first-token');
  expect(secure.decrypt).toHaveBeenCalledOnce();
  values.set('better-auth.cookie', storedCookie('replacement-token'));
  expect(await readCookie(plugin)).toContain('replacement-token');
  expect(secure.decrypt).toHaveBeenCalledTimes(2);
  values.delete('better-auth.cookie');
  expect(await readCookie(plugin)).toBe('');
});
test('failed decryption is latched for exact ciphertext without discarding encrypted credentials', async () => {
  const cipher = storedCookie('private-token');
  const values = new Map<string, unknown>([['better-auth.cookie', cipher]]);
  const plugin = storedPlugin(values);
  secure.decrypt.mockImplementation(() => {
    throw new Error('Keychain access denied');
  });
  expect(await readCookie(plugin)).toBe('');
  expect(await readCookie(plugin)).toBe('');
  expect(secure.decrypt).toHaveBeenCalledOnce();
  expect(secure.available).toHaveBeenCalledOnce();
  expect(values.get('better-auth.cookie')).toBe(cipher);
  values.set('better-auth.cookie', storedCookie('new-token'));
  expect(await readCookie(plugin)).toBe('');
  expect(secure.decrypt).toHaveBeenCalledTimes(2);
});
test('unavailable secure storage is checked once for unchanged ciphertext', async () => {
  secure.available.mockReturnValue(false);
  const plugin = storedPlugin(
    new Map([['better-auth.cookie', storedCookie('token')]]),
  );
  expect(await readCookie(plugin)).toBe('');
  expect(await readCookie(plugin)).toBe('');
  expect(secure.available).toHaveBeenCalledOnce();
  expect(secure.decrypt).not.toHaveBeenCalled();
});
test('unchanged session writes do not encrypt repeatedly', async () => {
  const plugin = storedPlugin(new Map());
  const hooks = plugin.fetchPlugins[0].hooks as unknown as {
    onSuccess: (context: unknown) => Promise<void>;
  };
  const context = {
    response: new Response(null, {
      headers: {
        'set-cookie': 'better-auth.session_token=test-token; Path=/; HttpOnly',
      },
    }),
    request: { url: 'http://localhost:3000/api/auth/sign-in/email' },
    data: {},
  };
  await hooks.onSuccess(context);
  await hooks.onSuccess(context);
  expect(secure.encrypt).toHaveBeenCalledOnce();
});

test('failed encryption is not retried by changing background writes and never persists plaintext', async () => {
  const values = new Map<string, unknown>();
  const plugin = storedPlugin(values);
  secure.encrypt.mockImplementation(() => {
    throw new Error('Keychain denied');
  });
  const hooks = plugin.fetchPlugins[0].hooks as unknown as {
    onSuccess: (context: unknown) => Promise<void>;
  };
  for (const token of ['one', 'two', 'three']) {
    await hooks.onSuccess({
      response: new Response(null, {
        headers: {
          'set-cookie': `better-auth.session_token=${token}; Path=/; HttpOnly`,
        },
      }),
      request: { url: 'http://localhost:3000/api/auth/sign-in/email' },
      data: {},
    });
  }
  expect(secure.encrypt).toHaveBeenCalledOnce();
  expect(values.size).toBe(0);
  expect(await readCookie(plugin)).toBe('');
});
