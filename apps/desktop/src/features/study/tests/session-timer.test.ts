import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-study-timer-'));
  const app = {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn(),
  };
  return { app, default: { app } };
});

const { db } = await import('../../../db');
const { CourseTable, StudyMessageTable, StudySessionTable, StudyTurnTable } =
  await import('../../../db/schema');
const { createSessionStore } = await import('../services/session-store');
const { createStudyTimer } = await import('../services/session-timer');
const { registerStudySessionOperation } =
  await import('../services/session-events');

const owner = 'timer-student';
const courseId = 'timer-course';
const context: AuthorizedContext = {
  userId: owner,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
};
const clock = { value: Date.parse('2026-03-08T07:55:00.000Z') };
const store = createSessionStore({
  database: db,
  now: () => clock.value,
});
const timer = createStudyTimer({
  database: db,
  now: () => clock.value,
});

const createTimedSession = async (durationMinutes: number | null = 10) =>
  store.createStudySession(context, {
    requestId: crypto.randomUUID(),
    courseId,
    activity: 'understand-topic',
    targetAssignmentId: null,
    topic: 'Clock test',
    contextItemIds: [],
    durationMinutes,
    title: 'Timer test',
  });

beforeEach(() => {
  clock.value = Date.parse('2026-03-08T07:55:00.000Z');
  vi.useFakeTimers();
  vi.setSystemTime(clock.value);
  db.delete(StudyMessageTable).run();
  db.delete(StudyTurnTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseTable).run();
  db.insert(CourseTable)
    .values({
      id: courseId,
      userId: owner,
      connectionId: null,
      sourceKey: `manual:${courseId}`,
      sourceName: 'Manual',
      sourceHost: '',
      externalId: null,
      name: 'Clock course',
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: '',
      firstSeenAt: new Date(clock.value).toISOString(),
      lastSeenAt: new Date(clock.value).toISOString(),
    })
    .run();
});

