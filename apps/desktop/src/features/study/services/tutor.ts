import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AssistancePolicy } from '@scholaros/services/learning/grade-contracts';
import type {
  AuthorizedContext,
  LearningLifecycle,
  SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import {
  idSchema,
  requestIdSchema,
  revisionSchema,
  safeErrorCodeSchema,
} from '@scholaros/services/learning/product-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import {
  studyMessagePartSchema,
  type MessagePart,
  type StudyTurnStatus,
} from '@scholaros/services/learning/study-contracts';
import {
  createLearningClient,
  LearningClientError,
  type LearningResponse,
  type TutorCandidatePart,
} from './learning-client';
import {
  LearningToolValidationError,
  runApprovedLearningEffects,
  validateLearningEffects,
  type LearningEffectHandlers,
  type LearningEffectKind,
} from './learning-tools';
import {
  prepareStudyContext,
  StudyContextError,
  type StudyContextDependencies,
  type StudyContextPreparation,
} from './study-context';

export const sendStudyTurnInputSchema = z
  .strictObject({
    sessionId: idSchema,
    requestId: requestIdSchema,
    expectedDraftRevision: revisionSchema,
    text: z.string().max(8000),
    attachmentIds: z.array(idSchema).max(8),
  })
  .refine(
    (input) => input.text.trim().length > 0 || input.attachmentIds.length > 0,
  );
export type SendStudyTurnInput = z.infer<typeof sendStudyTurnInputSchema>;

export const retryStudyTurnInputSchema = z.strictObject({
  sessionId: idSchema,
  turnId: idSchema,
  requestId: requestIdSchema,
});
export type RetryStudyTurnInput = z.infer<typeof retryStudyTurnInputSchema>;

export const cancelStudyTurnInputSchema = z.strictObject({
  sessionId: idSchema,
  turnId: idSchema,
});
export type CancelStudyTurnInput = z.infer<typeof cancelStudyTurnInputSchema>;

export type BeginStudyTurnRequest =
  | ({ kind: 'send' } & SendStudyTurnInput)
  | ({ kind: 'retry' } & RetryStudyTurnInput);

export type TurnAdmission = {
  sessionId: string;
  turnId: string;
  requestId: string;
  revision: number;
  generationEpoch: number;
  attemptNumber: number;
  contextRevision: number;
  policyRevision: number;
  gradeConsentRevision: number;
  studentMessage: string;
  attachmentIds: string[];
  executionRequired: boolean;
};

export type TutorCandidateAssessment = {
  allowed: boolean;
  safeParts?: MessagePart[];
  reasonCode: string;
  revision: number;
};

export type TutorCommitResult = { committed: boolean; revision: number };

export type TutorServiceDependencies = {
  beginStudyTurn: (
    context: AuthorizedContext,
    input: BeginStudyTurnRequest,
  ) => Promise<TurnAdmission>;
  setStudyTurnStatus: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      turnId: string;
      status: StudyTurnStatus;
    },
  ) => Promise<void>;
  settleStudyTurn: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      turnId: string;
      status: 'complete' | 'failed' | 'cancelled';
      errorCode?: SafeErrorCode;
    },
  ) => Promise<void>;
  commitStudyTurn: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      turnId: string;
      generationEpoch: number;
      contextRevision: number;
      policyRevision: number;
      gradeConsentRevision: number | null;
      gradeDerived: boolean;
      parts: MessagePart[];
      sourceReferences: SourceReference[];
    },
  ) => Promise<TutorCommitResult>;
  appendStudyTurnParts: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      turnId: string;
      generationEpoch: number;
      idempotencyKey: string;
      parts: MessagePart[];
    },
  ) => Promise<TutorCommitResult>;
  assessCandidate: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      turnId: string;
      candidate: {
        parts: TutorCandidatePart[];
        citations: SourceReference[];
        proposedEffects: unknown[];
      };
      policy: AssistancePolicy;
      sourceReferences: SourceReference[];
    },
  ) => Promise<TutorCandidateAssessment>;
  recordAssistance: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      turnId: string;
      generationEpoch: number;
      contextRevision: number;
      policyRevision: number;
      gradeConsentRevision: number;
      protectionId: string;
      allowedSupportSummary: string;
      riskTags: string[];
    },
  ) => Promise<void>;
  studyContext: StudyContextDependencies;
  learningClient: ReturnType<typeof createLearningClient>;
  learningEffectHandlers: LearningEffectHandlers;
};

