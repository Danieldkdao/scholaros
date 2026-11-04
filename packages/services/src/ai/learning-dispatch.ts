import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { activityCandidateSchema } from '../learning/activity-contracts';
import {
  sourcePassageSchema,
  sourceReferenceSchema,
  type SourceReference,
} from '../learning/context-contracts';
import {
  personalContextSchema,
  preferenceContentSchema,
} from '../learning/memory-contracts';
import {
  practiceEvaluationSchema,
  practiceQuestionSchema,
} from '../learning/practice-contracts';
import {
  practiceAnswerKeySchema,
  practiceGenerationInputSchema,
  type GeneratedPracticeCandidate as P23GeneratedPracticeCandidate,
  type PracticeGenerationInput,
} from './practice-generation';
import {
  idSchema,
  instantSchema,
  jsonValueSchema,
  requestIdSchema,
  revisionSchema,
  safeErrorCodeSchema,
} from '../learning/product-contracts';
import {
  studyActivities,
  studyHistoryRoles,
  studyMessagePartSchema,
} from '../learning/study-contracts';

export const learningCapabilitiesSchema = z.strictObject({
  version: z.literal(1),
  configurationRevision: z.string().min(1).max(200),
  tutor: z.enum(['available', 'unavailable']),
  imageInterpretation: z.enum(['available', 'unavailable']),
  pdfInterpretation: z.enum(['available', 'unavailable']),
  liveDictation: z.enum(['available', 'unavailable']),
  fileDictation: z.enum(['available', 'unavailable']),
  limits: z.strictObject({
    inputTextCharacters: z.number().int().positive(),
    materialWireBytes: z.number().int().positive(),
    pdfPagesPerOperation: z.number().int().positive(),
    imagesPerOperation: z.number().int().positive(),
    dictationDurationMs: z.number().int().positive(),
  }),
});
export type LearningCapabilities = z.infer<typeof learningCapabilitiesSchema>;

const tutorInputSchema = z.strictObject({
  activity: z.enum(studyActivities),
  studentText: z.string().min(1).max(8000),
  targetAssignmentId: idSchema.nullable(),
  sources: z.array(sourcePassageSchema).max(20),
  history: z
    .array(
      z.strictObject({
        role: z.enum(studyHistoryRoles),
        text: z.string().max(8000),
      }),
    )
    .max(12),
  personalContext: personalContextSchema,
  priorAssistanceSummary: z.string().max(2000).optional(),
  safeRegeneration: z
    .strictObject({
      attemptNumber: z.literal(2),
      reasonCode: z.string().min(1).max(100),
    })
    .optional(),
  freshness: z.strictObject({
    status: z.enum(['current', 'stale', 'partial', 'unavailable']),
    lastSuccessfulAt: instantSchema.nullable(),
  }),
});
const sourceInputSchema = z.strictObject({
  objective: z.string().min(1).max(1000),
  sources: z.array(sourcePassageSchema).max(20),
});
export const practiceAnswerEvaluationInputSchema = z
  .strictObject({
    question: practiceQuestionSchema,
    answer: jsonValueSchema,
    answerKey: practiceAnswerKeySchema.element,
    rubricVersion: idSchema,
    assisted: z.boolean(),
  })
  .superRefine((input, context) => {
    if (input.question.id !== input.answerKey.questionId)
      context.addIssue({
        code: 'custom',
        path: ['answerKey', 'questionId'],
        message: 'Practice answer key must match the question.',
      });
    if (input.question.kind !== input.answerKey.kind)
      context.addIssue({
        code: 'custom',
        path: ['answerKey', 'kind'],
        message: 'Practice answer key kind must match the question.',
      });
    if (Buffer.byteLength(JSON.stringify(input.answer), 'utf8') > 8192)
      context.addIssue({
        code: 'custom',
        path: ['answer'],
        message: 'Practice answer exceeds the request limit.',
      });
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 96 * 1024)
      context.addIssue({
        code: 'custom',
        message: 'Practice evaluation input exceeds the request limit.',
      });
  });
export type PracticeAnswerEvaluationInput = z.infer<
  typeof practiceAnswerEvaluationInputSchema
>;
export type GeneratedPracticeCandidate = P23GeneratedPracticeCandidate;
export { practiceGenerationInputSchema };
export type { PracticeGenerationInput };

