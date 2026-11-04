import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  type AuthorizedContext,
  type JsonValue,
} from '@scholaros/services/learning/product-contracts';
import {
  allowedAssistanceOperations,
  observedGradeSchema,
  type AllowedAssistanceOperation,
} from '@scholaros/services/learning/grade-contracts';
import { db } from '../../../db';
import {
  AssistanceLedgerTable,
  CourseAssignmentTable,
  CourseworkProtectionTable,
  GradeEvidenceTable,
  SettingTable,
  StudySessionTable,
  StudyTurnTable,
} from '../../../db/schema';
import { z } from 'zod';

export const assistanceRiskTags = [
  'answer-adjacent',
  'cumulative-fragment',
  'hidden-answer',
  'memory-policy-bypass',
  'policy-bypass',
  'repeated-candidate',
  'same-solution-practice',
  'source-injection-seen',
  'uninterpretable',
] as const;
export type AssistanceRiskTag = (typeof assistanceRiskTags)[number];

const operationCountsSchema = z.strictObject({
  concept: z.number().int().nonnegative().max(10_000),
  requirements: z.number().int().nonnegative().max(10_000),
  'bounded-hint': z.number().int().nonnegative().max(10_000),
  'distinct-practice': z.number().int().nonnegative().max(10_000),
  'source-feedback-review': z.number().int().nonnegative().max(10_000),
});
const assistanceSummarySchema = z.strictObject({
  version: z.literal(1),
  operations: operationCountsSchema,
  candidateDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(16),
});
const emptyOperationCounts = (): z.infer<typeof operationCountsSchema> => ({
  concept: 0,
  requirements: 0,
  'bounded-hint': 0,
  'distinct-practice': 0,
  'source-feedback-review': 0,
});
const emptyAssistanceSummary = (): z.infer<typeof assistanceSummarySchema> => ({
  version: 1,
  operations: emptyOperationCounts(),
  candidateDigests: [],
});

export type AssistanceCoverage = {
  assistanceUnits: number;
  operations: z.infer<typeof operationCountsSchema>;
  riskTags: AssistanceRiskTag[];
  candidateDigests: string[];
  corrupt: boolean;
};

export type CurrentGradeConsent = {
  enabled: boolean;
  revision: number;
};

export const readCurrentGradeConsent = (
  userId: string,
): CurrentGradeConsent => {
  const setting = db
    .select({ productPreferences: SettingTable.productPreferences })
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get();
  const preferences = setting?.productPreferences as
    | { grades?: { enabled?: unknown; revision?: unknown } }
    | undefined;
  const revision = preferences?.grades?.revision;
  const hasValidRevision =
    typeof revision === 'number' &&
    Number.isSafeInteger(revision) &&
    revision >= 0;
  return {
    enabled: preferences?.grades?.enabled === true && hasValidRevision,
    revision: hasValidRevision ? revision : 0,
  };
};

export const isCurrentVerifiedEvidence = (input: {
  consent: CurrentGradeConsent;
  protection: {
    state: string;
    sourceEvidenceId: string | null;
    verifiedAt: string | null;
    suppressed: boolean;
  };
  evidence: {
    id: string;
    consentRevision: number;
    completed: string;
    grade: unknown;
    remainingOpportunity: string;
    conflicts: unknown;
    observedAt: string;
    revokedAt: string | null;
  };
  now?: number;
  sourceChangedAt?: string | null;
}) => {
  const observedAt = Date.parse(input.evidence.observedAt);
  const verifiedAt = input.protection.verifiedAt
    ? Date.parse(input.protection.verifiedAt)
    : Number.NaN;
  const now = input.now ?? Date.now();
  const isFresh = (timestamp: number) =>
    Number.isFinite(timestamp) &&
    timestamp <= now &&
    now - timestamp <= 15 * 60_000;
  const conflicts = input.evidence.conflicts;
  const hasConflicts = !Array.isArray(conflicts) || conflicts.length > 0;
  const grade = observedGradeSchema.safeParse(input.evidence.grade);
  const sourceChangedAt =
    input.sourceChangedAt === null || input.sourceChangedAt === undefined
      ? null
      : Date.parse(input.sourceChangedAt);
  const sourceIsUnchanged =
    sourceChangedAt === null ||
    (Number.isFinite(sourceChangedAt) && sourceChangedAt <= observedAt);

  return (
    input.consent.enabled &&
    input.consent.revision === input.evidence.consentRevision &&
    input.protection.state === 'verified-completed' &&
    input.protection.sourceEvidenceId === input.evidence.id &&
    !input.protection.suppressed &&
    input.evidence.revokedAt === null &&
    input.evidence.completed === 'yes' &&
    input.evidence.remainingOpportunity === 'no' &&
    grade.success &&
    !hasConflicts &&
    isFresh(observedAt) &&
    isFresh(verifiedAt) &&
    sourceIsUnchanged
  );
};

