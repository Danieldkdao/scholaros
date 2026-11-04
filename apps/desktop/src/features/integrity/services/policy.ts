import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  assistancePolicySchema,
  type AssistancePolicy,
} from '@scholaros/services/learning/grade-contracts';
import { preferenceContentSchema } from '@scholaros/services/learning/memory-contracts';
import { practiceQuestionSchema } from '@scholaros/services/learning/practice-contracts';
import { studyMessagePartSchema } from '@scholaros/services/learning/study-contracts';
import {
  jsonValueSchema,
  type AuthorizedContext,
  type JsonValue,
} from '@scholaros/services/learning/product-contracts';
import {
  sourceReferenceSchema,
  type SourceReference,
} from '@scholaros/services/learning/context-contracts';
import { db } from '../../../db';
import {
  CourseAssignmentTable,
  CourseworkProtectionTable,
  ContextItemTable,
  ArtifactTable,
  ArtifactVersionTable,
  PracticeAttemptTable,
  GradeEvidenceTable,
  StudySessionTable,
  StudyTurnTable,
} from '../../../db/schema';
import {
  isCurrentVerifiedEvidence,
  readAssistanceCoverage,
  readCurrentGradeConsent,
} from './assistance-store';
import { isCurrentSourceReference } from './source-preview';

const policyInputSchema = z.strictObject({
  sessionId: z.string().min(1).max(300),
  targetAssignmentId: z.string().min(1).max(300).optional(),
  sourceIds: z.array(z.string().min(1).max(300)).max(50),
});
const candidateSchema = jsonValueSchema.superRefine((candidate, validation) => {
  const bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
  if (bytes > 512 * 1024)
    validation.addIssue({
      code: 'custom',
      message: 'Candidate exceeds the publication budget.',
    });
});
const candidateInputSchema = z.strictObject({
  sessionId: z.string().min(1).max(300),
  turnId: z.string().min(1).max(300),
  candidate: candidateSchema,
  policy: assistancePolicySchema,
  sourceReferences: z.array(sourceReferenceSchema).max(50),
});
const practiceCandidateProjectionSchema = z.strictObject({
  rubricVersion: z.string().min(1).max(300),
  questions: z.array(practiceQuestionSchema).min(1).max(20),
});
const practiceCandidateInputSchema = z.strictObject({
  courseId: z.string().min(1).max(300),
  sessionId: z.string().min(1).max(300),
  candidate: practiceCandidateProjectionSchema,
  sourceReferences: z.array(sourceReferenceSchema).max(50),
});

export type PracticeCandidateAssessmentInput = z.infer<
  typeof practiceCandidateInputSchema
>;

export type CandidateAssessment = {
  allowed: boolean;
  candidateDigest: string | null;
  safeParts?: { kind: 'text'; text: string }[];
  reasonCode:
    | 'approved'
    | 'invalid-input'
    | 'policy-changed'
    | 'scope-denied'
    | 'answer-risk'
    | 'limit-exceeded'
    | 'policy-bypass'
    | 'uninterpretable';
  revision: number;
};

const safeFallback =
  'I can help explain the concepts and requirements or use a different practice example, but I can’t provide that response.';
const fallback = (
  reasonCode: CandidateAssessment['reasonCode'],
  revision = 0,
  candidateDigest: string | null = null,
): CandidateAssessment => ({
  allowed: false,
  candidateDigest,
  safeParts: [{ kind: 'text', text: safeFallback }],
  reasonCode,
  revision,
});
const hashIdentity = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const isCurrent = (context: AuthorizedContext) =>
  !context.signal.aborted && context.isCurrent();

const emptyPolicy = (
  consentRevision: number,
  reasonCode: string,
): AssistancePolicy =>
  assistancePolicySchema.parse({
    state: 'unknown',
    policyRevision: 0,
    consentRevision,
    canonicalProtectionId: null,
    allowedOperations: ['concept', 'requirements'],
    reasonCode,
    priorAssistanceSummary: JSON.stringify({
      units: 0,
      operations: {
        concept: 0,
        requirements: 0,
        'bounded-hint': 0,
        'distinct-practice': 0,
        'source-feedback-review': 0,
      },
      riskTags: [],
      candidateDigests: [],
      corrupt: false,
    }),
  });

