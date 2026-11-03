import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  practiceEvaluationSchema,
  practiceFeedbackModes,
  practiceModes,
  practiceQuestionSchema,
  practiceSnapshotSchema,
  type PracticeSnapshot,
  type PracticeQuestionDTO,
} from '@scholaros/services/learning/practice-contracts';
import {
  idSchema,
  instantSchema,
  jsonValueSchema,
  requestIdSchema,
  revisionSchema,
  type JsonValue,
} from '@scholaros/services/learning/product-contracts';
import {
  ArtifactTable,
  ArtifactVersionTable,
  CourseTable,
  PracticeAnswerTable,
  PracticeAttemptTable,
  StudySessionTable,
} from '../../../db/schema';
import { validatePracticeEvaluation } from './practice-evaluation';

type PracticeDatabase = typeof import('../../../db').db;

type PracticeStoreErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'scope-denied'
  | 'revision-conflict'
  | 'storage-failed';

type PracticeStoreDependencies = {
  db: PracticeDatabase;
  now?: () => string;
  createId?: () => string;
};

const answerKeyBase = {
  questionId: idSchema,
  acceptedAlternatives: z.array(z.string().max(1000)).max(10),
  explanation: z.string().min(1).max(4000),
};

const practiceAnswerKeySchema = z.array(
  z.discriminatedUnion('kind', [
    z.strictObject({
      ...answerKeyBase,
      kind: z.literal('multiple-choice'),
      correctOptionId: idSchema,
    }),
    z.strictObject({
      ...answerKeyBase,
      kind: z.literal('numeric'),
      acceptedValues: z
        .array(
          z.strictObject({
            value: z.number().finite(),
            tolerance: z.number().finite().min(0).max(1_000_000),
            unit: z.string().max(100).nullable(),
          }),
        )
        .min(1)
        .max(10),
    }),
    z.strictObject({
      ...answerKeyBase,
      kind: z.literal('short-explanation'),
      rubricCriteria: z.array(z.string().min(1).max(500)).min(1).max(10),
    }),
  ]),
);

type PracticeAnswerKey = z.infer<typeof practiceAnswerKeySchema>;

const createPracticeAttemptInputSchema = z
  .strictObject({
    requestId: requestIdSchema,
    courseId: idSchema,
    sessionId: idSchema.nullable(),
    artifactId: idSchema.nullable(),
    versionId: idSchema,
    objectiveIds: z.array(idSchema).min(1).max(20),
    mode: z.enum(practiceModes),
    feedbackMode: z.enum(practiceFeedbackModes),
    rubricVersion: idSchema,
    questions: z.array(practiceQuestionSchema).min(1).max(20),
    hostAnswerKey: jsonValueSchema,
    priorAttemptId: idSchema.nullable().optional(),
    initialAssisted: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (new Set(input.objectiveIds).size !== input.objectiveIds.length)
      context.addIssue({
        code: 'custom',
        path: ['objectiveIds'],
        message: 'Objective identifiers must be unique.',
      });
    if (input.mode === 'exam' && input.feedbackMode !== 'end')
      context.addIssue({
        code: 'custom',
        path: ['feedbackMode'],
        message: 'Practice exams only reveal feedback after submission.',
      });
    if (input.feedbackMode === 'per-answer' && input.mode !== 'quiz')
      context.addIssue({
        code: 'custom',
        path: ['feedbackMode'],
        message: 'Per-answer feedback is only available for ordinary quizzes.',
      });
    if (
      input.questions.some((question) =>
        question.objectiveIds.some(
          (objectiveId) => !input.objectiveIds.includes(objectiveId),
        ),
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['questions'],
        message: 'Every question objective must belong to the attempt.',
      });
  });

const savePracticeAnswerInputSchema = z.strictObject({
  attemptId: idSchema,
  questionId: idSchema,
  expectedRevision: revisionSchema,
  value: jsonValueSchema,
  requestId: requestIdSchema,
});

const submitPracticeAttemptInputSchema = z.strictObject({
  attemptId: idSchema,
  expectedRevision: revisionSchema,
  requestId: requestIdSchema,
});

const switchPracticeToGuidedInputSchema = z.strictObject({
  attemptId: idSchema,
  expectedRevision: revisionSchema,
  requestId: requestIdSchema,
});

const retryPracticeAttemptInputSchema = z.strictObject({
  attemptId: idSchema,
  requestId: requestIdSchema,
});