export const readAssistanceCoverage = (
  context: AuthorizedContext,
  input: { courseId: string; protectionId: string },
): AssistanceCoverage => {
  if (context.signal.aborted || !context.isCurrent())
    return {
      assistanceUnits: 2,
      operations: emptyOperationCounts(),
      riskTags: ['uninterpretable'],
      candidateDigests: [],
      corrupt: true,
    };
  const ledgerEntry = db
    .select()
    .from(AssistanceLedgerTable)
    .where(
      and(
        eq(AssistanceLedgerTable.userId, context.userId),
        eq(AssistanceLedgerTable.courseId, input.courseId),
        eq(AssistanceLedgerTable.protectionId, input.protectionId),
      ),
    )
    .orderBy(desc(AssistanceLedgerTable.createdAt))
    .limit(1)
    .get();
  if (!ledgerEntry)
    return {
      assistanceUnits: 0,
      operations: emptyOperationCounts(),
      riskTags: [],
      candidateDigests: [],
      corrupt: false,
    };

  const summary = assistanceSummarySchema.safeParse(
    ledgerEntry.allowedSupportSummary,
  );
  const tags = z
    .array(z.enum(assistanceRiskTags))
    .max(8)
    .safeParse(ledgerEntry.answerRiskTags);
  const validAssistanceUnits =
    Number.isSafeInteger(ledgerEntry.assistanceUnits) &&
    ledgerEntry.assistanceUnits >= 0 &&
    ledgerEntry.assistanceUnits <= 10_000;
  if (!summary.success || !tags.success || !validAssistanceUnits)
    return {
      assistanceUnits: 2,
      operations: emptyOperationCounts(),
      riskTags: ['uninterpretable'],
      candidateDigests: [],
      corrupt: true,
    };

  return {
    assistanceUnits: ledgerEntry.assistanceUnits,
    operations: summary.data.operations,
    riskTags: tags.data,
    candidateDigests: summary.data.candidateDigests,
    corrupt: false,
  };
};

