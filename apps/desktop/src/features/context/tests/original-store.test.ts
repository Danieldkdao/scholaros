import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import * as fileSystem from 'node:fs/promises';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => {
  appState.userData = mkdtempSync(
    path.join(tmpdir(), 'scholaros-original-store-'),
  );
  return {
    app: {
      getPath: () => appState.userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
    },
  };
});

const { createOriginalStore } = await import('../services/original-store');

const testDirectories: string[] = [];

const createTestDirectory = async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'scholaros-original-fixture-'),
  );
  testDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    testDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  await rm(appState.userData, { recursive: true, force: true });
});

describe('Context original storage', () => {
  it('writes account-scoped opaque originals with restrictive permissions and verified reads', async () => {
    const rootDirectory = await createTestDirectory();
    const store = createOriginalStore({ rootDirectory });
    const bytes = Buffer.from('bounded original content');
    const stored = await store.write('student-one', bytes, 1024);
    const accountDirectory = path.join(
      rootDirectory,
      createHash('sha256').update('student-one').digest('hex'),
    );

    expect(stored).toMatchObject({
      hash: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    });
    expect(stored.storageKey).not.toContain('student-one');
    expect(await store.read('student-one', stored.storageKey)).toEqual(bytes);
    if (process.platform !== 'win32') {
      expect((await stat(accountDirectory)).mode & 0o777).toBe(0o700);
      expect(
        (
          await stat(
            path.join(accountDirectory, stored.storageKey.split('/')[1]!),
          )
        ).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it('rejects cross-account keys and traversal without touching another original', async () => {
    const store = createOriginalStore({
      rootDirectory: await createTestDirectory(),
    });
    const stored = await store.write(
      'student-one',
      Buffer.from('private'),
      1024,
    );

    await expect(
      store.read('student-two', stored.storageKey),
    ).rejects.toMatchObject({
      code: 'scope-denied',
    });
    await expect(
      store.remove('student-two', stored.storageKey),
    ).rejects.toMatchObject({
      code: 'scope-denied',
    });
    await expect(
      store.read('student-one', '../../outside'),
    ).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(await store.read('student-one', stored.storageKey)).toEqual(
      Buffer.from('private'),
    );
  });

  it('enforces the byte ceiling and removes only the requested original', async () => {
    const store = createOriginalStore({
      rootDirectory: await createTestDirectory(),
    });
    const stored = await store.write('student-one', Buffer.from('1234'), 4);

    await expect(
      store.write('student-one', Buffer.from('12345'), 4),
    ).rejects.toMatchObject({
      code: 'limit-exceeded',
    });
    await store.remove('student-one', stored.storageKey);
    await expect(
      store.read('student-one', stored.storageKey),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('cleans a partially copied temporary file after a write failure', async () => {
    const rootDirectory = await createTestDirectory();
    const failingOpen: typeof fileSystem.open = async (
      filePath,
      flags,
      mode,
    ) => {
      const handle = await fileSystem.open(filePath, flags, mode);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'writeFile')
            return async () => {
              await target.writeFile(Buffer.from('partial'));
              throw new Error('simulated copy failure');
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const failingStore = createOriginalStore({
      rootDirectory,
      fileSystem: { ...fileSystem, open: failingOpen },
    });

    await expect(
      failingStore.write('student-one', Buffer.from('full original'), 1024),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    const accountDirectory = path.join(
      rootDirectory,
      createHash('sha256').update('student-one').digest('hex'),
    );
    expect(await readdir(accountDirectory)).toEqual([]);
  });

  it('cleans the temporary file and allows retry after an atomic rename failure', async () => {
    const rootDirectory = await createTestDirectory();
    const failingFileSystem = {
      ...fileSystem,
      rename: async () => {
        throw new Error('simulated rename failure');
      },
    };
    const failingStore = createOriginalStore({
      rootDirectory,
      fileSystem: failingFileSystem,
    });

    await expect(
      failingStore.write('student-one', Buffer.from('retry me'), 1024),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    const accountDirectory = path.join(
      rootDirectory,
      createHash('sha256').update('student-one').digest('hex'),
    );
    expect(await readdir(accountDirectory)).toEqual([]);

    const retryStore = createOriginalStore({ rootDirectory });
    const stored = await retryStore.write(
      'student-one',
      Buffer.from('retry me'),
      1024,
    );
    expect(await retryStore.read('student-one', stored.storageKey)).toEqual(
      Buffer.from('retry me'),
    );
  });
});
