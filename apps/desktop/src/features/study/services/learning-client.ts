import { z } from 'zod';
import { safeErrorCodeSchema, type SafeErrorCode } from '@scholaros/services/learning/product-contracts';
import { sourceReferenceSchema, type SourceReference } from '@scholaros/services/learning/context-contracts';
import { preparedStudyContextSchema, type PreparedStudyContext } from '@scholaros/services/learning/study-contracts';
import { learningEffectSchema } from './learning-tools';

export const tutorGenerationInputSchema = z.strictObject({
  requestId: z.uuid(),
  sessionId: z.string().min(1).max(300),
  courseId: z.string().min(1).max(300),
  message: z.string().max(8000),
  context: preparedStudyContextSchema,
  safeRegeneration: z
    .strictObject({
      attemptNumber: z.literal(2),
      reasonCode: z.string().min(1).max(100),
    })
    .optional(),
});
export type TutorGenerationInput = z.infer<typeof tutorGenerationInputSchema>;

const tutorCandidatePartSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().max(32_000) }),
  z.strictObject({
    kind: z.literal('citation'),
    reference: sourceReferenceSchema,
  }),
]);
export type TutorCandidatePart = z.infer<typeof tutorCandidatePartSchema>;

export const learningRequestSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  kind: z.literal('tutor-turn'),
  sessionId: z.string().min(1).max(300),
  courseId: z.string().min(1).max(300),
  contextRevision: z.number().int().nonnegative().safe(),
  input: z.strictObject({
    message: z.string().max(8000),
    context: preparedStudyContextSchema,
    safeRegeneration: z
      .strictObject({
        attemptNumber: z.literal(2),
        reasonCode: z.string().min(1).max(100),
      })
      .optional(),
  }),
});
export type LearningRequest = z.infer<typeof learningRequestSchema>;

export const learningResponseSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  generationId: z.string().min(1).max(300),
  parts: z.array(tutorCandidatePartSchema).max(50),
  citations: z.array(sourceReferenceSchema).max(20),
  proposedEffects: z.array(learningEffectSchema).max(4),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative().safe().nullable(),
    outputTokens: z.number().int().nonnegative().safe().nullable(),
  }),
  configurationRevision: z.string().min(1).max(300),
});
export type LearningResponse = z.infer<typeof learningResponseSchema>;

export type LearningTransport = {
  requestLearning: (
    request: LearningRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

export class LearningClientError extends Error {
  readonly code: SafeErrorCode;
  readonly candidateInvalid: boolean;

  constructor(code: SafeErrorCode, candidateInvalid = false) {
    super(
      code === 'invalid-input'
        ? 'The tutor response could not be validated.'
        : 'The learning service is unavailable.',
    );
    this.name = 'LearningClientError';
    this.code = code;
    this.candidateInvalid = candidateInvalid;
  }
}

const getSafeTransportCode = (error: unknown): SafeErrorCode | null => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; name?: unknown };
  if (candidate.name === 'AbortError') return 'cancelled';
  const parsed = safeErrorCodeSchema.safeParse(candidate.code);
  return parsed.success ? parsed.data : null;
};

const sourceReferenceKey = (reference: SourceReference) =>
  JSON.stringify([
    reference.sourceKind,
    reference.sourceId,
    reference.versionId,
    reference.courseId,
    reference.locator,
    reference.title,
    reference.provenance,
    reference.observedAt,
    reference.state,
  ]);

const validateTutorCandidate = (
  input: TutorGenerationInput,
  response: unknown,
): LearningResponse => {
  const parsed = learningResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.requestId !== input.requestId)
    throw new LearningClientError('invalid-input', true);
  const offeredReferences = new Set(
    input.context.sourcePassages.map(({ reference }) =>
      sourceReferenceKey(reference),
    ),
  );
  const references = [
    ...parsed.data.citations,
    ...parsed.data.parts.flatMap((part) =>
      part.kind === 'citation' ? [part.reference] : [],
    ),
  ];
  if (
    references.some(
      (reference) => !offeredReferences.has(sourceReferenceKey(reference)),
    )
  )
    throw new LearningClientError('invalid-input', true);
  const citedKeys = new Set(parsed.data.citations.map(sourceReferenceKey));
  if (
    parsed.data.parts.some(
      (part) =>
        part.kind === 'citation' &&
        !citedKeys.has(sourceReferenceKey(part.reference)),
    )
  )
    throw new LearningClientError('invalid-input', true);
  return parsed.data;
};

const validateCombinedContextBounds = (context: PreparedStudyContext) => {
  const passageCharacters = context.sourcePassages.reduce(
    (total, passage) => total + passage.text.length,
    0,
  );
  const historyCharacters = context.history.reduce(
    (total, item) => total + item.text.length,
    0,
  );
  if (passageCharacters > 24_000 || historyCharacters > 16_000)
    throw new LearningClientError('limit-exceeded');
};

const buildRequest = (input: TutorGenerationInput): LearningRequest => {
  const parsed = tutorGenerationInputSchema.safeParse(input);
  if (!parsed.success) throw new LearningClientError('invalid-input');
  const generationInput = parsed.data;
  if (
    generationInput.sessionId !== generationInput.context.sessionId ||
    generationInput.courseId !== generationInput.context.courseId
  )
    throw new LearningClientError('scope-denied');
  validateCombinedContextBounds(generationInput.context);
  const request = learningRequestSchema.parse({
    version: 1,
    requestId: generationInput.requestId,
    kind: 'tutor-turn',
    sessionId: generationInput.sessionId,
    courseId: generationInput.courseId,
    contextRevision: generationInput.context.contextRevision,
    input: {
      message: generationInput.message,
      context: generationInput.context,
      safeRegeneration: generationInput.safeRegeneration,
    },
  });
  const body = JSON.stringify(request);
  if (new TextEncoder().encode(body).byteLength > 96 * 1024)
    throw new LearningClientError('limit-exceeded');
  return request;
};

export const createLearningClient = (transport: LearningTransport) => ({
  generateTutorCandidate: async (
    input: TutorGenerationInput,
    signal: AbortSignal,
  ): Promise<LearningResponse> => {
    if (signal.aborted) throw new LearningClientError('cancelled');
    const request = buildRequest(input);
    let response: unknown;
    try {
      response = await transport.requestLearning(request, signal);
    } catch (error) {
      const code = signal.aborted
        ? 'cancelled'
        : (getSafeTransportCode(error) ?? 'provider-failed');
      throw new LearningClientError(code);
    }
    if (signal.aborted) throw new LearningClientError('cancelled');
    return validateTutorCandidate(input, response);
  },
});