const recordAssistanceInputSchema = z.strictObject({
  protectionId: z.string().min(1).max(300),
  turnId: z.string().min(1).max(300),
  operation: z.enum(allowedAssistanceOperations).nullable(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  riskTags: z.array(z.enum(assistanceRiskTags)).max(8),
  expectedPolicyRevision: z.number().int().nonnegative().safe(),
  expectedConsentRevision: z.number().int().nonnegative().safe(),
});

const emptyLedgerTags = (): AssistanceRiskTag[] => [];
const currentTimestamp = () => new Date().toISOString();

type AssistanceRecordFailure =
  | 'answer-risk'
  | 'cancelled'
  | 'invalid-input'
  | 'limit-exceeded'
  | 'permission-revoked'
  | 'revision-conflict'
  | 'scope-denied'
  | 'session-changed'
  | 'storage-failed';

const reserveAssistance = (
  context: AuthorizedContext,
  input: unknown,
): true | AssistanceRecordFailure => {
  const parsed = recordAssistanceInputSchema.safeParse(input);
  if (!parsed.success) return 'invalid-input';
  if (context.signal.aborted) return 'cancelled';
  if (!context.isCurrent()) return 'session-changed';
  const values = parsed.data;
  const candidateDigest = values.candidateDigest;
  try {
    return db.transaction((transaction) => {
      if (context.signal.aborted) return 'cancelled';
      if (!context.isCurrent()) return 'session-changed';
      const turn = transaction
        .select()
        .from(StudyTurnTable)
        .where(
          and(
            eq(StudyTurnTable.userId, context.userId),
            eq(StudyTurnTable.id, values.turnId),
            inArray(StudyTurnTable.status, ['checking', 'complete', 'failed']),
          ),
        )
        .get();
      if (!turn) return 'scope-denied';
      if (turn.policyRevision !== values.expectedPolicyRevision)
        return 'revision-conflict';
      const session = transaction
        .select()
        .from(StudySessionTable)
        .where(
          and(
            eq(StudySessionTable.userId, context.userId),
            eq(StudySessionTable.id, turn.sessionId),
            isNull(StudySessionTable.deletedAt),
          ),
        )
        .get();
      if (!session || session.generationEpoch !== turn.generationEpoch)
        return 'session-changed';
      const protection = transaction
        .select()
        .from(CourseworkProtectionTable)
        .where(
          and(
            eq(CourseworkProtectionTable.userId, context.userId),
            eq(CourseworkProtectionTable.courseId, session.courseId),
            eq(CourseworkProtectionTable.id, values.protectionId),
          ),
        )
        .get();
      if (!protection || session.courseId !== protection.courseId)
        return 'scope-denied';

      const setting = transaction
        .select({ productPreferences: SettingTable.productPreferences })
        .from(SettingTable)
        .where(eq(SettingTable.userId, context.userId))
        .get();
      const preferences = setting?.productPreferences as
        | { grades?: { enabled?: unknown; revision?: unknown } }
        | undefined;
      const currentRevision = preferences?.grades?.revision;
      const hasValidConsentRevision =
        typeof currentRevision === 'number' &&
        Number.isSafeInteger(currentRevision) &&
        currentRevision >= 0;
      const consentRevision = hasValidConsentRevision ? currentRevision : 0;
      if (
        values.operation === 'source-feedback-review' &&
        !hasValidConsentRevision
      )
        return 'permission-revoked';
      if (consentRevision !== values.expectedConsentRevision)
        return 'permission-revoked';

      if (values.operation === 'source-feedback-review') {
        const aliases = [protection.canonicalIdentity, ...protection.aliases];
        const evidenceRows = transaction
          .select()
          .from(GradeEvidenceTable)
          .where(
            and(
              eq(GradeEvidenceTable.userId, context.userId),
              eq(GradeEvidenceTable.courseId, session.courseId),
              isNull(GradeEvidenceTable.revokedAt),
            ),
          )
          .all()
          .filter((evidence) => aliases.includes(evidence.assignmentIdentity))
          .sort((left, right) =>
            right.observedAt.localeCompare(left.observedAt),
          );
        const evidence = evidenceRows[0];
        if (
          !evidence ||
          evidenceRows.some(
            (candidate) =>
              candidate.observedAt === evidence.observedAt &&
              (candidate.completed !== evidence.completed ||
                candidate.remainingOpportunity !==
                  evidence.remainingOpportunity ||
                JSON.stringify(candidate.grade) !==
                  JSON.stringify(evidence.grade)),
          ) ||
          !isCurrentVerifiedEvidence({
            consent: {
              enabled: preferences?.grades?.enabled === true,
              revision: consentRevision,
            },
            protection,
            evidence,
            sourceChangedAt:
              transaction
                .select({
                  contentChangedAt: CourseAssignmentTable.contentChangedAt,
                })
                .from(CourseAssignmentTable)
                .where(
                  and(
                    eq(CourseAssignmentTable.userId, context.userId),
                    eq(CourseAssignmentTable.courseId, session.courseId),
                    inArray(CourseAssignmentTable.sourceKey, aliases),
                  ),
                )
                .all()
                .map((assignment) => assignment.contentChangedAt)
                .filter((timestamp): timestamp is string => timestamp !== null)
                .sort()
                .at(-1) ?? null,
          })
        )
          return 'permission-revoked';
      }

      const questionFingerprint =
        protection.questionFingerprint &&
        /^[a-f0-9]{64}$/.test(protection.questionFingerprint)
          ? protection.questionFingerprint
          : createHash('sha256')
              .update(
                `${context.userId}\u0000${session.courseId}\u0000${protection.canonicalIdentity}`,
              )
              .digest('hex');
      const existingEntry = transaction
        .select()
        .from(AssistanceLedgerTable)
        .where(
          and(
            eq(AssistanceLedgerTable.userId, context.userId),
            eq(AssistanceLedgerTable.courseId, session.courseId),
            eq(AssistanceLedgerTable.protectionId, protection.id),
            eq(AssistanceLedgerTable.questionFingerprint, questionFingerprint),
          ),
        )
        .orderBy(desc(AssistanceLedgerTable.createdAt))
        .limit(1)
        .get();
      const storedSummary = existingEntry
        ? assistanceSummarySchema.safeParse(existingEntry.allowedSupportSummary)
        : { success: true as const, data: emptyAssistanceSummary() };
      const storedTags = existingEntry
        ? z
            .array(z.enum(assistanceRiskTags))
            .safeParse(existingEntry.answerRiskTags)
        : { success: true as const, data: emptyLedgerTags() };
      if (!storedSummary.success || !storedTags.success)
        return 'storage-failed';
      if (
        existingEntry?.turnId === turn.id &&
        storedSummary.data.candidateDigests.includes(candidateDigest)
      )
        return true;
      if (protection.policyRevision !== values.expectedPolicyRevision)
        return 'revision-conflict';
      if (storedSummary.data.candidateDigests.includes(candidateDigest))
        return 'answer-risk';
      if (
        values.operation === 'bounded-hint' &&
        (storedSummary.data.operations['bounded-hint'] >= 2 ||
          storedSummary.data.operations['distinct-practice'] >= 6 ||
          (existingEntry?.assistanceUnits ?? 0) >= 6 ||
          storedTags.data.some((tag) => tag !== 'source-injection-seen'))
      )
        return 'limit-exceeded';

      const nextRevision = protection.policyRevision + 1;
      if (!Number.isSafeInteger(nextRevision)) return 'revision-conflict';
      if (context.signal.aborted) return 'cancelled';
      if (!context.isCurrent()) return 'session-changed';
      const revisionUpdated = transaction
        .update(CourseworkProtectionTable)
        .set({ policyRevision: nextRevision })
        .where(
          and(
            eq(CourseworkProtectionTable.userId, context.userId),
            eq(CourseworkProtectionTable.id, protection.id),
            eq(
              CourseworkProtectionTable.policyRevision,
              values.expectedPolicyRevision,
            ),
          ),
        )
        .run();
      if (revisionUpdated.changes !== 1) return 'revision-conflict';

      const operations = { ...storedSummary.data.operations };
      if (values.operation)
        operations[values.operation] = Math.min(
          10_000,
          operations[values.operation] + 1,
        );
      const candidateDigests = [
        ...storedSummary.data.candidateDigests,
        candidateDigest,
      ].slice(-16);
      const answerRiskTags = [
        ...new Set([...storedTags.data, ...values.riskTags]),
      ].slice(0, 8);
      const allowedSupportSummary: JsonValue = {
        version: 1,
        operations,
        candidateDigests,
      };
      const createdAt = currentTimestamp();

      if (existingEntry) {
        transaction
          .update(AssistanceLedgerTable)
          .set({
            turnId: turn.id,
            allowedSupportSummary,
            answerRiskTags,
            assistanceUnits: Math.min(
              10_000,
              existingEntry.assistanceUnits + (values.operation ? 1 : 0),
            ),
            createdAt,
          })
          .where(eq(AssistanceLedgerTable.id, existingEntry.id))
          .run();
      } else {
        transaction
          .insert(AssistanceLedgerTable)
          .values({
            id: randomUUID(),
            userId: context.userId,
            courseId: session.courseId,
            protectionId: protection.id,
            questionFingerprint,
            turnId: turn.id,
            allowedSupportSummary,
            answerRiskTags,
            assistanceUnits: values.operation ? 1 : 0,
            createdAt,
          })
          .run();
      }
      return true;
    });
  } catch {
    return 'storage-failed';
  }
};

const publicAssistanceSummarySchema = z.strictObject({
  version: z.literal(1),
  operation: z.enum(allowedAssistanceOperations).nullable(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPolicyRevision: z.number().int().nonnegative().safe(),
  expectedConsentRevision: z.number().int().nonnegative().safe(),
});
export type AllowedSupportSummary = z.infer<
  typeof publicAssistanceSummarySchema
>;
const publicRecordAssistanceInputSchema = z
  .strictObject({
    protectionId: z.string().min(1).max(300),
    turnId: z.string().min(1).max(300),
    allowedSupportSummary: publicAssistanceSummarySchema,
    riskTags: z.array(z.enum(assistanceRiskTags)).max(8),
  })
  .superRefine((input, validation) => {
    if (
      input.allowedSupportSummary.operation === null &&
      input.riskTags.length === 0
    )
      validation.addIssue({
        code: 'custom',
        message: 'A support operation or risk classification is required.',
      });
  });

export const recordAssistance = (
  context: AuthorizedContext,
  input: unknown,
): void => {
  if (context.signal.aborted) throw new Error('cancelled');
  if (!context.isCurrent()) throw new Error('session-changed');
  const parsed = publicRecordAssistanceInputSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid-input');
  const { protectionId, turnId, allowedSupportSummary, riskTags } = parsed.data;
  const recorded = reserveAssistance(context, {
    protectionId,
    turnId,
    operation: allowedSupportSummary.operation,
    candidateDigest: allowedSupportSummary.candidateDigest,
    riskTags,
    expectedPolicyRevision: allowedSupportSummary.expectedPolicyRevision,
    expectedConsentRevision: allowedSupportSummary.expectedConsentRevision,
  });
  if (recorded !== true) throw new Error(recorded);
};

export const assistanceOperationNames: readonly AllowedAssistanceOperation[] =
  allowedAssistanceOperations;
