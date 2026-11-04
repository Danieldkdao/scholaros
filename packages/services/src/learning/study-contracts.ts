import { z } from 'zod';
import { sourceReferenceSchema } from './context-contracts';
import { safeErrorCodeSchema } from './product-contracts';
import {
  idSchema,
  instantSchema,
  revisionSchema,
  requestIdSchema,
} from './product-contracts';
import { assistancePolicySchema } from './grade-contracts';
import { personalContextSchema } from './memory-contracts';

export const studyActivities = [
  'understand-topic',
  'prepare-exam',
  'practice-knowledge',
  'review-graded-mistakes',
  'assignment-start',
] as const;
export type StudyActivity = (typeof studyActivities)[number];
export const studySessionStatuses = [
  'saved',
  'in-progress',
  'finished',
  'interrupted',
] as const;
export type StudySessionStatus = (typeof studySessionStatuses)[number];
export const studyMessageRoles = ['student', 'tutor', 'system-status'] as const;
export type StudyMessageRole = (typeof studyMessageRoles)[number];
export const studyHistoryRoles = ['student', 'tutor'] as const;
export type StudyHistoryRole = (typeof studyHistoryRoles)[number];
export const studyMessageStatuses = [
  'accepted',
  'interrupted',
  'failed',
] as const;
export type StudyMessageStatus = (typeof studyMessageStatuses)[number];
export const studyTurnStatuses = [
  'preparing',
  'generating',
  'checking',
  'complete',
  'failed',
  'cancelled',
] as const;
export type StudyTurnStatus = (typeof studyTurnStatuses)[number];
export const freshnessStatuses = [
  'current',
  'stale',
  'partial',
  'unavailable',
] as const;
export type FreshnessStatus = (typeof freshnessStatuses)[number];

export const createStudySessionInputSchema = z.strictObject({
  requestId: requestIdSchema,
  courseId: idSchema,
  activity: z.enum(studyActivities),
  targetAssignmentId: idSchema.nullable().optional(),
  topic: z.string().max(1000).optional(),
  contextItemIds: z.array(idSchema).max(20),
  durationMinutes: z.number().int().min(1).max(240).nullable(),
  title: z.string().max(160).optional(),
});
export type CreateStudySessionInput = z.infer<
  typeof createStudySessionInputSchema
>;

export const studyTimerSchema = z.strictObject({
  deadlineAt: instantSchema.nullable(),
  revision: revisionSchema,
  expiredRevision: revisionSchema.nullable(),
  resolvedExpiredRevision: revisionSchema.nullable(),
  finishedAt: instantSchema.nullable(),
});
export type StudyTimerDTO = z.infer<typeof studyTimerSchema>;

export const studySessionSchema = z.strictObject({
  id: idSchema,
  courseId: idSchema,
  title: z.string().max(160),
  activity: z.enum(studyActivities),
  targetAssignmentId: idSchema.nullable(),
  topic: z.string().max(1000).nullable(),
  status: z.enum(studySessionStatuses),
  revision: revisionSchema,
  generationEpoch: revisionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  lastOpenedAt: instantSchema,
  draft: z.strictObject({
    text: z.string().max(8000),
    revision: revisionSchema,
  }),
  timer: studyTimerSchema,
});
export type StudySessionDTO = z.infer<typeof studySessionSchema>;

export const studyMessagePartSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().max(32_000) }),
  z.strictObject({
    kind: z.literal('citation'),
    reference: sourceReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('attachment'),
    itemId: idSchema,
    versionId: idSchema,
  }),
  z.strictObject({
    kind: z.literal('activity'),
    artifactId: idSchema,
    versionId: idSchema,
    attemptId: idSchema,
  }),
  z.strictObject({ kind: z.literal('practice'), practiceAttemptId: idSchema }),
  z.strictObject({
    kind: z.literal('status'),
    code: z.string().max(100),
    label: z.string().max(300),
  }),
]);
export type MessagePart = z.infer<typeof studyMessagePartSchema>;

export const studyMessageSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  sequence: z.number().int().nonnegative(),
  role: z.enum(studyMessageRoles),
  turnId: idSchema.nullable(),
  createdAt: instantSchema,
  parts: z.array(studyMessagePartSchema).max(100),
  status: z.enum(studyMessageStatuses),
  gradeDerived: z.boolean(),
  gradeConsentRevision: revisionSchema.nullable(),
});
export type StudyMessageDTO = z.infer<typeof studyMessageSchema>;

export const turnSchema = z.strictObject({
  id: idSchema,
  sessionId: idSchema,
  status: z.enum(studyTurnStatuses),
  attemptNumber: z.number().int().min(1),
  errorCode: safeErrorCodeSchema.nullable(),
  startedAt: instantSchema,
  settledAt: instantSchema.nullable(),
});
export type TurnDTO = z.infer<typeof turnSchema>;

export const sessionSnapshotSchema = z.strictObject({
  session: studySessionSchema,
  messages: z.array(studyMessageSchema).max(100),
  hasMoreBefore: z.boolean(),
  activeTurn: turnSchema.nullable(),
  sourceReferences: z.array(sourceReferenceSchema).max(200),
  revision: revisionSchema,
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const preparedStudyContextSchema = z.strictObject({
  sessionId: idSchema,
  courseId: idSchema,
  activity: z.enum(studyActivities),
  topic: z.string().max(1000).nullable(),
  targetAssignmentId: idSchema.nullable(),
  sourcePassages: z
    .array(
      z.strictObject({
        reference: sourceReferenceSchema,
        text: z.string().max(2000),
        score: z.number().finite().nullable(),
      }),
    )
    .max(20),
  personalContext: personalContextSchema,
  history: z
    .array(
      z.strictObject({
        role: z.enum(studyHistoryRoles),
        text: z.string().max(8000),
      }),
    )
    .max(12),
  freshness: z.strictObject({
    status: z.enum(freshnessStatuses),
    lastSuccessfulAt: instantSchema.nullable(),
  }),
  contextRevision: revisionSchema,
  policy: assistancePolicySchema,
});
export type PreparedStudyContext = z.infer<typeof preparedStudyContextSchema>;
