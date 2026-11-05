import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  directory: '',
  sessionOnly: false,
  available: vi.fn(async () => true),
  backend: vi.fn(() => 'gnome-libsecret'),
  encrypt: vi.fn(async (value: string) =>
    Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
  ),
  decrypt: vi.fn(async (value: Buffer) => {
    const content = value.toString();
    if (!content.startsWith('encrypted:'))
      throw new Error('Unexpected plaintext account grant.');
    return {
      result: Buffer.from(
        content.slice('encrypted:'.length),
        'base64',
      ).toString(),
      shouldReEncrypt: false,
    };
  }),
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.directory,
    commandLine: {
      hasSwitch: (name: string) => name === 'session-only' && mocks.sessionOnly,
    },
  },
  safeStorage: {
    isAsyncEncryptionAvailable: mocks.available,
    getSelectedStorageBackend: mocks.backend,
    encryptStringAsync: mocks.encrypt,
    decryptStringAsync: mocks.decrypt,
  },
}));

let directory = '';
let offlineAccount: typeof import('../src/lib/offline-account');

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'scholaros-offline-account-'));
  mocks.directory = directory;
  mocks.sessionOnly = false;
  mocks.available.mockResolvedValue(true);
  mocks.backend.mockReturnValue('gnome-libsecret');
  mocks.encrypt.mockImplementation(async (value) =>
    Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
  );
  mocks.decrypt.mockImplementation(async (value) => {
    const content = value.toString();
    if (!content.startsWith('encrypted:'))
      throw new Error('Unexpected plaintext account grant.');
    return {
      result: Buffer.from(
        content.slice('encrypted:'.length),
        'base64',
      ).toString(),
      shouldReEncrypt: false,
    };
  });
  vi.resetModules();
  offlineAccount = await import('../src/lib/offline-account');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

it('encrypts an online-auth grant and permits offline access only for the same session', async () => {
  const user = {
    id: 'student-a',
    name: 'Student A',
    email: 'student@example.test',
    image: null,
    hasCompletedOnboarding: true,
  };
  await offlineAccount.saveOfflineAccountGrant(user, 'session-cookie-a');
  const persistedGrant = await readFile(
    path.join(directory, 'offline-account', 'grant.bin'),
    'utf8',
  );
  expect(mocks.encrypt).toHaveBeenCalledOnce();
  expect(persistedGrant).not.toContain('student-a');
  expect(persistedGrant).not.toContain('session-cookie-a');

  await expect(
    offlineAccount.readOfflineAccountGrant('session-cookie-a'),
  ).resolves.toEqual({ ...user, authMode: 'offline-local' });
  await expect(
    offlineAccount.readOfflineAccountGrant('session-cookie-b'),
  ).resolves.toBeNull();
});

it('expires the grant after seven days and refuses an unavailable secure store', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const user = {
    id: 'student-a',
    name: 'Student A',
    email: 'student@example.test',
    image: null,
    hasCompletedOnboarding: true,
  };
  await offlineAccount.saveOfflineAccountGrant(user, 'session-cookie-a');
  now.mockReturnValue(1_000_000 + 7 * 24 * 60 * 60 * 1000 + 1);

  await expect(
    offlineAccount.readOfflineAccountGrant('session-cookie-a'),
  ).resolves.toBeNull();
  mocks.available.mockResolvedValue(false);
  await expect(
    offlineAccount.saveOfflineAccountGrant(user, 'session-cookie-a'),
  ).resolves.toBe(false);
});

it('rejects the Linux plaintext safeStorage fallback', async () => {
  mocks.backend.mockReturnValue('basic_text');

  await expect(offlineAccount.isOfflineStorageAvailable('linux')).resolves.toBe(
    false,
  );
});

it('does not touch Keychain for a missing offline grant', async () => {
  const previous = mocks.available.mock.calls.length;
  await expect(
    offlineAccount.readOfflineAccountGrant('session-cookie-a'),
  ).resolves.toBeNull();
  expect(mocks.available.mock.calls.length).toBe(previous);
});

it('stops automatic retries after secure storage fails and preserves the encrypted grant', async () => {
  const user = {
    id: 'student-a',
    name: 'Student A',
    email: 'student@example.test',
    image: null,
    hasCompletedOnboarding: true,
  };
  await offlineAccount.saveOfflineAccountGrant(user, 'session-cookie-a');
  const file = path.join(directory, 'offline-account', 'grant.bin');
  const original = await readFile(file);
  const reads = mocks.decrypt.mock.calls.length;
  mocks.decrypt.mockRejectedValue(new Error('Keychain access denied'));
  await Promise.all([
    offlineAccount.readOfflineAccountGrant('session-cookie-a'),
    offlineAccount.readOfflineAccountGrant('session-cookie-a'),
  ]);
  await offlineAccount.clearOfflineAccountGrant('session-cookie-a');
  expect(mocks.decrypt.mock.calls.length - reads).toBe(1);
  expect(await readFile(file)).toEqual(original);
});

it('does not repeat unavailable secure storage checks during polling', async () => {
  mocks.available.mockResolvedValue(false);
  const previous = mocks.available.mock.calls.length;
  await offlineAccount.isOfflineStorageAvailable();
  await offlineAccount.isOfflineStorageAvailable();
  expect(mocks.available.mock.calls.length - previous).toBe(1);
});

it('temporary sign-in never reads Keychain or alters a saved offline grant', async () => {
  const user = {
    id: 'student-a',
    name: 'Student A',
    email: 'student@example.test',
    image: null,
    hasCompletedOnboarding: true,
  };
  await offlineAccount.saveOfflineAccountGrant(user, 'session-cookie-a');
  const file = path.join(directory, 'offline-account', 'grant.bin');
  const original = await readFile(file);
  const before = [
    mocks.available.mock.calls.length,
    mocks.encrypt.mock.calls.length,
    mocks.decrypt.mock.calls.length,
  ];
  mocks.sessionOnly = true;
  expect(await offlineAccount.isOfflineStorageAvailable()).toBe(false);
  expect(
    await offlineAccount.readOfflineAccountGrant('session-cookie-a'),
  ).toBeNull();
  expect(
    await offlineAccount.saveOfflineAccountGrant(user, 'session-cookie-a'),
  ).toBe(false);
  await offlineAccount.clearOfflineAccountGrant();
  expect(await readFile(file)).toEqual(original);
  expect([
    mocks.available.mock.calls.length,
    mocks.encrypt.mock.calls.length,
    mocks.decrypt.mock.calls.length,
  ]).toEqual(before);
});
