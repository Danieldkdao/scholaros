import { z } from 'zod';
import type {
  AssistancePolicy,
  GradeSettings,
} from '@scholaros/services/learning/grade-contracts';
import type { PersonalContext } from '@scholaros/services/learning/memory-contracts';
import { gradeSettingsSchema } from '@scholaros/services/learning/grade-contracts';
import { personalContextSchema } from '@scholaros/services/learning/memory-contracts';
import type {
  AuthorizedContext,
  SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import { revisionSchema } from '@scholaros/services/learning/product-contracts';
import {
  sourcePassageSchema,
  type SourcePassage,
  type SourceReference,
} from '@scholaros/services/learning/context-contracts';
import {
  preparedStudyContextSchema,
  type PreparedStudyContext,
  type SessionSnapshot,
} from '@scholaros/services/learning/study-contracts';

export const studyContextInputSchema = z.strictObject({
  sessionId: z.string().min(1).max(300),
  turnId: z.string().min(1).max(300),
  text: z.string().max(8000),
  attachmentIds: z.array(z.string().min(1).max(300)).max(8),
  contextRevision: z.number().int().nonnegative().safe(),
  policyRevision: z.number().int().nonnegative().safe(),
  gradeConsentRevision: z.number().int().nonnegative().safe(),
});
export type StudyContextInput = z.infer<typeof studyContextInputSchema>;

export type StudySourceReadResult = {
  passages: SourcePassage[];
  status: 'current' | 'stale' | 'partial' | 'unavailable';
  lastSuccessfulAt: string | null;
};

export type StudyContextDependencies = {
  getStudySession: (
    context: AuthorizedContext,
    input: { sessionId: string; limit?: number },
  ) => Promise<SessionSnapshot | null>;
  readCourseSources: (
    context: AuthorizedContext,
    input: {
      sessionId: string;
      courseId: string;
      targetAssignmentId: string | null;
      gradeAccessEnabled: boolean;
      gradeConsentRevision: number;
      query: string;
    },
  ) => Promise<StudySourceReadResult | null>;
  readSelectedSources: (
    context: AuthorizedContext,
    input: { sessionId: string; query: string; selectedIds: string[] },
  ) => Promise<StudySourceReadResult | null>;
  preparePersonalContext: (
    context: AuthorizedContext,
    input: { sessionId: string; courseId: string },
  ) => Promise<PersonalContext | null>;
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
};

export type StudyContextPreparation = {
  session: SessionSnapshot['session'];
  context: PreparedStudyContext;
  offeredReferences: SourceReference[];
  gradeDerived: boolean;
  gradeAccessEnabled: boolean;
  gradeConsentRevision: number | null;
};

export class StudyContextError extends Error {
  readonly code: SafeErrorCode;

  constructor(code: SafeErrorCode) {
    super('The selected study context is no longer available.');
    this.name = 'StudyContextError';
    this.code = code;
  }
}

const referenceKey = (reference: SourceReference) =>
  JSON.stringify([
    reference.sourceKind,
    reference.sourceId,
    reference.versionId,
    reference.courseId,
    reference.locator,
  ]);

const requireCurrent = (context: AuthorizedContext) => {
  if (context.signal.aborted) throw new StudyContextError('cancelled');
  if (!context.isCurrent()) throw new StudyContextError('session-changed');
};

const validateReadResult = (result: StudySourceReadResult | null) => {
  if (result === null) return null;
  const passages = z
    .array(sourcePassageSchema)
    .max(500)
    .safeParse(result.passages);
  if (
    !passages.success ||
    !['current', 'stale', 'partial', 'unavailable'].includes(result.status) ||
    (result.lastSuccessfulAt !== null &&
      !z.iso.datetime({ offset: true }).safeParse(result.lastSuccessfulAt)
        .success)
  )
    throw new StudyContextError('storage-failed');
  return { ...result, passages: passages.data };
};

const referenceAllowedForContext = (
  reference: SourceReference,
  courseId: string,
  gradeSettings: GradeSettings,
) => {
  if (reference.courseId !== null && reference.courseId !== courseId)
    throw new StudyContextError('scope-denied');
  if (reference.state !== 'current') return false;
  if (reference.sourceKind === 'grade-evidence' && !gradeSettings.enabled)
    return false;
  return true;
};

const collectPassages = (
  results: Array<StudySourceReadResult | null>,
  courseId: string,
  gradeSettings: GradeSettings,
) => {
  const passagesByReference = new Map<string, SourcePassage>();
  const versionsBySource = new Map<string, string | null>();
  for (const [resultIndex, result] of results.entries()) {
    if (!result) continue;
    for (const passage of result.passages) {
      if (resultIndex === 0 && passage.reference.courseId !== courseId)
        throw new StudyContextError('scope-denied');
      if (
        !referenceAllowedForContext(passage.reference, courseId, gradeSettings)
      )
        continue;
      const sourceKey = `${passage.reference.sourceKind}:${passage.reference.sourceId}`;
      const currentVersion = versionsBySource.get(sourceKey);
      if (
        versionsBySource.has(sourceKey) &&
        currentVersion !== passage.reference.versionId
      )
        throw new StudyContextError('revision-conflict');
      versionsBySource.set(sourceKey, passage.reference.versionId);
      const key = referenceKey(passage.reference);
      if (!passagesByReference.has(key))
        passagesByReference.set(key, {
          ...passage,
          text: passage.text.slice(0, 2000),
        });
    }
  }
  return [...passagesByReference.values()]
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, 20)
    .reduce<SourcePassage[]>((bounded, passage) => {
      const usedCharacters = bounded.reduce(
        (total, item) => total + item.text.length,
        0,
      );
      const remaining = 24_000 - usedCharacters;
      if (remaining <= 0) return bounded;
      const text = passage.text.slice(0, remaining);
      return text ? [...bounded, { ...passage, text }] : bounded;
    }, []);
};