const getSession = (context: AuthorizedContext, sessionId: string) =>
  db
    .select()
    .from(StudySessionTable)
    .where(
      and(
        eq(StudySessionTable.userId, context.userId),
        eq(StudySessionTable.id, sessionId),
        isNull(StudySessionTable.deletedAt),
      ),
    )
    .get();

const getOrCreateProtection = (input: {
  userId: string;
  courseId: string;
  assignment: typeof CourseAssignmentTable.$inferSelect | null;
  aliases: string[];
}) => {
  const protections = db
    .select()
    .from(CourseworkProtectionTable)
    .where(
      and(
        eq(CourseworkProtectionTable.userId, input.userId),
        eq(CourseworkProtectionTable.courseId, input.courseId),
      ),
    )
    .all();
  const canonicalIdentity = input.assignment
    ? `assignment:${input.assignment.id}`
    : 'coursework:unknown';
  const matching = protections.filter(
    (protection) =>
      protection.canonicalIdentity === canonicalIdentity ||
      input.aliases.some((alias) => protection.aliases.includes(alias)),
  );
  if (matching.length === 1) return matching[0]!;
  if (matching.length > 1) {
    const unknownProtection = protections.find(
      (protection) => protection.canonicalIdentity === 'coursework:unknown',
    );
    return unknownProtection ?? null;
  }

  const identity = input.assignment ? canonicalIdentity : 'coursework:unknown';
  const id = randomUUID();
  db.insert(CourseworkProtectionTable)
    .values({
      id,
      userId: input.userId,
      courseId: input.courseId,
      connectionId: null,
      canonicalIdentity: identity,
      aliases: input.assignment
        ? [...new Set([input.assignment.id, input.assignment.sourceKey])].slice(
            0,
            100,
          )
        : [],
      questionFingerprint: hashIdentity(
        `${input.userId}\u0000${input.courseId}\u0000${identity}`,
      ),
      state: 'unknown',
      policyRevision: 0,
      verifiedAt: null,
      sourceEvidenceId: null,
      suppressed: false,
    })
    .onConflictDoNothing()
    .run();
  const createdOrExisting = db
    .select()
    .from(CourseworkProtectionTable)
    .where(
      and(
        eq(CourseworkProtectionTable.userId, input.userId),
        eq(CourseworkProtectionTable.courseId, input.courseId),
        eq(CourseworkProtectionTable.canonicalIdentity, identity),
      ),
    )
    .get();
  if (createdOrExisting) return createdOrExisting;

  return (
    db
      .select()
      .from(CourseworkProtectionTable)
      .where(
        and(
          eq(CourseworkProtectionTable.userId, input.userId),
          eq(CourseworkProtectionTable.courseId, input.courseId),
          eq(CourseworkProtectionTable.canonicalIdentity, 'coursework:unknown'),
        ),
      )
      .get() ?? null
  );
};

const resolveAssignments = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  requestedTarget: string | undefined,
  sourceIds: string[],
) => {
  const records = db
    .select()
    .from(CourseAssignmentTable)
    .where(
      and(
        eq(CourseAssignmentTable.userId, context.userId),
        eq(CourseAssignmentTable.courseId, session.courseId),
      ),
    )
    .all();
  const targetId = session.targetAssignmentId;
  if (requestedTarget && requestedTarget !== targetId)
    return { assignment: null, ambiguous: true };
  const identities = [
    ...new Set(
      [targetId, ...sourceIds].filter((id): id is string => Boolean(id)),
    ),
  ];
  const matches = records.filter(
    (record) =>
      identities.includes(record.id) || identities.includes(record.sourceKey),
  );
  const unique = [
    ...new Map(matches.map((record) => [record.id, record])).values(),
  ];
  if (unique.length === 1) return { assignment: unique[0]!, ambiguous: false };
  if (unique.length > 1) return { assignment: null, ambiguous: true };

  const protections = db
    .select()
    .from(CourseworkProtectionTable)
    .where(
      and(
        eq(CourseworkProtectionTable.userId, context.userId),
        eq(CourseworkProtectionTable.courseId, session.courseId),
      ),
    )
    .all();
  const retained = protections.filter((protection) =>
    identities.some(
      (identity) =>
        protection.canonicalIdentity === `assignment:${identity}` ||
        protection.aliases.includes(identity),
    ),
  );
  return {
    assignment: null,
    ambiguous: retained.length > 1,
    retainedProtection: retained.length === 1 ? retained[0] : null,
  };
};