const savePracticeEvaluationsInputSchema = z.strictObject({
  attemptId: idSchema,
  final: z.boolean(),
  evaluations: z
    .array(
      z.strictObject({
        questionId: idSchema,
        answerRevision: revisionSchema,
        evaluation: practiceEvaluationSchema,
      }),
    )
    .min(1)
    .max(20),
});

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
};

export class PracticeStoreError extends Error {
  constructor(readonly code: PracticeStoreErrorCode) {
    super('The practice attempt could not be saved.');
    this.name = 'PracticeStoreError';
  }
}

const matchAnswerKeys = (
  questions: PracticeQuestionDTO[],
  answerKeys: PracticeAnswerKey,
) => {
  if (
    questions.length !== answerKeys.length ||
    new Set(questions.map(({ id }) => id)).size !== questions.length
  )
    return null;
  const answerKeyMap = new Map(
    answerKeys.map((answerKey) => [answerKey.questionId, answerKey]),
  );
  for (const question of questions) {
    const answerKey = answerKeyMap.get(question.id);
    if (!answerKey || answerKey.kind !== question.kind) return null;
    if (
      answerKey.kind === 'multiple-choice' &&
      !question.options?.some(({ id }) => id === answerKey.correctOptionId)
    )
      return null;
    if (
      answerKey.kind === 'numeric' &&
      answerKey.acceptedValues.some(
        ({ value, tolerance }) =>
          tolerance > Math.max(1e-9, Math.abs(value) * 0.01),
      )
    )
      return null;
  }
  return answerKeyMap;
};

const parseAttemptInput = (input: unknown) => {
  const parsed = createPracticeAttemptInputSchema.safeParse(input);
  if (!parsed.success) throw new PracticeStoreError('invalid-input');
  const parsedAnswerKey = practiceAnswerKeySchema.safeParse(
    parsed.data.hostAnswerKey,
  );
  if (!parsedAnswerKey.success) throw new PracticeStoreError('invalid-input');
  if (!matchAnswerKeys(parsed.data.questions, parsedAnswerKey.data))
    throw new PracticeStoreError('invalid-input');
  if (
    parsed.data.artifactId === null &&
    parsed.data.versionId !== parsed.data.rubricVersion
  )
    throw new PracticeStoreError('invalid-input');
  const keyBytes = Buffer.byteLength(
    JSON.stringify(parsed.data.hostAnswerKey),
    'utf8',
  );
  if (keyBytes > 64 * 1024) throw new PracticeStoreError('invalid-input');
  return { ...parsed.data, hostAnswerKey: parsedAnswerKey.data };
};

const toPracticeSnapshot = (
  attempt: typeof PracticeAttemptTable.$inferSelect,
  answerRows: (typeof PracticeAnswerTable.$inferSelect)[],
): PracticeSnapshot | null => {
  const parsedQuestions = z
    .array(practiceQuestionSchema)
    .max(20)
    .safeParse(attempt.questionSet);
  if (!parsedQuestions.success) return null;
  const parsedAnswerKeys = practiceAnswerKeySchema.safeParse(
    attempt.hostAnswerKey,
  );
  if (!parsedAnswerKeys.success) return null;
  const answerKeyMap = matchAnswerKeys(
    parsedQuestions.data,
    parsedAnswerKeys.data,
  );
  if (!answerKeyMap) return null;
  const questionIds = new Set(parsedQuestions.data.map(({ id }) => id));
  const latestByQuestion = new Map<string, (typeof answerRows)[number]>();
  for (const answerRow of answerRows) {
    if (!questionIds.has(answerRow.questionId)) return null;
    const existing = latestByQuestion.get(answerRow.questionId);
    if (!existing || answerRow.revision > existing.revision)
      latestByQuestion.set(answerRow.questionId, answerRow);
  }

  const answers = parsedQuestions.data.flatMap((question) => {
    const answerRow = latestByQuestion.get(question.id);
    if (!answerRow) return [];
    const value = jsonValueSchema.safeParse(answerRow.answer);
    if (!value.success || !instantSchema.safeParse(answerRow.createdAt).success)
      return [];
    return [
      {
        questionId: answerRow.questionId,
        revision: answerRow.revision,
        value: value.data,
        savedAt: answerRow.createdAt,
      },
    ];
  });
  if (answers.length !== latestByQuestion.size) return null;

  const canRevealFeedback =
    attempt.status === 'evaluated' ||
    (attempt.mode === 'quiz' && attempt.feedbackMode === 'per-answer');
  const feedback = canRevealFeedback
    ? parsedQuestions.data.flatMap((question) => {
        const answerRow = latestByQuestion.get(question.id);
        const answerKey = answerKeyMap.get(question.id);
        if (!answerRow?.evaluation || !answerKey) return [];
        const evaluation = validatePracticeEvaluation(
          {
            question,
            answerKey: [answerKey] as unknown as JsonValue,
            rubricVersion: attempt.rubricVersion,
            assisted: answerRow.assisted,
          },
          answerRow.evaluation,
        );
        if (!evaluation) return [];
        return [evaluation];
      })
    : [];
  if (
    attempt.status === 'evaluated' &&
    feedback.length !== parsedQuestions.data.length
  )
    return null;

  const snapshot = practiceSnapshotSchema.safeParse({
    id: attempt.id,
    courseId: attempt.courseId,
    sessionId: attempt.sessionId,
    mode: attempt.mode,
    feedbackMode: attempt.feedbackMode,
    status: attempt.status,
    revision: attempt.revision,
    assisted: attempt.assisted,
    priorAttemptId: attempt.priorAttemptId,
    questions: parsedQuestions.data,
    answers,
    feedback,
  });
  return snapshot.success ? snapshot.data : null;
};

