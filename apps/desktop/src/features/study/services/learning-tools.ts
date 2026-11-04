import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  AssistancePolicy,
  GradeSettings,
} from '@scholaros/services/learning/grade-contracts';
import {
  preferenceContentSchema,
  type PreferenceContent,
  type MemoryDTO,
} from '@scholaros/services/learning/memory-contracts';
import {
  locatorSchema,
  sourceKinds,
  type SourceReference,
} from '@scholaros/services/learning/context-contracts';
import type {
  AuthorizedContext,
  SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import { idSchema } from '@scholaros/services/learning/product-contracts';
import type { MessagePart } from '@scholaros/services/learning/study-contracts';

export const learningEffectKinds = [
  'retrieve-source',
  'remember-preference',
  'create-activity',
  'offer-practice',
] as const;
export type LearningEffectKind = (typeof learningEffectKinds)[number];

const sourceSelectorSchema = z.strictObject({
  sourceKind: z.enum(sourceKinds),
  sourceId: idSchema,
  versionId: idSchema.nullable(),
  locator: locatorSchema.nullable(),
});
export type SourceSelectorSchema = z.infer<typeof sourceSelectorSchema>;
const sourceReferencesSchema = z.array(sourceSelectorSchema).min(1).max(20);
export type SourceReferencesSchema = z.infer<typeof sourceReferencesSchema>;
const retrieveSourceEffectSchema = z.strictObject({
  kind: z.literal('retrieve-source'),
  references: sourceReferencesSchema,
});
export type RetrieveSourceEffectSchema = z.infer<
  typeof retrieveSourceEffectSchema
>;
const rememberPreferenceEffectSchema = z.strictObject({
  kind: z.literal('remember-preference'),
  preference: preferenceContentSchema,
  evidence: z.string().min(1).max(500),
});
export type RememberPreferenceEffectSchema = z.infer<
  typeof rememberPreferenceEffectSchema
>;
const createActivityEffectSchema = z.strictObject({
  kind: z.literal('create-activity'),
  objective: z.string().min(1).max(1000),
  references: sourceReferencesSchema,
});
export type CreateActivityEffectSchema = z.infer<
  typeof createActivityEffectSchema
>;
const offerPracticeEffectSchema = z.strictObject({
  kind: z.literal('offer-practice'),
  objective: z.string().min(1).max(1000),
  references: sourceReferencesSchema,
});
export type OfferPracticeEffectSchema = z.infer<
  typeof offerPracticeEffectSchema
>;

export const learningEffectSchema = z.discriminatedUnion('kind', [
  retrieveSourceEffectSchema,
  rememberPreferenceEffectSchema,
  createActivityEffectSchema,
  offerPracticeEffectSchema,
]);
export type LearningEffectSchema = z.infer<typeof learningEffectSchema>;
export type LearningEffect = z.infer<typeof learningEffectSchema>;
type LearningEffectSourceSelector = z.infer<typeof sourceSelectorSchema>;

export type LearningToolValidationContext = {
  courseId: string;
  offeredReferences: SourceReference[];
  studentMessage: string;
  policy: AssistancePolicy;
  gradeAccessEnabled?: boolean;
  gradeConsentRevision?: number;
};

export class LearningToolValidationError extends Error {
  readonly code: SafeErrorCode;

  constructor(code: LearningToolValidationError['code']) {
    super('The tutor proposed an unavailable learning action.');
    this.name = 'LearningToolValidationError';
    this.code = code;
  }
}

const sourceSelectorKey = (reference: LearningEffectSourceSelector) =>
  JSON.stringify([
    reference.sourceKind,
    reference.sourceId,
    reference.versionId,
    reference.locator,
  ]);

const hasExplicitPreferenceEvidence = (
  studentMessage: string,
  evidence: string,
  preference: PreferenceContent,
) => {
  const actualText = studentMessage.toLocaleLowerCase();
  const quotedEvidence = evidence.toLocaleLowerCase().trim();
  if (!quotedEvidence || !actualText.includes(quotedEvidence)) return false;
  if (
    !/^(?:please remember|remember that i|i prefer|i'd prefer|i like|i learn better|too verbose|too long|make it shorter|make it simpler|use simpler wording)\b/i.test(
      quotedEvidence,
    )
  )
    return false;
  const preferenceCues: Record<PreferenceContent['field'], RegExp> = {
    'explanation-length':
      /\b(explanation|answer|response|short|concise|verbose|long|brief)\b/i,
    vocabulary:
      /\b(word|vocabulary|simple|simpler|technical|advanced|plain)\b/i,
    'example-style': /\b(example|analogy|visual|real[- ]world|story)\b/i,
    'learning-level': /\b(level|beginner|advanced|class|grade)\b/i,
  };
  return (
    quotedEvidence.includes(preference.value.toLocaleLowerCase()) &&
    preferenceCues[preference.field].test(quotedEvidence)
  );
};

const isAllowedByPolicy = (
  effect: LearningEffect,
  policy: AssistancePolicy,
) => {
  switch (effect.kind) {
    case 'retrieve-source':
      return policy.allowedOperations.length > 0;
    case 'remember-preference':
      return true;
    case 'create-activity':
      return (
        policy.allowedOperations.includes('concept') ||
        policy.allowedOperations.includes('distinct-practice')
      );
    case 'offer-practice':
      return policy.allowedOperations.includes('distinct-practice');
  }
};

const validateReferences = (
  selectors: LearningEffectSourceSelector[],
  context: LearningToolValidationContext,
): SourceReference[] => {
  const seen = new Set<string>();
  const references: SourceReference[] = [];
  for (const selector of selectors) {
    const key = sourceSelectorKey(selector);
    if (seen.has(key)) throw new LearningToolValidationError('invalid-input');
    seen.add(key);
    const matchingReferences = context.offeredReferences.filter(
      (reference) => sourceSelectorKey(reference) === key,
    );
    if (matchingReferences.length !== 1)
      throw new LearningToolValidationError('scope-denied');
    const [reference] = matchingReferences;
    if (!reference || reference.state !== 'current')
      throw new LearningToolValidationError('scope-denied');
    if (reference.courseId !== null && reference.courseId !== context.courseId)
      throw new LearningToolValidationError('scope-denied');
    if (
      reference.sourceKind === 'grade-evidence' &&
      (!context.gradeAccessEnabled ||
        context.gradeConsentRevision === undefined ||
        context.gradeConsentRevision !== context.policy.consentRevision)
    )
      throw new LearningToolValidationError('permission-revoked');
    references.push(reference);
  }
  return references;
};

export const validateLearningEffects = (
  input: unknown,
  context: LearningToolValidationContext,
): LearningEffect[] => {
  const parsed = z.array(learningEffectSchema).max(4).safeParse(input);
  if (!parsed.success) throw new LearningToolValidationError('invalid-input');
  const kinds = new Set<LearningEffectKind>();

  for (const effect of parsed.data) {
    if (kinds.has(effect.kind))
      throw new LearningToolValidationError('invalid-input');
    kinds.add(effect.kind);
    if (!isAllowedByPolicy(effect, context.policy))
      throw new LearningToolValidationError('permission-revoked');
    if (effect.kind === 'remember-preference') {
      if (
        !hasExplicitPreferenceEvidence(
          context.studentMessage,
          effect.evidence,
          effect.preference,
        )
      )
        throw new LearningToolValidationError('scope-denied');
      continue;
    }
    validateReferences(effect.references, context);
  }

  return parsed.data;
};

export const createLearningEffectIdempotencyKey = (
  turnId: string,
  effectIndex: number,
  effect: LearningEffect,
) => {
  const digest = createHash('sha256')
    .update(JSON.stringify(effect))
    .digest('hex');
  const seed = `${turnId}:${effectIndex}:${digest}`;
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const requestId = [
    bytes.subarray(0, 4).toString('hex'),
    bytes.subarray(4, 6).toString('hex'),
    bytes.subarray(6, 8).toString('hex'),
    bytes.subarray(8, 10).toString('hex'),
    bytes.subarray(10, 16).toString('hex'),
  ].join('-');
  return { digest, requestId };
};

export type LearningEffectExecutionContext = {
  authorizedContext: AuthorizedContext;
  sessionId: string;
  turnId: string;
  generationEpoch: number;
  contextRevision: number;
  courseId: string;
  targetAssignmentId: string | null;
  studentMessage: string;
  offeredReferences: SourceReference[];
  policy: AssistancePolicy;
  gradeAccessEnabled: boolean;
  gradeConsentRevision: number;
};

export type LearningEffectPersistenceInput = {
  sessionId: string;
  turnId: string;
  generationEpoch: number;
  contextRevision: number;
  policyRevision: number;
  gradeConsentRevision: number;
  courseId: string;
  targetAssignmentId: string | null;
  requestId: string;
  idempotencyKey: string;
  payloadDigest: string;
  effectIndex: number;
  policy: AssistancePolicy;
  references: SourceReference[];
};

export type LearningEffectHandlers = {
  isTurnCurrent: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      turnId: string;
      generationEpoch: number;
    },
  ) => Promise<boolean>;
  readContextRevision: (
    context: AuthorizedContext,
    input: { sessionId: string },
  ) => Promise<number | null>;
  resolveAssistancePolicy: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      targetAssignmentId: string | null;
      sourceIds: string[];
    },
  ) => Promise<AssistancePolicy | null>;
  getGradeSettings: (
    context: AuthorizedContext,
  ) => Promise<GradeSettings | null>;
  rememberPreference: (
    context: AuthorizedContext,
    input: LearningEffectPersistenceInput & {
      preference: PreferenceContent;
    },
  ) => Promise<MemoryDTO>;
  createActivity: (
    context: AuthorizedContext,
    input: LearningEffectPersistenceInput & {
      objective: string;
    },
  ) => Promise<{ artifactId: string; versionId: string; attemptId: string }>;
  offerPractice: (
    context: AuthorizedContext,
    input: LearningEffectPersistenceInput & {
      objective: string;
    },
  ) => Promise<{ practiceAttemptId: string }>;
};