export class TutorServiceError extends Error {
  readonly code: SafeErrorCode;

  constructor(code: SafeErrorCode) {
    super('The study turn could not be completed.');
    this.name = 'TutorServiceError';
    this.code = code;
  }
}

type ActiveTurnExecution = {
  controller: AbortController;
  promise: Promise<void>;
};

const fallbackPart: MessagePart = {
  kind: 'status',
  code: 'safe-response-unavailable',
  label:
    'I couldn’t safely prepare that response; try asking about a concept or a different source.',
};

const errorCodeFrom = (error: unknown): SafeErrorCode => {
  if (
    error instanceof TutorServiceError ||
    error instanceof StudyContextError ||
    error instanceof LearningClientError ||
    error instanceof LearningToolValidationError
  )
    return error.code;
  if (error && typeof error === 'object') {
    const parsed = safeErrorCodeSchema.safeParse(
      (error as { code?: unknown }).code,
    );
    if (parsed.success) return parsed.data;
  }
  return 'provider-failed';
};

const operationKey = (context: AuthorizedContext, admission: TurnAdmission) =>
  `${context.userId}:${admission.sessionId}:${admission.turnId}`;

const candidateParts = (response: LearningResponse): MessagePart[] => {
  const parts: MessagePart[] = [...response.parts];
  const existingReferences = new Set(
    parts.flatMap((part) =>
      part.kind === 'citation' ? [JSON.stringify(part.reference)] : [],
    ),
  );
  for (const reference of response.citations) {
    const key = JSON.stringify(reference);
    if (!existingReferences.has(key)) {
      parts.push({ kind: 'citation', reference });
      existingReferences.add(key);
    }
  }
  return parts;
};

const validateSafeParts = (
  parts: MessagePart[],
  offeredReferences: SourceReference[],
) => {
  const parsed = z.array(studyMessagePartSchema).max(100).safeParse(parts);
  if (!parsed.success) throw new TutorServiceError('invalid-input');
  const offered = new Set(
    offeredReferences.map((reference) => JSON.stringify(reference)),
  );
  for (const part of parsed.data) {
    if (
      part.kind === 'citation' &&
      !offered.has(JSON.stringify(part.reference))
    )
      throw new TutorServiceError('scope-denied');
    if (
      part.kind !== 'text' &&
      part.kind !== 'citation' &&
      part.kind !== 'status'
    )
      throw new TutorServiceError('invalid-input');
  }
  return parsed.data;
};

const safeRegenerationReason = (value: string) =>
  /^[a-z0-9-]{1,100}$/i.test(value) ? value : 'policy-rejected';

