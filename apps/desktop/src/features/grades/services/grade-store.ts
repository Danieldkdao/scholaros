import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { isReadNavigation } from '../../onboarding/lib/browser-policy';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  BrowserWorkspaceTable,
  CourseAssignmentTable,
  CourseTable,
  CourseworkProtectionTable,
  GradeEvidenceTable,
  SettingTable,
} from '../../../db/schema';
import type {
  GradeEvidenceSelectData,
  SettingSelectData,
} from '../../../db/schema';
import type {
  EvidenceTriState,
  GradeSettings,
  GradeVerificationState,
  ObservedGrade,
} from '@scholaros/services/learning/grade-contracts';
import { gradeSettingsSchema } from '@scholaros/services/learning/grade-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type { GradeSourceRecord } from './grade-collector';
import { GradeServiceError } from './grade-service';
import type {
  GradeServiceStore,
  SaveGradeEvidenceInput,
  SaveGradeSettingsInput,
  StoredGradeEvidence,
} from './grade-service';

type GradeReader = Omit<typeof db, '$client'>;

type GradePreference = {
  enabled: boolean;
  notes: string;
  revision: number;
};

const defaultGradePreference: GradePreference = {
  enabled: false,
  notes: '',
  revision: 0,
};

const gradesFromSettings = (settings: SettingSelectData | undefined) =>
  settings?.productPreferences?.grades ?? defaultGradePreference;

const gradeSettingsFor = (userId: string): GradeSettings => {
  const existingSettings = db
    .select()
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get();
  const existingGradeEvidenceIds = db
    .select({ id: GradeEvidenceTable.id })
    .from(GradeEvidenceTable)
    .where(eq(GradeEvidenceTable.userId, userId))
    .all();
  return gradeSettingsSchema.parse({
    ...gradesFromSettings(existingSettings),
    collectedCount: existingGradeEvidenceIds.length,
    updatedAt: existingSettings?.updatedAt ?? new Date().toISOString(),
  });
};

const assignmentVersionFor = (input: {
  assignment: typeof CourseAssignmentTable.$inferSelect;
  course: typeof CourseTable.$inferSelect;
  connection: typeof AcademicConnectionTable.$inferSelect | null;
  workspace: typeof BrowserWorkspaceTable.$inferSelect | null;
  academicConsent: boolean;
}) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        assignmentId: input.assignment.id,
        assignmentIdentity: input.assignment.sourceKey,
        assignmentUrl: input.assignment.url,
        assignmentLastSeenAt: input.assignment.lastSeenAt,
        assignmentChangedAt: input.assignment.contentChangedAt,
        assignmentContent: input.assignment.content ?? null,
        courseId: input.course.id,
        courseConnectionId: input.course.connectionId,
        courseActive: input.course.active,
        connectionStatus: input.connection?.status ?? null,
        connectionVerifiedAt: input.connection?.verifiedAt ?? null,
        connectionEligible: input.connection?.isCourseResource ?? false,
        workspaceVerifiedAt: input.workspace?.verifiedAt ?? null,
        academicConsent: input.academicConsent,
      }),
    )
    .digest('hex');

const protectionFor = (
  reader: GradeReader,
  userId: string,
  courseId: string,
  assignmentIdentity: string,
  assignmentId: string,
) => {
  const existingProtections = reader
    .select()
    .from(CourseworkProtectionTable)
    .where(
      and(
        eq(CourseworkProtectionTable.userId, userId),
        eq(CourseworkProtectionTable.courseId, courseId),
      ),
    )
    .all()
    .filter(
      (protection) =>
        protection.canonicalIdentity === assignmentIdentity ||
        protection.canonicalIdentity === `assignment:${assignmentId}` ||
        protection.aliases.includes(assignmentIdentity) ||
        protection.aliases.includes(assignmentId),
    );
  if (existingProtections.length > 1)
    throw new GradeServiceError(
      'scope-denied',
      'This assignment has conflicting protected identities.',
    );
  return existingProtections[0];
};