export type ExecutedLearningEffect = {
  effectIndex: number;
  idempotencyKey: string;
  parts: MessagePart[];
};

export type LearningEffectRunResult = {
  effects: ExecutedLearningEffect[];
  errorCode: SafeErrorCode | null;
};

const safeEffectErrorCode = (error: unknown): SafeErrorCode => {
  if (!error || typeof error !== 'object') return 'provider-failed';
  const parsed = z
    .enum([
      'invalid-input',
      'not-found',
      'scope-denied',
      'session-changed',
      'permission-revoked',
      'busy',
      'revision-conflict',
      'cancelled',
      'offline',
      'needs-sign-in',
      'rate-limited',
      'capability-changed',
      'feature-unavailable',
      'unsupported',
      'unreadable',
      'limit-exceeded',
      'provider-failed',
      'storage-failed',
    ])
    .safeParse((error as { code?: unknown }).code);
  return parsed.success ? parsed.data : 'provider-failed';
};

const assertEffectCurrent = async (
  execution: LearningEffectExecutionContext,
  effect: LearningEffect,
  handlers: LearningEffectHandlers,
) => {
  const context = execution.authorizedContext;
  if (context.signal.aborted)
    throw new LearningToolValidationError('cancelled');
  if (!context.isCurrent())
    throw new LearningToolValidationError('session-changed');
  const turnIsCurrent = await handlers.isTurnCurrent(context, {
    sessionId: execution.sessionId,
    turnId: execution.turnId,
    generationEpoch: execution.generationEpoch,
  });
  if (!turnIsCurrent) throw new LearningToolValidationError('session-changed');
  const currentPolicy = await handlers.resolveAssistancePolicy(context, {
    sessionId: execution.sessionId,
    targetAssignmentId: execution.targetAssignmentId,
    sourceIds: execution.offeredReferences.map(({ sourceId }) => sourceId),
  });
  if (
    !currentPolicy ||
    currentPolicy.policyRevision !== execution.policy.policyRevision ||
    currentPolicy.consentRevision !== execution.gradeConsentRevision ||
    !isAllowedByPolicy(effect, currentPolicy)
  )
    throw new LearningToolValidationError('permission-revoked');
  const currentGradeSettings = await handlers.getGradeSettings(context);
  if (
    !currentGradeSettings ||
    currentGradeSettings.revision !== execution.gradeConsentRevision ||
    currentGradeSettings.enabled !== execution.gradeAccessEnabled
  )
    throw new LearningToolValidationError('permission-revoked');
  const contextRevision = await handlers.readContextRevision(context, {
    sessionId: execution.sessionId,
  });
  if (context.signal.aborted)
    throw new LearningToolValidationError('cancelled');
  if (!context.isCurrent())
    throw new LearningToolValidationError('session-changed');
  if (contextRevision !== execution.contextRevision)
    throw new LearningToolValidationError('revision-conflict');
};