const getFreshness = (results: Array<StudySourceReadResult | null>) => {
  const validResults = results.filter(
    (result): result is StudySourceReadResult => result !== null,
  );
  let status: PreparedStudyContext['freshness']['status'];
  if (validResults.length === 0) status = 'unavailable';
  else if (
    validResults.length < results.length ||
    validResults.some(({ status: itemStatus }) => itemStatus === 'partial')
  )
    status = 'partial';
  else if (
    validResults.every(({ status: itemStatus }) => itemStatus === 'unavailable')
  )
    status = 'unavailable';
  else if (
    validResults.some(({ status: itemStatus }) => itemStatus === 'unavailable')
  )
    status = 'partial';
  else if (
    validResults.some(({ status: itemStatus }) => itemStatus === 'stale')
  )
    status = 'stale';
  else status = 'current';

  const timestamps = validResults
    .map(({ lastSuccessfulAt }) => lastSuccessfulAt)
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return { status, lastSuccessfulAt: timestamps[0] ?? null };
};

const messageText = (message: SessionSnapshot['messages'][number]) =>
  message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('\n')
    .slice(0, 8000);

const collectHistory = (
  snapshot: SessionSnapshot,
  input: StudyContextInput,
  gradeSettings: GradeSettings,
  policy: AssistancePolicy,
) => {
  const history: PreparedStudyContext['history'] = [];
  let characters = 0;
  let gradeDerived = false;
  const messages = snapshot.messages
    .filter(
      (message) =>
        message.turnId !== input.turnId &&
        message.status === 'accepted' &&
        (message.role === 'student' || message.role === 'tutor') &&
        (!message.gradeDerived ||
          (gradeSettings.enabled &&
            message.gradeConsentRevision === gradeSettings.revision &&
            message.gradeConsentRevision === policy.consentRevision)),
    )
    .slice(-12);
  for (const message of messages) {
    const role =
      message.role === 'student'
        ? 'student'
        : message.role === 'tutor'
          ? 'tutor'
          : null;
    if (!role) continue;
    const text = messageText(message);
    const remaining = 16_000 - characters;
    if (!text || remaining <= 0) continue;
    const boundedText = text.slice(0, remaining);
    history.push({ role, text: boundedText });
    characters += boundedText.length;
    if (message.gradeDerived) gradeDerived = true;
  }
  return { history, gradeDerived };
};