const sourceFromRows = (
  reader: GradeReader,
  context: AuthorizedContext,
  courseId: string,
  assignmentId: string,
): GradeSourceRecord | null => {
  const existingAssignment = reader
    .select()
    .from(CourseAssignmentTable)
    .where(
      and(
        eq(CourseAssignmentTable.userId, context.userId),
        eq(CourseAssignmentTable.courseId, courseId),
        eq(CourseAssignmentTable.id, assignmentId),
      ),
    )
    .get();
  if (!existingAssignment) {
    const existingProtection = reader
      .select()
      .from(CourseworkProtectionTable)
      .where(
        and(
          eq(CourseworkProtectionTable.userId, context.userId),
          eq(CourseworkProtectionTable.courseId, courseId),
        ),
      )
      .all()
      .find((protection) => protection.aliases.includes(assignmentId));
    if (!existingProtection) return null;
    return {
      assignmentId,
      assignmentIdentity: existingProtection.canonicalIdentity,
      courseId,
      connectionId: existingProtection.connectionId,
      connectionHost: null,
      assignmentUrl: null,
      assignmentTitle: '',
      courseTitle: '',
      sourceVersion: '',
      eligible: false,
      suppressed: true,
      policyRevision: existingProtection.policyRevision,
    };
  }

  const existingCourse = reader
    .select()
    .from(CourseTable)
    .where(
      and(eq(CourseTable.userId, context.userId), eq(CourseTable.id, courseId)),
    )
    .get();
  if (!existingCourse) return null;
  const existingConnection = existingCourse.connectionId
    ? (reader
        .select()
        .from(AcademicConnectionTable)
        .where(
          and(
            eq(AcademicConnectionTable.userId, context.userId),
            eq(AcademicConnectionTable.id, existingCourse.connectionId),
          ),
        )
        .get() ?? null)
    : null;
  const existingSettings = reader
    .select()
    .from(SettingTable)
    .where(eq(SettingTable.userId, context.userId))
    .get();
  const existingWorkspace =
    reader
      .select()
      .from(BrowserWorkspaceTable)
      .where(eq(BrowserWorkspaceTable.userId, context.userId))
      .get() ?? null;
  const identityConflicts = existingAssignment.identityConflicts ?? [];
  const existingAssignmentProtection = protectionFor(
    reader,
    context.userId,
    courseId,
    existingAssignment.sourceKey,
    existingAssignment.id,
  );
  const sourceHost = existingConnection?.host ?? null;
  const sourceUrlAllowed =
    !!sourceHost && isReadNavigation(existingAssignment.url, [sourceHost]);
  const eligible =
    !!existingConnection &&
    existingConnection.status === 'verified' &&
    !!existingConnection.verifiedAt &&
    existingConnection.isCourseResource &&
    !!existingSettings?.consent &&
    existingCourse.active &&
    existingAssignment.active &&
    !!existingWorkspace?.verifiedAt &&
    sourceUrlAllowed &&
    identityConflicts.length === 0 &&
    existingAssignment.suppressedAt === null &&
    !existingAssignmentProtection?.suppressed;
  return {
    assignmentId: existingAssignment.id,
    assignmentIdentity: existingAssignment.sourceKey,
    courseId: existingCourse.id,
    connectionId: existingCourse.connectionId,
    connectionHost: sourceHost,
    assignmentUrl: existingAssignment.url,
    assignmentTitle:
      existingAssignment.content?.title ?? existingAssignment.title,
    courseTitle: existingCourse.name,
    sourceVersion: assignmentVersionFor({
      assignment: existingAssignment,
      course: existingCourse,
      connection: existingConnection,
      workspace: existingWorkspace,
      academicConsent: !!existingSettings?.consent,
    }),
    eligible,
    suppressed:
      existingAssignment.suppressedAt !== null ||
      !!existingAssignmentProtection?.suppressed,
    policyRevision: existingAssignmentProtection?.policyRevision ?? 0,
  };
};

const getSettings = (userId: string) => gradeSettingsFor(userId);