const getEvidenceForProtection = (
  context: AuthorizedContext,
  courseId: string,
  protection: typeof CourseworkProtectionTable.$inferSelect,
) => {
  const identities = [protection.canonicalIdentity, ...protection.aliases];
  const evidenceRows = db
    .select()
    .from(GradeEvidenceTable)
    .where(
      and(
        eq(GradeEvidenceTable.userId, context.userId),
        eq(GradeEvidenceTable.courseId, courseId),
        isNull(GradeEvidenceTable.revokedAt),
      ),
    )
    .all()
    .filter((evidence) => identities.includes(evidence.assignmentIdentity))
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  const evidence = evidenceRows[0] ?? null;
  if (!evidence) return { evidence: null, conflicted: false };
  const conflicted = evidenceRows.some(
    (candidate) =>
      candidate.observedAt === evidence.observedAt &&
      (candidate.completed !== evidence.completed ||
        candidate.remainingOpportunity !== evidence.remainingOpportunity ||
        JSON.stringify(candidate.grade) !== JSON.stringify(evidence.grade) ||
        JSON.stringify(candidate.conflicts) !==
          JSON.stringify(evidence.conflicts)),
  );
  return { evidence, conflicted };
};

const sourceChangedAtForProtection = (
  userId: string,
  courseId: string,
  protection: typeof CourseworkProtectionTable.$inferSelect,
) => {
  const assignments = db
    .select({ contentChangedAt: CourseAssignmentTable.contentChangedAt })
    .from(CourseAssignmentTable)
    .where(
      and(
        eq(CourseAssignmentTable.userId, userId),
        eq(CourseAssignmentTable.courseId, courseId),
        inArray(CourseAssignmentTable.sourceKey, protection.aliases),
      ),
    )
    .all();
  return (
    assignments
      .map((assignment) => assignment.contentChangedAt)
      .filter((timestamp): timestamp is string => timestamp !== null)
      .sort()
      .at(-1) ?? null
  );
};

const hasCurrentAssignmentEvidenceSource = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  evidence: typeof GradeEvidenceTable.$inferSelect,
  protection: typeof CourseworkProtectionTable.$inferSelect,
) => {
  if (!Array.isArray(evidence.sourceReferences)) return false;
  return evidence.sourceReferences.some((source) => {
    const parsed = sourceReferenceSchema.safeParse(source);
    if (!parsed.success) return false;
    const reference = parsed.data;
    return (
      reference.sourceKind === 'assignment' &&
      reference.provenance === 'connected-source' &&
      reference.state === 'current' &&
      protection.aliases.includes(reference.sourceId) &&
      reference.courseId === session.courseId &&
      isCurrentSourceReference(context, session, reference)
    );
  });
};

const buildAssistancePolicy = (
  state: AssistancePolicy['state'],
  protection: typeof CourseworkProtectionTable.$inferSelect,
  consentRevision: number,
  coverage: ReturnType<typeof readAssistanceCoverage>,
): AssistancePolicy => {
  const allowedOperations: AssistancePolicy['allowedOperations'] = [
    'concept',
    'requirements',
    'bounded-hint',
    'distinct-practice',
  ];
  const riskRestricted = coverage.riskTags.some(
    (tag) => tag !== 'source-injection-seen',
  );
  const limitReached =
    coverage.assistanceUnits >= 6 ||
    coverage.operations['bounded-hint'] >= 2 ||
    riskRestricted;
  if (limitReached) {
    const canOfferPractice = !riskRestricted && coverage.assistanceUnits < 6;
    const limitedOperations = allowedOperations.filter(
      (operation) =>
        operation !== 'bounded-hint' &&
        (operation !== 'distinct-practice' || canOfferPractice),
    );
    return assistancePolicySchema.parse({
      state,
      policyRevision: protection.policyRevision,
      consentRevision,
      canonicalProtectionId: protection.id,
      allowedOperations: limitedOperations,
      reasonCode:
        state === 'verified-completed'
          ? 'verified-source-current'
          : 'active-or-unknown',
      priorAssistanceSummary: JSON.stringify({
        units: coverage.assistanceUnits,
        operations: coverage.operations,
        riskTags: coverage.riskTags,
        candidateDigests: coverage.candidateDigests,
        corrupt: coverage.corrupt,
      }).slice(0, 2000),
    });
  }
  if (state === 'verified-completed')
    allowedOperations.push('source-feedback-review');
  return assistancePolicySchema.parse({
    state,
    policyRevision: protection.policyRevision,
    consentRevision,
    canonicalProtectionId: protection.id,
    allowedOperations,
    reasonCode:
      state === 'verified-completed'
        ? 'verified-source-current'
        : 'active-or-unknown',
    priorAssistanceSummary: JSON.stringify({
      units: coverage.assistanceUnits,
      operations: coverage.operations,
      riskTags: coverage.riskTags,
      candidateDigests: coverage.candidateDigests,
    }).slice(0, 2000),
  });
};