export const practiceGenerateRequestSchema = z.strictObject({
  version: z.literal(1),
  requestId: requestIdSchema,
  kind: z.literal('practice-generate'),
  sessionId: idSchema,
  courseId: idSchema,
  contextRevision: revisionSchema,
  input: practiceGenerationInputSchema,
});
export type PracticeGenerateRequest = z.infer<
  typeof practiceGenerateRequestSchema
>;

export const practiceEvaluateRequestSchema = z.strictObject({
  version: z.literal(1),
  requestId: requestIdSchema,
  kind: z.literal('practice-evaluate'),
  sessionId: idSchema,
  courseId: idSchema,
  contextRevision: revisionSchema,
  input: practiceAnswerEvaluationInputSchema,
});
export type PracticeEvaluateRequest = z.infer<
  typeof practiceEvaluateRequestSchema
>;

const operationInputs = [
  z.strictObject({
    version: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal('tutor-turn'),
    sessionId: idSchema,
    courseId: idSchema,
    contextRevision: revisionSchema,
    input: tutorInputSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal('activity-generate'),
    sessionId: idSchema,
    courseId: idSchema,
    contextRevision: revisionSchema,
    input: sourceInputSchema,
  }),
  practiceGenerateRequestSchema,
  practiceEvaluateRequestSchema,
  z.strictObject({
    version: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal('memory-propose'),
    sessionId: idSchema,
    courseId: idSchema,
    contextRevision: revisionSchema,
    input: z.strictObject({ feedback: z.string().min(1).max(2000) }),
  }),
] as const;
const learningRequestBaseSchema = z.discriminatedUnion('kind', operationInputs);
export const learningRequestSchema = learningRequestBaseSchema.superRefine(
  (request, context) => {
    const serializedBytes = new TextEncoder().encode(
      JSON.stringify(request),
    ).byteLength;
    if (serializedBytes > 96 * 1024) {
      context.addIssue({
        code: 'custom',
        message: 'Learning request exceeds the wire limit.',
      });
      return;
    }
    const sources: { reference: SourceReference; text: string }[] =
      request.kind === 'practice-generate'
        ? request.input.sources.map(({ reference, excerpt }) => ({
            reference,
            text: excerpt,
          }))
        : request.kind === 'practice-evaluate'
          ? request.input.question.sourceReferences.map((reference) => ({
              reference,
              text: '',
            }))
          : 'sources' in request.input
            ? request.input.sources
            : [];
    if (
      sources.reduce((total, source) => total + source.text.length, 0) > 24_000
    )
      context.addIssue({
        code: 'custom',
        path: ['input', 'sources'],
        message: 'Combined source text exceeds the learning budget.',
      });
    if (
      request.kind === 'tutor-turn' &&
      request.input.history.reduce(
        (total, turn) => total + turn.text.length,
        0,
      ) > 16_000
    )
      context.addIssue({
        code: 'custom',
        path: ['input', 'history'],
        message: 'Combined history exceeds the learning budget.',
      });
    for (const source of sources) {
      if (
        source.reference.courseId !== null &&
        source.reference.courseId !== request.courseId
      )
        context.addIssue({
          code: 'custom',
          path: ['input', 'sources'],
          message: 'Source is outside the selected course.',
        });
      if (source.reference.state !== 'current')
        context.addIssue({
          code: 'custom',
          path: ['input', 'sources'],
          message: 'Only current offered sources can ground a new response.',
        });
    }
  },
);
export type LearningRequest = z.infer<typeof learningRequestSchema>;
export type LearningKind = LearningRequest['kind'];

export const learningEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('retrieve-source'),
    sourceId: idSchema,
    query: z.string().min(1).max(200),
  }),
  z.strictObject({
    kind: z.literal('remember-preference'),
    preference: preferenceContentSchema,
  }),
  z.strictObject({
    kind: z.literal('create-activity'),
    candidate: activityCandidateSchema,
  }),
  z.strictObject({
    kind: z.literal('offer-practice'),
    objective: z.string().min(1).max(1000),
    questions: z.array(practiceQuestionSchema).min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal('practice-feedback'),
    attemptId: idSchema,
    evaluation: practiceEvaluationSchema,
  }),
]);
export type LearningEffect = z.infer<typeof learningEffectSchema>;