const saveSettings = (
  context: AuthorizedContext,
  input: SaveGradeSettingsInput,
): GradeSettings => {
  if (!context.isCurrent())
    throw new GradeServiceError(
      'session-changed',
      'Your session changed; sign in again.',
    );
  const savedAt = new Date().toISOString();
  db.transaction((tx) => {
    tx.insert(SettingTable)
      .values({ userId: context.userId, updatedAt: savedAt })
      .onConflictDoNothing()
      .run();
    const existingSettings = tx
      .select()
      .from(SettingTable)
      .where(eq(SettingTable.userId, context.userId))
      .get();
    if (!existingSettings)
      throw new GradeServiceError(
        'storage-failed',
        'Grade settings could not be saved.',
      );
    const existingGrades = gradesFromSettings(existingSettings);
    if (existingGrades.revision !== input.expectedRevision)
      throw new GradeServiceError(
        'revision-conflict',
        'Grade settings changed; refresh and try again.',
      );
    const productPreferences = {
      ...existingSettings.productPreferences,
      grades: {
        enabled: input.enabled,
        notes: input.notes,
        revision: existingGrades.revision + 1,
      },
    };
    if (!context.isCurrent())
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
    tx.update(SettingTable)
      .set({ productPreferences, updatedAt: savedAt })
      .where(eq(SettingTable.userId, context.userId))
      .run();
  });
  return getSettings(context.userId);
};

const getSource = (
  context: AuthorizedContext,
  courseId: string,
  assignmentId: string,
) => sourceFromRows(db, context, courseId, assignmentId);

const ensureProtection = (
  context: AuthorizedContext,
  source: GradeSourceRecord,
) =>
  db.transaction((tx) => {
    if (!context.isCurrent())
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
    const existingProtection = protectionFor(
      tx,
      context.userId,
      source.courseId,
      source.assignmentIdentity,
      source.assignmentId,
    );
    const aliases = [
      ...new Set([
        ...(existingProtection?.aliases ?? []),
        source.assignmentId,
        source.assignmentIdentity,
      ]),
    ];
    const protectedAt = new Date().toISOString();
    if (existingProtection) {
      const shouldDowngrade =
        source.suppressed &&
        (!existingProtection.suppressed ||
          existingProtection.state !== 'unknown' ||
          existingProtection.sourceEvidenceId !== null);
      tx.update(CourseworkProtectionTable)
        .set({
          aliases,
          connectionId: source.connectionId,
          suppressed: source.suppressed,
          ...(shouldDowngrade
            ? {
                state: 'unknown' as const,
                verifiedAt: null,
                sourceEvidenceId: null,
                policyRevision: existingProtection.policyRevision + 1,
              }
            : {}),
        })
        .where(eq(CourseworkProtectionTable.id, existingProtection.id))
        .run();
      if (source.suppressed)
        tx.update(GradeEvidenceTable)
          .set({ revokedAt: protectedAt })
          .where(
            and(
              eq(GradeEvidenceTable.userId, context.userId),
              eq(GradeEvidenceTable.courseId, source.courseId),
              eq(
                GradeEvidenceTable.assignmentIdentity,
                source.assignmentIdentity,
              ),
              isNull(GradeEvidenceTable.revokedAt),
            ),
          )
          .run();
      return shouldDowngrade
        ? existingProtection.policyRevision + 1
        : existingProtection.policyRevision;
    }
    const protectionId = randomUUID();
    tx.insert(CourseworkProtectionTable)
      .values({
        id: protectionId,
        userId: context.userId,
        courseId: source.courseId,
        connectionId: source.connectionId,
        canonicalIdentity: `assignment:${source.assignmentId}`,
        aliases,
        state: 'unknown',
        policyRevision: 0,
        verifiedAt: null,
        sourceEvidenceId: null,
        suppressed: source.suppressed,
      })
      .run();
    return 0;
  });

const sourceVersionData = (value: string) => {
  try {
    const parsed = JSON.parse(value) as { assignmentVersion?: unknown };
    return typeof parsed.assignmentVersion === 'string'
      ? parsed.assignmentVersion
      : '';
  } catch {
    return '';
  }
};