export const resolveAssistancePolicy = (
  context: AuthorizedContext,
  input: unknown,
): AssistancePolicy => {
  if (context.signal.aborted) throw new Error('cancelled');
  if (!context.isCurrent()) throw new Error('session-changed');
  const parsed = policyInputSchema.safeParse(input);
  const consent = readCurrentGradeConsent(context.userId);
  if (!parsed.success)
    return emptyPolicy(consent.revision, 'invalid-policy-input');
  const session = getSession(context, parsed.data.sessionId);
  if (!session) return emptyPolicy(consent.revision, 'session-unavailable');
  if (!context.isCurrent()) throw new Error('session-changed');

  const resolved = resolveAssignments(
    context,
    session,
    parsed.data.targetAssignmentId,
    parsed.data.sourceIds,
  );
  const aliases = resolved.assignment
    ? [resolved.assignment.id, resolved.assignment.sourceKey]
    : parsed.data.sourceIds;
  const protection = resolved.ambiguous
    ? null
    : 'retainedProtection' in resolved && resolved.retainedProtection
      ? resolved.retainedProtection
      : getOrCreateProtection({
          userId: context.userId,
          courseId: session.courseId,
          assignment: resolved.assignment,
          aliases,
        });
  if (!protection) return emptyPolicy(consent.revision, 'identity-ambiguous');

  const { evidence, conflicted } = getEvidenceForProtection(
    context,
    session.courseId,
    protection,
  );
  const assignment = resolved.assignment;
  const evidenceIsCurrent = Boolean(
    evidence &&
    !conflicted &&
    hasCurrentAssignmentEvidenceSource(
      context,
      session,
      evidence,
      protection,
    ) &&
    isCurrentVerifiedEvidence({
      consent,
      protection,
      evidence,
      sourceChangedAt: sourceChangedAtForProtection(
        context.userId,
        session.courseId,
        protection,
      ),
    }),
  );
  const state: AssistancePolicy['state'] = evidenceIsCurrent
    ? 'verified-completed'
    : protection.state === 'active' || assignment?.active
      ? 'active'
      : 'unknown';
  const coverage = readAssistanceCoverage(context, {
    courseId: session.courseId,
    protectionId: protection.id,
  });
  if (!context.isCurrent()) throw new Error('session-changed');
  return buildAssistancePolicy(state, protection, consent.revision, coverage);
};

const isPolicyCurrent = (
  expected: AssistancePolicy,
  current: AssistancePolicy,
) =>
  expected.state === current.state &&
  expected.policyRevision === current.policyRevision &&
  expected.consentRevision === current.consentRevision &&
  expected.canonicalProtectionId === current.canonicalProtectionId;

export const isAssistancePolicyCurrent = (
  context: AuthorizedContext,
  input: {
    sessionId: string;
    sourceIds: string[];
    policy: AssistancePolicy;
  },
) => {
  if (!isCurrent(context)) return false;
  const currentPolicy = resolveAssistancePolicy(context, {
    sessionId: input.sessionId,
    sourceIds: input.sourceIds,
  });
  return isCurrent(context) && isPolicyCurrent(input.policy, currentPolicy);
};

const priorAssistanceDigestsSchema = z.object({
  candidateDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(16),
});
const candidateDigest = (candidate: JsonValue) =>
  createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
const sourceReferenceKey = (reference: SourceReference) =>
  JSON.stringify([
    reference.sourceKind,
    reference.sourceId,
    reference.versionId,
    reference.courseId,
    reference.locator,
  ]);
