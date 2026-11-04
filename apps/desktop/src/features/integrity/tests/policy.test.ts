import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-integrity-policy-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
    },
  };
});

const { db } = await import('../../../db');
const {
  AssistanceLedgerTable,
  CourseAssignmentTable,
  CourseworkProtectionTable,
  GradeEvidenceTable,
  SettingTable,
  StudySessionTable,
  StudyTurnTable,
} = await import('../../../db/schema');
const { recordAssistance } = await import('../services/assistance-store');
const { assessCandidate, assessPracticeCandidate, resolveAssistancePolicy } =
  await import('../services/policy');
const { filterSourcePreview } = await import('../services/source-preview');

const userId = 'student-policy';
const courseId = 'course-policy';
const assignmentId = 'assignment-policy';
const sourceKey = 'source-assignment-91';
const sessionId = 'session-policy';
const protectionId = 'protection-policy';
const evidenceId = 'evidence-policy';
const now = () => new Date().toISOString();
const context = () => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const setGradeAccess = (enabled: boolean, revision = 4) => {
  db.insert(SettingTable)
    .values({
      userId,
      productPreferences: {
        grades: { enabled, notes: '', revision },
        notifications: {
          enabled: false,
          categories: {
            'connection-attention': false,
            'sync-completed': false,
            'sync-failed': false,
            'context-completed': false,
            'context-failed': false,
            'tutor-ready': false,
            'activity-ready': false,
            'timer-expired': false,
            'deadline-reminder': false,
          },
          quietHours: {
            enabled: false,
            startMinute: 1320,
            endMinute: 480,
            timeZone: 'UTC',
          },
          revision: 0,
        },
        learning: {
          educationLevel: null,
          appearance: 'system',
          accessibility: { reduceMotion: false, highContrast: false },
          revision: 0,
        },
      },
      updatedAt: now(),
    })
    .run();
};

const setAssignment = (suppressedAt: string | null = null) => {
  db.insert(CourseAssignmentTable)
    .values({
      id: assignmentId,
      userId,
      courseId,
      sourceKey,
      title: 'Cellular respiration assessment',
      body: 'Explain the process and show the required reasoning.',
      dateValue: null,
      dateText: null,
      url: 'https://school.example/assignment/91',
      active: !suppressedAt,
      lastSeenAt: now(),
      content: null,
      identityConflicts: [],
      localOverrides: null,
      localEditedAt: null,
      suppressionId: suppressedAt ? 'suppression-policy' : null,
      suppressedAt,
      contentChangedAt: null,
    })
    .run();
};

const setSession = (id = sessionId, target = assignmentId) => {
  db.insert(StudySessionTable)
    .values({
      id,
      userId,
      courseId,
      title: 'Biology study',
      activity: 'assignment-start',
      targetAssignmentId: target,
      topic: null,
      status: 'in-progress',
      revision: 0,
      generationEpoch: 0,
      draftText: '',
      draftRevision: 0,
      deadlineAt: null,
      timerRevision: 0,
      expiredRevision: null,
      resolvedExpiredRevision: null,
      finishedAt: null,
      deletedAt: null,
      createdAt: now(),
      updatedAt: now(),
      lastOpenedAt: now(),
    })
    .run();
};

const setTurn = (id: string, turnSessionId: string, policyRevision = 7) => {
  db.insert(StudyTurnTable)
    .values({
      id,
      userId,
      sessionId: turnSessionId,
      requestId: `00000000-0000-4000-8000-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`,
      payloadHash: 'f'.repeat(64),
      generationEpoch: 0,
      status: 'checking',
      attemptNumber: 1,
      policyRevision,
      contextRevision: 0,
      errorCode: null,
      startedAt: now(),
      settledAt: null,
    })
    .run();
};

const setProtection = (state: 'active' | 'unknown' | 'verified-completed') => {
  db.insert(CourseworkProtectionTable)
    .values({
      id: protectionId,
      userId,
      courseId,
      connectionId: 'connection-policy',
      canonicalIdentity: `assignment:${assignmentId}`,
      aliases: [assignmentId, sourceKey],
      questionFingerprint: 'a'.repeat(64),
      state,
      policyRevision: 7,
      verifiedAt: state === 'verified-completed' ? now() : null,
      sourceEvidenceId: state === 'verified-completed' ? evidenceId : null,
      suppressed: false,
    })
    .run();
};