const storedEvidenceFromRows = (
  row: GradeEvidenceSelectData,
  protection: typeof CourseworkProtectionTable.$inferSelect,
  assignmentId: string,
): StoredGradeEvidence => {
  const conflicts = Array.isArray(row.conflicts)
    ? row.conflicts.filter((item): item is string => typeof item === 'string')
    : [];
  const state: GradeVerificationState = conflicts.length
    ? 'unknown'
    : protection.state;
  const reasonCode = conflicts.length
    ? 'conflicting-evidence'
    : state === 'verified-completed'
      ? 'verified'
      : row.completed === 'no'
        ? 'coursework-active'
        : row.remainingOpportunity === 'yes'
          ? 'opportunity-remains'
          : row.grade === null
            ? 'grade-unavailable'
            : row.remainingOpportunity === 'unknown'
              ? 'opportunity-unknown'
              : 'completion-unverified';
  return {
    consentRevision: row.consentRevision,
    assignmentVersion: sourceVersionData(row.sourceVersion),
    verification: {
      courseId: row.courseId,
      assignmentId,
      state,
      completion: row.completed as EvidenceTriState,
      grade: (row.grade as ObservedGrade | null) ?? null,
      remainingOpportunity: row.remainingOpportunity as EvidenceTriState,
      feedback: null,
      observedAt: row.observedAt,
      consentRevision: row.consentRevision,
      policyRevision: protection.policyRevision,
      sourceReferences: (row.sourceReferences as SourceReference[]) ?? [],
      reasonCode,
    },
  };
};

const getEvidence = (
  context: AuthorizedContext,
  source: GradeSourceRecord,
): StoredGradeEvidence | null => {
  const existingProtection = protectionFor(
    db,
    context.userId,
    source.courseId,
    source.assignmentIdentity,
    source.assignmentId,
  );
  if (!existingProtection?.sourceEvidenceId || existingProtection.suppressed)
    return null;
  const existingEvidence = db
    .select()
    .from(GradeEvidenceTable)
    .where(
      and(
        eq(GradeEvidenceTable.userId, context.userId),
        eq(GradeEvidenceTable.id, existingProtection.sourceEvidenceId),
        isNull(GradeEvidenceTable.revokedAt),
      ),
    )
    .get();
  return existingEvidence
    ? storedEvidenceFromRows(
        existingEvidence,
        existingProtection,
        source.assignmentId,
      )
    : null;
};

const saveEvidence = (
  context: AuthorizedContext,
  input: SaveGradeEvidenceInput,
): StoredGradeEvidence | null =>
  db.transaction((tx) => {
    if (!input.source.connectionId)
      throw new GradeServiceError(
        'scope-denied',
        'This assignment has no current course connection.',
      );
    if (!context.isCurrent())
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
    const existingSettings = tx
      .select()
      .from(SettingTable)
      .where(eq(SettingTable.userId, context.userId))
      .get();
    const consent = gradesFromSettings(existingSettings);
    if (!consent.enabled || consent.revision !== input.consentRevision)
      return null;
    const currentSource = sourceFromRows(
      tx,
      context,
      input.source.courseId,
      input.source.assignmentId,
    );
    if (
      !currentSource ||
      !currentSource.eligible ||
      currentSource.suppressed ||
      currentSource.assignmentIdentity !== input.source.assignmentIdentity ||
      currentSource.sourceVersion !== input.source.sourceVersion
    )
      return null;

    const observedAt = input.verification.observedAt;
    if (!observedAt)
      throw new GradeServiceError(
        'invalid-input',
        'Grade evidence is missing its observation time.',
      );
    const existingProtection = protectionFor(
      tx,
      context.userId,
      input.source.courseId,
      input.source.assignmentIdentity,
      input.source.assignmentId,
    );
    if (
      (existingProtection?.policyRevision ?? 0) !== input.source.policyRevision
    )
      return null;
    const protectionId = existingProtection?.id ?? randomUUID();
    const policyRevision = (existingProtection?.policyRevision ?? 0) + 1;
    const sourceReferences = input.verification.sourceReferences;
    const gradeReferences = sourceReferences.filter(
      ({ sourceKind }) => sourceKind === 'grade-evidence',
    );
    const evidenceId = gradeReferences[0]?.sourceId;
    if (
      !evidenceId ||
      gradeReferences.some((reference) => reference.sourceId !== evidenceId)
    )
      throw new GradeServiceError(
        'invalid-input',
        'Grade evidence is missing its trusted identity.',
      );
    const aliases = [
      ...new Set([
        ...(existingProtection?.aliases ?? []),
        input.source.assignmentId,
        input.source.assignmentIdentity,
      ]),
    ];
    tx.update(GradeEvidenceTable)
      .set({ revokedAt: observedAt })
      .where(
        and(
          eq(GradeEvidenceTable.userId, context.userId),
          eq(GradeEvidenceTable.connectionId, input.source.connectionId),
          eq(GradeEvidenceTable.courseId, input.source.courseId),
          inArray(GradeEvidenceTable.assignmentIdentity, aliases),
          isNull(GradeEvidenceTable.revokedAt),
        ),
      )
      .run();
    tx.insert(GradeEvidenceTable)
      .values({
        id: evidenceId,
        userId: context.userId,
        connectionId: input.source.connectionId,
        courseId: input.source.courseId,
        assignmentIdentity: input.source.assignmentIdentity,
        sourceVersion: input.sourceVersion,
        observedAt,
        consentRevision: input.consentRevision,
        completed: input.verification.completion,
        grade: input.verification.grade,
        remainingOpportunity: input.verification.remainingOpportunity,
        conflicts:
          input.verification.reasonCode === 'conflicting-evidence'
            ? ['conflicting-evidence']
            : [],
        sourceReferences,
        revokedAt: null,
      })
      .run();
    const protectionValues = {
      userId: context.userId,
      courseId: input.source.courseId,
      connectionId: input.source.connectionId,
      canonicalIdentity:
        existingProtection?.canonicalIdentity ??
        `assignment:${input.source.assignmentId}`,
      aliases,
      state: input.verification.state,
      policyRevision,
      verifiedAt:
        input.verification.state === 'verified-completed' ? observedAt : null,
      sourceEvidenceId: evidenceId,
      suppressed: false,
    };
    if (existingProtection)
      tx.update(CourseworkProtectionTable)
        .set(protectionValues)
        .where(eq(CourseworkProtectionTable.id, protectionId))
        .run();
    else
      tx.insert(CourseworkProtectionTable)
        .values({ id: protectionId, ...protectionValues })
        .run();
    if (!context.isCurrent())
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
    const insertedEvidence = tx
      .select()
      .from(GradeEvidenceTable)
      .where(eq(GradeEvidenceTable.id, evidenceId))
      .get();
    const persistedProtection = tx
      .select()
      .from(CourseworkProtectionTable)
      .where(eq(CourseworkProtectionTable.id, protectionId))
      .get();
    return insertedEvidence && persistedProtection
      ? storedEvidenceFromRows(
          insertedEvidence,
          persistedProtection,
          input.source.assignmentId,
        )
      : null;
  });