const mergeSourceReferences = (references: SourceReference[]) => [
  ...new Map(
    references.map((reference) => [sourceReferenceKey(reference), reference]),
  ).values(),
];
const readPriorCandidateDigests = (summary: string): string[] | null => {
  try {
    const parsed = priorAssistanceDigestsSchema.safeParse(JSON.parse(summary));
    return parsed.success ? parsed.data.candidateDigests : null;
  } catch {
    return null;
  }
};

const normalizeName = (value: string) =>
  value.toLowerCase().replace(/[-_\s]/g, '');
const forbiddenPolicyKeys = new Set([
  'baseurl',
  'completion',
  'completionoverride',
  'completionstatus',
  'completed',
  'gradeaccess',
  'gradeaccessenabled',
  'gradeconsent',
  'modelid',
  'permission',
  'permissions',
  'permissionoverride',
  'policybypassed',
  'policydecision',
  'policyoverride',
  'policyrevision',
  'policypassed',
  'sourceaccess',
  'sourceaccessgranted',
  'systemprompt',
  'teacher',
  'teacherclaim',
  'isteacher',
  'toolregistry',
  'verifiedcompleted',
]);
const forbiddenToolKeys = new Set([
  'functionarguments',
  'functioncall',
  'functionname',
  'functionresult',
  'tool',
  'toolarguments',
  'toolcall',
  'toolcalls',
  'tooleffects',
  'toolname',
  'tooloutput',
  'toolresponse',
  'toolresults',
  'tools',
]);
const forbiddenAnswerKeys = new Set([
  'answerkey',
  'correctanswer',
  'expectedanswer',
  'hiddenanswer',
  'modelanswer',
  'solutionkey',
]);
const policyBypassLanguage =
  /\b(?:enable|turn on|grant|override|bypass|ignore|skip|disable)\b.{0,80}\b(?:grade access|grade consent|consent|permission|completion|answer policy|assignment policy)\b|\b(?:pretend|mark|set)\b.{0,50}\b(?:completed|graded|teacher|permission)\b/i;
