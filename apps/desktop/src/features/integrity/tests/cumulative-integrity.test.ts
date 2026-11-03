import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(
    join(tmpdir(), 'scholaros-cumulative-integrity-'),
  );
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
const { resolveAssistancePolicy } = await import('../services/policy');

const userId = 'student-cumulative';
const courseId = 'course-cumulative';
const assignmentId = 'assignment-cumulative';
const sourceKey = 'source-cumulative-22';
const protectionId = 'protection-cumulative';
const context = () => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});
const now = () => new Date().toISOString();
const summary = (
  operation: 'bounded-hint' | null,
  policyRevision: number,
  consentRevision: number,
  digest: string,
) => ({
  version: 1,
  operation,
  candidateDigest: digest,
  expectedPolicyRevision: policyRevision,
  expectedConsentRevision: consentRevision,
});

const addSession = (
  sessionId: string,
  turnId: string,
  assignment = assignmentId,
  policyRevision = 0,
) => {
  db.insert(StudySessionTable)
    .values({
      id: sessionId,
      userId,
      courseId,
      title: 'Study',
      activity: 'assignment-start',
      targetAssignmentId: assignment,
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
  db.insert(StudyTurnTable)
    .values({
      id: turnId,
      userId,
      sessionId,
      requestId: `10000000-0000-4000-8000-${turnId.slice(-12).padStart(12, '0')}`,
      payloadHash: 'c'.repeat(64),
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

beforeEach(() => {
  db.delete(AssistanceLedgerTable).run();
  db.delete(StudyTurnTable).run();
  db.delete(GradeEvidenceTable).run();
  db.delete(CourseworkProtectionTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(SettingTable).run();
  db.insert(SettingTable).values({ userId, updatedAt: now() }).run();
  db.insert(CourseAssignmentTable)
    .values({
      id: assignmentId,
      userId,
      courseId,
      sourceKey,
      title: 'Cellular energy assignment',
      body: 'Describe the energy-transfer steps.',
      dateValue: null,
      dateText: null,
      url: 'https://school.example/assignment/22',
      active: true,
      lastSeenAt: now(),
      content: null,
      identityConflicts: [],
      localOverrides: null,
      localEditedAt: null,
      suppressionId: null,
      suppressedAt: null,
      contentChangedAt: null,
    })
    .run();
  db.insert(CourseworkProtectionTable)
    .values({
      id: protectionId,
      userId,
      courseId,
      connectionId: null,
      canonicalIdentity: `assignment:${assignmentId}`,
      aliases: [assignmentId, sourceKey],
      questionFingerprint: 'd'.repeat(64),
      state: 'active',
      policyRevision: 0,
      verifiedAt: null,
      sourceEvidenceId: null,
      suppressed: true,
    })
    .run();
});

describe('cumulative coursework protection', () => {
  it('keeps the same task identity and hint coverage across aliases, hidden records, and new sessions', () => {
    addSession('session-first', 'turn-first');

    const first = resolveAssistancePolicy(context(), {
      sessionId: 'session-first',
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    expect(() =>
      recordAssistance(context(), {
        protectionId,
        turnId: 'turn-first',
        allowedSupportSummary: summary(
          'bounded-hint',
          first.policyRevision,
          first.consentRevision,
          '1'.repeat(64),
        ),
        riskTags: [],
      }),
    ).not.toThrow();

    addSession(
      'session-second',
      'turn-second',
      assignmentId,
      first.policyRevision + 1,
    );
    const second = resolveAssistancePolicy(context(), {
      sessionId: 'session-second',
      sourceIds: [sourceKey],
    });
    expect(second.canonicalProtectionId).toBe(first.canonicalProtectionId);
    expect(second.priorAssistanceSummary).toContain('bounded-hint');
    expect(() =>
      recordAssistance(context(), {
        protectionId,
        turnId: 'turn-second',
        allowedSupportSummary: summary(
          'bounded-hint',
          second.policyRevision,
          second.consentRevision,
          '2'.repeat(64),
        ),
        riskTags: [],
      }),
    ).not.toThrow();

    const exhausted = resolveAssistancePolicy(context(), {
      sessionId: 'session-second',
      sourceIds: [assignmentId],
    });
    expect(exhausted.allowedOperations).not.toContain('bounded-hint');
    expect(exhausted.allowedOperations).toContain('concept');
    expect(exhausted.priorAssistanceSummary).not.toContain(
      'First conceptual nudge',
    );
  });

  it('carries rejected-risk tags across sessions without counting them as hints', () => {
    addSession('session-risk-first', 'turn-risk-first');
    const first = resolveAssistancePolicy(context(), {
      sessionId: 'session-risk-first',
      targetAssignmentId: assignmentId,
      sourceIds: [],
    });
    db.update(StudyTurnTable).set({ status: 'failed', settledAt: now() }).run();

    expect(() =>
      recordAssistance(context(), {
        protectionId,
        turnId: 'turn-risk-first',
        allowedSupportSummary: summary(
          null,
          first.policyRevision,
          first.consentRevision,
          'f'.repeat(64),
        ),
        riskTags: ['cumulative-fragment', 'policy-bypass'],
      }),
    ).not.toThrow();

    addSession(
      'session-risk-second',
      'turn-risk-second',
      assignmentId,
      first.policyRevision + 1,
    );
    const second = resolveAssistancePolicy(context(), {
      sessionId: 'session-risk-second',
      sourceIds: [sourceKey],
    });

    expect(second.priorAssistanceSummary).toContain('cumulative-fragment');
    expect(second.allowedOperations).not.toContain('bounded-hint');
    expect(second.allowedOperations).not.toContain('distinct-practice');
    expect(second.allowedOperations).toContain('concept');
  });

  it('keeps ambiguous or unverified external identities in one conservative course scope', () => {
    addSession('session-first', 'turn-first', 'missing-assignment');
    addSession('session-second', 'turn-second', 'another-missing-assignment');

    const first = resolveAssistancePolicy(context(), {
      sessionId: 'session-first',
      targetAssignmentId: 'missing-assignment',
      sourceIds: [],
    });
    const second = resolveAssistancePolicy(context(), {
      sessionId: 'session-second',
      targetAssignmentId: 'another-missing-assignment',
      sourceIds: ['spoofed-source-id'],
    });

    expect(first.state).toBe('unknown');
    expect(second.state).toBe('unknown');
    expect(second.canonicalProtectionId).toBe(first.canonicalProtectionId);
    expect(first.allowedOperations).not.toContain('source-feedback-review');
  });
});