describe('wall-clock session timers', () => {
  it('persists an absolute deadline and leaves untimed sessions deadline-free', async () => {
    const timed = await createTimedSession(10);
    const untimed = await createTimedSession(null);

    expect(timed.timer.deadlineAt).toBe('2026-03-08T08:05:00.000Z');
    expect(untimed.timer.deadlineAt).toBeNull();
    expect(untimed.timer.revision).toBe(0);
  });

  it('reconciles expiry once after an offline interval without clearing a draft or active turn', async () => {
    const created = await createTimedSession(1);
    await store.saveStudyDraft(context, {
      sessionId: created.id,
      text: 'Keep my unfinished work',
      expectedDraftRevision: 0,
    });
    const turn = await store.beginStudyTurn(context, {
      sessionId: created.id,
      requestId: crypto.randomUUID(),
      expectedDraftRevision: 1,
      text: 'A turn still generating',
      attachmentIds: [],
    });
    const unregister = registerStudySessionOperation(
      context,
      created.id,
      turn.turnId,
      new AbortController(),
    );
    clock.value += 2 * 60_000;
    vi.setSystemTime(clock.value);

    const first = await timer.reconcileStudyDeadline(context, {
      sessionId: created.id,
    });
    const second = await timer.reconcileStudyDeadline(context, {
      sessionId: created.id,
    });
    const snapshot = await store.getStudySession(context, {
      sessionId: created.id,
    });
    unregister();
    const summaries = db
      .select()
      .from(StudyMessageTable)
      .all()
      .filter((message) =>
        message.parts.some(
          (part) =>
            part.kind === 'status' &&
            part.code.startsWith('study-timer-expired'),
        ),
      );

    expect(first.expiredRevision).toBe(0);
    expect(second.expiredRevision).toBe(0);
    expect(first.resolvedExpiredRevision).toBeNull();
    expect(summaries).toHaveLength(1);
    expect(snapshot?.session.draft).toEqual({
      text: 'Keep my unfinished work',
      revision: 1,
    });
    expect(snapshot?.activeTurn?.id).toBe(turn.turnId);
  });

  it('finishes, extends and continues indefinitely with revision-checked commands', async () => {
    const created = await createTimedSession(5);
    const finished = await timer.finishStudySession(context, {
      sessionId: created.id,
      requestId: crypto.randomUUID(),
      expectedTimerRevision: 0,
    });

    expect(finished.status).toBe('finished');
    expect(finished.timer.finishedAt).toBe('2026-03-08T07:55:00.000Z');
    expect(
      await timer.finishStudySession(context, {
        sessionId: created.id,
        requestId: crypto.randomUUID(),
        expectedTimerRevision: 0,
      }),
    ).toMatchObject({ status: 'finished', timer: finished.timer });
    await expect(
      timer.extendStudySession(context, {
        sessionId: created.id,
        requestId: crypto.randomUUID(),
        expectedTimerRevision: 0,
        durationMinutes: 5,
      }),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
  });

  it('extends an expired session from now and does not add time again on replay', async () => {
    const created = await createTimedSession(1);
    clock.value += 2 * 60_000;
    vi.setSystemTime(clock.value);
    await timer.reconcileStudyDeadline(context, { sessionId: created.id });
    const extension = {
      sessionId: created.id,
      requestId: crypto.randomUUID(),
      expectedTimerRevision: 0,
      durationMinutes: 25,
    };
    const extended = await timer.extendStudySession(context, extension);
    const replayed = await timer.extendStudySession(context, extension);

    expect(extended.deadlineAt).toBe('2026-03-08T08:22:00.000Z');
    expect(extended.revision).toBe(1);
    expect(replayed).toEqual(extended);
    expect(db.select().from(StudySessionTable).get()?.deadlineAt).toBe(
      '2026-03-08T08:22:00.000Z',
    );
  });

  it('clears the deadline on Continue indefinitely and resolves that expiry revision once', async () => {
    const created = await createTimedSession(1);
    clock.value += 2 * 60_000;
    vi.setSystemTime(clock.value);
    await timer.reconcileStudyDeadline(context, { sessionId: created.id });
    const command = {
      sessionId: created.id,
      requestId: crypto.randomUUID(),
      expectedTimerRevision: 0,
    };

    const continued = await timer.continueStudyUntimed(context, command);
    const replayed = await timer.continueStudyUntimed(context, command);

    expect(continued).toMatchObject({
      deadlineAt: null,
      revision: 1,
      expiredRevision: 0,
      resolvedExpiredRevision: 0,
    });
    expect(replayed).toEqual(continued);
    expect(db.select().from(StudySessionTable).get()?.deadlineAt).toBeNull();
  });

  it('keeps the absolute deadline through a daylight-saving transition', async () => {
    const created = await createTimedSession(20);
    const start = new Date(created.timer.deadlineAt!);
    const display = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(start);

    expect(created.timer.deadlineAt).toBe('2026-03-08T08:15:00.000Z');
    expect(display).toContain('3:15');
    expect(display).toContain('CDT');
  });

  it('records a backward clock anomaly without granting a new duration', async () => {
    const created = await createTimedSession(10);
    const persistedDeadline = created.timer.deadlineAt;
    clock.value += 5 * 60_000;
    vi.setSystemTime(clock.value);
    await timer.reconcileStudyDeadline(context, { sessionId: created.id });
    clock.value -= 10 * 60_000;
    vi.setSystemTime(clock.value);

    const first = await timer.reconcileStudyDeadline(context, {
      sessionId: created.id,
    });
    const second = await timer.reconcileStudyDeadline(context, {
      sessionId: created.id,
    });
    const anomalies = db
      .select()
      .from(StudyMessageTable)
      .all()
      .filter((message) =>
        message.parts.some(
          (part) =>
            part.kind === 'status' &&
            part.code.startsWith('study-clock-anomaly'),
        ),
      );

    expect(first.deadlineAt).toBe(persistedDeadline);
    expect(second.deadlineAt).toBe(persistedDeadline);
    expect(anomalies).toHaveLength(1);
    expect(first.deadlineAt).not.toBe(
      new Date(clock.value + 10 * 60_000).toISOString(),
    );
  });
});