const createAssignmentReference = () => ({
  sourceKind: 'assignment' as const,
  sourceId: assignmentId,
  versionId: null,
  courseId,
  locator: null,
  title: 'Cellular respiration assessment',
  provenance: 'connected-source' as const,
  observedAt: now(),
  state: 'current' as const,
});

const hashCandidate = (candidate: Record<string, unknown>) =>
  createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
const createPracticeAssessmentInput = (): Parameters<
  typeof assessPracticeCandidate
>[1] => ({
  courseId,
  sessionId,
  sourceReferences: [createAssignmentReference()],
  candidate: {
    rubricVersion: 'practice-rubric-1',
    questions: [
      {
        id: 'practice-question-1',
        kind: 'short-explanation',
        prompt: 'Explain the energy transfer in cellular respiration.',
        options: null,
        unit: null,
        objectiveIds: ['objective-1'],
        sourceReferences: [createAssignmentReference()],
      },
    ],
  },
});

const setEvidence = (
  overrides: Partial<{
    completed: 'yes' | 'no' | 'unknown';
    grade: { scale: 'points'; earned: number; possible: number | null } | null;
    remainingOpportunity: 'yes' | 'no' | 'unknown';
    observedAt: string;
    consentRevision: number;
    conflicts: unknown;
  }> = {},
) => {
  db.insert(GradeEvidenceTable)
    .values({
      id: evidenceId,
      userId,
      connectionId: 'connection-policy',
      courseId,
      assignmentIdentity: sourceKey,
      sourceVersion: 'version-1',
      observedAt: overrides.observedAt ?? now(),
      consentRevision: overrides.consentRevision ?? 4,
      completed: overrides.completed ?? 'yes',
      grade: overrides.grade ?? { scale: 'points', earned: 0, possible: 10 },
      remainingOpportunity: overrides.remainingOpportunity ?? 'no',
      conflicts: (overrides.conflicts ?? []) as never,
      sourceReferences: [createAssignmentReference()],
      revokedAt: null,
    })
    .run();
};

const updateGradeAccess = (enabled: boolean, revision: number) => {
  const existingSetting = db.select().from(SettingTable).get();
  if (!existingSetting) return;
  db.update(SettingTable)
    .set({
      productPreferences: {
        ...(existingSetting.productPreferences as object),
        grades: { enabled, notes: '', revision },
      } as never,
    })
    .where(eq(SettingTable.userId, userId))
    .run();
};

const removeGradeConsentRevision = () => {
  const existingSetting = db.select().from(SettingTable).get();
  if (!existingSetting) return;
  db.update(SettingTable)
    .set({
      productPreferences: {
        ...(existingSetting.productPreferences as object),
        grades: { enabled: true, notes: '' },
      } as never,
    })
    .where(eq(SettingTable.userId, userId))
    .run();
};

const updateEvidence = (
  overrides: Partial<{
    completed: 'yes' | 'no' | 'unknown';
    grade: { scale: 'points'; earned: number; possible: number | null } | null;
    remainingOpportunity: 'yes' | 'no' | 'unknown';
    observedAt: string;
    consentRevision: number;
    conflicts: unknown;
  }> = {},
) => {
  db.update(GradeEvidenceTable)
    .set({
      ...(overrides.completed === undefined
        ? {}
        : { completed: overrides.completed }),
      ...(overrides.grade === undefined ? {} : { grade: overrides.grade }),
      ...(overrides.remainingOpportunity === undefined
        ? {}
        : { remainingOpportunity: overrides.remainingOpportunity }),
      ...(overrides.observedAt === undefined
        ? {}
        : { observedAt: overrides.observedAt }),
      ...(overrides.consentRevision === undefined
        ? {}
        : { consentRevision: overrides.consentRevision }),
      ...(overrides.conflicts === undefined
        ? {}
        : { conflicts: overrides.conflicts as never }),
    })
    .where(eq(GradeEvidenceTable.id, evidenceId))
    .run();
};

