import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-watch-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
      getLoginItemSettings: () => ({ openAtLogin: false }),
    },
  };
});

const { db } = await import('../../../db');
const { AcademicConnectionTable, CourseTable, SettingTable, WatchTargetTable } =
  await import('../../../db/schema');
const {
  getWatchSettings,
  getWatchTargets,
  getLastWatchReconciledAt,
  recordWatchReconciledAt,
  markWatchTargetProcessed,
  recordWatchFailure,
  recordWatchObservation,
  scheduleWatchTargetCheck,
  saveWatchSettings,
  synchronizeWatchTargets,
  upsertWatchTarget,
} = await import('../services/store');

const student = 'student-a';
const other = 'student-b';
const connectionId = 'connection-a';
const otherConnectionId = 'connection-b';
const now = '2026-11-01T12:00:00.000Z';
const watchUrl = 'https://canvas.school.edu/courses/1/assignments';

const insertConnection = (userId: string, id: string) =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id,
      userId,
      name: 'Canvas',
      url: 'https://canvas.school.edu/',
      host: 'canvas.school.edu',
      kind: 'canvas',
      status: 'verified',
      verifiedAt: now,
      isCourseResource: true,
    })
    .run();

const insertCourse = (userId: string, id: string, sourceConnectionId: string) =>
  db
    .insert(CourseTable)
    .values({
      id,
      userId,
      connectionId: sourceConnectionId,
      sourceKey: `${sourceConnectionId}-${id}`,
      sourceName: 'Canvas',
      sourceHost: 'canvas.school.edu',
      externalId: id,
      name: 'Biology',
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: 'https://canvas.school.edu/courses/1',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();

beforeEach(() => {
  db.delete(WatchTargetTable).run();
  db.delete(CourseTable).run();
  db.delete(AcademicConnectionTable).run();
  db.delete(SettingTable).run();
  insertConnection(student, connectionId);
  insertConnection(other, otherConnectionId);
  insertCourse(student, 'course-a', connectionId);
  insertCourse(other, 'course-b', otherConnectionId);
});

afterEach(() => vi.useRealTimers());

describe('watch persistence', () => {
  it('persists a dedicated account-scoped daily reconciliation timestamp only while watching is permitted', () => {
    expect(getLastWatchReconciledAt(student)).toBeNull();
    db.insert(SettingTable)
      .values({
        userId: student,
        consent: true,
        watchEnabled: true,
        updatedAt: now,
      })
      .run();
    recordWatchReconciledAt(student, now);
    expect(getLastWatchReconciledAt(student)).toBe(now);
    expect(getLastWatchReconciledAt(other)).toBeNull();
    db.update(SettingTable)
      .set({ watchEnabled: false })
      .where(eq(SettingTable.userId, student))
      .run();
    recordWatchReconciledAt(student, '2026-11-02T12:00:00.000Z');
    expect(getLastWatchReconciledAt(student)).toBe(now);
  });

  it('defaults to off and saves canonical URLs only for the current account', () => {
    expect(getWatchSettings(student)).toEqual({
      watchEnabled: false,
      watchUrls: [],
    });

    const saved = saveWatchSettings(student, {
      watchEnabled: true,
      watchUrls: [' https://canvas.school.edu:443/courses/1/assignments '],
    });

    expect(saved).toEqual({
      watchEnabled: true,
      watchUrls: [watchUrl],
    });
    expect(getWatchSettings(other)).toEqual({
      watchEnabled: false,
      watchUrls: [],
    });
  });

  it('revalidates URLs and rejects duplicate canonical identities in the service', () => {
    expect(() =>
      saveWatchSettings(student, {
        watchEnabled: true,
        watchUrls: ['https://other.edu/courses'],
      }),
    ).toThrow('Connect this resource before adding its URL.');
    expect(() =>
      saveWatchSettings(student, {
        watchEnabled: true,
        watchUrls: [
          watchUrl,
          'https://canvas.school.edu:443/courses/1/assignments',
        ],
      }),
    ).toThrow('That course page URL is already being watched.');
  });

  it('preserves saved URLs when watching is disabled after a connection is removed', () => {
    saveWatchSettings(student, { watchEnabled: true, watchUrls: [watchUrl] });
    db.update(AcademicConnectionTable)
      .set({ isCourseResource: false })
      .where(eq(AcademicConnectionTable.id, connectionId))
      .run();

    expect(
      saveWatchSettings(student, {
        watchEnabled: false,
        watchUrls: [watchUrl],
      }),
    ).toEqual({ watchEnabled: false, watchUrls: [watchUrl] });
    expect(() =>
      saveWatchSettings(student, { watchEnabled: true, watchUrls: [watchUrl] }),
    ).toThrow('Connect this resource before adding its URL.');
  });

  it('upserts one durable target and preserves its local ID', () => {
    const input = {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    };
    const first = upsertWatchTarget(student, input)!;
    const repeated = upsertWatchTarget(student, {
      ...input,
      requestedUrl: 'https://canvas.school.edu:443/courses/1/assignments',
    })!;

    expect(first.id).toBe(repeated.id);
    expect(getWatchTargets(student)).toHaveLength(1);
    expect(repeated).toMatchObject({
      userId: student,
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      verifiedUrl: null,
      pendingChange: false,
      status: 'active',
    });
  });

  it('switches from resource home pages to custom targets and back without deleting state', () => {
    saveWatchSettings(student, { watchEnabled: true, watchUrls: [] });
    const defaults = synchronizeWatchTargets(student);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      requestedUrl: 'https://canvas.school.edu/',
      status: 'active',
    });
    const defaultId = defaults[0]!.id;

    saveWatchSettings(student, { watchEnabled: true, watchUrls: [watchUrl] });
    const customTargets = synchronizeWatchTargets(student);
    expect(customTargets).toHaveLength(2);
    expect(customTargets).toContainEqual(
      expect.objectContaining({ requestedUrl: watchUrl, status: 'active' }),
    );
    expect(
      customTargets.find((target) => target.id === defaultId)?.status,
    ).toBe('suspended');

    saveWatchSettings(student, { watchEnabled: true, watchUrls: [] });
    const restoredDefaults = synchronizeWatchTargets(student);
    expect(
      restoredDefaults.find((target) => target.id === defaultId)?.status,
    ).toBe('active');
    expect(
      restoredDefaults.find((target) => target.requestedUrl === watchUrl)
        ?.status,
    ).toBe('suspended');

    saveWatchSettings(student, { watchEnabled: false, watchUrls: [] });
    expect(
      synchronizeWatchTargets(student).every(
        (target) => target.status === 'suspended',
      ),
    ).toBe(true);
  });

  it('targets an unambiguous custom route to its saved course', () => {
    saveWatchSettings(student, { watchEnabled: true, watchUrls: [watchUrl] });

    expect(synchronizeWatchTargets(student)).toContainEqual(
      expect.objectContaining({
        requestedUrl: watchUrl,
        courseId: 'course-a',
      }),
    );
  });

  it('keeps a custom route connection-scoped when saved course routes overlap', () => {
    insertCourse(student, 'course-duplicate', connectionId);
    saveWatchSettings(student, { watchEnabled: true, watchUrls: [watchUrl] });

    expect(synchronizeWatchTargets(student)).toContainEqual(
      expect.objectContaining({
        requestedUrl: watchUrl,
        courseId: null,
      }),
    );
  });

  it('does not associate a route with a course that shares only its path prefix', () => {
    saveWatchSettings(student, {
      watchEnabled: true,
      watchUrls: ['https://canvas.school.edu/courses/10/assignments'],
    });

    expect(synchronizeWatchTargets(student)).toContainEqual(
      expect.objectContaining({ courseId: null }),
    );
  });

  it('does not match unrelated routes beneath a course saved at the host root', () => {
    db.update(CourseTable)
      .set({ url: 'https://canvas.school.edu/' })
      .where(eq(CourseTable.id, 'course-a'))
      .run();
    saveWatchSettings(student, { watchEnabled: true, watchUrls: [watchUrl] });

    expect(synchronizeWatchTargets(student)).toContainEqual(
      expect.objectContaining({ courseId: null }),
    );
  });

  it('keeps changes pending until the matching fingerprint is processed', () => {
    const target = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;

    const firstObservation = recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'a'.repeat(64),
      checkedAt: now,
      nextCheckAt: '2026-11-01T12:05:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    expect(firstObservation.pendingChange).toBe(true);
    expect(
      markWatchTargetProcessed({
        userId: student,
        targetId: target.id,
        fingerprint: 'a'.repeat(64),
        processedAt: now,
      })?.pendingChange,
    ).toBe(false);

    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'b'.repeat(64),
      checkedAt: '2026-11-01T12:01:00.000Z',
      nextCheckAt: '2026-11-01T12:06:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    const completedOldRevision = markWatchTargetProcessed({
      userId: student,
      targetId: target.id,
      fingerprint: 'a'.repeat(64),
      processedAt: '2026-11-01T12:02:00.000Z',
    });

    expect(completedOldRevision).toMatchObject({
      detectedFingerprint: 'b'.repeat(64),
      processedFingerprint: 'a'.repeat(64),
      pendingChange: true,
    });
    expect(
      markWatchTargetProcessed({
        userId: student,
        targetId: target.id,
        fingerprint: 'b'.repeat(64),
        processedAt: '2026-11-01T12:03:00.000Z',
      })?.pendingChange,
    ).toBe(false);
  });

  it('schedules an unchanged partial observation without replacing its baseline', () => {
    const target = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'a'.repeat(64),
      checkedAt: now,
      nextCheckAt: now,
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    const processed = markWatchTargetProcessed({
      userId: student,
      targetId: target.id,
      fingerprint: 'a'.repeat(64),
      processedAt: now,
    })!;

    const scheduled = scheduleWatchTargetCheck({
      userId: student,
      targetId: target.id,
      checkedAt: '2026-11-01T12:01:00.000Z',
      nextCheckAt: '2026-11-01T12:06:00.000Z',
      attempted: false,
    });

    expect(scheduled).toMatchObject({
      detectedFingerprint: processed.detectedFingerprint,
      processedFingerprint: 'a'.repeat(64),
      pendingChange: false,
      lastAttemptAt: now,
      nextCheckAt: '2026-11-01T12:06:00.000Z',
    });
  });

  it('backs off failed checks and blocks after three attempts without losing pending changes', () => {
    const target = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'b'.repeat(64),
      checkedAt: now,
      nextCheckAt: now,
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });

    const firstFailure = recordWatchFailure({
      userId: student,
      targetId: target.id,
      failedAt: '2026-11-01T12:01:00.000Z',
      retryAt: '2026-11-01T12:02:00.000Z',
      blocked: false,
    });
    const secondFailure = recordWatchFailure({
      userId: student,
      targetId: target.id,
      failedAt: '2026-11-01T12:03:00.000Z',
      retryAt: '2026-11-01T12:08:00.000Z',
      blocked: false,
    });
    const thirdFailure = recordWatchFailure({
      userId: student,
      targetId: target.id,
      failedAt: '2026-11-01T12:09:00.000Z',
      retryAt: null,
      blocked: true,
    });

    expect(firstFailure).toMatchObject({
      failureCount: 1,
      pendingChange: true,
    });
    expect(secondFailure).toMatchObject({
      failureCount: 2,
      retryAt: '2026-11-01T12:08:00.000Z',
      pendingChange: true,
    });
    expect(thirdFailure).toMatchObject({
      failureCount: 3,
      status: 'blocked',
      retryAt: null,
      detectedFingerprint: 'b'.repeat(64),
      pendingChange: true,
    });
    saveWatchSettings(student, { watchEnabled: true, watchUrls: [watchUrl] });
    expect(
      synchronizeWatchTargets(student).find((item) => item.id === target.id)
        ?.status,
    ).toBe('blocked');
  });

  it('does not expose or update another account’s targets', () => {
    const target = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;

    expect(getWatchTargets(other)).toEqual([]);
    expect(
      recordWatchObservation({
        userId: other,
        targetId: target.id,
        fingerprint: 'a'.repeat(64),
        checkedAt: now,
        nextCheckAt: now,
        verifiedUrl: watchUrl,
        recipeVersion: 1,
      }),
    ).toBeNull();
    expect(
      markWatchTargetProcessed({
        userId: other,
        targetId: target.id,
        fingerprint: 'a'.repeat(64),
        processedAt: now,
      }),
    ).toBeNull();
  });
});
