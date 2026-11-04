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
  idSchema,
  instantSchema,
  jsonValueSchema,
  requestIdSchema,
  revisionSchema,
  safeErrorCodeSchema,
} from '../learning/product-contracts';
import {
  practiceEvaluationSchema,
  practiceQuestionSchema,
} from '../learning/practice-contracts';
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
  freshness: z.strictObject({
    status: z.enum(['current', 'stale', 'partial', 'unavailable']),
    lastSuccessfulAt: instantSchema.nullable(),
  }),
});
const sourceInputSchema = z.strictObject({
  objective: z.string().min(1).max(1000),
  sources: z.array(sourcePassageSchema).max(20),
});
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
  z.strictObject({
    version: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal('practice-generate'),
    sessionId: idSchema,
    courseId: idSchema,
    contextRevision: revisionSchema,
    input: sourceInputSchema.extend({
      difficulty: z.enum(['introductory', 'developing', 'challenging']),
    }),
  }),
  z.strictObject({
    version: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal('practice-evaluate'),
    sessionId: idSchema,
    courseId: idSchema,
    contextRevision: revisionSchema,
    input: z.strictObject({
      attemptId: idSchema,
      questionId: idSchema,
      answer: jsonValueSchema,
      answerRevision: revisionSchema,
    }),
  }),
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
    const sources = 'sources' in request.input ? request.input.sources : [];
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
export type LearningAssessment = {
  allowed: boolean;
  reasonCode: z.infer<typeof safeErrorCodeSchema> | null;
};
export type LearningDispatcherDependencies = {
  getCapabilities: () => Promise<LearningCapabilities>;
  generateCandidate: LearningOperationHandler;
  operations?: Partial<Record<LearningKind, LearningOperationHandler>>;
  assessCandidate: (
    accountId: string,
    request: LearningRequest,
    candidate: LearningCandidate,
    offeredSources: SourceReference[],
    signal: AbortSignal,
  ) => Promise<LearningAssessment>;
  now?: () => number;
  generationId?: () => string;
  idempotencyTtlMs?: number;
  idempotencyLimit?: number;
};
type IdempotencyEntry = {
  digest: string;
  expiresAt: number;
  createdAt: number;
  result: Promise<LearningResponse>;
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
    const operation = dependencies.operations?.[request.kind];
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

  const dispatch = async (
    accountId: string,
    rawRequest: unknown,
    signal: AbortSignal,
  ): Promise<LearningResponse> => {
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
    const result = dispatchCandidate(accountId, request, signal);
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