export const createTutorService = (
  dependencies: TutorServiceDependencies,
  lifecycle: LearningLifecycle,
) => {
  const activeExecutions = new Map<string, ActiveTurnExecution>();

  const assertTurnCurrent = async (
    context: AuthorizedContext,
    admission: TurnAdmission,
    preparation: StudyContextPreparation,
  ) => {
    if (context.signal.aborted) throw new TutorServiceError('cancelled');
    if (!context.isCurrent()) throw new TutorServiceError('session-changed');
    const [sessionSnapshot, contextRevision, gradeSettings, currentPolicy] =
      await Promise.all([
        dependencies.studyContext.getStudySession(context, {
          sessionId: admission.sessionId,
          limit: 1,
        }),
        dependencies.studyContext.readContextRevision(context, {
          sessionId: admission.sessionId,
        }),
        dependencies.studyContext.getGradeSettings(context),
        dependencies.studyContext.resolveAssistancePolicy(context, {
          sessionId: admission.sessionId,
          targetAssignmentId: preparation.session.targetAssignmentId,
          sourceIds: preparation.offeredReferences.map(
            ({ sourceId }) => sourceId,
          ),
        }),
      ]);
    if (context.signal.aborted || !context.isCurrent())
      throw new TutorServiceError('session-changed');
    if (
      !sessionSnapshot ||
      sessionSnapshot.session.id !== admission.sessionId ||
      sessionSnapshot.session.generationEpoch !== admission.generationEpoch
    )
      throw new TutorServiceError('session-changed');
    if (
      contextRevision === null ||
      contextRevision !== admission.contextRevision
    )
      throw new TutorServiceError('revision-conflict');
    if (
      !gradeSettings ||
      gradeSettings.revision !== admission.gradeConsentRevision ||
      gradeSettings.enabled !== preparation.gradeAccessEnabled
    )
      throw new TutorServiceError('permission-revoked');
    if (
      !currentPolicy ||
      currentPolicy.policyRevision !== admission.policyRevision ||
      currentPolicy.consentRevision !== admission.gradeConsentRevision
    )
      throw new TutorServiceError('permission-revoked');
  };

  const finishFailedTurn = async (
    context: AuthorizedContext,
    admission: TurnAdmission,
    errorCode: SafeErrorCode,
  ) => {
    const status =
      errorCode === 'cancelled' || errorCode === 'session-changed'
        ? 'cancelled'
        : 'failed';
    await dependencies.settleStudyTurn(context, {
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      status,
      errorCode,
    });
  };

  const runTurn = async (
    context: AuthorizedContext,
    admission: TurnAdmission,
  ) => {
    await dependencies.setStudyTurnStatus(context, {
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      status: 'preparing',
    });
    const preparation = await prepareStudyContext(
      context,
      {
        sessionId: admission.sessionId,
        turnId: admission.turnId,
        text: admission.studentMessage,
        attachmentIds: admission.attachmentIds,
        contextRevision: admission.contextRevision,
        policyRevision: admission.policyRevision,
        gradeConsentRevision: admission.gradeConsentRevision,
      },
      dependencies.studyContext,
    );
    if (preparation.session.generationEpoch !== admission.generationEpoch)
      throw new TutorServiceError('session-changed');

    await dependencies.setStudyTurnStatus(context, {
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      status: 'generating',
    });

    let acceptedParts: MessagePart[] | null = null;
    let acceptedEffects: unknown[] = [];
    let candidateAssessment: TutorCandidateAssessment | null = null;
    let regenerationReason: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assertTurnCurrent(context, admission, preparation);
      const requestId = attempt === 1 ? admission.requestId : randomUUID();
      let response: LearningResponse;
      try {
        response = await dependencies.learningClient.generateTutorCandidate(
          {
            requestId,
            sessionId: admission.sessionId,
            courseId: preparation.session.courseId,
            message: admission.studentMessage,
            context: preparation.context,
            ...(attempt === 2
              ? {
                  safeRegeneration: {
                    attemptNumber: 2 as const,
                    reasonCode: regenerationReason ?? 'candidate-rejected',
                  },
                }
              : {}),
          },
          context.signal,
        );
      } catch (error) {
        if (
          error instanceof LearningClientError &&
          error.candidateInvalid &&
          attempt === 1
        ) {
          regenerationReason = 'invalid-candidate';
          continue;
        }
        throw error;
      }
      await dependencies.setStudyTurnStatus(context, {
        sessionId: admission.sessionId,
        turnId: admission.turnId,
        status: 'checking',
      });

      let effects;
      try {
        effects = validateLearningEffects(response.proposedEffects, {
          courseId: preparation.session.courseId,
          offeredReferences: preparation.offeredReferences,
          studentMessage: admission.studentMessage,
          policy: preparation.context.policy,
          gradeAccessEnabled: preparation.gradeAccessEnabled,
          gradeConsentRevision: admission.gradeConsentRevision,
        });
      } catch {
        if (attempt === 1) {
          regenerationReason = 'invalid-tool-proposal';
          continue;
        }
        break;
      }

      const assessment = await dependencies.assessCandidate(context, {
        sessionId: admission.sessionId,
        turnId: admission.turnId,
        candidate: {
          parts: response.parts,
          citations: response.citations,
          proposedEffects: effects,
        },
        policy: preparation.context.policy,
        sourceReferences: preparation.offeredReferences,
      });
      candidateAssessment = assessment;
      if (!assessment.allowed) {
        if (attempt === 1) {
          regenerationReason = safeRegenerationReason(assessment.reasonCode);
          continue;
        }
        break;
      }

      acceptedParts = assessment.safeParts
        ? validateSafeParts(assessment.safeParts, preparation.offeredReferences)
        : validateSafeParts(
            candidateParts(response),
            preparation.offeredReferences,
          );
      acceptedEffects = assessment.safeParts ? [] : effects;
      break;
    }

    const safeParts =
      acceptedParts ??
      (candidateAssessment?.safeParts
        ? validateSafeParts(
            candidateAssessment.safeParts,
            preparation.offeredReferences,
          )
        : [fallbackPart]);
    const gradeDerived =
      (acceptedParts !== null ||
        candidateAssessment?.safeParts !== undefined) &&
      preparation.gradeDerived;
    await assertTurnCurrent(context, admission, preparation);

    const commitResult = await dependencies.commitStudyTurn(context, {
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      generationEpoch: admission.generationEpoch,
      contextRevision: preparation.context.contextRevision,
      policyRevision: preparation.context.policy.policyRevision,
      gradeConsentRevision: gradeDerived
        ? preparation.gradeConsentRevision
        : null,
      gradeDerived,
      parts: safeParts,
      sourceReferences: safeParts.flatMap((part) =>
        part.kind === 'citation' ? [part.reference] : [],
      ),
    });
    if (!commitResult.committed) throw new TutorServiceError('session-changed');

    const policy = preparation.context.policy;
    if (policy.canonicalProtectionId) {
      await assertTurnCurrent(context, admission, preparation);
      await dependencies.recordAssistance(context, {
        sessionId: admission.sessionId,
        turnId: admission.turnId,
        generationEpoch: admission.generationEpoch,
        contextRevision: admission.contextRevision,
        policyRevision: admission.policyRevision,
        gradeConsentRevision: admission.gradeConsentRevision,
        protectionId: policy.canonicalProtectionId,
        allowedSupportSummary: JSON.stringify({
          textPartCount: safeParts.filter((part) => part.kind === 'text')
            .length,
          citationCount: safeParts.filter((part) => part.kind === 'citation')
            .length,
          effectKinds: acceptedEffects.map(
            (effect) => (effect as { kind: LearningEffectKind }).kind,
          ),
        }),
        riskTags: acceptedEffects.map(
          (effect) => (effect as { kind: LearningEffectKind }).kind,
        ),
      });
    }

    if (acceptedEffects.length > 0) {
      const effectResult = await runApprovedLearningEffects(
        {
          authorizedContext: context,
          sessionId: admission.sessionId,
          turnId: admission.turnId,
          generationEpoch: admission.generationEpoch,
          contextRevision: preparation.context.contextRevision,
          courseId: preparation.session.courseId,
          targetAssignmentId: preparation.session.targetAssignmentId,
          studentMessage: admission.studentMessage,
          offeredReferences: preparation.offeredReferences,
          policy: preparation.context.policy,
          gradeAccessEnabled: preparation.gradeAccessEnabled,
          gradeConsentRevision: admission.gradeConsentRevision,
        },
        acceptedEffects,
        dependencies.learningEffectHandlers,
      );
      for (const effect of effectResult.effects) {
        const appended = await dependencies.appendStudyTurnParts(context, {
          sessionId: admission.sessionId,
          turnId: admission.turnId,
          generationEpoch: admission.generationEpoch,
          idempotencyKey: effect.idempotencyKey,
          parts: effect.parts,
        });
        if (!appended.committed) throw new TutorServiceError('session-changed');
      }
      if (effectResult.errorCode) {
        const appended = await dependencies.appendStudyTurnParts(context, {
          sessionId: admission.sessionId,
          turnId: admission.turnId,
          generationEpoch: admission.generationEpoch,
          idempotencyKey: `${admission.turnId}:effects-unavailable`,
          parts: [
            {
              kind: 'status',
              code: 'learning-action-unavailable',
              label:
                'Your explanation is saved, but one learning action could not be completed.',
            },
          ],
        });
        if (!appended.committed) throw new TutorServiceError('session-changed');
      }
    }

    await dependencies.settleStudyTurn(context, {
      sessionId: admission.sessionId,
      turnId: admission.turnId,
      status: 'complete',
    });
  };

  const launchTurn = (
    authorizedContext: AuthorizedContext,
    admission: TurnAdmission,
  ) => {
    const key = operationKey(authorizedContext, admission);
    const existing = activeExecutions.get(key);
    if (existing) return;

    const controller = new AbortController();
    const abortFromSession = () => controller.abort();
    authorizedContext.signal.addEventListener('abort', abortFromSession, {
      once: true,
    });
    if (authorizedContext.signal.aborted) controller.abort();
    const unregister = lifecycle.registerOperation(
      key,
      admission.turnId,
      controller,
    );
    let execution: ActiveTurnExecution;
    const promise = Promise.resolve()
      .then(() =>
        runTurn({ ...authorizedContext, signal: controller.signal }, admission),
      )
      .catch(async (error: unknown) => {
        const code = errorCodeFrom(error);
        try {
          await finishFailedTurn(authorizedContext, admission, code);
        } catch {
          return;
        }
      })
      .finally(() => {
        authorizedContext.signal.removeEventListener('abort', abortFromSession);
        unregister();
        if (activeExecutions.get(key) === execution)
          activeExecutions.delete(key);
      });
    execution = { controller, promise };
    activeExecutions.set(key, execution);
  };

  const sendStudyTurn = async (
    context: AuthorizedContext,
    rawInput: SendStudyTurnInput,
  ) => {
    const parsed = sendStudyTurnInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new TutorServiceError('invalid-input');
    if (!context.isCurrent() || context.signal.aborted)
      throw new TutorServiceError('session-changed');
    const admission = await dependencies.beginStudyTurn(context, {
      kind: 'send',
      ...parsed.data,
    });
    if (admission.executionRequired) launchTurn(context, admission);
    return { turnId: admission.turnId, revision: admission.revision };
  };

  const retryStudyTurn = async (
    context: AuthorizedContext,
    rawInput: RetryStudyTurnInput,
  ) => {
    const parsed = retryStudyTurnInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new TutorServiceError('invalid-input');
    if (!context.isCurrent() || context.signal.aborted)
      throw new TutorServiceError('session-changed');
    const admission = await dependencies.beginStudyTurn(context, {
      kind: 'retry',
      ...parsed.data,
    });
    if (admission.executionRequired) launchTurn(context, admission);
    return { turnId: admission.turnId, revision: admission.revision };
  };

  const cancelStudyTurn = async (
    context: AuthorizedContext,
    rawInput: CancelStudyTurnInput,
  ) => {
    const parsed = cancelStudyTurnInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new TutorServiceError('invalid-input');
    const key = `${context.userId}:${parsed.data.sessionId}:${parsed.data.turnId}`;
    const active = activeExecutions.get(key);
    if (active) {
      active.controller.abort();
      await active.promise;
      return;
    }
    if (!context.isCurrent()) throw new TutorServiceError('session-changed');
    await dependencies.settleStudyTurn(context, {
      sessionId: parsed.data.sessionId,
      turnId: parsed.data.turnId,
      status: 'cancelled',
      errorCode: 'cancelled',
    });
  };

  const cleanup = async () => {
    const executions = [...activeExecutions.values()];
    for (const execution of executions) execution.controller.abort();
    await Promise.allSettled(executions.map(({ promise }) => promise));
  };

  lifecycle.onTeardown(cleanup);
  return { sendStudyTurn, retryStudyTurn, cancelStudyTurn, cleanup };
};