const obfuscationPattern =
  /\b(?:atob|eval|unescape|fromCharCode)\s*\(|\\u[\da-f]{4}(?:\\u[\da-f]{4}){4,}|&#x?[\da-f]{3,};(?:&#x?[\da-f]{3,};){4,}/i;
const invisibleCharacters = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/;

type CandidateInspection = {
  reasonCode:
    | 'policy-bypass'
    | 'answer-risk'
    | 'uninterpretable'
    | 'scope-denied'
    | 'limit-exceeded'
    | null;
  references: SourceReference[];
};
const inspectCandidate = (candidate: JsonValue): CandidateInspection => {
  const references: SourceReference[] = [];
  const referenceKeys = new Set<string>();
  let reasonCode: CandidateInspection['reasonCode'] = null;
  const addReference = (input: JsonValue) => {
    const parsed = sourceReferenceSchema.safeParse(input);
    if (!parsed.success) {
      reasonCode ??= 'scope-denied';
      return;
    }
    const reference = parsed.data;
    const key = JSON.stringify([
      reference.sourceKind,
      reference.sourceId,
      reference.versionId,
      reference.courseId,
      reference.locator,
    ]);
    if (referenceKeys.has(key)) return;
    if (references.length >= 50) {
      reasonCode ??= 'limit-exceeded';
      return;
    }
    referenceKeys.add(key);
    references.push(reference);
  };
  const visit = (value: JsonValue, parentKey = '') => {
    if (typeof value === 'string') {
      if (invisibleCharacters.test(value) || obfuscationPattern.test(value))
        reasonCode ??= 'uninterpretable';
      if (parentKey === 'value' && policyBypassLanguage.test(value))
        reasonCode ??= 'policy-bypass';
      return;
    }
    if (Array.isArray(value)) {
      if (
        (parentKey === 'citations' || parentKey === 'sourceReferences') &&
        value.length > 50
      ) {
        reasonCode ??= 'limit-exceeded';
        return;
      }
      for (const child of value) visit(child, parentKey);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = normalizeName(key);
      if (forbiddenPolicyKeys.has(normalizedKey))
        reasonCode ??= 'policy-bypass';
      if (forbiddenToolKeys.has(normalizedKey)) reasonCode ??= 'scope-denied';
      if (forbiddenAnswerKeys.has(normalizedKey)) reasonCode ??= 'answer-risk';
      if (key === 'reference' && value.kind === 'citation') addReference(child);
      if (key === 'citations') {
        if (!Array.isArray(child)) reasonCode ??= 'scope-denied';
        else if (child.length > 50) reasonCode ??= 'limit-exceeded';
        else {
          for (const citation of child) {
            const reference =
              citation &&
              typeof citation === 'object' &&
              !Array.isArray(citation) &&
              Object.hasOwn(citation, 'reference')
                ? citation.reference
                : citation;
            addReference(reference);
          }
        }
      }
      if (key === 'sourceReferences') {
        if (!Array.isArray(child)) reasonCode ??= 'scope-denied';
        else if (child.length > 50) reasonCode ??= 'limit-exceeded';
        else for (const reference of child) addReference(reference);
      }
      if (key === 'kind' && child === 'remember-preference') {
        const preference =
          typeof value === 'object' && !Array.isArray(value)
            ? (value.preference ?? value.content)
            : undefined;
        if (!preferenceContentSchema.safeParse(preference).success)
          reasonCode ??= 'policy-bypass';
      }
      visit(child, key);
    }
  };
  visit(candidate);
  return { reasonCode, references };
};

const validateCandidateParts = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  candidate: JsonValue,
): CandidateInspection['reasonCode'] => {
  if (
    candidate === null ||
    Array.isArray(candidate) ||
    typeof candidate !== 'object'
  )
    return null;
  if (!Object.hasOwn(candidate, 'parts')) return null;
  if (!Array.isArray(candidate.parts)) return 'scope-denied';
  if (candidate.parts.length > 100) return 'limit-exceeded';
  for (const rawPart of candidate.parts) {
    const parsedPart = studyMessagePartSchema.safeParse(rawPart);
    if (!parsedPart.success) return 'scope-denied';
    const part = parsedPart.data;
    if (part.kind === 'status') return 'scope-denied';
    if (part.kind === 'attachment') {
      const item = db
        .select()
        .from(ContextItemTable)
        .where(
          and(
            eq(ContextItemTable.userId, context.userId),
            eq(ContextItemTable.id, part.itemId),
            eq(ContextItemTable.currentVersionId, part.versionId),
            isNull(ContextItemTable.removedAt),
          ),
        )
        .get();
      if (
        !item ||
        !isCurrentSourceReference(context, session, {
          sourceKind: 'context-version',
          sourceId: item.id,
          versionId: part.versionId,
          courseId: session.courseId,
          locator: null,
          title: item.title,
          provenance: item.provenance,
          observedAt: item.updatedAt,
          state: 'current',
        })
      )
        return 'scope-denied';
    }
    if (part.kind === 'activity') {
      const artifact = db
        .select()
        .from(ArtifactTable)
        .where(
          and(
            eq(ArtifactTable.userId, context.userId),
            eq(ArtifactTable.id, part.artifactId),
            eq(ArtifactTable.currentVersionId, part.versionId),
            isNull(ArtifactTable.removedAt),
          ),
        )
        .get();
      const version = db
        .select()
        .from(ArtifactVersionTable)
        .where(
          and(
            eq(ArtifactVersionTable.userId, context.userId),
            eq(ArtifactVersionTable.artifactId, part.artifactId),
            eq(ArtifactVersionTable.id, part.versionId),
          ),
        )
        .get();
      if (
        !artifact ||
        !version ||
        !isCurrentSourceReference(context, session, {
          sourceKind: 'saved-activity',
          sourceId: artifact.id,
          versionId: version.id,
          courseId: artifact.courseId,
          locator: null,
          title: artifact.title,
          provenance: 'ai-generated',
          observedAt: artifact.updatedAt,
          state: 'current',
        })
      )
        return 'scope-denied';
    }
    if (part.kind === 'practice') {
      const attempt = db
        .select()
        .from(PracticeAttemptTable)
        .where(
          and(
            eq(PracticeAttemptTable.userId, context.userId),
            eq(PracticeAttemptTable.id, part.practiceAttemptId),
            eq(PracticeAttemptTable.courseId, session.courseId),
            eq(PracticeAttemptTable.sessionId, session.id),
          ),
        )
        .get();
      if (!attempt) return 'scope-denied';
    }
  }
  return null;
};

