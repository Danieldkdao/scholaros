import { inArray, eq } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type {
  BetterSQLite3Database,
  BetterSQLiteTransaction,
} from 'drizzle-orm/better-sqlite3';
import * as fileSystem from 'node:fs/promises';
import path from 'node:path';
import type * as schema from '../../db/schema';
import {
  AcademicConnectionTable,
  AcademicContextEntryTable,
  AcademicContextTable,
  ArtifactStateTable,
  ArtifactTable,
  ArtifactVersionTable,
  AssistanceLedgerTable,
  BrowserWorkspaceTable,
  ConceptLinkTable,
  ConceptTable,
  ContextChunkTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseMaterialVersionTable,
  CourseRecordTombstoneTable,
  CourseSourceTable,
  CourseTable,
  CourseworkProtectionTable,
  GradeEvidenceTable,
  LearningObservationTable,
  MemoryTable,
  NavigationLocationTable,
  NotificationEventTable,
  PracticeAnswerTable,
  PracticeAttemptTable,
  SettingTable,
  StudyMessageTable,
  StudySessionTable,
  StudySourceReferenceTable,
  StudyTurnTable,
  WatchTargetTable,
} from '../../db/schema';
import type { createOriginalStore } from '../../features/context/services/original-store';
import { profileDirectoryFor } from '../../features/onboarding/lib/profile-directory';
import { deleteLocalAcademicDataInputSchema } from './contracts';

type CleanupDatabase = BetterSQLite3Database<typeof schema>;
type CleanupTransaction = BetterSQLiteTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type OriginalStore = Pick<
  ReturnType<typeof createOriginalStore>,
  'has' | 'list' | 'remove'
>;
type CleanupFileSystem = Pick<typeof fileSystem, 'lstat' | 'readdir' | 'rm'>;