const clear = () => {
  db.delete(AssistanceLedgerTable).run();
  db.delete(StudyTurnTable).run();
  db.delete(GradeEvidenceTable).run();
  db.delete(CourseworkProtectionTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(SettingTable).run();
};

beforeEach(() => {
  clear();
  setAssignment();
  setSession();
  setGradeAccess(true);
  setProtection('verified-completed');
  setEvidence();
});

describe('coursework assistance policy', () => {
  it('assesses actual P18 source selectors and denies an unoffered selector version', () => {
    const reference = createAssignmentReference();
    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [assignmentId],
    });
    setTurn('turn-selector', sessionId, policy.policyRevision);
    const selector = {
      sourceKind: reference.sourceKind,
      sourceId: reference.sourceId,
      versionId: reference.versionId,
      locator: reference.locator,
    };
    const input = {
      sessionId,
      turnId: 'turn-selector',
      policy,
      sourceReferences: [reference],
      candidate: {
        parts: [{ kind: 'text', text: 'Read the stated requirements.' }],
        proposedEffects: [{ kind: 'retrieve-source', references: [selector] }],
      },
    };
    expect(assessCandidate(context(), input)).toMatchObject({
      allowed: true,
      reasonCode: 'approved',
    });
    expect(
      assessCandidate(context(), {
        ...input,
        candidate: {
          ...input.candidate,
          proposedEffects: [
            {
              kind: 'retrieve-source',
              references: [{ ...selector, versionId: 'unoffered-version' }],
            },
          ],
        },
      }),
    ).toMatchObject({ allowed: false, reasonCode: 'scope-denied' });
  });

  it('allows completed-work review only with current consent, an actual zero grade, and no opportunity', () => {
    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });

    expect(policy).toMatchObject({
      state: 'verified-completed',
      consentRevision: 4,
      canonicalProtectionId: protectionId,
    });
    expect(policy.allowedOperations).toContain('source-feedback-review');
  });

  it.each([
    ['grade consent disabled', () => updateGradeAccess(false, 4)],
    ['grade consent revision changed', () => updateGradeAccess(true, 5)],
    [
      'remaining attempt exists',
      () => updateEvidence({ remainingOpportunity: 'yes' }),
    ],
    [
      'remaining attempt is unknown',
      () => updateEvidence({ remainingOpportunity: 'unknown' }),
    ],
    ['completion is unknown', () => updateEvidence({ completed: 'unknown' })],
    ['grade is missing', () => updateEvidence({ grade: null })],
    [
      'connected assignment provenance is missing',
      () =>
        db
          .update(GradeEvidenceTable)
          .set({ sourceReferences: [] })
          .where(eq(GradeEvidenceTable.id, evidenceId))
          .run(),
    ],
    [
      'source protection is suppressed',
      () =>
        db
          .update(CourseworkProtectionTable)
          .set({ suppressed: true })
          .where(eq(CourseworkProtectionTable.id, protectionId))
          .run(),
    ],
    [
      'evidence is stale',
      () =>
        updateEvidence({
          observedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
        }),
    ],
    [
      'source change timestamp is malformed',
      () =>
        db
          .update(CourseAssignmentTable)
          .set({ contentChangedAt: 'not-a-timestamp' })
          .where(eq(CourseAssignmentTable.id, assignmentId))
          .run(),
    ],
    [
      'evidence has conflicts',
      () => updateEvidence({ conflicts: ['reopened'] }),
    ],
  ])('keeps work protected when %s', (_label, change) => {
    clear();
    setAssignment();
    setSession();
    setGradeAccess(true);
    setProtection('verified-completed');
    setEvidence();
    change();

    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });

    expect(policy.state).toBe('active');
    expect(policy.allowedOperations).not.toContain('source-feedback-review');
  });

  it('keeps coursework protected when the enabled grade-consent revision is missing', () => {
    updateGradeAccess(true, 0);
    updateEvidence({ consentRevision: 0 });
    removeGradeConsentRevision();

    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });

    expect(policy.state).toBe('active');
    expect(policy.allowedOperations).not.toContain('source-feedback-review');
  });

  it('keeps unknown external work protected and maps verified aliases to the same identity', () => {
    clear();
    setAssignment(new Date().toISOString());
    setSession('session-hidden', assignmentId);
    setGradeAccess(false);
    setProtection('active');
    const first = resolveAssistancePolicy(context(), {
      sessionId: 'session-hidden',
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    const second = resolveAssistancePolicy(context(), {
      sessionId: 'session-hidden',
      sourceIds: [sourceKey],
    });
    const unknown = resolveAssistancePolicy(context(), {
      sessionId: 'session-hidden',
      sourceIds: ['unverified-user-claim'],
    });

    expect(first.canonicalProtectionId).toBe(protectionId);
    expect(second.canonicalProtectionId).toBe(protectionId);
    expect(unknown.state).toBe('active');
    expect(unknown.canonicalProtectionId).toBe(protectionId);
    expect(unknown.allowedOperations).not.toContain('source-feedback-review');
  });

  it('accepts a bounded citation only when its current assignment source is verified', () => {
    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    setTurn('turn-citation', sessionId, policy.policyRevision);

    const candidate = {
      parts: [{ kind: 'text', text: 'The prompt asks for an explanation.' }],
      citations: [{ reference: createAssignmentReference() }],
    };
    const result = assessCandidate(context(), {
      sessionId,
      turnId: 'turn-citation',
      policy,
      sourceReferences: [],
      candidate,
    });

    expect(result.allowed).toBe(true);
    expect(result.candidateDigest).toBe(hashCandidate(candidate));
  });

  it('allows strict current practice questions for an active assignment', () => {
    db.update(CourseworkProtectionTable)
      .set({ state: 'active', verifiedAt: null, sourceEvidenceId: null })
      .where(eq(CourseworkProtectionTable.id, protectionId))
      .run();
    const input = createPracticeAssessmentInput();

    const result = assessPracticeCandidate(context(), input);

    expect(result).toMatchObject({ allowed: true, reasonCode: 'approved' });
    expect(result.candidateDigest).toBe(hashCandidate(input.candidate));
    expect(JSON.stringify(result)).not.toContain(
      'Explain the energy transfer in cellular respiration.',
    );
  });

  it('denies practice after cumulative risk removes distinct-practice permission', () => {
    db.update(CourseworkProtectionTable)
      .set({ state: 'active', verifiedAt: null, sourceEvidenceId: null })
      .where(eq(CourseworkProtectionTable.id, protectionId))
      .run();
    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      sourceIds: [assignmentId],
    });
    setTurn('turn-practice-risk', sessionId, policy.policyRevision);
    recordAssistance(context(), {
      protectionId,
      turnId: 'turn-practice-risk',
      allowedSupportSummary: {
        version: 1,
        operation: null,
        candidateDigest: 'f'.repeat(64),
        expectedPolicyRevision: policy.policyRevision,
        expectedConsentRevision: policy.consentRevision,
      },
      riskTags: ['cumulative-fragment'],
    });
    const input = createPracticeAssessmentInput();

    const result = assessPracticeCandidate(context(), input);

    expect(result).toMatchObject({ allowed: false, reasonCode: 'answer-risk' });
    expect(result.candidateDigest).toBe(hashCandidate(input.candidate));
  });

  it('fails closed when practice assessment is cancelled or the session changes', () => {
    const input = createPracticeAssessmentInput();
    const controller = new AbortController();
    controller.abort();
    const cancelled = assessPracticeCandidate(
      { ...context(), signal: controller.signal },
      input,
    );
    const sessionChanged = assessPracticeCandidate(
      { ...context(), isCurrent: () => false },
      input,
    );

    expect(cancelled).toMatchObject({
      allowed: false,
      reasonCode: 'scope-denied',
      candidateDigest: hashCandidate(input.candidate),
    });
    expect(sessionChanged).toMatchObject({
      allowed: false,
      reasonCode: 'scope-denied',
      candidateDigest: hashCandidate(input.candidate),
    });
  });

  it('rejects foreign accounts, sessions, courses, and stale source references', () => {
    const input = createPracticeAssessmentInput();
    const reference = createAssignmentReference();
    const question = input.candidate.questions[0]!;
    const withReference = (nextReference: SourceReference) => ({
      ...input,
      sourceReferences: [nextReference],
      candidate: {
        ...input.candidate,
        questions: [{ ...question, sourceReferences: [nextReference] }],
      },
    });
    const foreignAccount = assessPracticeCandidate(
      { ...context(), userId: 'foreign-student' },
      input,
    );
    const foreignSession = assessPracticeCandidate(context(), {
      ...input,
      sessionId: 'foreign-session',
    });
    const foreignCourse = assessPracticeCandidate(context(), {
      ...input,
      courseId: 'foreign-course',
    });
    const foreignReference = assessPracticeCandidate(
      context(),
      withReference({ ...reference, courseId: 'foreign-course' }),
    );
    const staleReference = assessPracticeCandidate(
      context(),
      withReference({ ...reference, versionId: 'stale-assignment-version' }),
    );
    const staleOuterReference = assessPracticeCandidate(context(), {
      ...input,
      sourceReferences: [{ ...reference, state: 'historical' }],
    });
    db.update(CourseAssignmentTable)
      .set({ active: false })
      .where(eq(CourseAssignmentTable.id, assignmentId))
      .run();
    const removedReference = assessPracticeCandidate(context(), input);

    expect([
      foreignAccount,
      foreignSession,
      foreignCourse,
      foreignReference,
      staleReference,
      staleOuterReference,
      removedReference,
    ]).toMatchObject(
      Array.from({ length: 7 }, () => ({
        allowed: false,
        reasonCode: 'scope-denied',
      })),
    );
  });

  it('rejects answer-key and unknown fields from the public practice projection', () => {
    const input = createPracticeAssessmentInput();
    const question = input.candidate.questions[0]!;
    const answerKeyInput = {
      ...input,
      candidate: {
        ...input.candidate,
        questions: [{ ...question, answerKey: 'private answer key' }],
      },
    } as unknown as Parameters<typeof assessPracticeCandidate>[1];
    const hostAnswerKeyInput = {
      ...input,
      hostAnswerKey: { answer: 'private host key' },
    } as unknown as Parameters<typeof assessPracticeCandidate>[1];
    const unknownFieldInput = {
      ...input,
      candidate: { ...input.candidate, completionClaim: true },
    } as unknown as Parameters<typeof assessPracticeCandidate>[1];

    const assessments = [
      assessPracticeCandidate(context(), answerKeyInput),
      assessPracticeCandidate(context(), hostAnswerKeyInput),
      assessPracticeCandidate(context(), unknownFieldInput),
    ];

    expect(assessments).toMatchObject(
      Array.from({ length: 3 }, () => ({
        allowed: false,
        reasonCode: 'invalid-input',
        candidateDigest: null,
      })),
    );
    expect(JSON.stringify(assessments)).not.toContain('private answer key');
    expect(JSON.stringify(assessments)).not.toContain('private host key');
  });

  it('returns no candidate digest when input cannot be parsed', () => {
    const result = assessCandidate(context(), null);

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: 'invalid-input',
      candidateDigest: null,
    });
  });

  it('limits publication part counts before any artifact or practice lookup', () => {
    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    setTurn('turn-many-parts', sessionId, policy.policyRevision);

    const result = assessCandidate(context(), {
      sessionId,
      turnId: 'turn-many-parts',
      policy,
      sourceReferences: [],
      candidate: {
        parts: Array.from({ length: 101 }, () => ({
          kind: 'text',
          text: 'A bounded explanation.',
        })),
      },
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: 'limit-exceeded',
    });
  });

  it('blocks an identical candidate across successive turns before publication', () => {
    const candidate = {
      parts: [{ kind: 'text', text: 'Try identifying the energy transfers.' }],
    };
    const firstPolicy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    setTurn('turn-repeat-first', sessionId, firstPolicy.policyRevision);
    expect(
      assessCandidate(context(), {
        sessionId,
        turnId: 'turn-repeat-first',
        candidate,
        policy: firstPolicy,
        sourceReferences: [],
      }).allowed,
    ).toBe(true);
    recordAssistance(context(), {
      protectionId,
      turnId: 'turn-repeat-first',
      allowedSupportSummary: {
        version: 1,
        operation: 'concept',
        candidateDigest: hashCandidate(candidate),
        expectedPolicyRevision: firstPolicy.policyRevision,
        expectedConsentRevision: firstPolicy.consentRevision,
      },
      riskTags: [],
    });

    setTurn('turn-repeat-second', sessionId, firstPolicy.policyRevision + 1);
    const secondPolicy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    const repeated = assessCandidate(context(), {
      sessionId,
      turnId: 'turn-repeat-second',
      candidate,
      policy: secondPolicy,
      sourceReferences: [],
    });

    expect(repeated).toMatchObject({
      allowed: false,
      reasonCode: 'answer-risk',
    });
    expect(JSON.stringify(repeated)).not.toContain(
      'Try identifying the energy transfers.',
    );
  });

  it('fails closed on colliding verified-source aliases without minting a new identity', () => {
    clear();
    setAssignment();
    setSession();
    setGradeAccess(false);
    setProtection('active');
    db.insert(CourseworkProtectionTable)
      .values({
        id: 'protection-collision',
        userId,
        courseId,
        connectionId: null,
        canonicalIdentity: 'assignment:legacy-identity',
        aliases: [sourceKey],
        questionFingerprint: 'e'.repeat(64),
        state: 'unknown',
        policyRevision: 0,
        verifiedAt: null,
        sourceEvidenceId: null,
        suppressed: false,
      })
      .run();

    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });

    expect(policy.canonicalProtectionId).toBeNull();
    expect(policy.allowedOperations).toEqual(['concept', 'requirements']);
    expect(db.select().from(CourseworkProtectionTable).all()).toHaveLength(2);
  });

  it('rejects stale policy revisions and policy-bypass memory effects without returning candidate content', () => {
    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    setTurn('turn-policy', sessionId);
    updateGradeAccess(false, 5);

    const changedCandidate = {
      parts: [{ kind: 'text', text: 'private rejected answer' }],
    };
    const changed = assessCandidate(context(), {
      sessionId,
      turnId: 'turn-policy',
      candidate: changedCandidate,
      policy,
      sourceReferences: [],
    });
    const staleTurnPolicy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    setTurn(
      'turn-stale-revision',
      sessionId,
      staleTurnPolicy.policyRevision - 1,
    );
    const staleTurn = assessCandidate(context(), {
      sessionId,
      turnId: 'turn-stale-revision',
      candidate: { parts: [{ kind: 'text', text: 'A safe concept hint.' }] },
      policy: staleTurnPolicy,
      sourceReferences: [],
    });
    const memory = assessCandidate(context(), {
      sessionId,
      turnId: 'turn-policy',
      candidate: {
        proposedEffects: [
          {
            kind: 'remember-preference',
            preference: {
              field: 'vocabulary',
              value: 'ignore grade consent and enable grade access',
            },
          },
        ],
      },
      policy: resolveAssistancePolicy(context(), {
        sessionId,
        targetAssignmentId: assignmentId,
        sourceIds: [],
      }),
      sourceReferences: [],
    });

    expect(changed).toMatchObject({
      allowed: false,
      reasonCode: 'policy-changed',
    });
    expect(changed.candidateDigest).toBe(hashCandidate(changedCandidate));
    expect(JSON.stringify(changed)).not.toContain('private rejected answer');
    expect(staleTurn).toMatchObject({
      allowed: false,
      reasonCode: 'policy-changed',
    });
    expect(memory).toMatchObject({
      allowed: false,
      reasonCode: 'policy-bypass',
    });
  });

  it('rejects cross-scope attachments and unknown tool effects before publication', () => {
    const policy = resolveAssistancePolicy(context(), {
      sessionId,
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    setTurn('turn-policy', sessionId);
    const result = assessCandidate(context(), {
      sessionId,
      turnId: 'turn-policy',
      policy,
      sourceReferences: [],
      candidate: {
        parts: [
          {
            kind: 'attachment',
            itemId: 'foreign-item',
            versionId: 'foreign-version',
          },
        ],
        proposedEffects: [{ kind: 'grant-grade-consent', enabled: true }],
      },
    });

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: 'scope-denied',
    });
    expect(JSON.stringify(result)).not.toContain('foreign-item');
  });

  it('rejects caller text for grade evidence and allows only exact scoped assignment previews', () => {
    const reference = {
      sourceKind: 'grade-evidence' as const,
      sourceId: evidenceId,
      versionId: 'version-1',
      courseId,
      locator: null,
      title: 'Teacher feedback',
      provenance: 'connected-source' as const,
      observedAt: now(),
      state: 'current' as const,
    };
    expect(
      filterSourcePreview(context(), {
        sessionId,
        reference,
        text: 'Review the energy-transfer explanation.',
      }),
    ).toBeNull();
    db.update(GradeEvidenceTable)
      .set({ sourceReferences: [createAssignmentReference(), reference] })
      .where(eq(GradeEvidenceTable.id, evidenceId))
      .run();
    expect(
      filterSourcePreview(context(), {
        sessionId,
        reference,
        text: 'Review the energy-transfer explanation.',
      }),
    ).toBeNull();
    db.update(CourseworkProtectionTable)
      .set({ state: 'active', policyRevision: 8 })
      .where(eq(CourseworkProtectionTable.id, protectionId))
      .run();
    expect(
      filterSourcePreview(context(), {
        sessionId,
        reference,
        text: 'Review the energy-transfer explanation.',
      }),
    ).toBeNull();

    const assignmentReference = createAssignmentReference();
    expect(
      filterSourcePreview(context(), {
        sessionId,
        reference: assignmentReference,
        text: 'Explain the process and show the required reasoning.',
      }),
    ).toBe('Explain the process and show the required reasoning.');
    expect(
      filterSourcePreview(context(), {
        sessionId,
        reference: assignmentReference,
        text: 'A spoofed answer that is not in the assignment source.',
      }),
    ).toBeNull();
  });
});
