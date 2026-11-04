import { createHash, randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  like,
  lt,
  notInArray,
  or,
} from 'drizzle-orm';
import type { BetterSQLiteTransaction } from 'drizzle-orm/better-sqlite3';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { z } from 'zod';
import {
  pageInputSchema,
  safeErrorCodeSchema,
  type AuthorizedContext,
  type Page,
  type PageInput,
  type ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import { sourceReferenceSchema } from '@scholaros/services/learning/context-contracts';
import {
  createStudySessionInputSchema,
  studyMessagePartSchema,
  studyMessageSchema,
  studySessionSchema,
  studySessionStatuses,
  turnSchema,
  type CreateStudySessionInput,
  type MessagePart,
  type SessionSnapshot,
  type StudyMessageDTO,
  type StudySessionDTO,
  type TurnDTO,
} from '@scholaros/services/learning/study-contracts';
import { db } from '../../../db';
import * as schema from '../../../db/schema';
import {
  ArtifactStateTable,
  ArtifactTable,
  ArtifactVersionTable,
  AssistanceLedgerTable,
  ContextChunkTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseMaterialTable,
  CourseTable,
  CourseworkProtectionTable,
  GradeEvidenceTable,
  LearningObservationTable,
  PracticeAttemptTable,
  SettingTable,
  StudyMessageTable,
  StudySessionTable,
  StudySourceReferenceTable,
  StudyTurnTable,
  type StudySessionSelectData,
} from '../../../db/schema';
import { createStudyTimer } from './session-timer';
import {
  cancelStudySessionOperations,
  createStudySessionEvent,
  hasStudySessionOperation,
  publishStudySessionEvent,
  StudySessionError,
} from './session-events';

export type StudyTurnAdmissionInput = {
  sessionId: string;
  requestId: string;
  expectedDraftRevision: number;
  text: string;
  attachmentIds: string[];
};

export type StudyTurnAdmission = {
  turnId: string;
  generationEpoch: number;
  revision: number;
  policyRevision: number;
  contextRevision: number;
  gradeConsentRevision: number;
  duplicate: boolean;
  turn: TurnDTO;
};

export type CommitStudyTurnInput = {
  turnId: string;
  generationEpoch: number;
  policyRevision: number;
  contextRevision: number;
  parts: MessagePart[];
  sourceReferences: z.infer<typeof sourceReferenceSchema>[];
  gradeDerived: boolean;
  gradeConsentRevision: number | null;
};

export type AppendStudyTurnPartsInput = {
  sessionId: string;
  turnId: string;
  generationEpoch: number;
  idempotencyKey: string;
  parts: MessagePart[];
};

export type AppendStudyTurnPartsResult = {
  committed: boolean;
  revision: number;
};

export type CreateSessionStoreOptions = {
  database?: typeof db;
  now?: () => number;
  idGenerator?: () => string;
  // Retry may supply keys already removed by a partial prior attempt.
  cleanupOriginals?: (
    context: AuthorizedContext,
    userId: string,
    storageKeys: string[],
  ) => void | Promise<void>;
  publish?: (event: ProductEventV1) => void;
};

type Transaction = BetterSQLiteTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type StudyRevisions = {
  policyRevision: number;
  contextRevision: number;
  gradeConsentRevision: number;
  gradesEnabled: boolean;
};
type CursorData = {
  userId: string;
  query: string | null;
  courseId: string | null;
  status: StudySessionDTO['status'] | null;
  updatedAt: string;
  id: string;
};

const createSessionInput = createStudySessionInputSchema;
const listSessionsInput = z.strictObject({
  ...pageInputSchema.shape,
  status: z.enum(studySessionStatuses).optional(),
});
const getSessionInput = z.strictObject({
  sessionId: z.string().min(1).max(300),
  beforeSequence: z.number().int().nonnegative().safe().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const renameSessionInput = z.strictObject({
  sessionId: z.string().min(1).max(300),
  title: z.string().trim().min(1).max(160),
  expectedRevision: z.number().int().nonnegative().safe(),
});
const saveDraftInput = z.strictObject({
  sessionId: z.string().min(1).max(300),
  text: z.string().max(8000),
  expectedDraftRevision: z.number().int().nonnegative().safe(),
});
const deleteSessionInput = z.strictObject({
  sessionId: z.string().min(1).max(300),
  expectedRevision: z.number().int().nonnegative().safe(),
  requestId: z.uuid(),
});
const beginTurnInput = z.strictObject({
  sessionId: z.string().min(1).max(300),
  requestId: z.uuid(),
  expectedDraftRevision: z.number().int().nonnegative().safe(),
  text: z.string().max(8000),
  attachmentIds: z.array(z.string().min(1).max(300)).max(8),
});
const commitTurnInput = z.strictObject({
  turnId: z.string().min(1).max(300),
  generationEpoch: z.number().int().nonnegative().safe(),
  policyRevision: z.number().int().nonnegative().safe(),
  contextRevision: z.number().int().nonnegative().safe(),
  parts: z.array(studyMessagePartSchema).min(1).max(100),
  sourceReferences: z.array(sourceReferenceSchema).max(20),
  gradeDerived: z.boolean(),
  gradeConsentRevision: z.number().int().nonnegative().safe().nullable(),
});
const appendTurnPartsInput = z.strictObject({
  sessionId: z.string().min(1).max(300),
  turnId: z.string().min(1).max(300),
  generationEpoch: z.number().int().nonnegative().safe(),
  idempotencyKey: z.string().min(1).max(1000),
  parts: z.unknown(),
});
const appendTurnPartsSchema = z.array(studyMessagePartSchema).min(1).max(100);
const settleTurnInput = z.strictObject({
  turnId: z.string().min(1).max(300),
  status: z.enum(['failed', 'cancelled']),
  errorCode: safeErrorCodeSchema.optional(),
});
const updateTurnStatusInput = z.strictObject({
  turnId: z.string().min(1).max(300),
  status: z.enum(['generating', 'checking']),
});
const purgeGradeContentInput = z.strictObject({
  consentRevision: z.number().int().nonnegative().safe(),
});

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const stableId = (value: string) => {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const revisionFromDigest = (value: string) =>
  Number.parseInt(sha256(value).slice(0, 12), 16);

const assertCurrent = (context: AuthorizedContext) => {
  if (!context.isCurrent() || context.signal.aborted)
    throw new StudySessionError(
      'session-changed',
      'Your account session changed.',
    );
};

const toIso = (milliseconds: number) => {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime()))
    throw new StudySessionError(
      'invalid-input',
      'The device clock is unavailable.',
    );
  return date.toISOString();
};

const asStudyError = (error: unknown, message: string) =>
  error instanceof StudySessionError
    ? error
    : new StudySessionError('storage-failed', message);

const publishSessionChange = (
  publish: CreateSessionStoreOptions['publish'],
  context: AuthorizedContext,
  sessionId: string,
  revision: number,
  operationId?: string,
) => {
  if (!publish) return;
  publishStudySessionEvent(
    publish,
    createStudySessionEvent(context, {
      revision,
      sessionId,
      ...(operationId ? { operationId } : {}),
    }),
  );
};

const readSession = (
  transaction: Transaction,
  context: AuthorizedContext,
  sessionId: string,
  includeDeleted = false,
) =>
  transaction
    .select()
    .from(StudySessionTable)
    .where(
      and(
        eq(StudySessionTable.userId, context.userId),
        eq(StudySessionTable.id, sessionId),
        ...(includeDeleted ? [] : [isNull(StudySessionTable.deletedAt)]),
      ),
    )
    .get();

const collectDisposableOriginalStorageKeys = (
  transaction: Transaction,
  userId: string,
  sessionId: string,
) => {
  const contextLinks = transaction
    .select({ itemId: ContextLinkTable.itemId })
    .from(ContextLinkTable)
    .where(
      and(
        eq(ContextLinkTable.userId, userId),
        eq(ContextLinkTable.sessionId, sessionId),
      ),
    )
    .all();
  const originatingItems = transaction
    .select({ id: ContextItemTable.id })
    .from(ContextItemTable)
    .where(
      and(
        eq(ContextItemTable.userId, userId),
        eq(ContextItemTable.originatingSessionId, sessionId),
      ),
    )
    .all();
  const candidateItemIds = [
    ...new Set([
      ...contextLinks.map((link) => link.itemId),
      ...originatingItems.map((item) => item.id),
    ]),
  ];
  const deletedItemIds: string[] = [];
  const originalStorageKeys: string[] = [];

  for (const itemId of candidateItemIds) {
    const links = transaction
      .select()
      .from(ContextLinkTable)
      .where(
        and(
          eq(ContextLinkTable.userId, userId),
          eq(ContextLinkTable.itemId, itemId),
        ),
      )
      .all();
    const retainedElsewhere = links.some(
      (link) => link.sessionId !== sessionId,
    );
    const retainedInSession = links.some(
      (link) => link.sessionId === sessionId && link.retainedInLibrary,
    );
    if (retainedElsewhere || retainedInSession) continue;

    deletedItemIds.push(itemId);
    const versions = transaction
      .select({ originalStorageKey: ContextVersionTable.originalStorageKey })
      .from(ContextVersionTable)
      .where(
        and(
          eq(ContextVersionTable.userId, userId),
          eq(ContextVersionTable.itemId, itemId),
        ),
      )
      .all();
    originalStorageKeys.push(
      ...versions.flatMap((version) =>
        version.originalStorageKey ? [version.originalStorageKey] : [],
      ),
    );
  }

  const candidateKeys = [...new Set(originalStorageKeys)];
  if (!candidateKeys.length) return [];
  const remainingOriginals = transaction
    .select({ originalStorageKey: ContextVersionTable.originalStorageKey })
    .from(ContextVersionTable)
    .where(
      and(
        eq(ContextVersionTable.userId, userId),
        inArray(ContextVersionTable.originalStorageKey, candidateKeys),
        ...(deletedItemIds.length
          ? [notInArray(ContextVersionTable.itemId, deletedItemIds)]
          : []),
      ),
    )
    .all()
    .map((version) => version.originalStorageKey);
  return candidateKeys
    .filter((key) => !remainingOriginals.includes(key))
    .sort();
};

const currentGradeSettings = (transaction: Transaction, userId: string) => {
  const setting = transaction
    .select({ productPreferences: SettingTable.productPreferences })
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get();
  return (
    setting?.productPreferences.grades ?? {
      enabled: false,
      notes: '',
      revision: 0,
    }
  );
};

const readStudyRevisions = (
  transaction: Transaction,
  context: AuthorizedContext,
  session: StudySessionSelectData,
): StudyRevisions => {
  const course = transaction
    .select({
      id: CourseTable.id,
      lastSeenAt: CourseTable.lastSeenAt,
      contentChangedAt: CourseTable.contentChangedAt,
      overviewSyncedAt: CourseTable.overviewSyncedAt,
      assignmentsStatus: CourseTable.assignmentsStatus,
      assignmentsSyncedAt: CourseTable.assignmentsSyncedAt,
      announcementsStatus: CourseTable.announcementsStatus,
      announcementsSyncedAt: CourseTable.announcementsSyncedAt,
      materialsStatus: CourseTable.materialsStatus,
      materialsAttemptedAt: CourseTable.materialsAttemptedAt,
      materialsSyncedAt: CourseTable.materialsSyncedAt,
      active: CourseTable.active,
      suppressedAt: CourseTable.suppressedAt,
    })
    .from(CourseTable)
    .where(
      and(
        eq(CourseTable.userId, context.userId),
        eq(CourseTable.id, session.courseId),
      ),
    )
    .get();
  const contextLinks = transaction
    .select({
      itemId: ContextLinkTable.itemId,
      courseId: ContextLinkTable.courseId,
      sessionId: ContextLinkTable.sessionId,
      retainedInLibrary: ContextLinkTable.retainedInLibrary,
    })
    .from(ContextLinkTable)
    .where(
      and(
        eq(ContextLinkTable.userId, context.userId),
        or(
          eq(ContextLinkTable.sessionId, session.id),
          and(
            eq(ContextLinkTable.courseId, session.courseId),
            isNull(ContextLinkTable.sessionId),
          ),
        ),
      ),
    )
    .orderBy(asc(ContextLinkTable.itemId))
    .all();
  const contextItemIds = [...new Set(contextLinks.map((link) => link.itemId))];
  const contextItems = contextItemIds.length
    ? transaction
        .select({
          id: ContextItemTable.id,
          currentVersionId: ContextItemTable.currentVersionId,
          revision: ContextItemTable.revision,
          status: ContextItemTable.status,
          removedAt: ContextItemTable.removedAt,
        })
        .from(ContextItemTable)
        .where(
          and(
            eq(ContextItemTable.userId, context.userId),
            inArray(ContextItemTable.id, contextItemIds),
          ),
        )
        .orderBy(asc(ContextItemTable.id))
        .all()
    : [];
  const targetAssignment = session.targetAssignmentId
    ? transaction
        .select({
          id: CourseAssignmentTable.id,
          contentChangedAt: CourseAssignmentTable.contentChangedAt,
          active: CourseAssignmentTable.active,
          suppressedAt: CourseAssignmentTable.suppressedAt,
        })
        .from(CourseAssignmentTable)
        .where(
          and(
            eq(CourseAssignmentTable.userId, context.userId),
            eq(CourseAssignmentTable.courseId, session.courseId),
            eq(CourseAssignmentTable.id, session.targetAssignmentId),
          ),
        )
        .get()
    : null;
  const materials = transaction
    .select({
      id: CourseMaterialTable.id,
      currentUsableVersion: CourseMaterialTable.currentUsableVersion,
      extractionStatus: CourseMaterialTable.extractionStatus,
      active: CourseMaterialTable.active,
      suppressedAt: CourseMaterialTable.suppressedAt,
    })
    .from(CourseMaterialTable)
    .where(
      and(
        eq(CourseMaterialTable.userId, context.userId),
        eq(CourseMaterialTable.courseId, session.courseId),
      ),
    )
    .orderBy(asc(CourseMaterialTable.id))
    .limit(1000)
    .all();
  const courseworkPolicies = transaction
    .select({
      id: CourseworkProtectionTable.id,
      canonicalIdentity: CourseworkProtectionTable.canonicalIdentity,
      aliases: CourseworkProtectionTable.aliases,
      state: CourseworkProtectionTable.state,
      policyRevision: CourseworkProtectionTable.policyRevision,
      verifiedAt: CourseworkProtectionTable.verifiedAt,
      sourceEvidenceId: CourseworkProtectionTable.sourceEvidenceId,
      suppressed: CourseworkProtectionTable.suppressed,
    })
    .from(CourseworkProtectionTable)
    .where(
      and(
        eq(CourseworkProtectionTable.userId, context.userId),
        eq(CourseworkProtectionTable.courseId, session.courseId),
      ),
    )
    .orderBy(asc(CourseworkProtectionTable.id))
    .limit(1000)
    .all();
  const grades = currentGradeSettings(transaction, context.userId);
  const contextRevision = revisionFromDigest(
    JSON.stringify({
      course,
      targetAssignment,
      contextLinks,
      contextItems,
      materials,
      selectedAssignmentId: session.targetAssignmentId,
    }),
  );
  const policyRevision = revisionFromDigest(
    JSON.stringify({
      courseworkPolicies,
      gradeConsentRevision: grades.revision,
      gradesEnabled: grades.enabled,
    }),
  );
  return {
    policyRevision,
    contextRevision,
    gradeConsentRevision: grades.revision,
    gradesEnabled: grades.enabled,
  };
};

const toStudySessionDTO = (session: StudySessionSelectData): StudySessionDTO =>
  studySessionSchema.parse({
    id: session.id,
    courseId: session.courseId,
    title: session.title,
    activity: session.activity,
    targetAssignmentId: session.targetAssignmentId,
    topic: session.topic,
    status: session.status,
    revision: session.revision,
    generationEpoch: session.generationEpoch,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastOpenedAt: session.lastOpenedAt,
    draft: { text: session.draftText, revision: session.draftRevision },
    timer: {
      deadlineAt: session.deadlineAt,
      revision: session.timerRevision,
      expiredRevision: session.expiredRevision,
      resolvedExpiredRevision: session.resolvedExpiredRevision,
      finishedAt: session.finishedAt,
    },
  });

const toTurnDTO = (turn: typeof StudyTurnTable.$inferSelect): TurnDTO =>
  turnSchema.parse({
    id: turn.id,
    sessionId: turn.sessionId,
    status: turn.status,
    attemptNumber: turn.attemptNumber,
    errorCode: turn.errorCode,
    startedAt: turn.startedAt,
    settledAt: turn.settledAt,
  });

const messageSequence = (
  transaction: Transaction,
  userId: string,
  sessionId: string,
) => {
  const latestStudyMessage = transaction
    .select({ sequence: StudyMessageTable.sequence })
    .from(StudyMessageTable)
    .where(
      and(
        eq(StudyMessageTable.userId, userId),
        eq(StudyMessageTable.sessionId, sessionId),
      ),
    )
    .orderBy(desc(StudyMessageTable.sequence))
    .limit(1)
    .get();
  return (latestStudyMessage?.sequence ?? -1) + 1;
};

const sessionTitleFor = (
  input: CreateStudySessionInput,
  courseName: string,
) => {
  if (input.title?.trim()) return input.title.trim();
  if (input.topic?.trim()) return input.topic.trim().slice(0, 160);
  switch (input.activity) {
    case 'understand-topic':
      return `Understand ${courseName}`.slice(0, 160);
    case 'prepare-exam':
      return `Prepare for an exam in ${courseName}`.slice(0, 160);
    case 'practice-knowledge':
      return `Practice ${courseName}`.slice(0, 160);
    case 'review-graded-mistakes':
      return `Review graded work in ${courseName}`.slice(0, 160);
    case 'assignment-start':
      return `Start an assignment in ${courseName}`.slice(0, 160);
  }
};

const getSessionContextLinks = (
  transaction: Transaction,
  userId: string,
  sessionId: string,
) =>
  transaction
    .select()
    .from(ContextLinkTable)
    .where(
      and(
        eq(ContextLinkTable.userId, userId),
        eq(ContextLinkTable.sessionId, sessionId),
      ),
    )
    .all();

const validateContextItems = (
  transaction: Transaction,
  userId: string,
  courseId: string,
  contextItemIds: string[],
) => {
  if (new Set(contextItemIds).size !== contextItemIds.length)
    throw new StudySessionError(
      'invalid-input',
      'A context item was selected more than once.',
    );
  for (const itemId of contextItemIds) {
    const item = transaction
      .select()
      .from(ContextItemTable)
      .where(
        and(
          eq(ContextItemTable.userId, userId),
          eq(ContextItemTable.id, itemId),
        ),
      )
      .get();
    if (!item || item.removedAt)
      throw new StudySessionError(
        'scope-denied',
        'A selected context item is unavailable.',
      );
    const links = transaction
      .select()
      .from(ContextLinkTable)
      .where(
        and(
          eq(ContextLinkTable.userId, userId),
          eq(ContextLinkTable.itemId, itemId),
          isNull(ContextLinkTable.sessionId),
        ),
      )
      .all();
    if (
      links.some((link) => link.courseId !== null && link.courseId !== courseId)
    )
      throw new StudySessionError(
        'scope-denied',
        'A selected context item belongs to another course.',
      );
  }
};

const createCursor = (data: CursorData) =>
  Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');

const parseCursor = (value: string): CursorData | null => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as unknown;
    const schema = z.strictObject({
      userId: z.string().min(1).max(300),
      query: z.string().nullable(),
      courseId: z.string().nullable(),
      status: z.enum(studySessionStatuses).nullable(),
      updatedAt: z.iso.datetime({ offset: true }),
      id: z.string().min(1).max(300),
    });
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

const normalizeSearch = (value: string | undefined) =>
  value?.trim().toLocaleLowerCase() ?? '';

const escapeLike = (value: string) =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);

const readActiveGradeSettings = (transaction: Transaction, userId: string) =>
  currentGradeSettings(transaction, userId);

const validateSessionSourceReference = (
  transaction: Transaction,
  context: AuthorizedContext,
  session: StudySessionSelectData,
  reference: z.infer<typeof sourceReferenceSchema>,
  revisions: Pick<StudyRevisions, 'gradeConsentRevision' | 'gradesEnabled'>,
) => {
  if (reference.state !== 'current')
    throw new StudySessionError(
      'scope-denied',
      'A study source is no longer current.',
    );
  if (reference.courseId !== null && reference.courseId !== session.courseId)
    throw new StudySessionError(
      'scope-denied',
      'A study source belongs to another course.',
    );

  switch (reference.sourceKind) {
    case 'context-version': {
      const item = transaction
        .select()
        .from(ContextItemTable)
        .where(
          and(
            eq(ContextItemTable.userId, context.userId),
            eq(ContextItemTable.id, reference.sourceId),
            isNull(ContextItemTable.removedAt),
          ),
        )
        .get();
      const allowedLink = transaction
        .select()
        .from(ContextLinkTable)
        .where(
          and(
            eq(ContextLinkTable.userId, context.userId),
            eq(ContextLinkTable.itemId, reference.sourceId),
            or(
              eq(ContextLinkTable.sessionId, session.id),
              and(
                eq(ContextLinkTable.courseId, session.courseId),
                isNull(ContextLinkTable.sessionId),
              ),
              and(
                isNull(ContextLinkTable.courseId),
                isNull(ContextLinkTable.sessionId),
                eq(ContextLinkTable.retainedInLibrary, true),
              ),
            ),
          ),
        )
        .get();
      if (
        !item ||
        item.currentVersionId !== reference.versionId ||
        !allowedLink
      )
        throw new StudySessionError(
          'session-changed',
          'A selected context source changed.',
        );
      break;
    }
    case 'course-material': {
      const material = transaction
        .select()
        .from(CourseMaterialTable)
        .where(
          and(
            eq(CourseMaterialTable.userId, context.userId),
            eq(CourseMaterialTable.courseId, session.courseId),
            eq(CourseMaterialTable.id, reference.sourceId),
            eq(CourseMaterialTable.active, true),
            isNull(CourseMaterialTable.suppressedAt),
          ),
        )
        .get();
      if (!material || material.currentUsableVersion !== reference.versionId)
        throw new StudySessionError(
          'session-changed',
          'A course material source changed.',
        );
      break;
    }
    case 'assignment': {
      const assignment = transaction
        .select({ id: CourseAssignmentTable.id })
        .from(CourseAssignmentTable)
        .where(
          and(
            eq(CourseAssignmentTable.userId, context.userId),
            eq(CourseAssignmentTable.courseId, session.courseId),
            eq(CourseAssignmentTable.id, reference.sourceId),
            eq(CourseAssignmentTable.active, true),
            isNull(CourseAssignmentTable.suppressedAt),
          ),
        )
        .get();
      if (!assignment)
        throw new StudySessionError(
          'session-changed',
          'A selected assignment changed.',
        );
      break;
    }
    case 'announcement': {
      const announcement = transaction
        .select({ id: CourseAnnouncementTable.id })
        .from(CourseAnnouncementTable)
        .where(
          and(
            eq(CourseAnnouncementTable.userId, context.userId),
            eq(CourseAnnouncementTable.courseId, session.courseId),
            eq(CourseAnnouncementTable.id, reference.sourceId),
            eq(CourseAnnouncementTable.active, true),
            isNull(CourseAnnouncementTable.suppressedAt),
          ),
        )
        .get();
      if (!announcement)
        throw new StudySessionError(
          'session-changed',
          'A selected announcement changed.',
        );
      break;
    }
    case 'saved-activity': {
      const artifact = transaction
        .select({ id: ArtifactTable.id })
        .from(ArtifactTable)
        .where(
          and(
            eq(ArtifactTable.userId, context.userId),
            eq(ArtifactTable.id, reference.sourceId),
            isNull(ArtifactTable.removedAt),
            or(
              isNull(ArtifactTable.courseId),
              eq(ArtifactTable.courseId, session.courseId),
            ),
          ),
        )
        .get();
      if (!artifact)
        throw new StudySessionError(
          'session-changed',
          'A saved activity source changed.',
        );
      break;
    }
    case 'grade-evidence': {
      if (!revisions.gradesEnabled || revisions.gradeConsentRevision < 0)
        throw new StudySessionError(
          'permission-revoked',
          'Grade access is no longer available.',
        );
      const evidence = transaction
        .select({
          id: GradeEvidenceTable.id,
          consentRevision: GradeEvidenceTable.consentRevision,
        })
        .from(GradeEvidenceTable)
        .where(
          and(
            eq(GradeEvidenceTable.userId, context.userId),
            eq(GradeEvidenceTable.courseId, session.courseId),
            eq(GradeEvidenceTable.id, reference.sourceId),
            isNull(GradeEvidenceTable.revokedAt),
          ),
        )
        .get();
      if (
        !evidence ||
        evidence.consentRevision !== revisions.gradeConsentRevision
      )
        throw new StudySessionError(
          'permission-revoked',
          'Grade access is no longer available.',
        );
      break;
    }
  }
};

const cursorWhere = (cursor: CursorData) =>
  or(
    lt(StudySessionTable.updatedAt, cursor.updatedAt),
    and(
      eq(StudySessionTable.updatedAt, cursor.updatedAt),
      lt(StudySessionTable.id, cursor.id),
    ),
  );

const maskGradeDerivedMessage = (
  message: StudyMessageDTO,
  gradeSettings: ReturnType<typeof currentGradeSettings>,
): StudyMessageDTO => {
  if (
    !message.gradeDerived ||
    (gradeSettings.enabled &&
      message.gradeConsentRevision === gradeSettings.revision)
  )
    return message;
  return {
    ...message,
    parts: [
      {
        kind: 'status',
        code: 'grade-content-withheld',
        label:
          'Grade-derived content is unavailable while grade access is off.',
      },
    ],
  };
};

export const createSessionStore = ({
  database = db,
  now = Date.now,
  idGenerator = randomUUID,
  cleanupOriginals,
  publish,
}: CreateSessionStoreOptions = {}) => {
  const timer = createStudyTimer({ database, now, publish });

  const createStudySession = async (
    context: AuthorizedContext,
    rawInput: CreateStudySessionInput,
  ): Promise<StudySessionDTO> => {
    const parsedInput = createSessionInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError(
        'invalid-input',
        'Invalid study session details.',
      );
    assertCurrent(context);
    const input = parsedInput.data;
    const nowIso = toIso(now());
    const sessionId = stableId(
      `study-session\0${context.userId}\0${input.requestId}`,
    );

    try {
      const result = database.transaction((transaction) => {
        const existingStudySession = transaction
          .select()
          .from(StudySessionTable)
          .where(
            and(
              eq(StudySessionTable.id, sessionId),
              eq(StudySessionTable.userId, context.userId),
            ),
          )
          .get();
        const existingCourse = transaction
          .select({ id: CourseTable.id, name: CourseTable.name })
          .from(CourseTable)
          .where(
            and(
              eq(CourseTable.userId, context.userId),
              eq(CourseTable.id, input.courseId),
              eq(CourseTable.active, true),
              isNull(CourseTable.suppressedAt),
            ),
          )
          .get();
        if (!existingCourse)
          throw new StudySessionError(
            'scope-denied',
            'Choose an available course.',
          );

        const title = sessionTitleFor(input, existingCourse.name);
        if (existingStudySession) {
          if (existingStudySession.deletedAt)
            throw new StudySessionError(
              'not-found',
              'Study session not found.',
            );
          const existingContextIds = getSessionContextLinks(
            transaction,
            context.userId,
            existingStudySession.id,
          )
            .map((link) => link.itemId)
            .sort();
          const samePayload =
            existingStudySession.courseId === input.courseId &&
            existingStudySession.activity === input.activity &&
            existingStudySession.targetAssignmentId ===
              (input.targetAssignmentId ?? null) &&
            existingStudySession.topic === (input.topic?.trim() || null) &&
            existingStudySession.title === title &&
            JSON.stringify(existingContextIds) ===
              JSON.stringify([...input.contextItemIds].sort()) &&
            (existingStudySession.timerRevision > 0 ||
              existingStudySession.deadlineAt ===
                (input.durationMinutes === null
                  ? null
                  : toIso(
                      Date.parse(existingStudySession.createdAt) +
                        input.durationMinutes * 60_000,
                    )));
          if (!samePayload)
            throw new StudySessionError(
              'revision-conflict',
              'This create request ID was already used for different study details.',
            );
          return existingStudySession;
        }

        if (input.targetAssignmentId) {
          const targetAssignment = transaction
            .select({ id: CourseAssignmentTable.id })
            .from(CourseAssignmentTable)
            .where(
              and(
                eq(CourseAssignmentTable.userId, context.userId),
                eq(CourseAssignmentTable.courseId, input.courseId),
                eq(CourseAssignmentTable.id, input.targetAssignmentId),
                eq(CourseAssignmentTable.active, true),
                isNull(CourseAssignmentTable.suppressedAt),
              ),
            )
            .get();
          if (!targetAssignment)
            throw new StudySessionError(
              'scope-denied',
              'Choose an assignment from this course.',
            );
        }
        validateContextItems(
          transaction,
          context.userId,
          input.courseId,
          input.contextItemIds,
        );
        assertCurrent(context);

        const deadlineAt =
          input.durationMinutes === null
            ? null
            : toIso(Date.parse(nowIso) + input.durationMinutes * 60_000);
        const insertedStudySession = transaction
          .insert(StudySessionTable)
          .values({
            id: sessionId,
            userId: context.userId,
            courseId: input.courseId,
            title,
            activity: input.activity,
            targetAssignmentId: input.targetAssignmentId ?? null,
            topic: input.topic?.trim() || null,
            status: 'saved',
            revision: 0,
            generationEpoch: 0,
            draftText: '',
            draftRevision: 0,
            deadlineAt,
            timerRevision: 0,
            expiredRevision: null,
            resolvedExpiredRevision: null,
            finishedAt: null,
            deletedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
            lastOpenedAt: nowIso,
          })
          .returning()
          .get();
        for (const itemId of input.contextItemIds)
          transaction
            .insert(ContextLinkTable)
            .values({
              id: idGenerator(),
              userId: context.userId,
              itemId,
              courseId: input.courseId,
              sessionId,
              retainedInLibrary: false,
              createdAt: nowIso,
            })
            .run();
        return insertedStudySession;
      });
      assertCurrent(context);
      const studySession = toStudySessionDTO(result);
      publishSessionChange(
        publish,
        context,
        studySession.id,
        studySession.revision,
        input.requestId,
      );
      return studySession;
    } catch (error) {
      throw asStudyError(error, 'The study session could not be saved.');
    }
  };

  const listStudySessions = async (
    context: AuthorizedContext,
    rawInput: PageInput & { status?: StudySessionDTO['status'] },
  ): Promise<Page<StudySessionDTO> | null> => {
    const parsedInput = listSessionsInput.safeParse(rawInput);
    if (!parsedInput.success || !context.isCurrent() || context.signal.aborted)
      return null;
    const query = normalizeSearch(parsedInput.data.query);
    const courseId = parsedInput.data.courseId ?? null;
    const status = parsedInput.data.status ?? null;
    const cursor = parsedInput.data.cursor
      ? parseCursor(parsedInput.data.cursor)
      : null;
    if (
      (parsedInput.data.cursor && !cursor) ||
      (cursor &&
        (cursor.userId !== context.userId ||
          cursor.query !== (query || null) ||
          cursor.courseId !== courseId ||
          cursor.status !== status))
    )
      return null;

    try {
      await timer.reconcileDueStudyDeadlines(context);
      await reconcileOrphanedStudyTurns(context);
      const filters = [
        eq(StudySessionTable.userId, context.userId),
        isNull(StudySessionTable.deletedAt),
        ...(courseId ? [eq(StudySessionTable.courseId, courseId)] : []),
        ...(status ? [eq(StudySessionTable.status, status)] : []),
        ...(query
          ? [
              or(
                like(StudySessionTable.title, `%${escapeLike(query)}%`),
                like(StudySessionTable.topic, `%${escapeLike(query)}%`),
              )!,
            ]
          : []),
        ...(cursor ? [cursorWhere(cursor)] : []),
      ];
      const limit = parsedInput.data.limit ?? 25;
      const rows = database
        .select()
        .from(StudySessionTable)
        .where(and(...filters))
        .orderBy(desc(StudySessionTable.updatedAt), desc(StudySessionTable.id))
        .limit(limit + 1)
        .all();
      assertCurrent(context);
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map(toStudySessionDTO);
      const last = pageRows.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? createCursor({
              userId: context.userId,
              query: query || null,
              courseId,
              status,
              updatedAt: last.updatedAt,
              id: last.id,
            })
          : null;
      return {
        items,
        nextCursor,
        revision: Math.max(0, ...items.map((item) => item.revision)),
      };
    } catch {
      return null;
    }
  };

  const getStudySession = async (
    context: AuthorizedContext,
    rawInput: z.infer<typeof getSessionInput>,
  ): Promise<SessionSnapshot | null> => {
    const parsedInput = getSessionInput.safeParse(rawInput);
    if (!parsedInput.success || !context.isCurrent() || context.signal.aborted)
      return null;
    try {
      await timer.reconcileStudyDeadline(context, {
        sessionId: parsedInput.data.sessionId,
      });
      await reconcileOrphanedStudyTurns(context, parsedInput.data.sessionId);
      const snapshot = database.transaction((transaction) => {
        const session = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
        );
        if (!session) return null;
        const limit = parsedInput.data.limit ?? 100;
        const beforeSequence = parsedInput.data.beforeSequence;
        const query = transaction
          .select({
            id: StudyMessageTable.id,
            sessionId: StudyMessageTable.sessionId,
            sequence: StudyMessageTable.sequence,
            role: StudyMessageTable.role,
            turnId: StudyMessageTable.turnId,
            createdAt: StudyMessageTable.createdAt,
            parts: StudyMessageTable.parts,
            status: StudyMessageTable.status,
            gradeDerived: StudyMessageTable.gradeDerived,
            gradeConsentRevision: StudyMessageTable.gradeConsentRevision,
          })
          .from(StudyMessageTable)
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.sessionId, session.id),
              ...(beforeSequence === undefined
                ? []
                : [lt(StudyMessageTable.sequence, beforeSequence)]),
            ),
          )
          .orderBy(desc(StudyMessageTable.sequence))
          .limit(limit + 1)
          .all();
        const hasMoreBefore = query.length > limit;
        const pageMessages = query.slice(0, limit).reverse();
        const grades = readActiveGradeSettings(transaction, context.userId);
        const messages = pageMessages.map((row) =>
          maskGradeDerivedMessage(studyMessageSchema.parse(row), grades),
        );
        const activeTurnRow = transaction
          .select()
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, session.id),
              inArray(StudyTurnTable.status, [
                'preparing',
                'generating',
                'checking',
              ]),
            ),
          )
          .orderBy(desc(StudyTurnTable.startedAt))
          .limit(1)
          .get();
        const sourceReferences = messages.flatMap((message) =>
          message.parts.flatMap((part) =>
            part.kind === 'citation' ? [part.reference] : [],
          ),
        );
        return {
          session: toStudySessionDTO(session),
          messages,
          hasMoreBefore,
          activeTurn: activeTurnRow ? toTurnDTO(activeTurnRow) : null,
          sourceReferences,
          revision: session.revision,
        } satisfies SessionSnapshot;
      });
      assertCurrent(context);
      return snapshot;
    } catch {
      return null;
    }
  };

  const renameStudySession = async (
    context: AuthorizedContext,
    rawInput: z.infer<typeof renameSessionInput>,
  ): Promise<StudySessionDTO> => {
    const parsedInput = renameSessionInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid session title.');
    assertCurrent(context);
    try {
      const updatedStudySession = database.transaction((transaction) => {
        const existingStudySession = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
        );
        if (!existingStudySession)
          throw new StudySessionError('not-found', 'Study session not found.');
        if (
          existingStudySession.revision ===
            parsedInput.data.expectedRevision + 1 &&
          existingStudySession.title === parsedInput.data.title
        )
          return existingStudySession;
        if (existingStudySession.revision !== parsedInput.data.expectedRevision)
          throw new StudySessionError(
            'revision-conflict',
            'This study session changed.',
          );
        const nowIso = toIso(now());
        const updated = transaction
          .update(StudySessionTable)
          .set({
            title: parsedInput.data.title,
            revision: existingStudySession.revision + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, existingStudySession.id),
              eq(StudySessionTable.revision, parsedInput.data.expectedRevision),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updated)
          throw new StudySessionError(
            'revision-conflict',
            'This study session changed.',
          );
        return updated;
      });
      assertCurrent(context);
      const studySession = toStudySessionDTO(updatedStudySession);
      publishSessionChange(
        publish,
        context,
        studySession.id,
        studySession.revision,
      );
      return studySession;
    } catch (error) {
      throw asStudyError(error, 'The study session could not be renamed.');
    }
  };

  const saveStudyDraft = async (
    context: AuthorizedContext,
    rawInput: z.infer<typeof saveDraftInput>,
  ): Promise<{ draftRevision: number }> => {
    const parsedInput = saveDraftInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid study draft.');
    assertCurrent(context);
    try {
      const result = database.transaction((transaction) => {
        const existingStudySession = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
        );
        if (!existingStudySession)
          throw new StudySessionError('not-found', 'Study session not found.');
        if (
          existingStudySession.draftRevision ===
            parsedInput.data.expectedDraftRevision + 1 &&
          existingStudySession.draftText === parsedInput.data.text
        )
          return {
            draftRevision: existingStudySession.draftRevision,
            revision: existingStudySession.revision,
            changed: false,
          };
        if (
          existingStudySession.draftRevision !==
          parsedInput.data.expectedDraftRevision
        ) {
          if (existingStudySession.draftText === parsedInput.data.text)
            return {
              draftRevision: existingStudySession.draftRevision,
              revision: existingStudySession.revision,
              changed: false,
            };
          throw new StudySessionError(
            'revision-conflict',
            'A newer study draft is already saved.',
          );
        }
        const sameDraft =
          existingStudySession.draftText === parsedInput.data.text;
        if (sameDraft)
          return {
            draftRevision: existingStudySession.draftRevision,
            revision: existingStudySession.revision,
            changed: false,
          };
        const nowIso = toIso(now());
        const updatedStudySession = transaction
          .update(StudySessionTable)
          .set({
            draftText: parsedInput.data.text,
            draftRevision: existingStudySession.draftRevision + 1,
            revision: existingStudySession.revision + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, existingStudySession.id),
              eq(
                StudySessionTable.draftRevision,
                parsedInput.data.expectedDraftRevision,
              ),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedStudySession)
          throw new StudySessionError(
            'revision-conflict',
            'A newer study draft is already saved.',
          );
        return {
          draftRevision: updatedStudySession.draftRevision,
          revision: updatedStudySession.revision,
          changed: true,
        };
      });
      assertCurrent(context);
      if (result.changed)
        publishSessionChange(
          publish,
          context,
          parsedInput.data.sessionId,
          result.revision,
        );
      return { draftRevision: result.draftRevision };
    } catch (error) {
      throw asStudyError(error, 'The study draft could not be saved.');
    }
  };

  const validateAttachment = (
    transaction: Transaction,
    context: AuthorizedContext,
    session: StudySessionSelectData,
    itemId: string,
  ) => {
    const item = transaction
      .select()
      .from(ContextItemTable)
      .where(
        and(
          eq(ContextItemTable.userId, context.userId),
          eq(ContextItemTable.id, itemId),
          isNull(ContextItemTable.removedAt),
        ),
      )
      .get();
    if (
      !item ||
      !item.currentVersionId ||
      ['unreadable', 'unsupported', 'failed', 'cancelled'].includes(item.status)
    )
      throw new StudySessionError(
        'scope-denied',
        'A selected upload is unavailable.',
      );
    const links = transaction
      .select()
      .from(ContextLinkTable)
      .where(
        and(
          eq(ContextLinkTable.userId, context.userId),
          eq(ContextLinkTable.itemId, itemId),
        ),
      )
      .all();
    const authorized =
      item.originatingSessionId === session.id ||
      links.some(
        (link) =>
          link.sessionId === session.id ||
          (link.courseId === session.courseId && link.sessionId === null) ||
          (link.courseId === null &&
            link.sessionId === null &&
            link.retainedInLibrary),
      );
    if (
      !authorized ||
      links.some(
        (link) => link.courseId !== null && link.courseId !== session.courseId,
      )
    )
      throw new StudySessionError(
        'scope-denied',
        'A selected upload is outside this course.',
      );
    return {
      kind: 'attachment' as const,
      itemId,
      versionId: item.currentVersionId,
    };
  };

  const beginStudyTurn = async (
    context: AuthorizedContext,
    rawInput: StudyTurnAdmissionInput,
  ): Promise<StudyTurnAdmission> => {
    const parsedInput = beginTurnInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid study message.');
    if (
      !parsedInput.data.text.trim() &&
      parsedInput.data.attachmentIds.length === 0
    )
      throw new StudySessionError(
        'invalid-input',
        'Add a message or upload before sending.',
      );
    assertCurrent(context);
    const input = parsedInput.data;
    const payloadHash = sha256(
      JSON.stringify({
        expectedDraftRevision: input.expectedDraftRevision,
        text: input.text,
        attachmentIds: input.attachmentIds,
      }),
    );

    try {
      const result = database.transaction((transaction) => {
        const existingStudySession = readSession(
          transaction,
          context,
          input.sessionId,
        );
        if (!existingStudySession)
          throw new StudySessionError('not-found', 'Study session not found.');
        const existingTurn = transaction
          .select()
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, existingStudySession.id),
              eq(StudyTurnTable.requestId, input.requestId),
            ),
          )
          .get();
        if (existingTurn) {
          if (existingTurn.payloadHash !== payloadHash)
            throw new StudySessionError(
              'revision-conflict',
              'This Send request ID was already used for different content.',
            );
          const revisions = readStudyRevisions(
            transaction,
            context,
            existingStudySession,
          );
          return {
            turnId: existingTurn.id,
            generationEpoch: existingTurn.generationEpoch,
            revision: existingStudySession.revision,
            policyRevision: existingTurn.policyRevision,
            contextRevision: existingTurn.contextRevision,
            gradeConsentRevision: revisions.gradeConsentRevision,
            duplicate: true,
            turn: toTurnDTO(existingTurn),
          };
        }
        if (
          existingStudySession.status === 'finished' ||
          existingStudySession.finishedAt
        )
          throw new StudySessionError(
            'revision-conflict',
            'A finished session cannot accept messages.',
          );
        if (
          existingStudySession.expiredRevision !== null &&
          existingStudySession.expiredRevision !==
            existingStudySession.resolvedExpiredRevision
        )
          throw new StudySessionError(
            'busy',
            'Resolve the expired study timer before continuing.',
          );
        if (existingStudySession.draftRevision !== input.expectedDraftRevision)
          throw new StudySessionError(
            'revision-conflict',
            'The study draft changed before Send.',
          );
        const activeTurn = transaction
          .select({ id: StudyTurnTable.id })
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, existingStudySession.id),
              inArray(StudyTurnTable.status, [
                'preparing',
                'generating',
                'checking',
              ]),
            ),
          )
          .get();
        if (activeTurn)
          throw new StudySessionError(
            'busy',
            'A study response is already in progress.',
          );

        const revisions = readStudyRevisions(
          transaction,
          context,
          existingStudySession,
        );
        const attachmentParts = input.attachmentIds.map((itemId) =>
          validateAttachment(
            transaction,
            context,
            existingStudySession,
            itemId,
          ),
        );
        assertCurrent(context);
        const turnId = idGenerator();
        const messageId = idGenerator();
        const nowIso = toIso(now());
        const studentParts: MessagePart[] = [
          ...(input.text ? [{ kind: 'text' as const, text: input.text }] : []),
          ...attachmentParts,
        ];
        const insertedTurn = transaction
          .insert(StudyTurnTable)
          .values({
            id: turnId,
            userId: context.userId,
            sessionId: existingStudySession.id,
            requestId: input.requestId,
            payloadHash,
            generationEpoch: existingStudySession.generationEpoch,
            status: 'preparing',
            attemptNumber: 1,
            policyRevision: revisions.policyRevision,
            contextRevision: revisions.contextRevision,
            errorCode: null,
            startedAt: nowIso,
            settledAt: null,
          })
          .returning()
          .get();
        transaction
          .insert(StudyMessageTable)
          .values({
            id: messageId,
            userId: context.userId,
            sessionId: existingStudySession.id,
            sequence: messageSequence(
              transaction,
              context.userId,
              existingStudySession.id,
            ),
            turnId,
            role: 'student',
            status: 'accepted',
            parts: studentParts,
            gradeDerived: false,
            gradeConsentRevision: null,
            createdAt: nowIso,
          })
          .run();
        for (const attachment of attachmentParts) {
          transaction
            .insert(StudySourceReferenceTable)
            .values({
              id: idGenerator(),
              userId: context.userId,
              sessionId: existingStudySession.id,
              messageId,
              sourceKind: 'context-version',
              sourceId: attachment.itemId,
              versionId: attachment.versionId,
              locator: null,
              state: 'current',
            })
            .run();
        }
        const clearDraft = existingStudySession.draftText === input.text;
        const updatedStudySession = transaction
          .update(StudySessionTable)
          .set({
            status: 'in-progress',
            draftText: clearDraft ? '' : existingStudySession.draftText,
            draftRevision: clearDraft
              ? existingStudySession.draftRevision + 1
              : existingStudySession.draftRevision,
            revision: existingStudySession.revision + 1,
            updatedAt: nowIso,
            lastOpenedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, existingStudySession.id),
              eq(StudySessionTable.revision, existingStudySession.revision),
              eq(StudySessionTable.draftRevision, input.expectedDraftRevision),
              eq(
                StudySessionTable.generationEpoch,
                existingStudySession.generationEpoch,
              ),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedStudySession)
          throw new StudySessionError(
            'revision-conflict',
            'The study session changed before Send.',
          );
        return {
          turnId,
          generationEpoch: existingStudySession.generationEpoch,
          revision: updatedStudySession.revision,
          policyRevision: revisions.policyRevision,
          contextRevision: revisions.contextRevision,
          gradeConsentRevision: revisions.gradeConsentRevision,
          duplicate: false,
          turn: toTurnDTO(insertedTurn),
        };
      });
      assertCurrent(context);
      if (!result.duplicate)
        publishSessionChange(
          publish,
          context,
          input.sessionId,
          result.revision,
          input.requestId,
        );
      return result;
    } catch (error) {
      throw asStudyError(error, 'The study message could not be saved.');
    }
  };

  const updateStudyTurnStatus = async (
    context: AuthorizedContext,
    rawInput: z.infer<typeof updateTurnStatusInput>,
  ): Promise<TurnDTO> => {
    const parsedInput = updateTurnStatusInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError(
        'invalid-input',
        'Invalid study turn status.',
      );
    assertCurrent(context);
    try {
      const result = database.transaction((transaction) => {
        const turn = transaction
          .select()
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.id, parsedInput.data.turnId),
            ),
          )
          .get();
        if (!turn)
          throw new StudySessionError('not-found', 'Study turn not found.');
        const session = readSession(transaction, context, turn.sessionId);
        if (!session || session.generationEpoch !== turn.generationEpoch)
          throw new StudySessionError(
            'session-changed',
            'The study session changed.',
          );
        if (turn.status === parsedInput.data.status)
          return {
            turn,
            sessionId: session.id,
            revision: session.revision,
            changed: false,
          };
        if (!['preparing', 'generating', 'checking'].includes(turn.status))
          throw new StudySessionError(
            'revision-conflict',
            'The study turn already finished.',
          );
        const updated = transaction
          .update(StudyTurnTable)
          .set({ status: parsedInput.data.status })
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.id, turn.id),
              inArray(StudyTurnTable.status, [
                'preparing',
                'generating',
                'checking',
              ]),
            ),
          )
          .returning()
          .get();
        if (!updated)
          throw new StudySessionError(
            'revision-conflict',
            'The study turn changed.',
          );
        const updatedStudySession = transaction
          .update(StudySessionTable)
          .set({
            revision: session.revision + 1,
            updatedAt: toIso(now()),
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, session.id),
              eq(StudySessionTable.revision, session.revision),
              eq(StudySessionTable.generationEpoch, turn.generationEpoch),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedStudySession)
          throw new StudySessionError(
            'session-changed',
            'The study session changed.',
          );
        return {
          turn: updated,
          sessionId: session.id,
          revision: updatedStudySession.revision,
          changed: true,
        };
      });
      assertCurrent(context);
      if (result.changed)
        publishSessionChange(
          publish,
          context,
          result.sessionId,
          result.revision,
        );
      return toTurnDTO(result.turn);
    } catch (error) {
      throw asStudyError(error, 'The study turn could not be updated.');
    }
  };

  const commitStudyTurn = async (
    context: AuthorizedContext,
    rawInput: CommitStudyTurnInput,
  ): Promise<TurnDTO> => {
    const parsedInput = commitTurnInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid tutor response.');
    assertCurrent(context);
    try {
      const result = database.transaction((transaction) => {
        const turn = transaction
          .select()
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.id, parsedInput.data.turnId),
            ),
          )
          .get();
        if (!turn)
          throw new StudySessionError('not-found', 'Study turn not found.');
        const session = readSession(transaction, context, turn.sessionId);
        if (
          !session ||
          session.generationEpoch !== parsedInput.data.generationEpoch ||
          turn.generationEpoch !== parsedInput.data.generationEpoch
        )
          throw new StudySessionError(
            'session-changed',
            'The study session changed.',
          );
        if (turn.status === 'complete')
          return {
            turn,
            sessionId: session.id,
            revision: session.revision,
            changed: false,
          };
        if (!['preparing', 'generating', 'checking'].includes(turn.status))
          throw new StudySessionError(
            'revision-conflict',
            'The study turn is no longer active.',
          );
        const revisions = readStudyRevisions(transaction, context, session);
        if (
          revisions.policyRevision !== turn.policyRevision ||
          revisions.policyRevision !== parsedInput.data.policyRevision
        )
          throw new StudySessionError(
            'permission-revoked',
            'Study permissions changed during generation.',
          );
        if (
          revisions.contextRevision !== turn.contextRevision ||
          revisions.contextRevision !== parsedInput.data.contextRevision
        )
          throw new StudySessionError(
            'session-changed',
            'Study sources changed during generation.',
          );
        if (
          parsedInput.data.gradeDerived &&
          (!revisions.gradesEnabled ||
            parsedInput.data.gradeConsentRevision !==
              revisions.gradeConsentRevision)
        )
          throw new StudySessionError(
            'permission-revoked',
            'Grade access changed during generation.',
          );
        if (
          !parsedInput.data.gradeDerived &&
          parsedInput.data.gradeConsentRevision !== null
        )
          throw new StudySessionError(
            'invalid-input',
            'Grade metadata is host-controlled.',
          );

        const sourceReferences = parsedInput.data.sourceReferences;
        if (
          sourceReferences.some(
            (reference) => reference.sourceKind === 'grade-evidence',
          ) &&
          !parsedInput.data.gradeDerived
        )
          throw new StudySessionError(
            'scope-denied',
            'Grade references require host authorization.',
          );
        for (const reference of sourceReferences)
          validateSessionSourceReference(
            transaction,
            context,
            session,
            reference,
            revisions,
          );
        const citationReferences = parsedInput.data.parts.flatMap((part) =>
          part.kind === 'citation' ? [part.reference] : [],
        );
        for (const reference of citationReferences)
          validateSessionSourceReference(
            transaction,
            context,
            session,
            reference,
            revisions,
          );
        if (
          citationReferences.some(
            (reference) =>
              !sourceReferences.some(
                (sourceReference) =>
                  JSON.stringify(sourceReference) === JSON.stringify(reference),
              ),
          )
        )
          throw new StudySessionError(
            'invalid-input',
            'Every displayed citation must be included in the saved source references.',
          );
        assertCurrent(context);
        const tutorMessage = transaction
          .select()
          .from(StudyMessageTable)
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.sessionId, session.id),
              eq(StudyMessageTable.turnId, turn.id),
              eq(StudyMessageTable.role, 'tutor'),
            ),
          )
          .get();
        if (tutorMessage) {
          const updatedTurn = transaction
            .update(StudyTurnTable)
            .set({
              status: 'complete',
              settledAt: tutorMessage.createdAt,
              errorCode: null,
            })
            .where(eq(StudyTurnTable.id, turn.id))
            .returning()
            .get()!;
          const updatedSession = transaction
            .update(StudySessionTable)
            .set({
              revision: session.revision + 1,
              updatedAt: tutorMessage.createdAt,
            })
            .where(
              and(
                eq(StudySessionTable.userId, context.userId),
                eq(StudySessionTable.id, session.id),
                eq(StudySessionTable.revision, session.revision),
                eq(
                  StudySessionTable.generationEpoch,
                  parsedInput.data.generationEpoch,
                ),
                isNull(StudySessionTable.deletedAt),
              ),
            )
            .returning()
            .get();
          if (!updatedSession)
            throw new StudySessionError(
              'session-changed',
              'The study session changed.',
            );
          return {
            turn: updatedTurn,
            sessionId: session.id,
            revision: updatedSession.revision,
            changed: true,
          };
        }

        const nowIso = toIso(now());
        const messageId = idGenerator();
        transaction
          .insert(StudyMessageTable)
          .values({
            id: messageId,
            userId: context.userId,
            sessionId: session.id,
            sequence: messageSequence(transaction, context.userId, session.id),
            turnId: turn.id,
            role: 'tutor',
            status: 'accepted',
            parts: parsedInput.data.parts,
            gradeDerived: parsedInput.data.gradeDerived,
            gradeConsentRevision: parsedInput.data.gradeDerived
              ? parsedInput.data.gradeConsentRevision
              : null,
            createdAt: nowIso,
          })
          .run();
        for (const reference of sourceReferences)
          transaction
            .insert(StudySourceReferenceTable)
            .values({
              id: idGenerator(),
              userId: context.userId,
              sessionId: session.id,
              messageId,
              sourceKind: reference.sourceKind,
              sourceId: reference.sourceId,
              versionId: reference.versionId,
              locator: reference.locator,
              state: reference.state,
            })
            .run();
        const updatedTurn = transaction
          .update(StudyTurnTable)
          .set({ status: 'complete', settledAt: nowIso, errorCode: null })
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.id, turn.id),
              inArray(StudyTurnTable.status, [
                'preparing',
                'generating',
                'checking',
              ]),
              eq(
                StudyTurnTable.generationEpoch,
                parsedInput.data.generationEpoch,
              ),
            ),
          )
          .returning()
          .get();
        if (!updatedTurn)
          throw new StudySessionError(
            'session-changed',
            'The study turn changed before commit.',
          );
        const updatedSession = transaction
          .update(StudySessionTable)
          .set({
            status: 'in-progress',
            revision: session.revision + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, session.id),
              eq(
                StudySessionTable.generationEpoch,
                parsedInput.data.generationEpoch,
              ),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedSession)
          throw new StudySessionError(
            'session-changed',
            'The study session changed before commit.',
          );
        return {
          turn: updatedTurn,
          sessionId: session.id,
          revision: updatedSession.revision,
          changed: true,
        };
      });
      assertCurrent(context);
      if (result.changed)
        publishSessionChange(
          publish,
          context,
          result.sessionId,
          result.revision,
          result.turn.id,
        );
      return toTurnDTO(result.turn);
    } catch (error) {
      throw asStudyError(error, 'The tutor response could not be saved.');
    }
  };

  const appendStudyTurnParts = async (
    context: AuthorizedContext,
    rawInput: AppendStudyTurnPartsInput,
  ): Promise<AppendStudyTurnPartsResult> => {
    const parsedInput = appendTurnPartsInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError('invalid-input', 'Invalid tutor effect.');
    assertCurrent(context);

    try {
      const result = database.transaction((transaction) => {
        assertCurrent(context);
        const turn = transaction
          .select()
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, parsedInput.data.sessionId),
              eq(StudyTurnTable.id, parsedInput.data.turnId),
            ),
          )
          .get();
        if (!turn)
          throw new StudySessionError('not-found', 'Study turn not found.');

        const session = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
        );
        if (!session)
          throw new StudySessionError(
            'session-changed',
            'The study session changed.',
          );
        if (
          session.generationEpoch !== parsedInput.data.generationEpoch ||
          turn.generationEpoch !== parsedInput.data.generationEpoch
        )
          throw new StudySessionError(
            'session-changed',
            'The study session changed.',
          );
        if (turn.status === 'cancelled')
          throw new StudySessionError(
            'cancelled',
            'The study turn was cancelled.',
          );
        if (turn.status !== 'complete')
          throw new StudySessionError(
            'revision-conflict',
            'The tutor response has not been committed.',
          );

        const tutorMessage = transaction
          .select({ id: StudyMessageTable.id })
          .from(StudyMessageTable)
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.sessionId, session.id),
              eq(StudyMessageTable.turnId, turn.id),
              eq(StudyMessageTable.role, 'tutor'),
              eq(StudyMessageTable.status, 'accepted'),
            ),
          )
          .get();
        if (!tutorMessage)
          throw new StudySessionError(
            'revision-conflict',
            'The tutor response has not been committed.',
          );

        const parts = appendTurnPartsSchema.safeParse(parsedInput.data.parts);
        if (!parts.success)
          throw new StudySessionError('invalid-input', 'Invalid tutor effect.');
        const citations = parts.data.flatMap((part) =>
          part.kind === 'citation' ? [part.reference] : [],
        );
        if (citations.length > 20)
          throw new StudySessionError('invalid-input', 'Invalid tutor effect.');

        const messageId = stableId(
          JSON.stringify([
            'study-turn-effect',
            context.userId,
            session.id,
            turn.id,
            parsedInput.data.idempotencyKey,
          ]),
        );
        const existingMessage = transaction
          .select()
          .from(StudyMessageTable)
          .where(eq(StudyMessageTable.id, messageId))
          .get();
        if (
          existingMessage &&
          (existingMessage.userId !== context.userId ||
            existingMessage.sessionId !== session.id ||
            existingMessage.turnId !== turn.id ||
            existingMessage.role !== 'tutor' ||
            existingMessage.status !== 'accepted' ||
            JSON.stringify(existingMessage.parts) !==
              JSON.stringify(parts.data))
        )
          throw new StudySessionError(
            'revision-conflict',
            'This tutor effect key was already used for different content.',
          );

        const grades = readActiveGradeSettings(transaction, context.userId);
        const revisions = {
          gradesEnabled: grades.enabled,
          gradeConsentRevision: grades.revision,
        };
        for (const reference of citations)
          validateSessionSourceReference(
            transaction,
            context,
            session,
            reference,
            revisions,
          );
        const gradeDerived = citations.some(
          (reference) => reference.sourceKind === 'grade-evidence',
        );
        const gradeConsentRevision = gradeDerived
          ? revisions.gradeConsentRevision
          : null;
        if (
          existingMessage &&
          (existingMessage.gradeDerived !== gradeDerived ||
            existingMessage.gradeConsentRevision !== gradeConsentRevision)
        )
          throw new StudySessionError(
            'revision-conflict',
            'This tutor effect key was already used for different content.',
          );
        if (existingMessage)
          return {
            messageId,
            sessionId: session.id,
            revision: session.revision,
            changed: false,
          };

        assertCurrent(context);
        const nowIso = toIso(now());
        transaction
          .insert(StudyMessageTable)
          .values({
            id: messageId,
            userId: context.userId,
            sessionId: session.id,
            sequence: messageSequence(transaction, context.userId, session.id),
            turnId: turn.id,
            role: 'tutor',
            status: 'accepted',
            parts: parts.data,
            gradeDerived,
            gradeConsentRevision,
            createdAt: nowIso,
          })
          .run();
        for (const reference of citations)
          transaction
            .insert(StudySourceReferenceTable)
            .values({
              id: idGenerator(),
              userId: context.userId,
              sessionId: session.id,
              messageId,
              sourceKind: reference.sourceKind,
              sourceId: reference.sourceId,
              versionId: reference.versionId,
              locator: reference.locator,
              state: reference.state,
            })
            .run();
        const updatedSession = transaction
          .update(StudySessionTable)
          .set({
            revision: session.revision + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, session.id),
              eq(StudySessionTable.revision, session.revision),
              eq(
                StudySessionTable.generationEpoch,
                parsedInput.data.generationEpoch,
              ),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning({ revision: StudySessionTable.revision })
          .get();
        if (!updatedSession)
          throw new StudySessionError(
            'session-changed',
            'The study session changed.',
          );
        assertCurrent(context);
        return {
          messageId,
          sessionId: session.id,
          revision: updatedSession.revision,
          changed: true,
        };
      });
      assertCurrent(context);
      if (result.changed)
        publishSessionChange(
          publish,
          context,
          result.sessionId,
          result.revision,
          result.messageId,
        );
      return { committed: true, revision: result.revision };
    } catch (error) {
      throw asStudyError(error, 'The tutor effect could not be saved.');
    }
  };

  const settleStudyTurn = async (
    context: AuthorizedContext,
    rawInput: z.infer<typeof settleTurnInput>,
  ): Promise<TurnDTO> => {
    const parsedInput = settleTurnInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError(
        'invalid-input',
        'Invalid study turn result.',
      );
    assertCurrent(context);
    try {
      const result = database.transaction((transaction) => {
        const turn = transaction
          .select()
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.id, parsedInput.data.turnId),
            ),
          )
          .get();
        if (!turn)
          throw new StudySessionError('not-found', 'Study turn not found.');
        const session = readSession(transaction, context, turn.sessionId);
        if (!session || session.generationEpoch !== turn.generationEpoch)
          throw new StudySessionError(
            'session-changed',
            'The study session changed.',
          );
        if (turn.status === parsedInput.data.status)
          return {
            turn,
            sessionId: session.id,
            revision: session.revision,
            changed: false,
          };
        if (!['preparing', 'generating', 'checking'].includes(turn.status))
          throw new StudySessionError(
            'revision-conflict',
            'The study turn already finished.',
          );
        const settledAt = toIso(now());
        const updatedTurn = transaction
          .update(StudyTurnTable)
          .set({
            status: parsedInput.data.status,
            errorCode: parsedInput.data.errorCode ?? null,
            settledAt,
          })
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.id, turn.id),
              inArray(StudyTurnTable.status, [
                'preparing',
                'generating',
                'checking',
              ]),
            ),
          )
          .returning()
          .get();
        if (!updatedTurn)
          throw new StudySessionError(
            'revision-conflict',
            'The study turn already finished.',
          );
        transaction
          .update(StudyMessageTable)
          .set({
            status:
              parsedInput.data.status === 'failed' ? 'failed' : 'interrupted',
          })
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.sessionId, session.id),
              eq(StudyMessageTable.turnId, turn.id),
              eq(StudyMessageTable.role, 'student'),
            ),
          )
          .run();
        const updatedStudySession = transaction
          .update(StudySessionTable)
          .set({
            status: 'interrupted',
            revision: session.revision + 1,
            updatedAt: settledAt,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, session.id),
              eq(StudySessionTable.revision, session.revision),
              eq(StudySessionTable.generationEpoch, turn.generationEpoch),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedStudySession)
          throw new StudySessionError(
            'session-changed',
            'The study session changed.',
          );
        return {
          turn: updatedTurn,
          sessionId: session.id,
          revision: updatedStudySession.revision,
          changed: true,
        };
      });
      assertCurrent(context);
      if (result.changed)
        publishSessionChange(
          publish,
          context,
          result.sessionId,
          result.revision,
          result.turn.id,
        );
      return toTurnDTO(result.turn);
    } catch (error) {
      throw asStudyError(error, 'The study turn result could not be saved.');
    }
  };

  const reconcileOrphanedStudyTurns = async (
    context: AuthorizedContext,
    sessionId?: string,
  ): Promise<number> => {
    assertCurrent(context);
    const activeTurns = database
      .select({
        id: StudyTurnTable.id,
        sessionId: StudyTurnTable.sessionId,
        requestId: StudyTurnTable.requestId,
      })
      .from(StudyTurnTable)
      .where(
        and(
          eq(StudyTurnTable.userId, context.userId),
          inArray(StudyTurnTable.status, [
            'preparing',
            'generating',
            'checking',
          ]),
          ...(sessionId ? [eq(StudyTurnTable.sessionId, sessionId)] : []),
        ),
      )
      .orderBy(asc(StudyTurnTable.startedAt), asc(StudyTurnTable.id))
      .limit(100)
      .all();
    let interruptedCount = 0;

    for (const turn of activeTurns) {
      const operationIsActive =
        hasStudySessionOperation(context.userId, turn.sessionId, turn.id) ||
        hasStudySessionOperation(
          context.userId,
          turn.sessionId,
          turn.requestId,
        );
      if (operationIsActive) continue;
      assertCurrent(context);
      try {
        await settleStudyTurn(context, {
          turnId: turn.id,
          status: 'cancelled',
          errorCode: 'cancelled',
        });
        interruptedCount += 1;
      } catch (error) {
        if (
          context.isCurrent() &&
          !context.signal.aborted &&
          error instanceof StudySessionError &&
          error.code === 'session-changed'
        )
          continue;
        throw error;
      }
    }

    return interruptedCount;
  };

  const retryStudyTurn = async (
    context: AuthorizedContext,
    rawInput: { sessionId: string; turnId: string; requestId: string },
  ): Promise<StudyTurnAdmission> => {
    const parsedInput = z
      .strictObject({
        sessionId: z.string().min(1).max(300),
        turnId: z.string().min(1).max(300),
        requestId: z.uuid(),
      })
      .safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError(
        'invalid-input',
        'Invalid study retry request.',
      );
    assertCurrent(context);
    const input = parsedInput.data;
    const retryDigest = sha256(JSON.stringify({ turnId: input.turnId }));
    const markerId = stableId(
      `study-turn-retry\0${context.userId}\0${input.sessionId}\0${input.requestId}`,
    );
    const markerCode = `study-turn-retry:${retryDigest}`;

    try {
      const result = database.transaction((transaction) => {
        const session = readSession(transaction, context, input.sessionId);
        if (!session)
          throw new StudySessionError('not-found', 'Study session not found.');
        const turn = transaction
          .select()
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, session.id),
              eq(StudyTurnTable.id, input.turnId),
            ),
          )
          .get();
        if (!turn || turn.generationEpoch !== session.generationEpoch)
          throw new StudySessionError(
            'session-changed',
            'The study turn changed.',
          );

        const marker = transaction
          .select()
          .from(StudyMessageTable)
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.sessionId, session.id),
              eq(StudyMessageTable.id, markerId),
            ),
          )
          .get();
        if (marker) {
          const [part] = marker.parts;
          if (
            marker.role !== 'system-status' ||
            part?.kind !== 'status' ||
            part.code !== markerCode
          )
            throw new StudySessionError(
              'revision-conflict',
              'This retry request ID was already used for a different turn.',
            );
          const revisions = readStudyRevisions(transaction, context, session);
          return {
            turnId: turn.id,
            generationEpoch: turn.generationEpoch,
            revision: session.revision,
            policyRevision: turn.policyRevision,
            contextRevision: turn.contextRevision,
            gradeConsentRevision: revisions.gradeConsentRevision,
            duplicate: true,
            turn: toTurnDTO(turn),
          };
        }
        if (session.status === 'finished' || session.finishedAt)
          throw new StudySessionError(
            'revision-conflict',
            'A finished session cannot be retried.',
          );
        if (
          session.expiredRevision !== null &&
          session.expiredRevision !== session.resolvedExpiredRevision
        )
          throw new StudySessionError(
            'busy',
            'Resolve the expired study timer before retrying.',
          );
        if (turn.status !== 'failed' && turn.status !== 'cancelled')
          throw new StudySessionError(
            'revision-conflict',
            'Only an interrupted turn can be retried.',
          );
        const activeTurn = transaction
          .select({ id: StudyTurnTable.id })
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, session.id),
              inArray(StudyTurnTable.status, [
                'preparing',
                'generating',
                'checking',
              ]),
            ),
          )
          .get();
        if (activeTurn)
          throw new StudySessionError(
            'busy',
            'A study response is already in progress.',
          );
        const studentMessage = transaction
          .select({ id: StudyMessageTable.id })
          .from(StudyMessageTable)
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.sessionId, session.id),
              eq(StudyMessageTable.turnId, turn.id),
              eq(StudyMessageTable.role, 'student'),
            ),
          )
          .get();
        if (!studentMessage)
          throw new StudySessionError(
            'session-changed',
            'The saved student message is unavailable.',
          );

        const revisions = readStudyRevisions(transaction, context, session);
        assertCurrent(context);
        const nowIso = toIso(now());
        const updatedTurn = transaction
          .update(StudyTurnTable)
          .set({
            status: 'preparing',
            attemptNumber: turn.attemptNumber + 1,
            policyRevision: revisions.policyRevision,
            contextRevision: revisions.contextRevision,
            errorCode: null,
            startedAt: nowIso,
            settledAt: null,
          })
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.id, turn.id),
              inArray(StudyTurnTable.status, ['failed', 'cancelled']),
              eq(StudyTurnTable.generationEpoch, session.generationEpoch),
            ),
          )
          .returning()
          .get();
        if (!updatedTurn)
          throw new StudySessionError(
            'revision-conflict',
            'The study turn changed before retry.',
          );
        const updatedStudentMessage = transaction
          .update(StudyMessageTable)
          .set({ status: 'accepted' })
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.id, studentMessage.id),
              eq(StudyMessageTable.turnId, turn.id),
            ),
          )
          .returning({ id: StudyMessageTable.id })
          .get();
        if (!updatedStudentMessage)
          throw new StudySessionError(
            'session-changed',
            'The saved student message changed.',
          );
        transaction
          .insert(StudyMessageTable)
          .values({
            id: markerId,
            userId: context.userId,
            sessionId: session.id,
            sequence: messageSequence(transaction, context.userId, session.id),
            turnId: turn.id,
            role: 'system-status',
            status: 'accepted',
            parts: [
              {
                kind: 'status',
                code: markerCode,
                label: 'Retrying the previous response.',
              },
            ],
            gradeDerived: false,
            gradeConsentRevision: null,
            createdAt: nowIso,
          })
          .run();
        const updatedSession = transaction
          .update(StudySessionTable)
          .set({
            status: 'in-progress',
            revision: session.revision + 1,
            updatedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, session.id),
              eq(StudySessionTable.revision, session.revision),
              eq(StudySessionTable.generationEpoch, session.generationEpoch),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updatedSession)
          throw new StudySessionError(
            'session-changed',
            'The study session changed before retry.',
          );
        return {
          turnId: updatedTurn.id,
          generationEpoch: updatedTurn.generationEpoch,
          revision: updatedSession.revision,
          policyRevision: updatedTurn.policyRevision,
          contextRevision: updatedTurn.contextRevision,
          gradeConsentRevision: revisions.gradeConsentRevision,
          duplicate: false,
          turn: toTurnDTO(updatedTurn),
        };
      });
      assertCurrent(context);
      if (!result.duplicate)
        publishSessionChange(
          publish,
          context,
          input.sessionId,
          result.revision,
          input.requestId,
        );
      return result;
    } catch (error) {
      throw asStudyError(error, 'The study turn could not be retried.');
    }
  };

  const deleteStudySession = async (
    context: AuthorizedContext,
    rawInput: z.infer<typeof deleteSessionInput>,
  ): Promise<void> => {
    const parsedInput = deleteSessionInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError(
        'invalid-input',
        'Invalid study session deletion.',
      );
    assertCurrent(context);
    let fencedSession: StudySessionSelectData;
    try {
      fencedSession = database.transaction((transaction) => {
        const existingStudySession = readSession(
          transaction,
          context,
          parsedInput.data.sessionId,
          true,
        );
        if (!existingStudySession)
          throw new StudySessionError('not-found', 'Study session not found.');
        if (existingStudySession.deletedAt) return existingStudySession;
        if (existingStudySession.revision !== parsedInput.data.expectedRevision)
          throw new StudySessionError(
            'revision-conflict',
            'The study session changed before deletion.',
          );
        assertCurrent(context);
        const nowIso = toIso(now());
        const updated = transaction
          .update(StudySessionTable)
          .set({
            title: 'Deleted session',
            targetAssignmentId: null,
            topic: null,
            status: 'interrupted',
            generationEpoch: existingStudySession.generationEpoch + 1,
            revision: existingStudySession.revision + 1,
            draftText: '',
            draftRevision: existingStudySession.draftRevision + 1,
            deadlineAt: null,
            timerRevision: existingStudySession.timerRevision + 1,
            finishedAt: null,
            deletedAt: nowIso,
            updatedAt: nowIso,
            lastOpenedAt: nowIso,
          })
          .where(
            and(
              eq(StudySessionTable.userId, context.userId),
              eq(StudySessionTable.id, existingStudySession.id),
              eq(StudySessionTable.revision, parsedInput.data.expectedRevision),
              isNull(StudySessionTable.deletedAt),
            ),
          )
          .returning()
          .get();
        if (!updated)
          throw new StudySessionError(
            'revision-conflict',
            'The study session changed before deletion.',
          );
        return updated;
      });
    } catch (error) {
      throw asStudyError(error, 'The study session could not be deleted.');
    }

    cancelStudySessionOperations(context.userId, fencedSession.id);
    if (context.isCurrent() && !context.signal.aborted)
      publishSessionChange(
        publish,
        context,
        fencedSession.id,
        fencedSession.revision,
        parsedInput.data.requestId,
      );
    try {
      const originalStorageKeysBeforeDeletion = database.transaction(
        (transaction) =>
          collectDisposableOriginalStorageKeys(
            transaction,
            context.userId,
            fencedSession.id,
          ),
      );
      if (originalStorageKeysBeforeDeletion.length) {
        if (!cleanupOriginals)
          throw new StudySessionError(
            'storage-failed',
            'Session uploads could not be removed from local storage.',
          );
        await cleanupOriginals(
          context,
          context.userId,
          originalStorageKeysBeforeDeletion,
        );
      }
      assertCurrent(context);
      database.transaction((transaction) => {
        const currentOriginalStorageKeys = collectDisposableOriginalStorageKeys(
          transaction,
          context.userId,
          fencedSession.id,
        );
        if (
          JSON.stringify(currentOriginalStorageKeys) !==
          JSON.stringify(originalStorageKeysBeforeDeletion)
        )
          throw new StudySessionError(
            'revision-conflict',
            'Session uploads changed before deletion.',
          );
        const turnIds = transaction
          .select({ id: StudyTurnTable.id })
          .from(StudyTurnTable)
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, fencedSession.id),
            ),
          )
          .all()
          .map((turn) => turn.id);
        if (turnIds.length)
          transaction
            .update(AssistanceLedgerTable)
            .set({ turnId: null })
            .where(
              and(
                eq(AssistanceLedgerTable.userId, context.userId),
                inArray(AssistanceLedgerTable.turnId, turnIds),
              ),
            )
            .run();
        transaction
          .update(LearningObservationTable)
          .set({ sourceSessionId: null })
          .where(
            and(
              eq(LearningObservationTable.userId, context.userId),
              eq(LearningObservationTable.sourceSessionId, fencedSession.id),
            ),
          )
          .run();
        const practiceAttempts = transaction
          .select({ id: PracticeAttemptTable.id })
          .from(PracticeAttemptTable)
          .where(
            and(
              eq(PracticeAttemptTable.userId, context.userId),
              eq(PracticeAttemptTable.sessionId, fencedSession.id),
            ),
          )
          .all()
          .map((attempt) => attempt.id);
        if (practiceAttempts.length)
          transaction
            .update(PracticeAttemptTable)
            .set({ sessionId: null })
            .where(
              and(
                eq(PracticeAttemptTable.userId, context.userId),
                inArray(PracticeAttemptTable.id, practiceAttempts),
              ),
            )
            .run();

        const artifacts = transaction
          .select()
          .from(ArtifactTable)
          .where(
            and(
              eq(ArtifactTable.userId, context.userId),
              eq(ArtifactTable.originatingSessionId, fencedSession.id),
              isNull(ArtifactTable.removedAt),
            ),
          )
          .all();
        const retainedArtifactIds = artifacts
          .filter((artifact) => artifact.retained || artifact.courseId !== null)
          .map((artifact) => artifact.id);
        const disposableArtifactIds = artifacts
          .filter(
            (artifact) => !artifact.retained && artifact.courseId === null,
          )
          .map((artifact) => artifact.id);
        if (retainedArtifactIds.length)
          transaction
            .update(ArtifactTable)
            .set({ originatingSessionId: null })
            .where(
              and(
                eq(ArtifactTable.userId, context.userId),
                inArray(ArtifactTable.id, retainedArtifactIds),
              ),
            )
            .run();
        if (disposableArtifactIds.length) {
          transaction
            .delete(ArtifactStateTable)
            .where(
              and(
                eq(ArtifactStateTable.userId, context.userId),
                inArray(ArtifactStateTable.artifactId, disposableArtifactIds),
              ),
            )
            .run();
          transaction
            .delete(ArtifactVersionTable)
            .where(
              and(
                eq(ArtifactVersionTable.userId, context.userId),
                inArray(ArtifactVersionTable.artifactId, disposableArtifactIds),
              ),
            )
            .run();
          transaction
            .delete(ArtifactTable)
            .where(
              and(
                eq(ArtifactTable.userId, context.userId),
                inArray(ArtifactTable.id, disposableArtifactIds),
              ),
            )
            .run();
        }

        const contextLinks = transaction
          .select()
          .from(ContextLinkTable)
          .where(
            and(
              eq(ContextLinkTable.userId, context.userId),
              eq(ContextLinkTable.sessionId, fencedSession.id),
            ),
          )
          .all();
        const originatingItems = transaction
          .select()
          .from(ContextItemTable)
          .where(
            and(
              eq(ContextItemTable.userId, context.userId),
              eq(ContextItemTable.originatingSessionId, fencedSession.id),
            ),
          )
          .all();
        const candidateItemIds = [
          ...new Set([
            ...contextLinks.map((link) => link.itemId),
            ...originatingItems.map((item) => item.id),
          ]),
        ];
        for (const itemId of candidateItemIds) {
          const item = transaction
            .select()
            .from(ContextItemTable)
            .where(
              and(
                eq(ContextItemTable.userId, context.userId),
                eq(ContextItemTable.id, itemId),
              ),
            )
            .get();
          const links = transaction
            .select()
            .from(ContextLinkTable)
            .where(
              and(
                eq(ContextLinkTable.userId, context.userId),
                eq(ContextLinkTable.itemId, itemId),
              ),
            )
            .all();
          const linkedToThisSession = links.filter(
            (link) => link.sessionId === fencedSession.id,
          );
          const retainedElsewhere = links.some(
            (link) => link.sessionId !== fencedSession.id,
          );
          const retainedInSession = linkedToThisSession.some(
            (link) => link.retainedInLibrary,
          );
          const keepItem = retainedElsewhere || retainedInSession;

          if (keepItem) {
            if (retainedInSession && !retainedElsewhere) {
              transaction
                .update(ContextLinkTable)
                .set({ sessionId: null, retainedInLibrary: true })
                .where(
                  and(
                    eq(ContextLinkTable.userId, context.userId),
                    eq(ContextLinkTable.itemId, itemId),
                    eq(ContextLinkTable.sessionId, fencedSession.id),
                  ),
                )
                .run();
            } else {
              transaction
                .delete(ContextLinkTable)
                .where(
                  and(
                    eq(ContextLinkTable.userId, context.userId),
                    eq(ContextLinkTable.itemId, itemId),
                    eq(ContextLinkTable.sessionId, fencedSession.id),
                  ),
                )
                .run();
            }
            if (item)
              transaction
                .update(ContextItemTable)
                .set({ originatingSessionId: null })
                .where(
                  and(
                    eq(ContextItemTable.userId, context.userId),
                    eq(ContextItemTable.id, itemId),
                  ),
                )
                .run();
            continue;
          }

          transaction
            .delete(ContextLinkTable)
            .where(
              and(
                eq(ContextLinkTable.userId, context.userId),
                eq(ContextLinkTable.itemId, itemId),
              ),
            )
            .run();
          transaction
            .delete(ContextChunkTable)
            .where(
              and(
                eq(ContextChunkTable.userId, context.userId),
                eq(ContextChunkTable.itemId, itemId),
              ),
            )
            .run();
          transaction
            .delete(ContextVersionTable)
            .where(
              and(
                eq(ContextVersionTable.userId, context.userId),
                eq(ContextVersionTable.itemId, itemId),
              ),
            )
            .run();
          transaction
            .delete(ContextItemTable)
            .where(
              and(
                eq(ContextItemTable.userId, context.userId),
                eq(ContextItemTable.id, itemId),
              ),
            )
            .run();
        }
        transaction
          .delete(StudySourceReferenceTable)
          .where(
            and(
              eq(StudySourceReferenceTable.userId, context.userId),
              eq(StudySourceReferenceTable.sessionId, fencedSession.id),
            ),
          )
          .run();
        transaction
          .delete(StudyMessageTable)
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.sessionId, fencedSession.id),
            ),
          )
          .run();
        transaction
          .update(StudyTurnTable)
          .set({
            payloadHash: 'deleted',
            status: 'cancelled',
            errorCode: 'session-changed',
            settledAt: toIso(now()),
          })
          .where(
            and(
              eq(StudyTurnTable.userId, context.userId),
              eq(StudyTurnTable.sessionId, fencedSession.id),
            ),
          )
          .run();
      });
    } catch (error) {
      throw asStudyError(
        error,
        'The study session content could not be removed.',
      );
    }
  };

  const purgeGradeDerivedStudyContent = async (
    context: AuthorizedContext,
    rawInput: z.infer<typeof purgeGradeContentInput>,
  ): Promise<void> => {
    const parsedInput = purgeGradeContentInput.safeParse(rawInput);
    if (!parsedInput.success)
      throw new StudySessionError(
        'invalid-input',
        'Invalid grade-history revision.',
      );
    assertCurrent(context);
    try {
      const changedSessions = database.transaction((transaction) => {
        assertCurrent(context);
        const gradeSettings = currentGradeSettings(transaction, context.userId);
        if (
          gradeSettings.enabled ||
          gradeSettings.revision !== parsedInput.data.consentRevision
        )
          throw new StudySessionError(
            'revision-conflict',
            'Grade settings changed before cleanup.',
          );
        const messages = transaction
          .select()
          .from(StudyMessageTable)
          .where(
            and(
              eq(StudyMessageTable.userId, context.userId),
              eq(StudyMessageTable.gradeDerived, true),
            ),
          )
          .all();
        const changedSessionIds = new Set<string>();
        for (const message of messages) {
          transaction
            .update(StudyMessageTable)
            .set({
              parts: [
                {
                  kind: 'status',
                  code: 'grade-content-removed',
                  label: 'Grade-derived study content was removed.',
                },
              ],
              gradeDerived: false,
              gradeConsentRevision: null,
            })
            .where(
              and(
                eq(StudyMessageTable.userId, context.userId),
                eq(StudyMessageTable.id, message.id),
                eq(StudyMessageTable.gradeDerived, true),
              ),
            )
            .run();
          transaction
            .delete(StudySourceReferenceTable)
            .where(
              and(
                eq(StudySourceReferenceTable.userId, context.userId),
                eq(StudySourceReferenceTable.messageId, message.id),
              ),
            )
            .run();
          changedSessionIds.add(message.sessionId);
        }
        const changedSessions: { sessionId: string; revision: number }[] = [];
        for (const sessionId of changedSessionIds) {
          const existingStudySession = readSession(
            transaction,
            context,
            sessionId,
          );
          if (!existingStudySession) continue;
          const updatedStudySession = transaction
            .update(StudySessionTable)
            .set({
              revision: existingStudySession.revision + 1,
              updatedAt: toIso(now()),
            })
            .where(
              and(
                eq(StudySessionTable.userId, context.userId),
                eq(StudySessionTable.id, sessionId),
                eq(StudySessionTable.revision, existingStudySession.revision),
                isNull(StudySessionTable.deletedAt),
              ),
            )
            .returning({ revision: StudySessionTable.revision })
            .get();
          if (updatedStudySession)
            changedSessions.push({
              sessionId,
              revision: updatedStudySession.revision,
            });
        }
        return changedSessions;
      });
      assertCurrent(context);
      if (publish)
        for (const session of changedSessions) {
          const event = createStudySessionEvent(context, session);
          publishStudySessionEvent(publish, event);
        }
    } catch (error) {
      throw asStudyError(
        error,
        'Grade-derived study history could not be removed.',
      );
    }
  };

  return {
    createStudySession,
    listStudySessions,
    getStudySession,
    renameStudySession,
    saveStudyDraft,
    deleteStudySession,
    beginStudyTurn,
    updateStudyTurnStatus,
    commitStudyTurn,
    appendStudyTurnParts,
    settleStudyTurn,
    reconcileOrphanedStudyTurns,
    retryStudyTurn,
    purgeGradeDerivedStudyContent,
    timer,
  };
};

const defaultStore = createSessionStore();

export const createStudySession = defaultStore.createStudySession;
export const listStudySessions = defaultStore.listStudySessions;
export const getStudySession = defaultStore.getStudySession;
export const renameStudySession = defaultStore.renameStudySession;
export const saveStudyDraft = defaultStore.saveStudyDraft;
export const deleteStudySession = defaultStore.deleteStudySession;
export const beginStudyTurn = defaultStore.beginStudyTurn;
export const updateStudyTurnStatus = defaultStore.updateStudyTurnStatus;
export const commitStudyTurn = defaultStore.commitStudyTurn;
export const appendStudyTurnParts = defaultStore.appendStudyTurnParts;
export const settleStudyTurn = defaultStore.settleStudyTurn;
export const reconcileOrphanedStudyTurns =
  defaultStore.reconcileOrphanedStudyTurns;
export const retryStudyTurn = defaultStore.retryStudyTurn;
export const purgeGradeDerivedStudyContent =
  defaultStore.purgeGradeDerivedStudyContent;