const validateCandidateEffects = (
  candidate: JsonValue,
  policy: AssistancePolicy,
  references: SourceReference[],
): CandidateInspection['reasonCode'] => {
  if (
    candidate === null ||
    Array.isArray(candidate) ||
    typeof candidate !== 'object'
  )
    return null;
  if (!Object.hasOwn(candidate, 'proposedEffects')) return null;
  if (!Array.isArray(candidate.proposedEffects)) return 'scope-denied';
  if (candidate.proposedEffects.length > 32) return 'limit-exceeded';
  for (const effect of candidate.proposedEffects) {
    if (effect === null || Array.isArray(effect) || typeof effect !== 'object')
      return 'scope-denied';
    const kind = effect.kind ?? effect.type;
    if (kind === 'retrieve-source') {
      if (Object.hasOwn(effect, 'references')) {
        const selectors = z
          .array(
            sourceReferenceSchema.pick({
              sourceKind: true,
              sourceId: true,
              versionId: true,
              locator: true,
            }),
          )
          .min(1)
          .max(20)
          .safeParse(effect.references);
        if (
          !selectors.success ||
          selectors.data.some(
            (selector) =>
              !references.some(
                (reference) =>
                  reference.state === 'current' &&
                  reference.sourceKind === selector.sourceKind &&
                  reference.sourceId === selector.sourceId &&
                  reference.versionId === selector.versionId &&
                  JSON.stringify(reference.locator) ===
                    JSON.stringify(selector.locator),
              ),
          )
        )
          return 'scope-denied';
        continue;
      }
      const sourceId = effect.sourceId ?? effect.id;
      if (
        typeof sourceId !== 'string' ||
        !references.some(
          (reference) =>
            reference.sourceId === sourceId && reference.state === 'current',
        )
      )
        return 'scope-denied';
      continue;
    }
    if (kind === 'remember-preference') {
      const preference = preferenceContentSchema.safeParse(
        effect.preference ?? effect.content,
      );
      if (!preference.success) return 'policy-bypass';
      if (policyBypassLanguage.test(preference.data.value))
        return 'policy-bypass';
      continue;
    }
    if (kind === 'create-activity' || kind === 'offer-practice') {
      if (!policy.allowedOperations.includes('distinct-practice'))
        return 'answer-risk';
      continue;
    }
    return 'scope-denied';
  }
  return null;
};

export const assessCandidate = (
  context: AuthorizedContext,
  input: unknown,
): CandidateAssessment => {
  const parsed = candidateInputSchema.safeParse(input);
  if (!parsed.success) return fallback('invalid-input');
  const digest = candidateDigest(parsed.data.candidate);
  const deny = (reasonCode: CandidateAssessment['reasonCode'], revision = 0) =>
    fallback(reasonCode, revision, digest);
  if (!isCurrent(context)) return deny('scope-denied');
  const session = getSession(context, parsed.data.sessionId);
  const turn = db
    .select()
    .from(StudyTurnTable)
    .where(
      and(
        eq(StudyTurnTable.userId, context.userId),
        eq(StudyTurnTable.id, parsed.data.turnId),
        eq(StudyTurnTable.sessionId, parsed.data.sessionId),
        inArray(StudyTurnTable.status, ['generating', 'checking']),
      ),
    )
    .get();
  if (
    !session ||
    !turn ||
    session.deletedAt !== null ||
    session.generationEpoch !== turn.generationEpoch
  )
    return deny('scope-denied');

  const inspection = inspectCandidate(parsed.data.candidate);
  const sourceReferences = mergeSourceReferences([
    ...parsed.data.sourceReferences,
    ...inspection.references,
  ]);
  if (sourceReferences.length > 50) return deny('limit-exceeded');
  const sourceIds = sourceReferences
    .filter((reference) => reference.sourceKind === 'assignment')
    .map((reference) => reference.sourceId);
  const currentPolicy = resolveAssistancePolicy(context, {
    sessionId: session.id,
    sourceIds,
  });
  if (turn.policyRevision !== currentPolicy.policyRevision)
    return deny('policy-changed', currentPolicy.policyRevision);
  if (!isPolicyCurrent(parsed.data.policy, currentPolicy))
    return deny('policy-changed', currentPolicy.policyRevision);
  const priorCandidateDigests = readPriorCandidateDigests(
    currentPolicy.priorAssistanceSummary,
  );
  if (!priorCandidateDigests)
    return deny('uninterpretable', currentPolicy.policyRevision);
  if (priorCandidateDigests.includes(digest))
    return deny('answer-risk', currentPolicy.policyRevision);
  if (inspection.reasonCode)
    return deny(inspection.reasonCode, currentPolicy.policyRevision);

  const structuralFailure =
    validateCandidateParts(context, session, parsed.data.candidate) ??
    validateCandidateEffects(
      parsed.data.candidate,
      currentPolicy,
      sourceReferences,
    );
  if (structuralFailure)
    return deny(structuralFailure, currentPolicy.policyRevision);
  if (
    sourceReferences.some(
      (reference) =>
        reference.state !== 'current' ||
        (reference.courseId !== null &&
          reference.courseId !== session.courseId) ||
        (reference.sourceKind === 'grade-evidence' &&
          !currentPolicy.allowedOperations.includes(
            'source-feedback-review',
          )) ||
        !isCurrentSourceReference(context, session, reference),
    )
  )
    return deny('scope-denied', currentPolicy.policyRevision);
  if (!currentPolicy.allowedOperations.includes('concept'))
    return deny('policy-changed', currentPolicy.policyRevision);
  if (!isCurrent(context))
    return deny('scope-denied', currentPolicy.policyRevision);
  return {
    allowed: true,
    candidateDigest: digest,
    reasonCode: 'approved',
    revision: currentPolicy.policyRevision,
  };
};

