import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  practiceFeedbackModes,
  practiceModes,
  practiceQuestionSchema,
  type PracticeEvaluationDTO,
  type PracticeQuestionDTO,
  type PracticeSnapshot,
} from '@scholaros/services/learning/practice-contracts';
import {
  idSchema,
  jsonValueSchema,
  requestIdSchema,
  type AuthorizedContext,
  type AuthorizedRegistrar,
  type ActionCleanup,
  type JsonValue,
  type ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import { PracticeStoreError, type PracticeStore } from './practice-store';
import { validatePracticeEvaluation } from './practice-evaluation';
import {
  createStudySessionEvent,
  registerStudySessionOperation,
} from '../../study/services/session-events';

export const practiceAttemptCreationInputSchema = z
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
  })
  .superRefine((input, context) => {
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
        message: 'Per-answer feedback is unavailable for practice exams.',
      });
  });
export type PracticeAttemptCreationInputSchema = z.infer<
  typeof practiceAttemptCreationInputSchema
>;

export type PracticeAttemptCreationInput = z.infer<
  typeof practiceAttemptCreationInputSchema
>;

export type PracticeCandidateForAssessment = {
  courseId: string;
  sessionId: string | null;
  rubricVersion: string;
  mode: (typeof practiceModes)[number];
  questions: PracticeQuestionDTO[];
  hostAnswerKey: JsonValue;
};

export type PracticeEvaluationRequest = {
  requestId: string;
  attemptId: string;
  courseId: string;
  sessionId: string | null;
  mode: (typeof practiceModes)[number];
  question: PracticeQuestionDTO;
  answer: JsonValue;
  answerKey: JsonValue;
  rubricVersion: string;
  assisted: boolean;
};

