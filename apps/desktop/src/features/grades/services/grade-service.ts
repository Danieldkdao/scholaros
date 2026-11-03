import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  GradeSettings,
  GradeVerificationDTO,
} from '@scholaros/services/learning/grade-contracts';
import type {
  AuthorizedContext,
  LearningLifecycle,
  SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import {
  idSchema,
  requestIdSchema,
  revisionSchema,
} from '@scholaros/services/learning/product-contracts';
import { gradeSettingsSchema } from '@scholaros/services/learning/grade-contracts';
import { sourceReferenceSchema } from '@scholaros/services/learning/context-contracts';
import type { GradeObservation, GradeSourceRecord } from './grade-collector';

const verificationFreshnessMs = 15 * 60 * 1000;

export const saveGradeSettingsInputSchema = z.strictObject({
  enabled: z.boolean(),
  notes: z.string().max(2000),
  expectedRevision: revisionSchema,
  deleteCollected: z.boolean().optional(),
});
export type SaveGradeSettingsInput = z.infer<
  typeof saveGradeSettingsInputSchema
>;

export const verifyCourseworkInputSchema = z.strictObject({
  courseId: idSchema,
  assignmentId: idSchema,
  requestId: requestIdSchema,
});
export type VerifyCourseworkInput = z.infer<typeof verifyCourseworkInputSchema>;

export const getVerifiedCourseworkEvidenceInputSchema = z.strictObject({
  courseId: idSchema,
  assignmentId: idSchema,
});
export type GetVerifiedCourseworkEvidenceInput = z.infer<
  typeof getVerifiedCourseworkEvidenceInputSchema
>;

export type StoredGradeEvidence = {
  consentRevision: number;
  assignmentVersion: string;
  verification: GradeVerificationDTO;
};

export type SaveGradeEvidenceInput = {
  source: GradeSourceRecord;
  consentRevision: number;
  sourceVersion: string;
  verification: GradeVerificationDTO;
};

export type GradeServiceStore = {
  getSettings: (userId: string) => GradeSettings;
  saveSettings: (
    context: AuthorizedContext,
    input: SaveGradeSettingsInput,
  ) => GradeSettings;
  getSource: (
    context: AuthorizedContext,
    courseId: string,
    assignmentId: string,
  ) => GradeSourceRecord | null;
  ensureProtection: (
    context: AuthorizedContext,
    source: GradeSourceRecord,
  ) => number;
  getEvidence: (
    context: AuthorizedContext,
    source: GradeSourceRecord,
  ) => StoredGradeEvidence | null;
  saveEvidence: (
    context: AuthorizedContext,
    input: SaveGradeEvidenceInput,
  ) => StoredGradeEvidence | null;
  revokeEvidence: (context: AuthorizedContext, now: string) => void;
  deleteCollected: (context: AuthorizedContext) => void;
};

export class GradeServiceError extends Error {
  constructor(
    readonly code: SafeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GradeServiceError';
  }
}

type FeedbackCacheEntry = {
  assignmentVersion: string;
  consentRevision: number;
  feedback: string;
  expiresAt: number;
};

type GradeServiceDependencies = {
  store: GradeServiceStore;
  collect: (
    context: AuthorizedContext,
    source: GradeSourceRecord,
    signal: AbortSignal,
  ) => Promise<GradeObservation>;
  lifecycle?: Pick<LearningLifecycle, 'isCurrent' | 'registerOperation'>;
  now?: () => number;
  onSettingsChanged?: (
    context: AuthorizedContext,
    settings: GradeSettings,
    deletedCollected: boolean,
  ) => Promise<void> | void;
  onEvidenceUpdated?: (
    context: AuthorizedContext,
    verification: GradeVerificationDTO,
  ) => void;
};

const unknownVerification = (
  courseId: string,
  assignmentId: string,
  consentRevision: number,
  policyRevision: number,
  reasonCode: string,
): GradeVerificationDTO => ({
  courseId,
  assignmentId,
  state: 'unknown',
  completion: 'unknown',
  grade: null,
  remainingOpportunity: 'unknown',
  feedback: null,
  observedAt: null,
  consentRevision,
  policyRevision,
  sourceReferences: [],
  reasonCode,
});

const stateForObservation = (observation: GradeObservation) => {
  if (observation.conflicts.length) return 'unknown' as const;
  if (
    observation.completion === 'no' ||
    observation.remainingOpportunity === 'yes'
  )
    return 'active' as const;
  if (
    observation.completion === 'yes' &&
    observation.grade !== null &&
    observation.remainingOpportunity === 'no'
  )
    return 'verified-completed' as const;
  return 'unknown' as const;
};

const reasonForObservation = (observation: GradeObservation) => {
  if (observation.conflicts.length) return 'conflicting-evidence';
  if (observation.completion === 'no') return 'coursework-active';
  if (observation.remainingOpportunity === 'yes') return 'opportunity-remains';
  if (observation.grade === null) return 'grade-unavailable';
  if (observation.completion !== 'yes') return 'completion-unverified';
  if (observation.remainingOpportunity !== 'no') return 'opportunity-unknown';
  return 'verified';
};

const sourceReferencesFor = (
  source: GradeSourceRecord,
  observation: GradeObservation,
  evidenceId: string,
) => {
  const locators = [
    observation.locators.grade,
    observation.locators.completion,
    observation.locators.opportunity,
  ].filter((locator) => locator !== null);
  return locators.map((locator) =>
    sourceReferenceSchema.parse({
      sourceKind: 'grade-evidence',
      sourceId: evidenceId,
      versionId: observation.contentDigest,
      courseId: source.courseId,
      locator,
      title: source.assignmentTitle.slice(0, 300),
      provenance: 'connected-source',
      observedAt: observation.observedAt,
      state: 'current',
    }),
  );
};

export const createGradeService = ({
  store,
  collect,
  lifecycle,
  now = Date.now,
  onSettingsChanged,
  onEvidenceUpdated,
}: GradeServiceDependencies) => {
  const activeOperations = new Map<string, Set<AbortController>>();
  const pendingVerifications = new Map<string, Promise<GradeVerificationDTO>>();
  const feedbackCache = new Map<string, FeedbackCacheEntry>();
  let disposed = false;

  const isCurrent = (context: AuthorizedContext) =>
    !disposed &&
    !context.signal.aborted &&
    context.isCurrent() &&
    (!lifecycle || lifecycle.isCurrent(context.epoch));

  const assertCurrent = (context: AuthorizedContext) => {
    if (!isCurrent(context))
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
  };

  const cancelAccountOperations = (userId: string) => {
    for (const controller of activeOperations.get(userId) ?? [])
      controller.abort(
        new GradeServiceError('permission-revoked', 'Grade access changed.'),
      );
    activeOperations.delete(userId);
    for (const key of feedbackCache.keys())
      if (key.startsWith(`${userId}:`)) feedbackCache.delete(key);
  };

  const getGradeSettings = async (
    context: AuthorizedContext,
  ): Promise<GradeSettings> => {
    assertCurrent(context);
    const settings = gradeSettingsSchema.parse(
      store.getSettings(context.userId),
    );
    assertCurrent(context);
    return settings;
  };

  const saveGradeSettings = async (
    context: AuthorizedContext,
    input: unknown,
  ): Promise<GradeSettings> => {
    const parsed = saveGradeSettingsInputSchema.safeParse(input);
    if (!parsed.success)
      throw new GradeServiceError(
        'invalid-input',
        'Check the grade access settings.',
      );
    if (parsed.data.enabled && parsed.data.deleteCollected)
      throw new GradeServiceError(
        'invalid-input',
        'Turn grade access off before deleting collected grades.',
      );
    assertCurrent(context);
    const currentSettings = store.getSettings(context.userId);
    if (currentSettings.revision !== parsed.data.expectedRevision)
      throw new GradeServiceError(
        'revision-conflict',
        'Grade settings changed; refresh and try again.',
      );
    const changed =
      currentSettings.enabled !== parsed.data.enabled ||
      currentSettings.notes !== parsed.data.notes ||
      parsed.data.deleteCollected === true;
    if (!changed) return currentSettings;

    const updatedSettings = store.saveSettings(context, parsed.data);
    cancelAccountOperations(context.userId);
    store.revokeEvidence(context, new Date(now()).toISOString());
    await onSettingsChanged?.(
      context,
      updatedSettings,
      parsed.data.deleteCollected === true,
    );
    if (!isCurrent(context))
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
    if (parsed.data.deleteCollected) store.deleteCollected(context);
    if (!isCurrent(context))
      throw new GradeServiceError(
        'session-changed',
        'Your session changed; sign in again.',
      );
    return gradeSettingsSchema.parse(store.getSettings(context.userId));
  };

  const verifyCoursework = async (
    context: AuthorizedContext,
    input: unknown,
  ): Promise<GradeVerificationDTO> => {
    const parsed = verifyCourseworkInputSchema.safeParse(input);
    if (!parsed.success)
      throw new GradeServiceError(
        'invalid-input',
        'Choose a valid course assignment.',
      );
    assertCurrent(context);
    let currentSettings = store.getSettings(context.userId);
    if (!currentSettings.enabled)
      return unknownVerification(
        parsed.data.courseId,
        parsed.data.assignmentId,
        currentSettings.revision,
        0,
        'grade-access-disabled',
      );

    const source = store.getSource(
      context,
      parsed.data.courseId,
      parsed.data.assignmentId,
    );
    if (!source)
      return unknownVerification(
        parsed.data.courseId,
        parsed.data.assignmentId,
        currentSettings.revision,
        0,
        'source-unavailable',
      );
    const policyRevision = store.ensureProtection(context, source);
    if (source.suppressed)
      return unknownVerification(
        source.courseId,
        source.assignmentId,
        currentSettings.revision,
        policyRevision,
        'source-suppressed',
      );
    if (!source.eligible)
      return unknownVerification(
        source.courseId,
        source.assignmentId,
        currentSettings.revision,
        policyRevision,
        'source-not-authorized',
      );

    const consentRevision = currentSettings.revision;
    const operationKey = `${context.userId}:${context.epoch}:${source.courseId}:${source.assignmentId}:${consentRevision}`;
    const pendingVerification = pendingVerifications.get(operationKey);
    if (pendingVerification) return pendingVerification;
    const verification = (async () => {
      const controller = new AbortController();
      const operations = activeOperations.get(context.userId) ?? new Set();
      operations.add(controller);
      activeOperations.set(context.userId, operations);
      const unregister = lifecycle?.registerOperation(
        `grades:${context.userId}:${source.courseId}:${source.assignmentId}`,
        parsed.data.requestId,
        controller,
      );
      const signal = AbortSignal.any([context.signal, controller.signal]);
      try {
        signal.throwIfAborted();
        const observation = await collect(context, source, signal);
        signal.throwIfAborted();
        assertCurrent(context);
        currentSettings = store.getSettings(context.userId);
        if (
          !currentSettings.enabled ||
          currentSettings.revision !== consentRevision
        )
          return unknownVerification(
            source.courseId,
            source.assignmentId,
            currentSettings.revision,
            policyRevision,
            'permission-revoked',
          );
        const state = stateForObservation(observation);
        const evidenceId = randomUUID();
        const verification: GradeVerificationDTO = {
          courseId: source.courseId,
          assignmentId: source.assignmentId,
          state,
          completion: observation.completion,
          grade: observation.conflicts.length ? null : observation.grade,
          remainingOpportunity: observation.remainingOpportunity,
          feedback:
            state === 'verified-completed' ? observation.feedback : null,
          observedAt: observation.observedAt,
          consentRevision,
          policyRevision: policyRevision + 1,
          sourceReferences: sourceReferencesFor(
            source,
            observation,
            evidenceId,
          ),
          reasonCode: reasonForObservation(observation),
        };
        const sourceVersion = JSON.stringify({
          assignmentVersion: source.sourceVersion,
          contentDigest: observation.contentDigest,
        });
        const savedEvidence = store.saveEvidence(context, {
          source,
          consentRevision,
          sourceVersion,
          verification,
        });
        if (!savedEvidence) {
          const latestSettings = store.getSettings(context.userId);
          if (
            !latestSettings.enabled ||
            latestSettings.revision !== consentRevision
          )
            return unknownVerification(
              source.courseId,
              source.assignmentId,
              latestSettings.revision,
              policyRevision,
              'permission-revoked',
            );
          const latestSource = store.getSource(
            context,
            source.courseId,
            source.assignmentId,
          );
          const reasonCode = !latestSource
            ? 'source-unavailable'
            : latestSource.suppressed
              ? 'source-suppressed'
              : !latestSource.eligible
                ? 'source-not-authorized'
                : latestSource.sourceVersion !== source.sourceVersion ||
                    latestSource.policyRevision !== source.policyRevision
                  ? 'evidence-stale'
                  : 'source-unavailable';
          return unknownVerification(
            source.courseId,
            source.assignmentId,
            latestSettings.revision,
            latestSource?.policyRevision ?? policyRevision,
            reasonCode,
          );
        }
        onEvidenceUpdated?.(context, savedEvidence.verification);
        if (savedEvidence.verification.feedback) {
          const key = `${context.userId}:${source.courseId}:${source.assignmentId}`;
          feedbackCache.set(key, {
            assignmentVersion: source.sourceVersion,
            consentRevision,
            feedback: savedEvidence.verification.feedback,
            expiresAt: now() + verificationFreshnessMs,
          });
        }
        return savedEvidence.verification;
      } catch {
        if (!isCurrent(context))
          throw new GradeServiceError(
            'session-changed',
            'Your session changed; sign in again.',
          );
        const latestSettings = store.getSettings(context.userId);
        if (
          !latestSettings.enabled ||
          latestSettings.revision !== consentRevision
        )
          return unknownVerification(
            source.courseId,
            source.assignmentId,
            latestSettings.revision,
            policyRevision,
            'permission-revoked',
          );
        return unknownVerification(
          source.courseId,
          source.assignmentId,
          latestSettings.revision,
          policyRevision,
          'source-unavailable',
        );
      } finally {
        unregister?.();
        operations.delete(controller);
        if (
          !operations.size &&
          activeOperations.get(context.userId) === operations
        )
          activeOperations.delete(context.userId);
      }
    })();
    pendingVerifications.set(operationKey, verification);
    try {
      return await verification;
    } finally {
      if (pendingVerifications.get(operationKey) === verification)
        pendingVerifications.delete(operationKey);
    }
  };

  const getVerifiedCourseworkEvidence = async (
    context: AuthorizedContext,
    input: unknown,
  ): Promise<GradeVerificationDTO | null> => {
    const parsed = getVerifiedCourseworkEvidenceInputSchema.safeParse(input);
    if (!parsed.success) return null;
    try {
      assertCurrent(context);
      const currentSettings = store.getSettings(context.userId);
      if (!currentSettings.enabled)
        return unknownVerification(
          parsed.data.courseId,
          parsed.data.assignmentId,
          currentSettings.revision,
          0,
          'grade-access-disabled',
        );
      const source = store.getSource(
        context,
        parsed.data.courseId,
        parsed.data.assignmentId,
      );
      if (!source)
        return unknownVerification(
          parsed.data.courseId,
          parsed.data.assignmentId,
          currentSettings.revision,
          0,
          'source-unavailable',
        );
      const policyRevision = store.ensureProtection(context, source);
      if (source.suppressed)
        return unknownVerification(
          source.courseId,
          source.assignmentId,
          currentSettings.revision,
          policyRevision,
          'source-suppressed',
        );
      if (!source.eligible)
        return unknownVerification(
          source.courseId,
          source.assignmentId,
          currentSettings.revision,
          policyRevision,
          'source-not-authorized',
        );
      const evidence = store.getEvidence(context, source);
      if (
        !evidence ||
        evidence.consentRevision !== currentSettings.revision ||
        evidence.assignmentVersion !== source.sourceVersion
      )
        return unknownVerification(
          source.courseId,
          source.assignmentId,
          currentSettings.revision,
          policyRevision,
          'evidence-stale',
        );
      const observedAt = Date.parse(evidence.verification.observedAt ?? '');
      const age = now() - observedAt;
      if (
        !Number.isFinite(observedAt) ||
        age < 0 ||
        age > verificationFreshnessMs
      )
        return unknownVerification(
          source.courseId,
          source.assignmentId,
          currentSettings.revision,
          evidence.verification.policyRevision,
          'evidence-stale',
        );
      const cachedFeedback = feedbackCache.get(
        `${context.userId}:${source.courseId}:${source.assignmentId}`,
      );
      return {
        ...evidence.verification,
        feedback:
          cachedFeedback &&
          cachedFeedback.consentRevision === currentSettings.revision &&
          cachedFeedback.assignmentVersion === source.sourceVersion &&
          cachedFeedback.expiresAt >= now()
            ? cachedFeedback.feedback
            : null,
      };
    } catch {
      return null;
    }
  };

  const dispose = async () => {
    disposed = true;
    for (const controllers of activeOperations.values())
      for (const controller of controllers) controller.abort();
    activeOperations.clear();
    pendingVerifications.clear();
    feedbackCache.clear();
  };

  return {
    getGradeSettings,
    saveGradeSettings,
    verifyCoursework,
    getVerifiedCourseworkEvidence,
    dispose,
  };
};
