import { safeStorage, app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { CurrentUser } from '../features/onboarding/types';

const offlineGrantSchema = z.strictObject({
  version: z.literal(1),
  accountId: z.string().min(1).max(300),
  name: z.string().max(300),
  email: z.string().max(320),
  image: z.string().max(2000).nullable(),
  hasCompletedOnboarding: z.boolean(),
  sessionFingerprint: z.string().length(64),
  authenticatedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
export type OfflineGrantSchema = z.infer<typeof offlineGrantSchema>;

type OfflineGrant = z.infer<typeof offlineGrantSchema>;
const sessionOnly = () => app.commandLine?.hasSwitch('session-only') === true;
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
const directory = () => path.join(app.getPath('userData'), 'offline-account');
const grantPath = () => path.join(directory(), 'grant.bin');
const fingerprint = (cookie: string) =>
  createHash('sha256').update(cookie, 'utf8').digest('hex');

// A denied Keychain request must not be retried by background polling.
// Restarting the app gives the owner an explicit opportunity to try again.
let secureStorageFailed = false;
let pendingAvailability: Promise<boolean> | null = null;
let secureOperation: Promise<unknown> = Promise.resolve();

const runSecureOperation = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = secureOperation
    .catch(() => undefined)
    .then(async () => {
      if (secureStorageFailed)
        throw new Error('Secure offline storage is unavailable.');
      try {
        return await operation();
      } catch (error) {
        secureStorageFailed = true;
        throw error;
      }
    });
  secureOperation = result;
  return result;
};

export const isOfflineStorageAvailable = async (
  platform: NodeJS.Platform = process.platform,
) => {
  if (sessionOnly() || secureStorageFailed) return false;
  if (pendingAvailability) return pendingAvailability;
  pendingAvailability = (async () => {
    try {
      const available = await safeStorage.isAsyncEncryptionAvailable();
      const encrypted =
        available &&
        (platform !== 'linux' ||
          safeStorage.getSelectedStorageBackend() !== 'basic_text');
      if (!encrypted) secureStorageFailed = true;
      return encrypted;
    } catch {
      secureStorageFailed = true;
      return false;
    } finally {
      pendingAvailability = null;
    }
  })();
  return pendingAvailability;
};

const writeGrant = async (grant: OfflineGrant, plaintext?: string) => {
  const directoryPath = directory();
  const filePath = grantPath();
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await chmod(directoryPath, 0o700);
  let encrypted: Buffer;
  try {
    encrypted = await runSecureOperation(() =>
      safeStorage.encryptStringAsync(plaintext ?? JSON.stringify(grant)),
    );
  } catch (error) {
    secureStorageFailed = true;
    throw error;
  }
  try {
    await writeFile(temporaryPath, encrypted, { flag: 'wx', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export const saveOfflineAccountGrant = async (
  user: CurrentUser,
  cookie: string,
) => {
  if (!cookie.trim() || !(await isOfflineStorageAvailable())) return false;
  const authenticatedAt = Date.now();
  const grant: OfflineGrant = {
    version: 1,
    accountId: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    hasCompletedOnboarding: user.hasCompletedOnboarding,
    sessionFingerprint: fingerprint(cookie),
    authenticatedAt,
    expiresAt: authenticatedAt + maxAgeMs,
  };
  await writeGrant(grant);
  return true;
};

export const readOfflineAccountGrant = async (
  cookie: string,
): Promise<CurrentUser | null> => {
  if (sessionOnly() || !cookie.trim()) return null;
  let encrypted: Buffer;
  try {
    encrypted = await readFile(grantPath());
  } catch {
    return null;
  }

  if (!(await isOfflineStorageAvailable())) return null;
  let decrypted: Awaited<ReturnType<typeof safeStorage.decryptStringAsync>>;
  try {
    decrypted = await runSecureOperation(() =>
      safeStorage.decryptStringAsync(encrypted),
    );
  } catch {
    secureStorageFailed = true;
    return null;
  }
  let parsed: OfflineGrant;
  try {
    parsed = offlineGrantSchema.parse(JSON.parse(decrypted.result));
  } catch {
    await rm(grantPath(), { force: true }).catch(() => undefined);
    return null;
  }
  if (
    parsed.authenticatedAt > Date.now() ||
    parsed.expiresAt - parsed.authenticatedAt > maxAgeMs ||
    parsed.expiresAt <= Date.now()
  ) {
    await rm(grantPath(), { force: true }).catch(() => undefined);
    return null;
  }
  if (parsed.sessionFingerprint !== fingerprint(cookie)) {
    await rm(grantPath(), { force: true }).catch(() => undefined);
    return null;
  }
  if (decrypted.shouldReEncrypt)
    await writeGrant(parsed, decrypted.result).catch(() => undefined);
  return {
    id: parsed.accountId,
    name: parsed.name,
    email: parsed.email,
    image: parsed.image,
    hasCompletedOnboarding: parsed.hasCompletedOnboarding,
    authMode: 'offline-local',
  };
};

export const clearOfflineAccountGrant = async (cookie?: string) => {
  if (sessionOnly()) return;
  if (!cookie) {
    await rm(grantPath(), { force: true }).catch(() => undefined);
    return;
  }
  let encrypted: Buffer;
  try {
    encrypted = await readFile(grantPath());
  } catch {
    return;
  }
  if (!(await isOfflineStorageAvailable())) return;
  let plaintext: string;
  try {
    plaintext = (
      await runSecureOperation(() => safeStorage.decryptStringAsync(encrypted))
    ).result;
  } catch {
    secureStorageFailed = true;
    return;
  }
  try {
    const parsed = offlineGrantSchema.safeParse(JSON.parse(plaintext));
    if (
      !parsed.success ||
      parsed.data.sessionFingerprint === fingerprint(cookie)
    )
      await rm(grantPath(), { force: true });
  } catch {
    // Keep the encrypted grant if its ownership cannot be established.
  }
};
