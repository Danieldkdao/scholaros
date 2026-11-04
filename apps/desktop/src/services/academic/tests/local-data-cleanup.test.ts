import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../db/schema';
import { createOriginalStore } from '../../../features/context/services/original-store';
import { profileDirectoryFor } from '../../../features/onboarding/lib/profile-directory';
import type { DeleteLocalAcademicDataInput } from '../contracts';
import { createLocalDataCleanup } from '../local-data-cleanup';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/scholaros-cleanup-test-only' },
}));

type AccountContext = {
  userId: string;
  operationId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

type TableInfo = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

const accountA = 'synthetic-account-a';
const accountB = 'synthetic-account-b';
const migrationDirectory = fileURLToPath(
  new URL('../../../db/migrations/', import.meta.url),
);
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const timestamp = '2026-11-04T00:00:00.000Z';

let sandboxDirectory = '';
let userDataPath = '';
let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;
let originalStore: ReturnType<typeof createOriginalStore>;
let accountTables: string[];

const contextFor = (
  userId: string,
  options: { current?: boolean; signal?: AbortSignal } = {},
): AccountContext => ({
  userId,
  operationId: `request-${userId}`,
  signal: options.signal ?? new AbortController().signal,
  isCurrent: () => options.current ?? true,
});

const tableValue = (tableName: string, columnName: string, userId: string) => {
  if (columnName === 'user_id') return userId;
  if (columnName === 'id') return `${userId}-${tableName}`;
  if (columnName === 'connection_id') return `${userId}-academic_connections`;
  if (columnName === 'course_id') return `${userId}-courses`;
  if (columnName === 'session_id') return `${userId}-study_sessions`;
  if (columnName === 'item_id') return `${userId}-context_items`;
  if (columnName === 'artifact_id') return `${userId}-artifacts`;
  if (columnName === 'attempt_id') return `${userId}-practice_attempts`;
  if (columnName === 'version_id') return `${userId}-artifact_versions`;
  if (columnName === 'material_id') return `${userId}-course_materials`;
  if (columnName.endsWith('_at')) return timestamp;
  if (columnName === 'url' || columnName.endsWith('_url'))
    return `https://example.invalid/${encodeURIComponent(userId)}/${tableName}`;
  if (
    [
      'aliases',
      'answer',
      'categories',
      'conflicts',
      'content',
      'evidence_ids',
      'evidence_summary',
      'evaluation',
      'grade',
      'interpreted_pages',
      'locators',
      'parts',
      'policy_decision',
      'question_set',
      'source_references',
      'state',
    ].includes(columnName)
  )
    return '{}';
  return `fixture-${userId}-${columnName}`;
};

const seedAccountRows = (
  userId: string,
  overrides: Record<string, Record<string, string | number | null>> = {},
) => {
  for (const tableName of accountTables) {
    const columns = sqlite.pragma(
      `table_info(${quoteIdentifier(tableName)})`,
    ) as TableInfo[];
    const tableOverrides = overrides[tableName] ?? {};
    const requiredColumns = columns.filter(
      ({ name, notnull, pk }) =>
        notnull === 1 || pk > 0 || Object.hasOwn(tableOverrides, name),
    );
    const columnNames = requiredColumns.map(({ name }) => name);
    const values = requiredColumns.map(({ name, type }) => {
      if (Object.hasOwn(tableOverrides, name)) return tableOverrides[name];
      if (/INT/i.test(type)) return 1;
      if (/REAL|FLOAT|DOUBLE/i.test(type)) return 1.5;
      return tableValue(tableName, name, userId);
    });
    const sql = `INSERT INTO ${quoteIdentifier(tableName)} (${columnNames
      .map(quoteIdentifier)
      .join(', ')}) VALUES (${columnNames.map(() => '?').join(', ')})`;
    sqlite.prepare(sql).run(...values);
  }
};

const getAccountTableNames = () => {
  const tableNames = (
    sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND sql LIKE '%user_id%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
  return tableNames.filter((tableName) => {
    const columns = sqlite.pragma(
      `table_info(${quoteIdentifier(tableName)})`,
    ) as TableInfo[];
    return columns.some(
      ({ name, notnull, pk }) =>
        name === 'user_id' && (notnull === 1 || pk > 0),
    );
  });
};

const accountRowExists = (tableName: string, userId: string) =>
  Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM ${quoteIdentifier(tableName)} WHERE user_id = ? LIMIT 1`,
      )
      .get(userId),
  );

const createQuiescenceTracker = () => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: async <TResult>(
      _context: AccountContext,
      action: () => Promise<TResult>,
    ): Promise<TResult> => {
      calls += 1;
      return action();
    },
  };
};

const createCleanup = (
  options: {
    fileSystem?: {
      lstat: typeof import('node:fs/promises').lstat;
      readdir: typeof import('node:fs/promises').readdir;
      rm: typeof import('node:fs/promises').rm;
    };
    withAccountOperationsQuiesced?: <TResult>(
      context: AccountContext,
      action: () => Promise<TResult>,
    ) => Promise<TResult>;
  } = {},
) =>
  createLocalDataCleanup({
    database,
    originalStore,
    userDataPath,
    fileSystem: options.fileSystem,
    withAccountOperationsQuiesced:
      options.withAccountOperationsQuiesced ??
      (async (_context, action) => action()),
  });

const deleteInput = (requestId: string): DeleteLocalAcademicDataInput => ({
  requestId,
  scope: 'account-local',
});

beforeEach(async () => {
  sandboxDirectory = await mkdtemp(
    path.join(tmpdir(), 'scholaros-local-cleanup-'),
  );
  userDataPath = path.join(sandboxDirectory, 'user-data');
  await mkdir(userDataPath, { recursive: true });
  sqlite = new Database(path.join(sandboxDirectory, 'synthetic.sqlite'));
  sqlite.pragma('foreign_keys = ON');
  database = drizzle({ client: sqlite, schema });
  migrate(database, { migrationsFolder: migrationDirectory });
  originalStore = createOriginalStore({
    rootDirectory: path.join(userDataPath, 'context-originals'),
  });
  accountTables = getAccountTableNames();
});

afterEach(async () => {
  sqlite.close();
  await rm(sandboxDirectory, { recursive: true, force: true });
});

describe('local academic data cleanup', () => {
  it('deletes one account transactionally and preserves another account and referenced files', async () => {
    const sharedOriginal = await originalStore.write(
      accountA,
      new Uint8Array([1, 2, 3]),
    );
    const unreferencedOriginal = await originalStore.write(
      accountA,
      new Uint8Array([4, 5, 6]),
    );
    const accountBOriginal = await originalStore.write(
      accountB,
      new Uint8Array([7, 8, 9]),
    );
    seedAccountRows(accountA, {
      context_versions: { original_storage_key: sharedOriginal.storageKey },
    });
    seedAccountRows(accountB, {
      context_versions: { original_storage_key: sharedOriginal.storageKey },
    });

    const materialIdA = `${accountA}-course_materials`;
    const materialIdB = `${accountB}-course_materials`;
    const accountAToken = accountA.replaceAll('-', '');
    const accountBToken = accountB.replaceAll('-', '');
    sqlite
      .prepare(
        'INSERT INTO course_material_versions (material_id, content_hash) VALUES (?, ?)',
      )
      .run(materialIdA, `${accountA}-material-hash`);
    sqlite
      .prepare(
        'INSERT INTO course_material_versions (material_id, content_hash) VALUES (?, ?)',
      )
      .run(materialIdB, `${accountB}-material-hash`);
    sqlite
      .prepare(
        `INSERT INTO course_material_chunks
         (id, material_id, version, ordinal, text, source_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${accountA}-material-chunk`,
        materialIdA,
        `${accountA}-material-hash`,
        1,
        `${accountAToken}cleanupneedle`,
        'https://example.invalid/account-a/material',
      );
    sqlite
      .prepare(
        `INSERT INTO course_material_chunks
         (id, material_id, version, ordinal, text, source_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${accountB}-material-chunk`,
        materialIdB,
        `${accountB}-material-hash`,
        1,
        `${accountBToken}cleanupneedle`,
        'https://example.invalid/account-b/material',
      );

    const profileA = profileDirectoryFor(userDataPath, accountA, 'browser-a');
    const profileB = profileDirectoryFor(userDataPath, accountB, 'browser-b');
    await mkdir(profileA, { recursive: true });
    await mkdir(profileB, { recursive: true });
    await writeFile(path.join(profileA, 'synthetic-profile-data'), 'account-a');
    await writeFile(path.join(profileB, 'synthetic-profile-data'), 'account-b');
    const unknownProfileEntry = path.join(
      path.dirname(profileA),
      'preserve-me',
    );
    await mkdir(unknownProfileEntry);
    await writeFile(path.join(unknownProfileEntry, 'keep.txt'), 'unknown');

    const quiescence = createQuiescenceTracker();
    const cleanup = createCleanup({
      withAccountOperationsQuiesced: quiescence.run,
    });
    const result = await cleanup.deleteLocalAcademicData(
      contextFor(accountA),
      deleteInput('00000000-0000-4000-8000-000000000001'),
    );

    expect(result).toEqual({
      requestId: '00000000-0000-4000-8000-000000000001',
      scope: 'account-local',
      status: 'deleted',
    });
    expect(quiescence.calls).toBe(1);
    expect(
      accountTables.some((tableName) => accountRowExists(tableName, accountA)),
    ).toBe(false);
    expect(
      accountTables.every((tableName) => accountRowExists(tableName, accountB)),
    ).toBe(true);
    expect(
      sqlite
        .prepare('SELECT 1 FROM course_material_versions WHERE material_id = ?')
        .get(materialIdA),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare('SELECT 1 FROM course_material_chunks WHERE material_id = ?')
        .get(materialIdA),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare('SELECT 1 FROM course_material_chunks WHERE material_id = ?')
        .get(materialIdB),
    ).toBeTruthy();
    expect(
      sqlite
        .prepare(
          'SELECT 1 FROM course_material_chunks_fts WHERE course_material_chunks_fts MATCH ?',
        )
        .get(`${accountAToken}cleanupneedle`),
    ).toBeUndefined();
    expect(
      sqlite
        .prepare(
          'SELECT 1 FROM course_material_chunks_fts WHERE course_material_chunks_fts MATCH ?',
        )
        .get(`${accountBToken}cleanupneedle`),
    ).toBeTruthy();
    expect(
      await originalStore.has(accountA, unreferencedOriginal.storageKey),
    ).toBe(false);
    expect(await originalStore.has(accountA, sharedOriginal.storageKey)).toBe(
      true,
    );
    expect(await originalStore.has(accountB, accountBOriginal.storageKey)).toBe(
      true,
    );
    await expect(
      readFile(path.join(profileA, 'synthetic-profile-data'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(path.join(profileB, 'synthetic-profile-data'), 'utf8'),
    ).resolves.toBe('account-b');
    await expect(
      readFile(path.join(unknownProfileEntry, 'keep.txt'), 'utf8'),
    ).resolves.toBe('unknown');
  });

  it('does not mutate data when the trusted context is stale or cancelled', async () => {
    seedAccountRows(accountA);
    const quiescence = createQuiescenceTracker();
    const cleanup = createCleanup({
      withAccountOperationsQuiesced: quiescence.run,
    });

    await expect(
      cleanup.deleteLocalAcademicData(
        contextFor(accountA, { current: false }),
        deleteInput('00000000-0000-4000-8000-000000000002'),
      ),
    ).rejects.toMatchObject({ code: 'session-changed' });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      cleanup.deleteLocalAcademicData(
        contextFor(accountA, { signal: cancelled.signal }),
        deleteInput('00000000-0000-4000-8000-000000000003'),
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(
      cleanup.deleteLocalAcademicData(contextFor(accountA), {
        requestId: 'not-a-uuid',
        scope: 'account-local',
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });

    expect(quiescence.calls).toBe(0);
    expect(accountRowExists('study_sessions', accountA)).toBe(true);
  });

  it('rolls back every row delete on transaction failure and retries post-commit profile cleanup', async () => {
    const original = await originalStore.write(accountA, new Uint8Array([1]));
    seedAccountRows(accountA, {
      context_versions: { original_storage_key: original.storageKey },
    });
    const profile = profileDirectoryFor(userDataPath, accountA, 'browser-a');
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'synthetic-profile-data'), 'account-a');
    const cleanup = createCleanup();

    sqlite.exec(`
      CREATE TRIGGER fail_account_cleanup
      BEFORE DELETE ON study_sessions
      WHEN old.user_id = '${accountA}'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic transaction failure');
      END;
    `);
    await expect(
      cleanup.deleteLocalAcademicData(
        contextFor(accountA),
        deleteInput('00000000-0000-4000-8000-000000000004'),
      ),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(accountRowExists('courses', accountA)).toBe(true);
    expect(accountRowExists('study_sessions', accountA)).toBe(true);
    expect(await originalStore.has(accountA, original.storageKey)).toBe(true);
    await expect(
      readFile(path.join(profile, 'synthetic-profile-data'), 'utf8'),
    ).resolves.toBe('account-a');

    sqlite.exec('DROP TRIGGER fail_account_cleanup');
    let failProfileRemoval = true;
    const fileSystem = {
      lstat: (await import('node:fs/promises')).lstat,
      readdir: (await import('node:fs/promises')).readdir,
      rm: async (...args: Parameters<typeof rm>) => {
        if (failProfileRemoval) {
          failProfileRemoval = false;
          throw new Error('synthetic profile removal failure');
        }
        return rm(...args);
      },
    };
    const retryableCleanup = createCleanup({ fileSystem });
    await expect(
      retryableCleanup.deleteLocalAcademicData(
        contextFor(accountA),
        deleteInput('00000000-0000-4000-8000-000000000005'),
      ),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    expect(
      accountTables.some((tableName) => accountRowExists(tableName, accountA)),
    ).toBe(false);
    expect(await originalStore.has(accountA, original.storageKey)).toBe(false);
    await expect(
      readFile(path.join(profile, 'synthetic-profile-data'), 'utf8'),
    ).resolves.toBe('account-a');

    await expect(
      retryableCleanup.deleteLocalAcademicData(
        contextFor(accountA),
        deleteInput('00000000-0000-4000-8000-000000000005'),
      ),
    ).resolves.toEqual({
      requestId: '00000000-0000-4000-8000-000000000005',
      scope: 'account-local',
      status: 'deleted',
    });
    await expect(
      readFile(path.join(profile, 'synthetic-profile-data'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops post-commit cleanup on a stale account context and completes on retry', async () => {
    const original = await originalStore.write(
      accountA,
      new Uint8Array([1, 2]),
    );
    seedAccountRows(accountA, {
      context_versions: { original_storage_key: original.storageKey },
    });
    const profile = profileDirectoryFor(userDataPath, accountA, 'browser-a');
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, 'synthetic-profile-data'), 'account-a');
    const cleanup = createCleanup();
    const staleContext = contextFor(accountA);
    let currentChecks = 0;
    staleContext.isCurrent = () => {
      currentChecks += 1;
      return currentChecks < 4;
    };

    await expect(
      cleanup.deleteLocalAcademicData(
        staleContext,
        deleteInput('00000000-0000-4000-8000-000000000006'),
      ),
    ).rejects.toMatchObject({ code: 'session-changed' });
    expect(
      accountTables.some((tableName) => accountRowExists(tableName, accountA)),
    ).toBe(false);
    expect(await originalStore.has(accountA, original.storageKey)).toBe(true);
    await expect(
      readFile(path.join(profile, 'synthetic-profile-data'), 'utf8'),
    ).resolves.toBe('account-a');

    await expect(
      cleanup.deleteLocalAcademicData(
        contextFor(accountA),
        deleteInput('00000000-0000-4000-8000-000000000006'),
      ),
    ).resolves.toEqual({
      requestId: '00000000-0000-4000-8000-000000000006',
      scope: 'account-local',
      status: 'deleted',
    });
    expect(await originalStore.has(accountA, original.storageKey)).toBe(false);
    await expect(
      readFile(path.join(profile, 'synthetic-profile-data'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked profile without deleting its target', async () => {
    seedAccountRows(accountA);
    const profile = profileDirectoryFor(userDataPath, accountA, 'browser-a');
    const externalProfile = path.join(userDataPath, 'external-profile');
    await mkdir(path.dirname(profile), { recursive: true });
    await mkdir(externalProfile);
    await writeFile(
      path.join(externalProfile, 'synthetic-profile-data'),
      'external-account',
    );
    await symlink(externalProfile, profile);

    await expect(
      createCleanup().deleteLocalAcademicData(
        contextFor(accountA),
        deleteInput('00000000-0000-4000-8000-000000000007'),
      ),
    ).rejects.toMatchObject({ code: 'storage-failed' });
    await expect(
      readFile(path.join(externalProfile, 'synthetic-profile-data'), 'utf8'),
    ).resolves.toBe('external-account');
  });
});
