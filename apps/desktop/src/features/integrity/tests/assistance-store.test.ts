import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-assistance-store-'));
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
  CourseworkProtectionTable,
  SettingTable,
  StudySessionTable,
  StudyTurnTable,
} = await import('../../../db/schema');
const { recordAssistance } = await import('../services/assistance-store');

const userId = 'student-ledger';
const courseId = 'course-ledger';
const protectionId = 'protection-ledger';
const context = (isCurrent: () => boolean = () => true) => ({
  userId,
  epoch: 3,
  isCurrent,
  signal: new AbortController().signal,
});
const now = () => new Date().toISOString();
const summary = (
  operation:
    | 'concept'
    | 'requirements'
    | 'bounded-hint'
    | 'distinct-practice'
    | 'source-feedback-review'
    | null,
  policyRevision: number,
  digest: string,
) => ({
  version: 1,
  operation,
  candidateDigest: digest,
  expectedPolicyRevision: policyRevision,
  expectedConsentRevision: 0,
});
const insertSessionAndTurn = (
  sessionId: string,
  turnId: string,
  policyRevision = 0,
) => {
  db.insert(StudySessionTable)
    .values({
      id: sessionId,
      userId,
      courseId,
      title: 'Study',
      activity: 'assignment-start',
      targetAssignmentId: null,
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
      requestId: `00000000-0000-4000-8000-${turnId.padStart(12, '0')}`,
      payloadHash: 'a'.repeat(64),
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
  db.delete(StudySessionTable).run();
  db.delete(CourseworkProtectionTable).run();
  db.delete(SettingTable).run();
  db.insert(SettingTable).values({ userId, updatedAt: now() }).run();
  db.insert(CourseworkProtectionTable)
    .values({
      id: protectionId,
      userId,
      courseId,
      connectionId: null,
      canonicalIdentity: 'coursework:unknown',
      aliases: [],
      questionFingerprint: 'b'.repeat(64),
      state: 'unknown',
      policyRevision: 0,
      verifiedAt: null,
      sourceEvidenceId: null,
      suppressed: false,
    })
    .run();
});

describe('content-minimized assistance ledger', () => {
  it('persists only bounded operation counts, risk tags, and candidate digests', () => {
    insertSessionAndTurn('session-ledger', 'turn-ledger-1');

    const input = {
      protectionId,
      turnId: 'turn-ledger-1',
      allowedSupportSummary: summary('bounded-hint', 0, 'c'.repeat(64)),
      riskTags: [],
    };
    expect(() => recordAssistance(context(), input)).not.toThrow();
    db.update(StudyTurnTable)
      .set({ status: 'complete', settledAt: now() })
      .run();
    expect(() => recordAssistance(context(), input)).not.toThrow();

    const [entry] = db.select().from(AssistanceLedgerTable).all();
    const stored = JSON.stringify(entry?.allowedSupportSummary);
    expect(entry?.assistanceUnits).toBe(1);
    expect(entry?.answerRiskTags).toEqual([]);
    expect(stored).not.toContain('Sensitive exact answer');
    expect(stored).toContain('bounded-hint');
    expect(
      db.select().from(CourseworkProtectionTable).get()?.policyRevision,
    ).toBe(1);
  });

  it('retains risk-only decisions without counting rejected text as permitted assistance', () => {
    insertSessionAndTurn('session-risk', 'turn-risk');

    expect(() =>
      recordAssistance(context(), {
        protectionId,
        turnId: 'turn-risk',
        allowedSupportSummary: summary(null, 0, 'e'.repeat(64)),
        riskTags: ['answer-adjacent', 'policy-bypass'],
      }),
    ).not.toThrow();

    const [entry] = db.select().from(AssistanceLedgerTable).all();
    const summaryJson = JSON.parse(
      JSON.stringify(entry?.allowedSupportSummary),
    ) as { operations: Record<string, number>; candidateDigests: string[] };
    expect(entry?.answerRiskTags).toEqual(['answer-adjacent', 'policy-bypass']);
    expect(entry?.assistanceUnits).toBe(0);
    expect(summaryJson.operations['bounded-hint']).toBe(0);
    expect(summaryJson.candidateDigests).toEqual(['e'.repeat(64)]);
  });

  it('uses a revision compare-and-swap and caps active-work hints across separate sessions', () => {
    insertSessionAndTurn('session-ledger-1', 'turn-ledger-1', 0);
    insertSessionAndTurn('session-ledger-2', 'turn-ledger-2', 1);
    insertSessionAndTurn('session-ledger-3', 'turn-ledger-3', 2);

    const write = (turnId: string, expectedPolicyRevision: number) =>
      recordAssistance(context(), {
        protectionId,
        turnId,
        allowedSupportSummary: summary(
          'bounded-hint',
          expectedPolicyRevision,
          `${expectedPolicyRevision}`.repeat(64),
        ),
        riskTags: [],
      });

    expect(() => write('turn-ledger-1', 0)).not.toThrow();
    expect(() => write('turn-ledger-2', 0)).toThrow('revision-conflict');
    expect(() => write('turn-ledger-2', 1)).not.toThrow();
    expect(() => write('turn-ledger-3', 2)).toThrow('limit-exceeded');
    expect(db.select().from(AssistanceLedgerTable).all()).toHaveLength(1);
    expect(db.select().from(AssistanceLedgerTable).get()?.assistanceUnits).toBe(
      2,
    );
  });

  it('does not record work after session invalidation, foreign turns, or raw summaries', () => {
    insertSessionAndTurn('session-ledger', 'turn-ledger-1');
    const input = {
      protectionId,
      turnId: 'turn-ledger-1',
      allowedSupportSummary: summary('concept', 0, 'd'.repeat(64)),
      riskTags: [],
    };

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      recordAssistance(
        context(() => false),
        input,
      ),
    ).toThrow('session-changed');
    expect(() =>
      recordAssistance({ ...context(), signal: controller.signal }, input),
    ).toThrow('cancelled');
    expect(() =>
      recordAssistance(context(), { ...input, turnId: 'foreign-turn' }),
    ).toThrow('scope-denied');
    expect(() =>
      recordAssistance(context(), {
        ...input,
        allowedSupportSummary: {
          ...input.allowedSupportSummary,
          text: 'full deleted transcript must never persist',
        },
      }),
    ).toThrow('invalid-input');
    expect(db.select().from(AssistanceLedgerTable).all()).toHaveLength(0);
  });
});