export const createPracticeStore = ({
  db,
  now = () => new Date().toISOString(),
  createId = randomUUID,
}: PracticeStoreDependencies) => {
  const readAttempt = (userId: string, attemptId: string) => {
    try {
      const attempt = db
        .select()
        .from(PracticeAttemptTable)
        .where(
          and(
            eq(PracticeAttemptTable.userId, userId),
            eq(PracticeAttemptTable.id, attemptId),
          ),
        )
        .get();
      if (!attempt) return null;
      const answerRows = db
        .select()
        .from(PracticeAnswerTable)
        .where(
          and(
            eq(PracticeAnswerTable.userId, userId),
            eq(PracticeAnswerTable.attemptId, attemptId),
          ),
        )
        .orderBy(
          PracticeAnswerTable.questionId,
          desc(PracticeAnswerTable.revision),
        )
        .all();
      return toPracticeSnapshot(attempt, answerRows);
    } catch {
      return null;
    }
  };

  const createPracticeAttempt = (userId: string, input: unknown) => {
    const parsed = parseAttemptInput(input);
    if (!idSchema.safeParse(userId).success)
      throw new PracticeStoreError('invalid-input');
    const createdAt = now();
    if (!instantSchema.safeParse(createdAt).success)
      throw new PracticeStoreError('storage-failed');

    try {
      const attemptId = db.transaction((tx) => {
        const duplicate = tx
          .select()
          .from(PracticeAttemptTable)
          .where(eq(PracticeAttemptTable.id, parsed.requestId))
          .get();
        if (duplicate) {
          if (duplicate.userId !== userId)
            throw new PracticeStoreError('not-found');
          if (
            duplicate.courseId !== parsed.courseId ||
            duplicate.sessionId !== parsed.sessionId ||
            duplicate.artifactId !== parsed.artifactId ||
            duplicate.versionId !== parsed.versionId ||
            duplicate.mode !== parsed.mode ||
            duplicate.feedbackMode !== parsed.feedbackMode ||
            duplicate.assisted !==
              (parsed.initialAssisted ?? parsed.mode === 'guided') ||
            duplicate.rubricVersion !== parsed.rubricVersion ||
            stableJson(duplicate.objectiveIds) !==
              stableJson(parsed.objectiveIds) ||
            stableJson(duplicate.questionSet) !==
              stableJson(parsed.questions) ||
            stableJson(duplicate.hostAnswerKey) !==
              stableJson(parsed.hostAnswerKey) ||
            duplicate.priorAttemptId !== (parsed.priorAttemptId ?? null)
          )
            throw new PracticeStoreError('revision-conflict');
          return duplicate.id;
        }

        const course = tx
          .select({ id: CourseTable.id })
          .from(CourseTable)
          .where(
            and(
              eq(CourseTable.userId, userId),
              eq(CourseTable.id, parsed.courseId),
            ),
          )
          .get();
        if (!course) throw new PracticeStoreError('not-found');

        if (parsed.sessionId) {
          const session = tx
            .select({ id: StudySessionTable.id })
            .from(StudySessionTable)
            .where(
              and(
                eq(StudySessionTable.id, parsed.sessionId),
                eq(StudySessionTable.userId, userId),
                eq(StudySessionTable.courseId, parsed.courseId),
                isNull(StudySessionTable.deletedAt),
              ),
            )
            .get();
          if (!session) throw new PracticeStoreError('scope-denied');
        }

        if (parsed.artifactId) {
          const artifact = tx
            .select()
            .from(ArtifactTable)
            .where(
              and(
                eq(ArtifactTable.id, parsed.artifactId),
                eq(ArtifactTable.userId, userId),
                isNull(ArtifactTable.removedAt),
              ),
            )
            .get();
          if (
            !artifact ||
            (artifact.courseId !== null &&
              artifact.courseId !== parsed.courseId) ||
            (artifact.courseId === null &&
              artifact.originatingSessionId !== parsed.sessionId)
          )
            throw new PracticeStoreError('scope-denied');
          const version = tx
            .select({ id: ArtifactVersionTable.id })
            .from(ArtifactVersionTable)
            .where(
              and(
                eq(ArtifactVersionTable.id, parsed.versionId),
                eq(ArtifactVersionTable.artifactId, parsed.artifactId),
                eq(ArtifactVersionTable.userId, userId),
              ),
            )
            .get();
          if (!version) throw new PracticeStoreError('scope-denied');
        }

        if (parsed.priorAttemptId) {
          const priorAttempt = tx
            .select()
            .from(PracticeAttemptTable)
            .where(
              and(
                eq(PracticeAttemptTable.id, parsed.priorAttemptId),
                eq(PracticeAttemptTable.userId, userId),
                eq(PracticeAttemptTable.courseId, parsed.courseId),
              ),
            )
            .get();
          if (!priorAttempt) throw new PracticeStoreError('scope-denied');
        }

        tx.insert(PracticeAttemptTable)
          .values({
            id: parsed.requestId,
            userId,
            courseId: parsed.courseId,
            sessionId: parsed.sessionId,
            artifactId: parsed.artifactId,
            versionId: parsed.versionId,
            objectiveIds: parsed.objectiveIds,
            mode: parsed.mode,
            feedbackMode: parsed.feedbackMode,
            status: 'in-progress',
            assisted: parsed.initialAssisted ?? parsed.mode === 'guided',
            priorAttemptId: parsed.priorAttemptId ?? null,
            rubricVersion: parsed.rubricVersion,
            questionSet: parsed.questions,
            hostAnswerKey: parsed.hostAnswerKey,
            revision: 0,
            startedAt: createdAt,
            submittedAt: null,
          })
          .run();
        return parsed.requestId;
      });
      const snapshot = readAttempt(userId, attemptId);
      if (!snapshot) throw new PracticeStoreError('storage-failed');
      return snapshot;
    } catch (error) {
      if (error instanceof PracticeStoreError) throw error;
      throw new PracticeStoreError('storage-failed');
    }
  };

  const getPracticeAttempt = (
    userId: string,
    input: { attemptId: string },
  ): PracticeSnapshot | null => {
    const parsed = z.strictObject({ attemptId: idSchema }).safeParse(input);
    if (!parsed.success || !idSchema.safeParse(userId).success) return null;
    return readAttempt(userId, parsed.data.attemptId);
  };

  const getEvaluationWork = (userId: string, attemptId: string) => {
    if (
      !idSchema.safeParse(userId).success ||
      !idSchema.safeParse(attemptId).success
    )
      return null;
    try {
      const attempt = db
        .select()
        .from(PracticeAttemptTable)
        .where(
          and(
            eq(PracticeAttemptTable.userId, userId),
            eq(PracticeAttemptTable.id, attemptId),
          ),
        )
        .get();
      if (!attempt) return null;
      const questions = z
        .array(practiceQuestionSchema)
        .safeParse(attempt.questionSet);
      const answerKeys = practiceAnswerKeySchema.safeParse(
        attempt.hostAnswerKey,
      );
      if (!questions.success || !answerKeys.success) return null;
      if (!matchAnswerKeys(questions.data, answerKeys.data)) return null;
      const answerRows = db
        .select()
        .from(PracticeAnswerTable)
        .where(
          and(
            eq(PracticeAnswerTable.userId, userId),
            eq(PracticeAnswerTable.attemptId, attemptId),
          ),
        )
        .orderBy(
          PracticeAnswerTable.questionId,
          desc(PracticeAnswerTable.revision),
        )
        .all();
      const latestAnswers = new Map<string, (typeof answerRows)[number]>();
      for (const answerRow of answerRows) {
        const existing = latestAnswers.get(answerRow.questionId);
        if (!existing || answerRow.revision > existing.revision)
          latestAnswers.set(answerRow.questionId, answerRow);
      }
      return {
        attempt: {
          id: attempt.id,
          courseId: attempt.courseId,
          sessionId: attempt.sessionId,
          mode: attempt.mode,
          feedbackMode: attempt.feedbackMode,
          status: attempt.status,
          revision: attempt.revision,
          assisted: attempt.assisted,
          priorAttemptId: attempt.priorAttemptId,
          rubricVersion: attempt.rubricVersion,
        },
        questions: questions.data,
        answerKeys: answerKeys.data,
        answers: latestAnswers,
      };
    } catch {
      return null;
    }
  };

  const savePracticeAnswer = (userId: string, input: unknown) => {
    const parsed = savePracticeAnswerInputSchema.safeParse(input);
    if (!parsed.success || !idSchema.safeParse(userId).success)
      throw new PracticeStoreError('invalid-input');
    const answerValue = parsed.data.value === null ? '' : parsed.data.value;
    if (Buffer.byteLength(JSON.stringify(answerValue), 'utf8') > 8192)
      throw new PracticeStoreError('invalid-input');
    const createdAt = now();
    if (!instantSchema.safeParse(createdAt).success)
      throw new PracticeStoreError('storage-failed');

    try {
      const attemptId = db.transaction((tx) => {
        const existingAnswer = tx
          .select()
          .from(PracticeAnswerTable)
          .where(eq(PracticeAnswerTable.id, parsed.data.requestId))
          .get();
        if (existingAnswer) {
          if (
            existingAnswer.userId !== userId ||
            existingAnswer.attemptId !== parsed.data.attemptId ||
            existingAnswer.questionId !== parsed.data.questionId ||
            stableJson(existingAnswer.answer) !== stableJson(answerValue)
          )
            throw new PracticeStoreError('revision-conflict');
          return existingAnswer.attemptId;
        }

        const attempt = tx
          .select()
          .from(PracticeAttemptTable)
          .where(
            and(
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.id, parsed.data.attemptId),
            ),
          )
          .get();
        if (!attempt) throw new PracticeStoreError('not-found');
        if (attempt.status !== 'in-progress')
          throw new PracticeStoreError('revision-conflict');
        if (attempt.revision !== parsed.data.expectedRevision)
          throw new PracticeStoreError('revision-conflict');
        const questions = z
          .array(practiceQuestionSchema)
          .safeParse(attempt.questionSet);
        if (
          !questions.success ||
          !questions.data.some(({ id }) => id === parsed.data.questionId)
        )
          throw new PracticeStoreError('invalid-input');

        const previousAnswer = tx
          .select({ revision: PracticeAnswerTable.revision })
          .from(PracticeAnswerTable)
          .where(
            and(
              eq(PracticeAnswerTable.userId, userId),
              eq(PracticeAnswerTable.attemptId, attempt.id),
              eq(PracticeAnswerTable.questionId, parsed.data.questionId),
            ),
          )
          .orderBy(desc(PracticeAnswerTable.revision))
          .get();
        const answerRevision = (previousAnswer?.revision ?? -1) + 1;
        tx.insert(PracticeAnswerTable)
          .values({
            id: parsed.data.requestId,
            userId,
            attemptId: attempt.id,
            questionId: parsed.data.questionId,
            revision: answerRevision,
            answer: answerValue,
            assisted: attempt.assisted,
            evaluation: null,
            createdAt,
          })
          .run();
        const updatedAttempt = tx
          .update(PracticeAttemptTable)
          .set({ revision: attempt.revision + 1 })
          .where(
            and(
              eq(PracticeAttemptTable.id, attempt.id),
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.revision, parsed.data.expectedRevision),
              eq(PracticeAttemptTable.status, 'in-progress'),
            ),
          )
          .run();
        if (updatedAttempt.changes !== 1)
          throw new PracticeStoreError('revision-conflict');
        return attempt.id;
      });
      const snapshot = readAttempt(userId, attemptId);
      if (!snapshot) throw new PracticeStoreError('storage-failed');
      return snapshot;
    } catch (error) {
      if (error instanceof PracticeStoreError) throw error;
      throw new PracticeStoreError('storage-failed');
    }
  };

  const submitPracticeAttempt = (userId: string, input: unknown) => {
    const parsed = submitPracticeAttemptInputSchema.safeParse(input);
    if (!parsed.success || !idSchema.safeParse(userId).success)
      throw new PracticeStoreError('invalid-input');
    const submittedAt = now();
    if (!instantSchema.safeParse(submittedAt).success)
      throw new PracticeStoreError('storage-failed');

    try {
      const attemptId = db.transaction((tx) => {
        const attempt = tx
          .select()
          .from(PracticeAttemptTable)
          .where(
            and(
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.id, parsed.data.attemptId),
            ),
          )
          .get();
        if (!attempt) throw new PracticeStoreError('not-found');
        if (attempt.status === 'submitted' || attempt.status === 'evaluated')
          return attempt.id;
        if (
          attempt.status !== 'in-progress' ||
          attempt.revision !== parsed.data.expectedRevision
        )
          throw new PracticeStoreError('revision-conflict');
        const questions = z
          .array(practiceQuestionSchema)
          .safeParse(attempt.questionSet);
        if (!questions.success) throw new PracticeStoreError('storage-failed');
        for (const question of questions.data) {
          const answer = tx
            .select({ id: PracticeAnswerTable.id })
            .from(PracticeAnswerTable)
            .where(
              and(
                eq(PracticeAnswerTable.userId, userId),
                eq(PracticeAnswerTable.attemptId, attempt.id),
                eq(PracticeAnswerTable.questionId, question.id),
              ),
            )
            .orderBy(desc(PracticeAnswerTable.revision))
            .get();
          if (!answer) {
            tx.insert(PracticeAnswerTable)
              .values({
                id: createId(),
                userId,
                attemptId: attempt.id,
                questionId: question.id,
                revision: 0,
                answer: '',
                assisted: attempt.assisted,
                evaluation: null,
                createdAt: submittedAt,
              })
              .run();
          }
        }
        const updatedAttempt = tx
          .update(PracticeAttemptTable)
          .set({
            status: 'submitted',
            submittedAt,
            revision: attempt.revision + 1,
          })
          .where(
            and(
              eq(PracticeAttemptTable.id, attempt.id),
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.revision, parsed.data.expectedRevision),
              eq(PracticeAttemptTable.status, 'in-progress'),
            ),
          )
          .run();
        if (updatedAttempt.changes !== 1)
          throw new PracticeStoreError('revision-conflict');
        return attempt.id;
      });
      const snapshot = readAttempt(userId, attemptId);
      if (!snapshot) throw new PracticeStoreError('storage-failed');
      return snapshot;
    } catch (error) {
      if (error instanceof PracticeStoreError) throw error;
      throw new PracticeStoreError('storage-failed');
    }
  };

  const switchPracticeToGuided = (userId: string, input: unknown) => {
    const parsed = switchPracticeToGuidedInputSchema.safeParse(input);
    if (!parsed.success || !idSchema.safeParse(userId).success)
      throw new PracticeStoreError('invalid-input');

    try {
      const attemptId = db.transaction((tx) => {
        const attempt = tx
          .select()
          .from(PracticeAttemptTable)
          .where(
            and(
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.id, parsed.data.attemptId),
            ),
          )
          .get();
        if (!attempt) throw new PracticeStoreError('not-found');
        if (attempt.mode === 'guided') return attempt.id;
        if (
          attempt.status !== 'in-progress' ||
          attempt.revision !== parsed.data.expectedRevision
        )
          throw new PracticeStoreError('revision-conflict');
        const updatedAttempt = tx
          .update(PracticeAttemptTable)
          .set({
            mode: 'guided',
            assisted: true,
            revision: attempt.revision + 1,
          })
          .where(
            and(
              eq(PracticeAttemptTable.id, attempt.id),
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.revision, parsed.data.expectedRevision),
              eq(PracticeAttemptTable.status, 'in-progress'),
            ),
          )
          .run();
        if (updatedAttempt.changes !== 1)
          throw new PracticeStoreError('revision-conflict');
        return attempt.id;
      });
      const snapshot = readAttempt(userId, attemptId);
      if (!snapshot) throw new PracticeStoreError('storage-failed');
      return snapshot;
    } catch (error) {
      if (error instanceof PracticeStoreError) throw error;
      throw new PracticeStoreError('storage-failed');
    }
  };

  const savePracticeEvaluations = (userId: string, input: unknown) => {
    const parsed = savePracticeEvaluationsInputSchema.safeParse(input);
    if (!parsed.success || !idSchema.safeParse(userId).success)
      throw new PracticeStoreError('invalid-input');
    if (
      new Set(parsed.data.evaluations.map(({ questionId }) => questionId))
        .size !== parsed.data.evaluations.length
    )
      throw new PracticeStoreError('invalid-input');

    try {
      const attemptId = db.transaction((tx) => {
        const attempt = tx
          .select()
          .from(PracticeAttemptTable)
          .where(
            and(
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.id, parsed.data.attemptId),
            ),
          )
          .get();
        if (!attempt) throw new PracticeStoreError('not-found');
        if (parsed.data.final && attempt.status === 'evaluated') {
          const questions = z
            .array(practiceQuestionSchema)
            .safeParse(attempt.questionSet);
          const answerKeys = practiceAnswerKeySchema.safeParse(
            attempt.hostAnswerKey,
          );
          if (
            !questions.success ||
            !answerKeys.success ||
            !matchAnswerKeys(questions.data, answerKeys.data)
          )
            throw new PracticeStoreError('storage-failed');
          if (parsed.data.evaluations.length !== questions.data.length)
            throw new PracticeStoreError('invalid-input');
          const existingRows = tx
            .select()
            .from(PracticeAnswerTable)
            .where(
              and(
                eq(PracticeAnswerTable.userId, userId),
                eq(PracticeAnswerTable.attemptId, attempt.id),
              ),
            )
            .all();
          const matching = parsed.data.evaluations.every((item) => {
            const question = questions.data.find(
              ({ id }) => id === item.questionId,
            );
            const answerKey = answerKeys.data.find(
              (candidate) => candidate.questionId === item.questionId,
            );
            const answer = existingRows.find(
              (row) =>
                row.questionId === item.questionId &&
                row.revision === item.answerRevision,
            );
            return Boolean(
              question &&
              answerKey &&
              answer &&
              !existingRows.some(
                (row) =>
                  row.questionId === item.questionId &&
                  row.revision > item.answerRevision,
              ) &&
              stableJson(answer.evaluation) === stableJson(item.evaluation) &&
              validatePracticeEvaluation(
                {
                  question,
                  answerKey: answerKeys.data as unknown as JsonValue,
                  rubricVersion: attempt.rubricVersion,
                  assisted: answer.assisted,
                },
                item.evaluation,
              ),
            );
          });
          if (!matching) throw new PracticeStoreError('revision-conflict');
          return attempt.id;
        }
        if (
          (parsed.data.final && attempt.status !== 'submitted') ||
          (!parsed.data.final &&
            (attempt.status !== 'in-progress' ||
              attempt.mode !== 'quiz' ||
              attempt.feedbackMode !== 'per-answer'))
        )
          throw new PracticeStoreError('revision-conflict');
        const questions = z
          .array(practiceQuestionSchema)
          .safeParse(attempt.questionSet);
        const answerKeys = practiceAnswerKeySchema.safeParse(
          attempt.hostAnswerKey,
        );
        if (!questions.success || !answerKeys.success)
          throw new PracticeStoreError('storage-failed');
        if (!matchAnswerKeys(questions.data, answerKeys.data))
          throw new PracticeStoreError('storage-failed');
        if (
          parsed.data.final &&
          parsed.data.evaluations.length !== questions.data.length
        )
          throw new PracticeStoreError('invalid-input');

        for (const item of parsed.data.evaluations) {
          const question = questions.data.find(
            ({ id }) => id === item.questionId,
          );
          const answerKey = answerKeys.data.find(
            (candidate) => candidate.questionId === item.questionId,
          );
          const answer = tx
            .select()
            .from(PracticeAnswerTable)
            .where(
              and(
                eq(PracticeAnswerTable.userId, userId),
                eq(PracticeAnswerTable.attemptId, attempt.id),
                eq(PracticeAnswerTable.questionId, item.questionId),
                eq(PracticeAnswerTable.revision, item.answerRevision),
              ),
            )
            .get();
          if (!question || !answerKey || !answer)
            throw new PracticeStoreError('revision-conflict');
          if (
            !validatePracticeEvaluation(
              {
                question,
                answerKey: answerKeys.data as unknown as JsonValue,
                rubricVersion: attempt.rubricVersion,
                assisted: answer.assisted,
              },
              item.evaluation,
            )
          )
            throw new PracticeStoreError('invalid-input');
          if (
            answer.evaluation &&
            stableJson(answer.evaluation) !== stableJson(item.evaluation)
          )
            throw new PracticeStoreError('revision-conflict');
          tx.update(PracticeAnswerTable)
            .set({ evaluation: item.evaluation })
            .where(
              and(
                eq(PracticeAnswerTable.id, answer.id),
                eq(PracticeAnswerTable.userId, userId),
                eq(PracticeAnswerTable.attemptId, attempt.id),
                eq(PracticeAnswerTable.revision, item.answerRevision),
              ),
            )
            .run();
        }
        if (parsed.data.final) {
          const updatedAttempt = tx
            .update(PracticeAttemptTable)
            .set({ status: 'evaluated', revision: attempt.revision + 1 })
            .where(
              and(
                eq(PracticeAttemptTable.id, attempt.id),
                eq(PracticeAttemptTable.userId, userId),
                eq(PracticeAttemptTable.status, 'submitted'),
              ),
            )
            .run();
          if (updatedAttempt.changes !== 1)
            throw new PracticeStoreError('revision-conflict');
        } else {
          tx.update(PracticeAttemptTable)
            .set({ revision: attempt.revision + 1 })
            .where(
              and(
                eq(PracticeAttemptTable.id, attempt.id),
                eq(PracticeAttemptTable.userId, userId),
                eq(PracticeAttemptTable.status, 'in-progress'),
                eq(PracticeAttemptTable.mode, 'quiz'),
                eq(PracticeAttemptTable.feedbackMode, 'per-answer'),
              ),
            )
            .run();
        }
        return attempt.id;
      });
      const snapshot = readAttempt(userId, attemptId);
      if (!snapshot) throw new PracticeStoreError('storage-failed');
      return snapshot;
    } catch (error) {
      if (error instanceof PracticeStoreError) throw error;
      throw new PracticeStoreError('storage-failed');
    }
  };

  const retryPracticeAttempt = (userId: string, input: unknown) => {
    const parsed = retryPracticeAttemptInputSchema.safeParse(input);
    if (!parsed.success || !idSchema.safeParse(userId).success)
      throw new PracticeStoreError('invalid-input');
    const priorAttempt = db
      .select()
      .from(PracticeAttemptTable)
      .where(
        and(
          eq(PracticeAttemptTable.userId, userId),
          eq(PracticeAttemptTable.id, parsed.data.attemptId),
        ),
      )
      .get();
    if (!priorAttempt) throw new PracticeStoreError('not-found');
    if (priorAttempt.status === 'in-progress')
      throw new PracticeStoreError('revision-conflict');
    const questions = z
      .array(practiceQuestionSchema)
      .safeParse(priorAttempt.questionSet);
    const answerKeys = practiceAnswerKeySchema.safeParse(
      priorAttempt.hostAnswerKey,
    );
    if (!questions.success || !answerKeys.success)
      throw new PracticeStoreError('storage-failed');
    return createPracticeAttempt(userId, {
      requestId: parsed.data.requestId,
      courseId: priorAttempt.courseId,
      sessionId: priorAttempt.sessionId,
      artifactId: priorAttempt.artifactId,
      versionId: priorAttempt.versionId,
      objectiveIds: priorAttempt.objectiveIds,
      mode: priorAttempt.mode,
      feedbackMode:
        priorAttempt.mode === 'guided' ? 'end' : priorAttempt.feedbackMode,
      rubricVersion: priorAttempt.rubricVersion,
      questions: questions.data,
      hostAnswerKey: answerKeys.data,
      priorAttemptId: priorAttempt.id,
      initialAssisted: priorAttempt.assisted,
    });
  };

  const deletePracticeAttemptsForSession = (
    userId: string,
    sessionId: string,
  ) => {
    if (
      !idSchema.safeParse(userId).success ||
      !idSchema.safeParse(sessionId).success
    )
      throw new PracticeStoreError('invalid-input');
    try {
      return db.transaction((tx) => {
        const attempts = tx
          .select({ id: PracticeAttemptTable.id })
          .from(PracticeAttemptTable)
          .where(
            and(
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.sessionId, sessionId),
            ),
          )
          .all();
        for (let offset = 0; offset < attempts.length; offset += 500) {
          const attemptIds = attempts
            .slice(offset, offset + 500)
            .map(({ id }) => id);
          tx.delete(PracticeAnswerTable)
            .where(
              and(
                eq(PracticeAnswerTable.userId, userId),
                inArray(PracticeAnswerTable.attemptId, attemptIds),
              ),
            )
            .run();
        }
        tx.delete(PracticeAttemptTable)
          .where(
            and(
              eq(PracticeAttemptTable.userId, userId),
              eq(PracticeAttemptTable.sessionId, sessionId),
            ),
          )
          .run();
        return attempts.length;
      });
    } catch (error) {
      if (error instanceof PracticeStoreError) throw error;
      throw new PracticeStoreError('storage-failed');
    }
  };

  return {
    createPracticeAttempt,
    deletePracticeAttemptsForSession,
    getEvaluationWork,
    getPracticeAttempt,
    retryPracticeAttempt,
    savePracticeAnswer,
    savePracticeEvaluations,
    submitPracticeAttempt,
    switchPracticeToGuided,
  };
};

export type PracticeStore = ReturnType<typeof createPracticeStore>;