const revokeEvidence = (context: AuthorizedContext, now: string) => {
  db.transaction((tx) => {
    if (!context.isCurrent())
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
    tx.update(GradeEvidenceTable)
      .set({ revokedAt: now })
      .where(
        and(
          eq(GradeEvidenceTable.userId, context.userId),
          isNull(GradeEvidenceTable.revokedAt),
        ),
      )
      .run();
    const existingProtections = tx
      .select()
      .from(CourseworkProtectionTable)
      .where(eq(CourseworkProtectionTable.userId, context.userId))
      .all();
    for (const protection of existingProtections)
      tx.update(CourseworkProtectionTable)
        .set({
          state: 'unknown',
          policyRevision: protection.policyRevision + 1,
          verifiedAt: null,
          sourceEvidenceId: null,
        })
        .where(eq(CourseworkProtectionTable.id, protection.id))
        .run();
  });
};

const deleteCollected = (context: AuthorizedContext) =>
  db.transaction((tx) => {
    if (!context.isCurrent())
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
    tx.delete(GradeEvidenceTable)
      .where(eq(GradeEvidenceTable.userId, context.userId))
      .run();
    const existingProtections = tx
      .select()
      .from(CourseworkProtectionTable)
      .where(eq(CourseworkProtectionTable.userId, context.userId))
      .all();
    for (const protection of existingProtections)
      tx.update(CourseworkProtectionTable)
        .set({
          state: 'unknown',
          policyRevision: protection.policyRevision + 1,
          verifiedAt: null,
          sourceEvidenceId: null,
        })
        .where(eq(CourseworkProtectionTable.id, protection.id))
        .run();
  });

export const gradeStore: GradeServiceStore = {
  getSettings,
  saveSettings,
  getSource,
  ensureProtection,
  getEvidence,
  saveEvidence,
  revokeEvidence,
  deleteCollected,
};