export type LocalDataCleanupContext = {
  userId: string;
  operationId: string;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

export type DeleteLocalAcademicDataResult = {
  requestId: string;
  scope: 'account-local';
  status: 'deleted';
};

export type LocalDataCleanupErrorCode =
  | 'invalid-input'
  | 'cancelled'
  | 'session-changed'
  | 'storage-failed';

const localDataCleanupErrorMessage = (code: LocalDataCleanupErrorCode) => {
  switch (code) {
    case 'invalid-input':
      return 'The local-data removal request is invalid.';
    case 'cancelled':
      return 'Local data removal was cancelled.';
    case 'session-changed':
      return 'Your account changed; reconnect before removing local data.';
    case 'storage-failed':
      return 'Some local data could not be removed. Try again.';
  }
};

export class LocalDataCleanupError extends Error {
  constructor(readonly code: LocalDataCleanupErrorCode) {
    super(localDataCleanupErrorMessage(code));
    this.name = 'LocalDataCleanupError';
  }
}

type WithAccountOperationsQuiesced = <TResult>(
  context: LocalDataCleanupContext,
  action: () => Promise<TResult>,
) => Promise<TResult>;

type LocalDataCleanupOptions = {
  database: CleanupDatabase;
  originalStore: OriginalStore;
  userDataPath: string;
  fileSystem?: CleanupFileSystem;
  withAccountOperationsQuiesced: WithAccountOperationsQuiesced;
};

const accountScopedTables = [
  AcademicConnectionTable,
  AcademicContextEntryTable,
  AcademicContextTable,
  ArtifactStateTable,
  ArtifactTable,
  ArtifactVersionTable,
  AssistanceLedgerTable,
  BrowserWorkspaceTable,
  ConceptLinkTable,
  ConceptTable,
  ContextChunkTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseMaterialTable,
  CourseRecordTombstoneTable,
  CourseSourceTable,
  CourseTable,
  CourseworkProtectionTable,
  GradeEvidenceTable,
  LearningObservationTable,
  MemoryTable,
  NavigationLocationTable,
  NotificationEventTable,
  PracticeAnswerTable,
  PracticeAttemptTable,
  SettingTable,
  StudyMessageTable,
  StudySessionTable,
  StudySourceReferenceTable,
  StudyTurnTable,
  WatchTargetTable,
] as const;

const isMissingPath = (cause: unknown) =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  cause.code === 'ENOENT';

const assertCurrent = (context: LocalDataCleanupContext) => {
  if (context.signal.aborted) throw new LocalDataCleanupError('cancelled');
  if (!context.isCurrent()) throw new LocalDataCleanupError('session-changed');
  if (!context.userId.trim()) throw new LocalDataCleanupError('invalid-input');
};

const deleteAccountRows = (transaction: CleanupTransaction, userId: string) => {
  const courseMaterialIds = transaction
    .select({ id: CourseMaterialTable.id })
    .from(CourseMaterialTable)
    .where(eq(CourseMaterialTable.userId, userId))
    .all()
    .map(({ id }) => id);

  transaction
    .delete(NotificationEventTable)
    .where(eq(NotificationEventTable.userId, userId))
    .run();
  transaction
    .delete(PracticeAnswerTable)
    .where(eq(PracticeAnswerTable.userId, userId))
    .run();
  transaction
    .delete(StudySourceReferenceTable)
    .where(eq(StudySourceReferenceTable.userId, userId))
    .run();
  transaction
    .delete(StudyMessageTable)
    .where(eq(StudyMessageTable.userId, userId))
    .run();
  transaction
    .delete(StudyTurnTable)
    .where(eq(StudyTurnTable.userId, userId))
    .run();
  transaction
    .delete(ArtifactStateTable)
    .where(eq(ArtifactStateTable.userId, userId))
    .run();
  transaction
    .delete(LearningObservationTable)
    .where(eq(LearningObservationTable.userId, userId))
    .run();
  transaction
    .delete(AssistanceLedgerTable)
    .where(eq(AssistanceLedgerTable.userId, userId))
    .run();
  transaction
    .delete(CourseworkProtectionTable)
    .where(eq(CourseworkProtectionTable.userId, userId))
    .run();
  transaction
    .delete(PracticeAttemptTable)
    .where(eq(PracticeAttemptTable.userId, userId))
    .run();
  transaction
    .delete(ArtifactVersionTable)
    .where(eq(ArtifactVersionTable.userId, userId))
    .run();
  transaction
    .delete(ArtifactTable)
    .where(eq(ArtifactTable.userId, userId))
    .run();
  transaction
    .delete(ContextChunkTable)
    .where(eq(ContextChunkTable.userId, userId))
    .run();
  transaction
    .delete(ContextLinkTable)
    .where(eq(ContextLinkTable.userId, userId))
    .run();
  transaction
    .delete(ContextVersionTable)
    .where(eq(ContextVersionTable.userId, userId))
    .run();
  transaction
    .delete(ContextItemTable)
    .where(eq(ContextItemTable.userId, userId))
    .run();
  transaction
    .delete(ConceptLinkTable)
    .where(eq(ConceptLinkTable.userId, userId))
    .run();
  transaction.delete(ConceptTable).where(eq(ConceptTable.userId, userId)).run();
  transaction.delete(MemoryTable).where(eq(MemoryTable.userId, userId)).run();
  transaction
    .delete(GradeEvidenceTable)
    .where(eq(GradeEvidenceTable.userId, userId))
    .run();
  transaction
    .delete(StudySessionTable)
    .where(eq(StudySessionTable.userId, userId))
    .run();
  transaction
    .delete(CourseAnnouncementTable)
    .where(eq(CourseAnnouncementTable.userId, userId))
    .run();
  transaction
    .delete(CourseAssignmentTable)
    .where(eq(CourseAssignmentTable.userId, userId))
    .run();
  transaction
    .delete(WatchTargetTable)
    .where(eq(WatchTargetTable.userId, userId))
    .run();
  transaction
    .delete(CourseRecordTombstoneTable)
    .where(eq(CourseRecordTombstoneTable.userId, userId))
    .run();
  transaction
    .delete(CourseSourceTable)
    .where(eq(CourseSourceTable.userId, userId))
    .run();
  transaction
    .delete(NavigationLocationTable)
    .where(eq(NavigationLocationTable.userId, userId))
    .run();
  transaction
    .delete(AcademicContextEntryTable)
    .where(eq(AcademicContextEntryTable.userId, userId))
    .run();

  if (courseMaterialIds.length > 0) {
    transaction
      .delete(CourseMaterialChunkTable)
      .where(inArray(CourseMaterialChunkTable.materialId, courseMaterialIds))
      .run();
    transaction
      .delete(CourseMaterialVersionTable)
      .where(inArray(CourseMaterialVersionTable.materialId, courseMaterialIds))
      .run();
  }

  transaction
    .delete(CourseMaterialTable)
    .where(eq(CourseMaterialTable.userId, userId))
    .run();
  transaction.delete(CourseTable).where(eq(CourseTable.userId, userId)).run();
  transaction
    .delete(AcademicConnectionTable)
    .where(eq(AcademicConnectionTable.userId, userId))
    .run();
  transaction
    .delete(AcademicContextTable)
    .where(eq(AcademicContextTable.userId, userId))
    .run();
  transaction
    .delete(BrowserWorkspaceTable)
    .where(eq(BrowserWorkspaceTable.userId, userId))
    .run();
  transaction.delete(SettingTable).where(eq(SettingTable.userId, userId)).run();

  for (const table of accountScopedTables) {
    const remainingAccountRow = transaction
      .select({ userId: table.userId })
      .from(table)
      .where(eq(table.userId, userId))
      .limit(1)
      .get();
    if (remainingAccountRow) throw new LocalDataCleanupError('storage-failed');
  }

  if (courseMaterialIds.length > 0) {
    const remainingMaterialChunk = transaction
      .select({ materialId: CourseMaterialChunkTable.materialId })
      .from(CourseMaterialChunkTable)
      .where(inArray(CourseMaterialChunkTable.materialId, courseMaterialIds))
      .limit(1)
      .get();
    const remainingMaterialVersion = transaction
      .select({ materialId: CourseMaterialVersionTable.materialId })
      .from(CourseMaterialVersionTable)
      .where(inArray(CourseMaterialVersionTable.materialId, courseMaterialIds))
      .limit(1)
      .get();
    if (remainingMaterialChunk || remainingMaterialVersion)
      throw new LocalDataCleanupError('storage-failed');
  }
};

const removeUnreferencedOriginals = async (
  database: CleanupDatabase,
  originalStore: OriginalStore,
  userId: string,
) => {
  const storageKeys = await originalStore.list(userId);
  if (storageKeys.length === 0) return;

  const referencedStorageKeys = new Set(
    database
      .select({ storageKey: ContextVersionTable.originalStorageKey })
      .from(ContextVersionTable)
      .where(inArray(ContextVersionTable.originalStorageKey, storageKeys))
      .all()
      .flatMap(({ storageKey }) => (storageKey ? [storageKey] : [])),
  );

  for (const storageKey of storageKeys) {
    if (referencedStorageKeys.has(storageKey)) continue;
    await originalStore.remove(userId, storageKey);
    if (await originalStore.has(userId, storageKey))
      throw new LocalDataCleanupError('storage-failed');
  }
};

const removeAccountProfiles = async (
  fileSystem: CleanupFileSystem,
  userDataPath: string,
  userId: string,
) => {
  // Profiles are keyed by account and executable; use the account parent only.
  const accountProfilesPath = path.resolve(
    path.dirname(profileDirectoryFor(userDataPath, userId, '')),
  );
  const profilesRoot = path.resolve(userDataPath, 'study-profiles');
  if (path.dirname(accountProfilesPath) !== profilesRoot)
    throw new LocalDataCleanupError('storage-failed');

  let profilesRootStats: Awaited<ReturnType<typeof fileSystem.lstat>>;
  try {
    profilesRootStats = await fileSystem.lstat(profilesRoot);
  } catch (cause) {
    if (isMissingPath(cause)) return;
    throw new LocalDataCleanupError('storage-failed');
  }
  if (!profilesRootStats.isDirectory() || profilesRootStats.isSymbolicLink())
    throw new LocalDataCleanupError('storage-failed');

  let accountProfilesStats: Awaited<ReturnType<typeof fileSystem.lstat>>;
  try {
    accountProfilesStats = await fileSystem.lstat(accountProfilesPath);
  } catch (cause) {
    if (isMissingPath(cause)) return;
    throw new LocalDataCleanupError('storage-failed');
  }
  if (
    !accountProfilesStats.isDirectory() ||
    accountProfilesStats.isSymbolicLink()
  )
    throw new LocalDataCleanupError('storage-failed');

  const profileEntries = await fileSystem.readdir(accountProfilesPath, {
    withFileTypes: true,
  });
  for (const entry of profileEntries) {
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const profilePath = path.join(accountProfilesPath, entry.name);
    const profileStats = await fileSystem.lstat(profilePath);
    if (!profileStats.isDirectory() || profileStats.isSymbolicLink())
      throw new LocalDataCleanupError('storage-failed');
    await fileSystem.rm(profilePath, { recursive: true });
  }
  const remainingProfiles = await fileSystem.readdir(accountProfilesPath, {
    withFileTypes: true,
  });
  if (remainingProfiles.some((entry) => /^[a-f0-9]{64}$/.test(entry.name)))
    throw new LocalDataCleanupError('storage-failed');
};

export const createLocalDataCleanup = ({
  database,
  originalStore,
  userDataPath,
  fileSystem: cleanupFileSystem = fileSystem,
  withAccountOperationsQuiesced,
}: LocalDataCleanupOptions) => {
  const deleteLocalAcademicData = async (
    context: LocalDataCleanupContext,
    input: unknown,
  ): Promise<DeleteLocalAcademicDataResult> => {
    const parsedInput = deleteLocalAcademicDataInputSchema.safeParse(input);
    if (!parsedInput.success) throw new LocalDataCleanupError('invalid-input');
    assertCurrent(context);

    try {
      await withAccountOperationsQuiesced(context, async () => {
        assertCurrent(context);
        database.transaction((transaction) => {
          assertCurrent(context);
          deleteAccountRows(transaction, context.userId);
        });
        assertCurrent(context);
        await removeUnreferencedOriginals(
          database,
          originalStore,
          context.userId,
        );
        assertCurrent(context);
        await removeAccountProfiles(
          cleanupFileSystem,
          userDataPath,
          context.userId,
        );
      });
    } catch (cause) {
      if (cause instanceof LocalDataCleanupError) throw cause;
      if (context.signal.aborted) throw new LocalDataCleanupError('cancelled');
      if (!context.isCurrent())
        throw new LocalDataCleanupError('session-changed');
      throw new LocalDataCleanupError('storage-failed');
    }

    return {
      requestId: parsedInput.data.requestId,
      scope: parsedInput.data.scope,
      status: 'deleted',
    };
  };

  return { deleteLocalAcademicData };
};