export const runApprovedLearningEffects = async (
  execution: LearningEffectExecutionContext,
  rawEffects: unknown,
  handlers: LearningEffectHandlers,
): Promise<LearningEffectRunResult> => {
  const validationContext: LearningToolValidationContext = {
    courseId: execution.courseId,
    offeredReferences: execution.offeredReferences,
    studentMessage: execution.studentMessage,
    policy: execution.policy,
    gradeAccessEnabled: execution.gradeAccessEnabled,
    gradeConsentRevision: execution.gradeConsentRevision,
  };
  const effects = validateLearningEffects(rawEffects, validationContext);
  const completed: ExecutedLearningEffect[] = [];

  for (const [effectIndex, effect] of effects.entries()) {
    try {
      await assertEffectCurrent(execution, effect, handlers);
      const references =
        effect.kind === 'remember-preference'
          ? []
          : validateReferences(effect.references, validationContext);
      const { digest, requestId } = createLearningEffectIdempotencyKey(
        execution.turnId,
        effectIndex,
        effect,
      );
      const commonInput: LearningEffectPersistenceInput = {
        sessionId: execution.sessionId,
        turnId: execution.turnId,
        generationEpoch: execution.generationEpoch,
        contextRevision: execution.contextRevision,
        policyRevision: execution.policy.policyRevision,
        gradeConsentRevision: execution.gradeConsentRevision,
        courseId: execution.courseId,
        targetAssignmentId: execution.targetAssignmentId,
        requestId,
        idempotencyKey: `${execution.turnId}:${effectIndex}:${digest}`,
        payloadDigest: digest,
        effectIndex,
        policy: execution.policy,
        references,
      };
      let parts: MessagePart[];
      switch (effect.kind) {
        case 'retrieve-source':
          parts = references.map((reference) => ({
            kind: 'citation',
            reference,
          }));
          break;
        case 'remember-preference': {
          const memory = await handlers.rememberPreference(
            execution.authorizedContext,
            { ...commonInput, preference: effect.preference },
          );
          const savedPreference = preferenceContentSchema.safeParse(
            memory.content,
          );
          if (
            memory.type !== 'explicit-preference' ||
            !savedPreference.success ||
            savedPreference.data.field !== effect.preference.field ||
            savedPreference.data.value !== effect.preference.value
          )
            throw new LearningToolValidationError('storage-failed');
          parts = [
            {
              kind: 'status',
              code: 'preference-saved',
              label: 'Saved this preference to personal context.',
            },
          ];
          break;
        }
        case 'create-activity': {
          const artifact = await handlers.createActivity(
            execution.authorizedContext,
            { ...commonInput, objective: effect.objective },
          );
          const createdArtifact = z
            .strictObject({
              artifactId: z.string().min(1).max(300),
              versionId: z.string().min(1).max(300),
              attemptId: z.string().min(1).max(300),
            })
            .safeParse(artifact);
          if (!createdArtifact.success)
            throw new LearningToolValidationError('storage-failed');
          parts = [{ kind: 'activity', ...createdArtifact.data }];
          break;
        }
        case 'offer-practice': {
          const practice = await handlers.offerPractice(
            execution.authorizedContext,
            { ...commonInput, objective: effect.objective },
          );
          const createdPractice = z
            .strictObject({ practiceAttemptId: z.string().min(1).max(300) })
            .safeParse(practice);
          if (!createdPractice.success)
            throw new LearningToolValidationError('storage-failed');
          parts = [{ kind: 'practice', ...createdPractice.data }];
          break;
        }
      }
      await assertEffectCurrent(execution, effect, handlers);
      completed.push({
        effectIndex,
        idempotencyKey: commonInput.idempotencyKey,
        parts,
      });
    } catch (error) {
      return { effects: completed, errorCode: safeEffectErrorCode(error) };
    }
  }

  return { effects: completed, errorCode: null };
};