export type PracticeActionDependencies = {
  store: PracticeStore;
  regenerateRetry?: (
    context: AuthorizedContext,
    input: { priorAttemptId: string; requestId: string },
    signal: AbortSignal,
  ) => Promise<PracticeAttemptCreationInput>;
  assessCandidate: (
    context: AuthorizedContext,
    candidate: PracticeCandidateForAssessment,
    signal: AbortSignal,
  ) => Promise<{ allowed: boolean }>;
  canPublishFeedback: (
    context: AuthorizedContext,
    input: {
      attemptId: string;
      courseId: string;
      sessionId: string | null;
      sourceReferences: PracticeQuestionDTO['sourceReferences'];
    },
  ) => Promise<boolean>;
  evaluateAnswer: (
    context: AuthorizedContext,
    input: PracticeEvaluationRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  publish: (event: ProductEventV1) => void;
};

export class PracticeActionError extends Error {
  constructor(
    readonly code:
      | 'invalid-input'
      | 'not-found'
      | 'scope-denied'
      | 'session-changed'
      | 'permission-revoked'
      | 'revision-conflict'
      | 'cancelled'
      | 'provider-failed'
      | 'storage-failed',
  ) {
    super('The practice action could not be completed.');
    this.name = 'PracticeActionError';
  }
}

const assertCurrent = (context: AuthorizedContext) => {
  if (context.signal.aborted) throw new PracticeActionError('cancelled');
  if (!context.isCurrent()) throw new PracticeActionError('session-changed');
};

const storeError = (error: unknown): never => {
  if (error instanceof PracticeStoreError)
    throw new PracticeActionError(error.code);
  throw new PracticeActionError('storage-failed');
};

const parseAttemptInput = (input: unknown) => {
  const parsed = practiceAttemptCreationInputSchema.safeParse(input);
  if (!parsed.success) throw new PracticeActionError('invalid-input');
  return parsed.data;
};

const candidateForAssessment = (
  input: PracticeAttemptCreationInput,
): PracticeCandidateForAssessment => ({
  courseId: input.courseId,
  sessionId: input.sessionId,
  rubricVersion: input.rubricVersion,
  mode: input.mode,
  questions: input.questions,
  hostAnswerKey: input.hostAnswerKey,
});

const assessPracticeCandidate = async (
  context: AuthorizedContext,
  candidate: PracticeCandidateForAssessment,
  dependencies: Pick<PracticeActionDependencies, 'assessCandidate'>,
) => {
  assertCurrent(context);
  let assessment: { allowed: boolean };
  try {
    assessment = await dependencies.assessCandidate(
      context,
      candidate,
      context.signal,
    );
  } catch {
    if (context.signal.aborted) throw new PracticeActionError('cancelled');
    throw new PracticeActionError('scope-denied');
  }
  assertCurrent(context);
  if (!assessment.allowed) throw new PracticeActionError('scope-denied');
};

export const createPracticeAttempt = async (
  context: AuthorizedContext,
  input: PracticeAttemptCreationInput,
  dependencies: Pick<PracticeActionDependencies, 'store' | 'assessCandidate'>,
): Promise<PracticeSnapshot> => {
  const parsed = parseAttemptInput(input);
  await assessPracticeCandidate(
    context,
    candidateForAssessment(parsed),
    dependencies,
  );
  assertCurrent(context);
  try {
    return dependencies.store.createPracticeAttempt(context.userId, parsed);
  } catch (error) {
    return storeError(error);
  }
};

const evaluationRequestId = (
  attemptId: string,
  questionId: string,
  answerRevision: number,
  rubricVersion: string,
) => {
  const bytes = createHash('sha1')
    .update(`${attemptId}\0${questionId}\0${answerRevision}\0${rubricVersion}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const practiceEvent = (
  context: AuthorizedContext,
  snapshot: PracticeSnapshot,
  outcome?: ProductEventV1['outcome'],
  operationId?: string,
): ProductEventV1 => ({
  version: 1,
  accountId: context.userId,
  revision: snapshot.revision,
  resource: 'study',
  targetId: snapshot.id,
  ...(outcome ? { outcome } : {}),
  ...(operationId ? { operationId } : {}),
});

const publishAfterCommit = (
  publish: PracticeActionDependencies['publish'],
  event: ProductEventV1,
) => {
  try {
    publish(event);
  } catch {
    // Reconnect reloads snapshots, so a failed invalidation never rolls back evidence.
  }
};

const workQuestions = (
  work: NonNullable<ReturnType<PracticeStore['getEvaluationWork']>>,
) => {
  const questionKeys = new Map(
    work.answerKeys.map((answerKey) => [answerKey.questionId, answerKey]),
  );
  return work.questions.map((question) => ({
    question,
    answerKey: questionKeys.get(question.id),
    answer: work.answers.get(question.id),
  }));
};

const candidateForWork = (
  work: NonNullable<ReturnType<PracticeStore['getEvaluationWork']>>,
): PracticeCandidateForAssessment => ({
  courseId: work.attempt.courseId,
  sessionId: work.attempt.sessionId,
  rubricVersion: work.attempt.rubricVersion,
  mode: work.attempt.mode,
  questions: work.questions,
  hostAnswerKey: jsonValueSchema.parse(work.answerKeys),
});

const requireCurrentFeedbackPermission = async (
  context: AuthorizedContext,
  work: NonNullable<ReturnType<PracticeStore['getEvaluationWork']>>,
  dependencies: Pick<PracticeActionDependencies, 'canPublishFeedback'>,
) => {
  assertCurrent(context);
  let allowed: boolean;
  try {
    allowed = await dependencies.canPublishFeedback(context, {
      attemptId: work.attempt.id,
      courseId: work.attempt.courseId,
      sessionId: work.attempt.sessionId,
      sourceReferences: work.questions.flatMap(
        ({ sourceReferences }) => sourceReferences,
      ),
    });
  } catch {
    if (context.signal.aborted) throw new PracticeActionError('cancelled');
    throw new PracticeActionError('permission-revoked');
  }
  assertCurrent(context);
  if (!allowed) throw new PracticeActionError('permission-revoked');
};

const evaluateAnswer = async (
  context: AuthorizedContext,
  work: NonNullable<ReturnType<PracticeStore['getEvaluationWork']>>,
  question: PracticeQuestionDTO,
  answerKey: NonNullable<ReturnType<typeof workQuestions>[number]['answerKey']>,
  answerRow: NonNullable<ReturnType<typeof workQuestions>[number]['answer']>,
  dependencies: Pick<
    PracticeActionDependencies,
    'canPublishFeedback' | 'evaluateAnswer' | 'store' | 'publish'
  >,
): Promise<PracticeEvaluationDTO> => {
  await requireCurrentFeedbackPermission(context, work, dependencies);
  let providerResult: unknown;
  try {
    providerResult = await dependencies.evaluateAnswer(
      context,
      {
        requestId: evaluationRequestId(
          work.attempt.id,
          question.id,
          answerRow.revision,
          work.attempt.rubricVersion,
        ),
        attemptId: work.attempt.id,
        courseId: work.attempt.courseId,
        sessionId: work.attempt.sessionId,
        mode: work.attempt.mode,
        question,
        answer: answerRow.answer,
        answerKey: jsonValueSchema.parse(answerKey),
        rubricVersion: work.attempt.rubricVersion,
        assisted: answerRow.assisted,
      },
      context.signal,
    );
  } catch {
    if (context.signal.aborted) throw new PracticeActionError('cancelled');
    assertCurrent(context);
    const interrupted = dependencies.store.interruptPracticeEvaluation(
      context.userId,
      work.attempt.id,
    );
    if (interrupted)
      publishAfterCommit(
        dependencies.publish,
        practiceEvent(context, interrupted),
      );
    throw new PracticeActionError('provider-failed');
  }
  await requireCurrentFeedbackPermission(context, work, dependencies);
  const evaluation = validatePracticeEvaluation(
    {
      question,
      answerKey: jsonValueSchema.parse([answerKey]),
      rubricVersion: work.attempt.rubricVersion,
      assisted: answerRow.assisted,
    },
    providerResult,
  );
  if (!evaluation) {
    assertCurrent(context);
    const interrupted = dependencies.store.interruptPracticeEvaluation(
      context.userId,
      work.attempt.id,
    );
    if (interrupted)
      publishAfterCommit(
        dependencies.publish,
        practiceEvent(context, interrupted),
      );
    throw new PracticeActionError('provider-failed');
  }
  return evaluation;
};

export const createPracticeActions = (
  dependencies: PracticeActionDependencies,
) => {
  const getPracticeAttempt = async (
    context: AuthorizedContext,
    input: { attemptId: string },
  ): Promise<PracticeSnapshot> => {
    assertCurrent(context);
    const snapshot = dependencies.store.getPracticeAttempt(
      context.userId,
      input,
    );
    if (!snapshot) throw new PracticeActionError('not-found');
    assertCurrent(context);
    if (snapshot.feedback.length === 0) return snapshot;
    const work = dependencies.store.getEvaluationWork(
      context.userId,
      snapshot.id,
    );
    if (!work) throw new PracticeActionError('not-found');
    try {
      await assessPracticeCandidate(
        context,
        candidateForWork(work),
        dependencies,
      );
      await requireCurrentFeedbackPermission(context, work, dependencies);
      return snapshot;
    } catch (error) {
      if (
        error instanceof PracticeActionError &&
        (error.code === 'session-changed' || error.code === 'cancelled')
      )
        throw error;
      return { ...snapshot, feedback: [] };
    }
  };

  const savePracticeAnswer = async (
    context: AuthorizedContext,
    input: {
      attemptId: string;
      questionId: string;
      expectedRevision: number;
      value: JsonValue;
      requestId: string;
    },
  ): Promise<PracticeSnapshot> => {
    assertCurrent(context);
    let saved: PracticeSnapshot;
    try {
      saved = dependencies.store.savePracticeAnswer(context.userId, input);
    } catch (error) {
      return storeError(error);
    }
    if (saved.mode !== 'quiz' || saved.feedbackMode !== 'per-answer')
      return saved;

    const work = dependencies.store.getEvaluationWork(context.userId, saved.id);
    if (!work) throw new PracticeActionError('not-found');
    await assessPracticeCandidate(
      context,
      candidateForWork(work),
      dependencies,
    );
    const question = work.questions.find(({ id }) => id === input.questionId);
    const answerKey = work.answerKeys.find(
      (candidate) => candidate.questionId === input.questionId,
    );
    const answer = work.answers.get(input.questionId);
    if (!question || !answerKey || !answer)
      throw new PracticeActionError('storage-failed');
    if (answer.evaluation) {
      const existingEvaluation = validatePracticeEvaluation(
        {
          question,
          answerKey: jsonValueSchema.parse([answerKey]),
          rubricVersion: work.attempt.rubricVersion,
          assisted: answer.assisted,
        },
        answer.evaluation,
      );
      if (existingEvaluation) {
        await requireCurrentFeedbackPermission(context, work, dependencies);
        return saved;
      }
    }
    const evaluation = await evaluateAnswer(
      context,
      work,
      question,
      answerKey,
      answer,
      dependencies,
    );
    assertCurrent(context);
    try {
      const evaluated = dependencies.store.savePracticeEvaluations(
        context.userId,
        {
          attemptId: saved.id,
          final: false,
          evaluations: [
            {
              questionId: question.id,
              answerRevision: answer.revision,
              evaluation,
            },
          ],
        },
      );
      return evaluated;
    } catch (error) {
      return storeError(error);
    }
  };

  const submitPracticeAttempt = async (
    context: AuthorizedContext,
    input: { attemptId: string; expectedRevision: number; requestId: string },
  ): Promise<PracticeSnapshot> => {
    assertCurrent(context);
    const beforeSubmit = dependencies.store.getPracticeAttempt(context.userId, {
      attemptId: input.attemptId,
    });
    if (!beforeSubmit) throw new PracticeActionError('not-found');
    let submitted: PracticeSnapshot;
    try {
      submitted = dependencies.store.submitPracticeAttempt(
        context.userId,
        input,
      );
    } catch (error) {
      return storeError(error);
    }
    if (submitted.status === 'evaluated')
      return getPracticeAttempt(context, { attemptId: submitted.id });

    const work = dependencies.store.getEvaluationWork(
      context.userId,
      submitted.id,
    );
    if (!work) throw new PracticeActionError('storage-failed');
    await assessPracticeCandidate(
      context,
      candidateForWork(work),
      dependencies,
    );
    const evaluations: Array<{
      questionId: string;
      answerRevision: number;
      evaluation: NonNullable<ReturnType<typeof validatePracticeEvaluation>>;
    }> = [];
    for (const { question, answerKey, answer } of workQuestions(work)) {
      if (!answerKey || !answer)
        throw new PracticeActionError('storage-failed');
      const existingEvaluation = answer.evaluation
        ? validatePracticeEvaluation(
            {
              question,
              answerKey: jsonValueSchema.parse([answerKey]),
              rubricVersion: work.attempt.rubricVersion,
              assisted: answer.assisted,
            },
            answer.evaluation,
          )
        : null;
      const evaluation =
        existingEvaluation ??
        (await evaluateAnswer(
          context,
          work,
          question,
          answerKey,
          answer,
          dependencies,
        ));
      evaluations.push({
        questionId: question.id,
        answerRevision: answer.revision,
        evaluation,
      });
    }
    await requireCurrentFeedbackPermission(context, work, dependencies);
    assertCurrent(context);
    const wasAlreadyEvaluated =
      dependencies.store.getPracticeAttempt(context.userId, {
        attemptId: submitted.id,
      })?.status === 'evaluated';
    let evaluated: PracticeSnapshot;
    try {
      evaluated = dependencies.store.savePracticeEvaluations(context.userId, {
        attemptId: submitted.id,
        final: true,
        evaluations,
      });
    } catch (error) {
      return storeError(error);
    }
    if (!wasAlreadyEvaluated && context.isCurrent())
      publishAfterCommit(
        dependencies.publish,
        practiceEvent(context, evaluated, 'completed', input.requestId),
      );
    return evaluated;
  };

  const switchPracticeToGuided = async (
    context: AuthorizedContext,
    input: { attemptId: string; expectedRevision: number; requestId: string },
  ) => {
    assertCurrent(context);
    try {
      return dependencies.store.switchPracticeToGuided(context.userId, input);
    } catch (error) {
      return storeError(error);
    }
  };

  const pendingRetries = new Map<string, Promise<PracticeSnapshot>>();
  const retryPracticeAttemptWork = async (
    context: AuthorizedContext,
    input: { attemptId: string; requestId: string },
  ) => {
    assertCurrent(context);
    const work = dependencies.store.getEvaluationWork(
      context.userId,
      input.attemptId,
    );
    if (!work) throw new PracticeActionError('not-found');
    await assessPracticeCandidate(
      context,
      candidateForWork(work),
      dependencies,
    );
    const existing = dependencies.store.getPracticeAttempt(context.userId, {
      attemptId: input.requestId,
    });
    if (existing) {
      if (
        existing.priorAttemptId !== input.attemptId ||
        existing.courseId !== work.attempt.courseId ||
        existing.sessionId !== work.attempt.sessionId
      )
        throw new PracticeActionError('revision-conflict');
      return existing;
    }
    await requireCurrentFeedbackPermission(context, work, dependencies);
    if (!dependencies.regenerateRetry)
      throw new PracticeActionError('provider-failed');
    const fresh = parseAttemptInput(
      await dependencies.regenerateRetry(
        context,
        { priorAttemptId: input.attemptId, requestId: input.requestId },
        context.signal,
      ),
    );
    if (
      fresh.requestId !== input.requestId ||
      fresh.courseId !== work.attempt.courseId ||
      fresh.sessionId !== work.attempt.sessionId ||
      fresh.artifactId !== null ||
      !Array.isArray(fresh.hostAnswerKey) ||
      !fresh.hostAnswerKey.every(
        (key) =>
          key &&
          typeof key === 'object' &&
          !Array.isArray(key) &&
          typeof key.generationProof === 'string' &&
          key.generationProof.length > 0,
      )
    )
      throw new PracticeActionError('scope-denied');
    await assessPracticeCandidate(
      context,
      candidateForAssessment(fresh),
      dependencies,
    );
    await requireCurrentFeedbackPermission(context, work, dependencies);
    try {
      return dependencies.store.retryPracticeAttempt(
        context.userId,
        input,
        ({ sessionId, revision }) => {
          if (!context.isCurrent() || context.signal.aborted) return;
          publishAfterCommit(
            dependencies.publish,
            createStudySessionEvent(context, {
              sessionId,
              revision,
              operationId: input.requestId,
            }),
          );
        },
        fresh,
      );
    } catch (error) {
      return storeError(error);
    }
  };
  const retryPracticeAttempt = (
    context: AuthorizedContext,
    input: { attemptId: string; requestId: string },
  ) => {
    assertCurrent(context);
    const key = JSON.stringify([
      context.userId,
      input.attemptId,
      input.requestId,
    ]);
    const existing = pendingRetries.get(key);
    if (existing)
      return existing.then((snapshot) => {
        assertCurrent(context);
        return snapshot;
      });
    const operation = retryPracticeAttemptWork(context, input).finally(() =>
      pendingRetries.delete(key),
    );
    pendingRetries.set(key, operation);
    return operation;
  };

  return {
    getPracticeAttempt,
    retryPracticeAttempt,
    savePracticeAnswer,
    submitPracticeAttempt,
    switchPracticeToGuided,
  };
};

export const registerPracticeActions = (
  registrar: AuthorizedRegistrar,
  dependencies: Omit<PracticeActionDependencies, 'publish'>,
): ActionCleanup => {
  const actions = createPracticeActions({
    ...dependencies,
    publish: (event) => registrar.publish(event),
  });
  let disposed = false;
  const active = new Set<{
    controller: AbortController;
    promise: Promise<unknown>;
  }>();
  const protect =
    <Input extends { attemptId: string }, Result>(
      handler: (context: AuthorizedContext, input: Input) => Promise<Result>,
    ) =>
    async (context: AuthorizedContext, input: Input): Promise<Result> => {
      assertCurrent(context);
      if (disposed) throw new PracticeActionError('session-changed');
      const controller = new AbortController();
      const abort = () => controller.abort();
      context.signal.addEventListener('abort', abort, { once: true });
      const operationId = randomUUID();
      const unregister = registrar.lifecycle.registerOperation(
        `${context.userId}:practice:${input.attemptId}`,
        operationId,
        controller,
      );
      let unregisterSession: (() => void) | undefined;
      let execution:
        | { controller: AbortController; promise: Promise<unknown> }
        | undefined;
      try {
        const sessionId = dependencies.store.getPracticeAttempt(
          context.userId,
          { attemptId: input.attemptId },
        )?.sessionId;
        if (sessionId)
          unregisterSession = registerStudySessionOperation(
            context,
            sessionId,
            operationId,
            controller,
          );
        const promise = Promise.resolve().then(() =>
          handler({ ...context, signal: controller.signal }, input),
        );
        execution = { controller, promise };
        active.add(execution);
        return await promise;
      } finally {
        context.signal.removeEventListener('abort', abort);
        unregisterSession?.();
        unregister();
        if (execution) active.delete(execution);
      }
    };
  const cleanup = async () => {
    disposed = true;
    const pending = [...active];
    for (const { controller } of pending) controller.abort();
    await Promise.allSettled(pending.map(({ promise }) => promise));
  };
  registrar.handle('getPracticeAttempt', protect(actions.getPracticeAttempt));
  registrar.handle('savePracticeAnswer', protect(actions.savePracticeAnswer));
  registrar.handle(
    'submitPracticeAttempt',
    protect(actions.submitPracticeAttempt),
  );
  registrar.handle(
    'switchPracticeToGuided',
    protect(actions.switchPracticeToGuided),
  );
  registrar.handle(
    'retryPracticeAttempt',
    protect(actions.retryPracticeAttempt),
  );
  registrar.lifecycle.onTeardown(cleanup);
  return cleanup;
};
