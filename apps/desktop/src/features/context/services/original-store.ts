import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';

export const maxContextOriginalBytes = 10 * 1024 * 1024;

export type ContextOriginal = {
  storageKey: string;
  hash: string;
  byteLength: number;
};

export type ContextStorageErrorCode =
  | 'invalid-input'
  | 'limit-exceeded'
  | 'not-found'
  | 'scope-denied'
  | 'storage-failed';

export class ContextStorageError extends Error {
  constructor(readonly code: ContextStorageErrorCode) {
    super(code);
    this.name = 'ContextStorageError';
  }
}

type OriginalFileSystem = Pick<
  typeof fs,
  | 'chmod'
  | 'lstat'
  | 'mkdir'
  | 'open'
  | 'readFile'
  | 'readdir'
  | 'rename'
  | 'unlink'
>;

type OriginalStoreOptions = {
  rootDirectory?: string;
  fileSystem?: OriginalFileSystem;
};

const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

const isMissing = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ENOENT';

const storageError = () => new ContextStorageError('storage-failed');

export const createOriginalStore = ({
  rootDirectory = path.join(app.getPath('userData'), 'context-originals'),
  fileSystem = fs,
}: OriginalStoreOptions = {}) => {
  const accountDirectory = (userId: string) =>
    path.join(rootDirectory, digest(userId));

  const ensureDirectory = async (directory: string) => {
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await fileSystem.lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
      throw storageError();
    await fileSystem.chmod(directory, 0o700);
  };

  const pathForKey = (userId: string, storageKey: string) => {
    const [accountScope, fileId, ...extraParts] = storageKey.split('/');
    if (
      !accountScope ||
      !fileId ||
      extraParts.length > 0 ||
      !/^[a-f0-9]{64}$/.test(accountScope) ||
      !/^[0-9a-f-]{36}$/.test(fileId)
    )
      throw new ContextStorageError('invalid-input');
    if (accountScope !== digest(userId))
      throw new ContextStorageError('scope-denied');
    return {
      directory: accountDirectory(userId),
      filePath: path.join(accountDirectory(userId), fileId),
    };
  };

  const write = async (
    userId: string,
    bytes: Uint8Array,
    byteLimit = maxContextOriginalBytes,
  ): Promise<ContextOriginal> => {
    if (
      !userId.trim() ||
      !(bytes instanceof Uint8Array) ||
      !Number.isSafeInteger(byteLimit) ||
      byteLimit < 1 ||
      byteLimit > maxContextOriginalBytes
    )
      throw new ContextStorageError('invalid-input');
    if (bytes.byteLength > byteLimit)
      throw new ContextStorageError('limit-exceeded');

    const scope = digest(userId);
    const directory = accountDirectory(userId);
    const fileId = randomUUID();
    const storageKey = `${scope}/${fileId}`;
    const temporaryPath = path.join(directory, `.tmp-${randomUUID()}`);
    const finalPath = path.join(directory, fileId);
    let temporaryExists = false;
    let finalExists = false;

    try {
      await ensureDirectory(rootDirectory);
      await ensureDirectory(directory);
      const handle = await fileSystem.open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      temporaryExists = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fileSystem.rename(temporaryPath, finalPath);
      temporaryExists = false;
      finalExists = true;
      await fileSystem.chmod(finalPath, 0o600);
      return {
        storageKey,
        hash: digest(bytes),
        byteLength: bytes.byteLength,
      };
    } catch {
      if (temporaryExists)
        await fileSystem.unlink(temporaryPath).catch(() => {});
      if (finalExists) await fileSystem.unlink(finalPath).catch(() => {});
      throw storageError();
    }
  };

  const read = async (
    userId: string,
    storageKey: string,
    expectedHash?: string,
  ): Promise<Buffer> => {
    if (!userId.trim()) throw new ContextStorageError('invalid-input');
    const { directory, filePath } = pathForKey(userId, storageKey);
    try {
      const directoryStats = await fileSystem.lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
        throw storageError();
      const fileStats = await fileSystem.lstat(filePath);
      if (!fileStats.isFile() || fileStats.isSymbolicLink())
        throw storageError();
      if (fileStats.size > maxContextOriginalBytes)
        throw new ContextStorageError('limit-exceeded');
      const bytes = await fileSystem.readFile(filePath);
      if (expectedHash && digest(bytes) !== expectedHash) throw storageError();
      return bytes;
    } catch (error) {
      if (error instanceof ContextStorageError) throw error;
      if (isMissing(error)) throw new ContextStorageError('not-found');
      throw storageError();
    }
  };

  const remove = async (userId: string, storageKey: string): Promise<void> => {
    if (!userId.trim()) throw new ContextStorageError('invalid-input');
    const { directory, filePath } = pathForKey(userId, storageKey);
    try {
      const directoryStats = await fileSystem.lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
        throw storageError();
      await fileSystem.unlink(filePath);
    } catch (error) {
      if (error instanceof ContextStorageError) throw error;
      if (isMissing(error)) return;
      throw storageError();
    }
  };

  const has = async (userId: string, storageKey: string): Promise<boolean> => {
    if (!userId.trim()) throw new ContextStorageError('invalid-input');
    const { directory, filePath } = pathForKey(userId, storageKey);
    try {
      const directoryStats = await fileSystem.lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
        throw storageError();
      const fileStats = await fileSystem.lstat(filePath);
      return fileStats.isFile() && !fileStats.isSymbolicLink();
    } catch (error) {
      if (error instanceof ContextStorageError) throw error;
      if (isMissing(error)) return false;
      throw storageError();
    }
  };

  const list = async (userId: string): Promise<string[]> => {
    if (!userId.trim()) throw new ContextStorageError('invalid-input');
    const directory = accountDirectory(userId);
    try {
      const directoryStats = await fileSystem.lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
        throw storageError();
      const entries = await fileSystem.readdir(directory, {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}$/.test(entry.name))
        .map((entry) => `${digest(userId)}/${entry.name}`)
        .sort();
    } catch (error) {
      if (error instanceof ContextStorageError) throw error;
      if (isMissing(error)) return [];
      throw storageError();
    }
  };

  return { has, list, read, remove, write };
};

const originalStore = createOriginalStore();

export const readContextOriginal = originalStore.read;
export const removeContextOriginal = originalStore.remove;
export const writeContextOriginal = originalStore.write;