export const assessPracticeCandidate = (
  context: AuthorizedContext,
  input: PracticeCandidateAssessmentInput,
): CandidateAssessment => {
  const parsed = practiceCandidateInputSchema.safeParse(input);
  if (!parsed.success) return fallback('invalid-input');
  const digest = candidateDigest(parsed.data.candidate);
  const deny = (reasonCode: CandidateAssessment['reasonCode'], revision = 0) =>
    fallback(reasonCode, revision, digest);
  if (!isCurrent(context)) return deny('scope-denied');
  if (
    new TextEncoder().encode(JSON.stringify(parsed.data.candidate)).byteLength >
    512 * 1024
  )
    return deny('limit-exceeded');

  const session = getSession(context, parsed.data.sessionId);
  if (!session || session.courseId !== parsed.data.courseId)
    return deny('scope-denied');

  const inspection = inspectCandidate(parsed.data.candidate);
  if (inspection.reasonCode) return deny(inspection.reasonCode);
  const allSourceReferences = [
    ...parsed.data.sourceReferences,
    ...inspection.references,
  ];
  if (
    allSourceReferences.some(
      (reference) =>
        reference.state !== 'current' ||
        (reference.courseId !== null &&
          reference.courseId !== session.courseId) ||
        (reference.sourceKind === 'assignment' &&
          (reference.courseId !== session.courseId ||
            reference.provenance !== 'connected-source')) ||
        !isCurrentSourceReference(context, session, reference),
    )
  )
    return deny('scope-denied');
  const sourceReferences = mergeSourceReferences(allSourceReferences);
  if (sourceReferences.length > 50) return deny('limit-exceeded');

  const sourceIds = sourceReferences
    .filter((reference) => reference.sourceKind === 'assignment')
    .map((reference) => reference.sourceId);
  let currentPolicy: AssistancePolicy;
  try {
    currentPolicy = resolveAssistancePolicy(context, {
      sessionId: session.id,
      sourceIds,
    });
  } catch {
    return deny('scope-denied');
  }
  if (!isCurrent(context))
    return deny('scope-denied', currentPolicy.policyRevision);

  const priorCandidateDigests = readPriorCandidateDigests(
    currentPolicy.priorAssistanceSummary,
  );
  if (!priorCandidateDigests)
    return deny('uninterpretable', currentPolicy.policyRevision);
  if (priorCandidateDigests.includes(digest))
    return deny('answer-risk', currentPolicy.policyRevision);
  if (!currentPolicy.allowedOperations.includes('distinct-practice'))
    return deny('answer-risk', currentPolicy.policyRevision);
  if (!isCurrent(context))
    return deny('scope-denied', currentPolicy.policyRevision);

  return {
    allowed: true,
    candidateDigest: digest,
    reasonCode: 'approved',
    revision: currentPolicy.policyRevision,
  };
};