export const prepareStudyContext = async (
  authorizedContext: AuthorizedContext,
  rawInput: StudyContextInput,
  dependencies: StudyContextDependencies,
): Promise<StudyContextPreparation> => {
  const parsedInput = studyContextInputSchema.safeParse(rawInput);
  if (!parsedInput.success) throw new StudyContextError('invalid-input');
  const input = parsedInput.data;
  requireCurrent(authorizedContext);

  const snapshot = await dependencies.getStudySession(authorizedContext, {
    sessionId: input.sessionId,
  });
  requireCurrent(authorizedContext);
  if (!snapshot || snapshot.session.id !== input.sessionId)
    throw new StudyContextError('not-found');
  const session = snapshot.session;
  const sourceQuery = [session.topic?.trim(), input.text.trim()]
    .filter((value): value is string => !!value)
    .join('\n')
    .slice(-8000);
  const gradeSettingsResult =
    await dependencies.getGradeSettings(authorizedContext);
  requireCurrent(authorizedContext);
  const gradeSettings = gradeSettingsResult
    ? gradeSettingsSchema.safeParse(gradeSettingsResult)
    : null;
  if (!gradeSettings?.success) throw new StudyContextError('storage-failed');
  if (gradeSettings.data.revision !== input.gradeConsentRevision)
    throw new StudyContextError('permission-revoked');

  const [
    courseReadResult,
    selectedReadResult,
    personalContextResult,
    contextRevisionResult,
  ] = await Promise.all([
    dependencies.readCourseSources(authorizedContext, {
      sessionId: session.id,
      courseId: session.courseId,
      targetAssignmentId: session.targetAssignmentId,
      gradeAccessEnabled: gradeSettings.data.enabled,
      gradeConsentRevision: gradeSettings.data.revision,
      query: sourceQuery,
    }),
    dependencies.readSelectedSources(authorizedContext, {
      sessionId: session.id,
      query: input.text,
      selectedIds: input.attachmentIds,
    }),
    dependencies.preparePersonalContext(authorizedContext, {
      sessionId: session.id,
      courseId: session.courseId,
    }),
    dependencies.readContextRevision(authorizedContext, {
      sessionId: session.id,
    }),
  ]);
  requireCurrent(authorizedContext);

  const courseRead = validateReadResult(courseReadResult);
  const selectedRead = validateReadResult(selectedReadResult);
  const contextRevision = revisionSchema.safeParse(contextRevisionResult);
  if (!contextRevision.success) throw new StudyContextError('storage-failed');
  if (contextRevision.data !== input.contextRevision)
    throw new StudyContextError('revision-conflict');
  const personalContext = personalContextResult
    ? personalContextSchema.safeParse(personalContextResult)
    : null;
  if (!personalContext?.success) throw new StudyContextError('storage-failed');

  const readResults = [courseRead, selectedRead];
  const sourcePassages = collectPassages(
    readResults,
    session.courseId,
    gradeSettings.data,
  );
  const sourceIds = [
    ...new Set(sourcePassages.map(({ reference }) => reference.sourceId)),
  ];
  const assistancePolicyResult = await dependencies.resolveAssistancePolicy(
    authorizedContext,
    {
      sessionId: session.id,
      targetAssignmentId: session.targetAssignmentId,
      sourceIds,
    },
  );
  requireCurrent(authorizedContext);
  if (!assistancePolicyResult)
    throw new StudyContextError('feature-unavailable');
  if (
    assistancePolicyResult.policyRevision !== input.policyRevision ||
    assistancePolicyResult.consentRevision !== input.gradeConsentRevision
  )
    throw new StudyContextError('permission-revoked');
  const policy = assistancePolicyResult;

  const collectedHistory = collectHistory(
    snapshot,
    input,
    gradeSettings.data,
    policy,
  );
  const freshness = getFreshness(readResults);
  const context = preparedStudyContextSchema.parse({
    sessionId: session.id,
    courseId: session.courseId,
    activity: session.activity,
    topic: session.topic,
    targetAssignmentId: session.targetAssignmentId,
    sourcePassages,
    personalContext: personalContext.data,
    history: collectedHistory.history,
    freshness,
    contextRevision: contextRevision.data,
    policy,
  });
  const gradeDerived =
    collectedHistory.gradeDerived ||
    sourcePassages.some(
      ({ reference }) => reference.sourceKind === 'grade-evidence',
    ) ||
    (gradeSettings.data.enabled &&
      policy.state === 'verified-completed' &&
      session.activity === 'review-graded-mistakes');

  return {
    session,
    context,
    offeredReferences: sourcePassages.map(({ reference }) => reference),
    gradeDerived,
    gradeAccessEnabled: gradeSettings.data.enabled,
    gradeConsentRevision: gradeDerived ? gradeSettings.data.revision : null,
  };
};
