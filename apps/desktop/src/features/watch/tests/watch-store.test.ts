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
  getWatchHealthSummary,
  getLastWatchReconciledAt,
  recordWatchReconciledAt,
  markWatchTargetProcessed,
  recordWatchFailure,
  recordWatchObservation,
  resetWatchTargetsAfterReconnect,
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

const enableWatch = (userId: string) => {
  saveWatchSettings(userId, { watchEnabled: true, watchUrls: [] });
  db.update(SettingTable)
    .set({ consent: true })
    .where(eq(SettingTable.userId, userId))
    .run();
};

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
    enableWatch(student);
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
        sessionEpoch: 0,
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
      sessionEpoch: 0,
    });

    expect(completedOldRevision).toBeNull();
    expect(getWatchTargets(student)[0]).toMatchObject({
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
        sessionEpoch: 0,
      })?.pendingChange,
    ).toBe(false);
  });

  it('preserves transient retry history through unchanged successful observations', () => {
    enableWatch(student);
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
      nextCheckAt: '2026-11-01T12:05:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    recordWatchFailure({
      userId: student,
      targetId: target.id,
      failedAt: '2026-11-01T12:00:30.000Z',
      retryAt: '2026-11-01T12:01:30.000Z',
      blocked: false,
      category: 'network',
    });

    const unchanged = recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'a'.repeat(64),
      checkedAt: '2026-11-01T12:01:30.000Z',
      nextCheckAt: '2026-11-01T12:06:30.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });

    expect(unchanged).toMatchObject({
      failureCount: 1,
      lastFailureCategory: 'network',
      retryAt: '2026-11-01T12:01:30.000Z',
      pendingSince: now,
    });

    const changed = recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'b'.repeat(64),
      checkedAt: '2026-11-01T12:02:00.000Z',
      nextCheckAt: '2026-11-01T12:07:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    expect(changed).toMatchObject({
      failureCount: 0,
      lastFailureCategory: null,
      retryAt: null,
      pendingSince: '2026-11-01T12:02:00.000Z',
    });
  });

  it.each(['watchEnabled', 'consent'] as const)(
    'rejects a late observation after %s is revoked',
    (permission) => {
      enableWatch(student);
      const target = upsertWatchTarget(student, {
        connectionId,
        courseId: 'course-a',
        requestedUrl: watchUrl,
        recipeVersion: 1,
      })!;
      db.update(SettingTable)
        .set({ [permission]: false })
        .where(eq(SettingTable.userId, student))
        .run();

      const observation = recordWatchObservation({
        userId: student,
        targetId: target.id,
        fingerprint: 'a'.repeat(64),
        checkedAt: now,
        nextCheckAt: '2026-11-01T12:05:00.000Z',
        verifiedUrl: watchUrl,
        recipeVersion: 1,
      });

      expect(observation).toBeNull();
      expect(getWatchTargets(student)[0]).toMatchObject({
        detectedFingerprint: null,
        pendingChange: false,
        status: 'active',
      });
    },
  );

  it('persists pending age only for the current revision and clears it on coverage', () => {
    enableWatch(student);
    const target = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    const firstDetectedAt = now;
    const secondDetectedAt = '2026-11-01T12:02:00.000Z';
    const secondCheckedAt = '2026-11-01T12:03:00.000Z';

    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'a'.repeat(64),
      checkedAt: firstDetectedAt,
      nextCheckAt: '2026-11-01T12:05:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'a'.repeat(64),
      checkedAt: secondDetectedAt,
      nextCheckAt: '2026-11-01T12:07:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    expect(getWatchTargets(student)[0]).toMatchObject({
      pendingSince: firstDetectedAt,
      pendingSinceEstimated: false,
    });

    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint: 'b'.repeat(64),
      checkedAt: secondDetectedAt,
      nextCheckAt: '2026-11-01T12:07:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    const staleCompletion = markWatchTargetProcessed({
      userId: student,
      targetId: target.id,
      fingerprint: 'a'.repeat(64),
      processedAt: secondCheckedAt,
      sessionEpoch: 0,
    });

    expect(staleCompletion).toBeNull();
    expect(getWatchTargets(student)[0]).toMatchObject({
      detectedFingerprint: 'b'.repeat(64),
      processedFingerprint: null,
      pendingChange: true,
      pendingSince: secondDetectedAt,
      pendingSinceEstimated: false,
    });

    const covered = markWatchTargetProcessed({
      userId: student,
      targetId: target.id,
      fingerprint: 'b'.repeat(64),
      processedAt: secondCheckedAt,
      sessionEpoch: 0,
    });
    expect(covered).toMatchObject({
      detectedFingerprint: 'b'.repeat(64),
      processedFingerprint: 'b'.repeat(64),
      pendingChange: false,
      pendingSince: null,
      pendingSinceEstimated: false,
    });
  });

  it('materializes estimated pending age once for legacy revisions', () => {
    enableWatch(student);
    const target = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    const fingerprint = 'a'.repeat(64);
    const legacySince = '2026-10-31T12:00:00.000Z';
    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint,
      checkedAt: legacySince,
      nextCheckAt: '2026-10-31T12:05:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    db.update(WatchTargetTable)
      .set({ pendingSince: null, pendingSinceEstimated: false })
      .where(eq(WatchTargetTable.id, target.id))
      .run();

    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint,
      checkedAt: now,
      nextCheckAt: '2026-11-01T12:05:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    recordWatchObservation({
      userId: student,
      targetId: target.id,
      fingerprint,
      checkedAt: '2026-11-02T12:00:00.000Z',
      nextCheckAt: '2026-11-02T12:05:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });

    expect(getWatchTargets(student)[0]).toMatchObject({
      pendingSince: legacySince,
      pendingSinceEstimated: true,
    });
  });

  it('rejects a late refresh failure after watch permission is revoked', () => {
    enableWatch(student);
    const target = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    db.update(SettingTable)
      .set({ watchEnabled: false, consent: false })
      .where(eq(SettingTable.userId, student))
      .run();

    const failure = recordWatchFailure({
      userId: student,
      targetId: target.id,
      failedAt: '2026-11-01T12:01:00.000Z',
      retryAt: '2026-11-01T12:02:00.000Z',
      blocked: false,
      category: 'network',
    });

    expect(failure).toBeNull();
    expect(getWatchTargets(student)[0]).toMatchObject({
      failureCount: 0,
      lastFailureCategory: null,
      retryAt: null,
      status: 'active',
    });
  });

  it('does not let one healthy target mask another target that needs sign-in', () => {
    enableWatch(student);
    const healthyTarget = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    const signInTarget = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: 'https://canvas.school.edu/courses/1/announcements',
      recipeVersion: 1,
    })!;
    recordWatchObservation({
      userId: student,
      targetId: healthyTarget.id,
      fingerprint: 'a'.repeat(64),
      checkedAt: now,
      nextCheckAt: '2026-11-01T12:05:00.000Z',
      verifiedUrl: watchUrl,
      recipeVersion: 1,
    });
    markWatchTargetProcessed({
      userId: student,
      targetId: healthyTarget.id,
      fingerprint: 'a'.repeat(64),
      processedAt: now,
      sessionEpoch: 0,
    });
    recordWatchObservation({
      userId: student,
      targetId: signInTarget.id,
      fingerprint: 'b'.repeat(64),
      checkedAt: '2026-11-01T12:01:00.000Z',
      nextCheckAt: '2026-11-01T12:06:00.000Z',
      verifiedUrl: 'https://canvas.school.edu/courses/1/announcements',
      recipeVersion: 1,
    });
    recordWatchFailure({
      userId: student,
      targetId: signInTarget.id,
      failedAt: '2026-11-01T12:02:00.000Z',
      retryAt: null,
      blocked: false,
      category: 'needs-sign-in',
    });

    const health = getWatchHealthSummary(
      student,
      'watching',
      Date.parse('2026-11-01T12:02:00.000Z'),
    );

    expect(health).toMatchObject({
      status: 'needs-sign-in',
      pendingRevisionCount: 1,
      oldestPendingSince: '2026-11-01T12:01:00.000Z',
      oldestPendingSinceEstimated: false,
      lastSuccessfulCheckAt: '2026-11-01T12:01:00.000Z',
      nextRetryAt: null,
      failures: [{ category: 'needs-sign-in', targetCount: 1 }],
    });
    expect(JSON.stringify(health)).not.toContain('school.edu');
  });

  it('does not let a healthy target mask another target with a retryable failure', () => {
    enableWatch(student);
    upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    });
    const failingTarget = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: 'https://canvas.school.edu/courses/1/announcements',
      recipeVersion: 1,
    })!;
    recordWatchFailure({
      userId: student,
      targetId: failingTarget.id,
      failedAt: now,
      retryAt: '2026-11-01T12:01:00.000Z',
      blocked: false,
      category: 'network',
    });

    const health = getWatchHealthSummary(student, 'watching', Date.parse(now));

    expect(health).toMatchObject({
      status: 'blocked',
      nextRetryAt: '2026-11-01T12:01:00.000Z',
      failures: [{ category: 'network', targetCount: 1 }],
    });
  });

  it('schedules an unchanged partial observation without replacing its baseline', () => {
    enableWatch(student);
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
      sessionEpoch: 0,
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
    enableWatch(student);
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
      category: 'network',
    });
    const secondFailure = recordWatchFailure({
      userId: student,
      targetId: target.id,
      failedAt: '2026-11-01T12:03:00.000Z',
      retryAt: '2026-11-01T12:08:00.000Z',
      blocked: false,
      category: 'network',
    });
    const thirdFailure = recordWatchFailure({
      userId: student,
      targetId: target.id,
      failedAt: '2026-11-01T12:09:00.000Z',
      retryAt: null,
      blocked: true,
      category: 'network',
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

  it('keeps scope-changed targets suspended during routine synchronization', () => {
    enableWatch(student);
    saveWatchSettings(student, { watchEnabled: true, watchUrls: [watchUrl] });
    const target = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    recordWatchFailure({
      userId: student,
      targetId: target.id,
      failedAt: now,
      retryAt: null,
      blocked: false,
      category: 'scope-changed',
    });

    const synchronizedTarget = synchronizeWatchTargets(student).find(
      (item) => item.id === target.id,
    );

    expect(synchronizedTarget?.status).toBe('suspended');
  });

  it('resets only currently authorized intervention targets after reconnect', () => {
    enableWatch(student);
    const announcementsUrl =
      'https://canvas.school.edu/courses/1/announcements';
    const gradesUrl = 'https://canvas.school.edu/courses/1/grades';
    saveWatchSettings(student, {
      watchEnabled: true,
      watchUrls: [watchUrl, announcementsUrl],
    });
    const assignmentsTarget = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: watchUrl,
      recipeVersion: 1,
    })!;
    const announcementsTarget = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: announcementsUrl,
      recipeVersion: 1,
    })!;
    const unauthorizedTarget = upsertWatchTarget(student, {
      connectionId,
      courseId: 'course-a',
      requestedUrl: gradesUrl,
      recipeVersion: 1,
    })!;
    for (const [target, category] of [
      [assignmentsTarget, 'needs-sign-in'],
      [announcementsTarget, 'scope-changed'],
      [unauthorizedTarget, 'needs-sign-in'],
    ] as const)
      recordWatchFailure({
        userId: student,
        targetId: target.id,
        failedAt: now,
        retryAt: null,
        blocked: false,
        category,
      });

    const resetTargetIds = resetWatchTargetsAfterReconnect(
      student,
      connectionId,
      '2026-11-01T12:10:00.000Z',
    );
    const targets = getWatchTargets(student);

    expect(resetTargetIds.sort()).toEqual(
      [assignmentsTarget.id, announcementsTarget.id].sort(),
    );
    expect(
      targets.find((target) => target.id === assignmentsTarget.id),
    ).toMatchObject({ status: 'active', lastFailureCategory: null });
    expect(
      targets.find((target) => target.id === announcementsTarget.id),
    ).toMatchObject({ status: 'active', lastFailureCategory: null });
    expect(
      targets.find((target) => target.id === unauthorizedTarget.id),
    ).toMatchObject({
      status: 'suspended',
      lastFailureCategory: 'needs-sign-in',
    });
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
        sessionEpoch: 0,
      }),
    ).toBeNull();
  });
});