export const learningCandidateSchema = z.strictObject({
  text: z.string().max(32_000),
  citationIndexes: z.array(z.number().int().min(0).max(19)).max(20),
  proposedEffects: z.array(learningEffectSchema).max(5),
});
export type LearningCandidate = z.infer<typeof learningCandidateSchema>;

export const learningResponseSchema = z
  .strictObject({
    version: z.literal(1),
    requestId: requestIdSchema,
    generationId: idSchema,
    parts: z.array(studyMessagePartSchema).max(100),
    citations: z.array(sourceReferenceSchema).max(20),
    proposedEffects: z.array(learningEffectSchema).max(5),
    usage: z.strictObject({
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
    }),
    configurationRevision: z.string().min(1).max(200),
  })
  .superRefine((response, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      2 * 1024 * 1024
    )
      context.addIssue({
        code: 'custom',
        message: 'Learning response exceeds the operation byte limit.',
      });
  });
export type LearningResponse = z.infer<typeof learningResponseSchema>;

export const generatedPracticeCandidateSchema = z
  .strictObject({
    questions: z.array(practiceQuestionSchema).min(1).max(20),
    hostAnswerKey: practiceAnswerKeySchema,
    rubricVersion: idSchema,
  })
  .superRefine((candidate, context) => {
    if (candidate.questions.length !== candidate.hostAnswerKey.length) {
      context.addIssue({
        code: 'custom',
        path: ['hostAnswerKey'],
        message: 'Every practice question must have one host answer key.',
      });
      return;
    }
    candidate.questions.forEach((question, index) => {
      const answerKey = candidate.hostAnswerKey[index]!;
      if (
        question.id !== answerKey.questionId ||
        question.kind !== answerKey.kind
      )
        context.addIssue({
          code: 'custom',
          path: ['hostAnswerKey', index],
          message: 'Practice answer key must match its question.',
        });
    });
    if (
      new TextEncoder().encode(JSON.stringify(candidate)).byteLength >
      64 * 1024
    )
      context.addIssue({
        code: 'custom',
        message: 'Practice candidate exceeds the operation byte limit.',
      });
  });
export type GeneratedPracticeCandidateSchema = z.infer<
  typeof generatedPracticeCandidateSchema
>;

const learningUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
});
const practiceResponseByteCheck = (response: unknown) =>
  new TextEncoder().encode(JSON.stringify(response)).byteLength <=
  2 * 1024 * 1024;

export const practiceGenerateResponseSchema = z
  .strictObject({
    version: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal('practice-generate'),
    candidate: generatedPracticeCandidateSchema,
    configurationRevision: z.string().min(1).max(200),
    usage: learningUsageSchema,
  })
  .superRefine((response, context) => {
    if (!practiceResponseByteCheck(response))
      context.addIssue({
        code: 'custom',
        message: 'Practice response exceeds the operation byte limit.',
      });
  });
export type PracticeGenerateResponse = z.infer<
  typeof practiceGenerateResponseSchema
>;

export const practiceEvaluateResponseSchema = z
  .strictObject({
    version: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal('practice-evaluate'),
    evaluation: practiceEvaluationSchema,
    configurationRevision: z.string().min(1).max(200),
    usage: learningUsageSchema,
  })
  .superRefine((response, context) => {
    if (!practiceResponseByteCheck(response))
      context.addIssue({
        code: 'custom',
        message: 'Practice response exceeds the operation byte limit.',
      });
  });
export type PracticeEvaluateResponse = z.infer<
  typeof practiceEvaluateResponseSchema
>;

export const learningOperationResponseSchema = z.union([
  learningResponseSchema,
  practiceGenerateResponseSchema,
  practiceEvaluateResponseSchema,
]);
export type LearningOperationResponse = z.infer<
  typeof learningOperationResponseSchema
>;

export const learningDispatchErrorCodes = [
  'invalid-input',
  'scope-denied',
  'capability-changed',
  'feature-unavailable',
  'limit-exceeded',
  'cancelled',
  'provider-failed',
  'revision-conflict',
  'unsupported',
  'unreadable',
] as const;
export type LearningDispatchErrorCode =
  (typeof learningDispatchErrorCodes)[number];
export class LearningDispatchError extends Error {
  readonly code: LearningDispatchErrorCode;

  constructor(code: LearningDispatchErrorCode) {
    super(code);
    this.name = 'LearningDispatchError';
    this.code = code;
  }
}

export type LearningCandidateResult = {
  candidate: unknown;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  offeredSources?: SourceReference[];
};
export type LearningOperationHandler = (
  request: LearningRequest,
  signal: AbortSignal,
) => Promise<LearningCandidateResult | unknown>;
export type LearningOperationHandlers = {
  'activity-generate'?: LearningOperationHandler;
  'practice-generate'?: (
    request: PracticeGenerateRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  'practice-evaluate'?: (
    request: PracticeEvaluateRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  'memory-propose'?: LearningOperationHandler;
};
export type LearningAssessment = {
  allowed: boolean;
  reasonCode: z.infer<typeof safeErrorCodeSchema> | null;
};
export type LearningDispatcherDependencies = {
  getCapabilities: () => Promise<LearningCapabilities>;
  generateCandidate: LearningOperationHandler;
  operations?: LearningOperationHandlers;
  assessCandidate: (
    accountId: string,
    request: LearningRequest,
    candidate: LearningCandidate,
    offeredSources: SourceReference[],
    signal: AbortSignal,
  ) => Promise<LearningAssessment>;
  assessPracticeCandidate?: (
    request: PracticeGenerateRequest,
    candidate: GeneratedPracticeCandidate,
    signal: AbortSignal,
  ) => Promise<void>;
  now?: () => number;
  generationId?: () => string;
  idempotencyTtlMs?: number;
  idempotencyLimit?: number;
};
type IdempotencyEntry = {
  digest: string;
  expiresAt: number;
  createdAt: number;
  result: Promise<LearningOperationResponse>;
};
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const offeredSourceReferences = (request: LearningRequest): SourceReference[] =>
  'sources' in request.input
    ? request.input.sources.map((source) => source.reference)
    : [];
const candidateResult = (result: LearningCandidateResult | unknown) => {
  if (result !== null && typeof result === 'object' && 'candidate' in result) {
    const value = result as LearningCandidateResult;
    return {
      candidate: value.candidate,
      usage: value.usage ?? { inputTokens: null, outputTokens: null },
      offeredSources: value.offeredSources,
    };
  }
  return {
    candidate: result,
    usage: { inputTokens: null, outputTokens: null },
    offeredSources: undefined,
  };
};
const sameReference = (left: SourceReference, right: SourceReference) =>
  JSON.stringify(left) === JSON.stringify(right);
const effectMatchesOperation = (kind: LearningKind, effect: LearningEffect) => {
  switch (effect.kind) {
    case 'retrieve-source':
      return kind === 'tutor-turn';
    case 'remember-preference':
      return kind === 'tutor-turn' || kind === 'memory-propose';
    case 'create-activity':
      return kind === 'tutor-turn' || kind === 'activity-generate';
    case 'offer-practice':
      return kind === 'tutor-turn' || kind === 'practice-generate';
    case 'practice-feedback':
      return kind === 'practice-evaluate';
  }
};

export const createLearningDispatcher = (
  dependencies: LearningDispatcherDependencies,
) => {
  const now = dependencies.now ?? Date.now;
  const idempotencyTtlMs = dependencies.idempotencyTtlMs ?? 5 * 60_000;
  const idempotencyLimit = dependencies.idempotencyLimit ?? 512;
  const idempotency = new Map<string, IdempotencyEntry>();

  const dispatchCandidate = async (
    accountId: string,
    request: LearningRequest,
    signal: AbortSignal,
  ): Promise<LearningResponse> => {
    signal.throwIfAborted();
    const capabilities = learningCapabilitiesSchema.parse(
      await dependencies.getCapabilities(),
    );
    if (capabilities.tutor !== 'available')
      throw new LearningDispatchError('feature-unavailable');
    const operation =
      request.kind === 'activity-generate'
        ? dependencies.operations?.['activity-generate']
        : request.kind === 'memory-propose'
          ? dependencies.operations?.['memory-propose']
          : undefined;
    if (request.kind !== 'tutor-turn' && !operation)
      throw new LearningDispatchError('feature-unavailable');
    const generated = await (operation ?? dependencies.generateCandidate)(
      request,
      signal,
    );
    signal.throwIfAborted();
    const {
      candidate: rawCandidate,
      usage,
      offeredSources: trustedOfferedSources,
    } = candidateResult(generated);
    const parsedCandidate = learningCandidateSchema.safeParse(rawCandidate);
    if (!parsedCandidate.success)
      throw new LearningDispatchError('provider-failed');
    const offered = trustedOfferedSources ?? offeredSourceReferences(request);
    const citations: SourceReference[] = [];
    for (const index of parsedCandidate.data.citationIndexes) {
      const reference = offered[index];
      if (
        !reference ||
        citations.some((citation) => sameReference(citation, reference))
      )
        throw new LearningDispatchError('invalid-input');
      citations.push(reference);
    }
    for (const effect of parsedCandidate.data.proposedEffects) {
      if (!effectMatchesOperation(request.kind, effect))
        throw new LearningDispatchError('invalid-input');
      const effectReferences =
        effect.kind === 'create-activity'
          ? effect.candidate.sourceReferences
          : effect.kind === 'offer-practice'
            ? effect.questions.flatMap((question) => question.sourceReferences)
            : effect.kind === 'practice-feedback'
              ? effect.evaluation.sourceReferences
              : [];
      if (
        effectReferences.some(
          (reference) =>
            !offered.some((item) => sameReference(item, reference)),
        ) ||
        (effect.kind === 'retrieve-source' &&
          !offered.some((reference) => reference.sourceId === effect.sourceId))
      )
        throw new LearningDispatchError('invalid-input');
    }
    signal.throwIfAborted();
    const assessment = await dependencies.assessCandidate(
      accountId,
      request,
      parsedCandidate.data,
      offered,
      signal,
    );
    signal.throwIfAborted();
    const currentCapabilities = learningCapabilitiesSchema.parse(
      await dependencies.getCapabilities(),
    );
    if (
      currentCapabilities.configurationRevision !==
      capabilities.configurationRevision
    )
      throw new LearningDispatchError('capability-changed');
    if (!assessment.allowed) throw new LearningDispatchError('scope-denied');
    const parts: LearningResponse['parts'] = parsedCandidate.data.text
      ? [{ kind: 'text', text: parsedCandidate.data.text }]
      : [];
    parts.push(
      ...citations.map((reference) => ({
        kind: 'citation' as const,
        reference,
      })),
    );
    return learningResponseSchema.parse({
      version: 1,
      requestId: request.requestId,
      generationId: (dependencies.generationId ?? randomUUID)(),
      parts,
      citations,
      proposedEffects: parsedCandidate.data.proposedEffects,
      usage,
      configurationRevision: capabilities.configurationRevision,
    });
  };

  const getAvailableCapabilities = async () => {
    const capabilities = learningCapabilitiesSchema.parse(
      await dependencies.getCapabilities(),
    );
    if (capabilities.tutor !== 'available')
      throw new LearningDispatchError('feature-unavailable');
    return capabilities;
  };

  const assertCapabilitiesUnchanged = async (startingRevision: string) => {
    const currentCapabilities = await getAvailableCapabilities();
    if (currentCapabilities.configurationRevision !== startingRevision)
      throw new LearningDispatchError('capability-changed');
  };

  const parseOperationResult = (
    result: unknown,
    valueKey: 'candidate' | 'evaluation',
  ) => {
    if (result === null || typeof result !== 'object' || Array.isArray(result))
      throw new LearningDispatchError('provider-failed');
    const record = result as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== valueKey && key !== 'usage'))
      throw new LearningDispatchError('provider-failed');
    const usage = learningUsageSchema.safeParse(
      record.usage ?? { inputTokens: null, outputTokens: null },
    );
    if (!usage.success || !(valueKey in record))
      throw new LearningDispatchError('provider-failed');
    return { value: record[valueKey], usage: usage.data };
  };

  const dispatchPracticeGeneration = async (
    request: PracticeGenerateRequest,
    signal: AbortSignal,
  ): Promise<PracticeGenerateResponse> => {
    signal.throwIfAborted();
    const capabilities = await getAvailableCapabilities();
    const generate = dependencies.operations?.['practice-generate'];
    const assess = dependencies.assessPracticeCandidate;
    if (!generate || !assess)
      throw new LearningDispatchError('feature-unavailable');

    const generated = await generate(request, signal);
    signal.throwIfAborted();
    const { value, usage } = parseOperationResult(generated, 'candidate');
    const candidate = generatedPracticeCandidateSchema.safeParse(value);
    if (
      !candidate.success ||
      candidate.data.questions.length !== request.input.questionCount ||
      candidate.data.questions.some(
        (question) =>
          question.objectiveIds.some(
            (objectiveId) =>
              !request.input.objectives.some(({ id }) => id === objectiveId),
          ) ||
          question.sourceReferences.length === 0 ||
          question.sourceReferences.some(
            (reference) =>
              !request.input.sources.some((source) =>
                sameReference(source.reference, reference),
              ),
          ),
      )
    )
      throw new LearningDispatchError('provider-failed');

    signal.throwIfAborted();
    await assess(request, candidate.data, signal);
    signal.throwIfAborted();
    await assertCapabilitiesUnchanged(capabilities.configurationRevision);
    return practiceGenerateResponseSchema.parse({
      version: 1,
      requestId: request.requestId,
      kind: 'practice-generate',
      candidate: candidate.data,
      configurationRevision: capabilities.configurationRevision,
      usage,
    });
  };

  const dispatchPracticeEvaluation = async (
    request: PracticeEvaluateRequest,
    signal: AbortSignal,
  ): Promise<PracticeEvaluateResponse> => {
    signal.throwIfAborted();
    const capabilities = await getAvailableCapabilities();
    const evaluate = dependencies.operations?.['practice-evaluate'];
    if (!evaluate) throw new LearningDispatchError('feature-unavailable');

    const evaluated = await evaluate(request, signal);
    signal.throwIfAborted();
    const { value, usage } = parseOperationResult(evaluated, 'evaluation');
    const evaluation = practiceEvaluationSchema.safeParse(value);
    if (
      !evaluation.success ||
      evaluation.data.questionId !== request.input.question.id ||
      evaluation.data.rubricVersion !== request.input.rubricVersion ||
      evaluation.data.assisted !== request.input.assisted ||
      evaluation.data.sourceReferences.length !==
        request.input.question.sourceReferences.length ||
      evaluation.data.sourceReferences.some(
        (reference, index) =>
          !sameReference(
            reference,
            request.input.question.sourceReferences[index]!,
          ),
      )
    )
      throw new LearningDispatchError('provider-failed');

    await assertCapabilitiesUnchanged(capabilities.configurationRevision);
    return practiceEvaluateResponseSchema.parse({
      version: 1,
      requestId: request.requestId,
      kind: 'practice-evaluate',
      evaluation: evaluation.data,
      configurationRevision: capabilities.configurationRevision,
      usage,
    });
  };

  const dispatch = async (
    accountId: string,
    rawRequest: unknown,
    signal: AbortSignal,
  ): Promise<LearningOperationResponse> => {
    const parsedRequest = learningRequestSchema.safeParse(rawRequest);
    if (!parsedRequest.success)
      throw new LearningDispatchError('invalid-input');
    const request = parsedRequest.data;
    const idempotencyKey = `${accountId}:${request.sessionId}:${request.requestId}`;
    const digest = createHash('sha256')
      .update(canonicalJson(request))
      .digest('hex');
    const currentTime = now();
    for (const [key, entry] of idempotency)
      if (entry.expiresAt <= currentTime) idempotency.delete(key);
    const existing = idempotency.get(idempotencyKey);
    if (existing) {
      if (existing.digest !== digest)
        throw new LearningDispatchError('revision-conflict');
      return existing.result;
    }
    if (idempotency.size >= idempotencyLimit) {
      const oldestEntry = [...idempotency.entries()].sort(
        ([, left], [, right]) => left.createdAt - right.createdAt,
      )[0];
      if (oldestEntry) idempotency.delete(oldestEntry[0]);
    }
    const result =
      request.kind === 'practice-generate'
        ? dispatchPracticeGeneration(request, signal)
        : request.kind === 'practice-evaluate'
          ? dispatchPracticeEvaluation(request, signal)
          : dispatchCandidate(accountId, request, signal);
    idempotency.set(idempotencyKey, {
      digest,
      expiresAt: currentTime + idempotencyTtlMs,
      createdAt: currentTime,
      result,
    });
    try {
      return await result;
    } catch (error) {
      if (idempotency.get(idempotencyKey)?.result === result)
        idempotency.delete(idempotencyKey);
      throw error;
    }
  };

  return { dispatch };
};
