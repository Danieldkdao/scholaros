import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CourseSourceScan, CourseChildItem } from '../types';
import type { WatchPageSnapshot } from '../../watch/types';

const electronTestState = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  electronTestState.userData = mkdtempSync(join(tmpdir(), 'scholaros-flow-'));
  const app = {
    getPath: () => electronTestState.userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
  };
  return { app, default: { app } };
});

const { rmSync } = await import('node:fs');
const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseSourceTable,
  CourseTable,
  SettingTable,
  WatchTargetTable,
} = await import('../../../db/schema');
const { applyCourseRefresh, getCourseDetail } =
  await import('../services/store');
const { buildMaterialContent } =
  await import('../../context/lib/material-content');
const { saveCourseMaterial } =
  await import('../../context/services/material-store');
const { readCourseMaterialPassages, searchCourseMaterialPassages } =
  await import('../../context/services/read-actions');
const {
  getWatchSettings,
  getWatchTargets,
  markWatchTargetProcessed,
  recordWatchFailure,
  recordWatchObservation,
  saveWatchSettings,
  scheduleWatchTargetCheck,
  upsertWatchTarget,
} = await import('../../watch/services/store');
const { createWatchController } =
  await import('../../watch/services/controller');
const { createPageFingerprint } =
  await import('../../watch/lib/page-fingerprint');

const userId = 'flow-student';
const connectionId = 'flow-canvas';
const connectionHost = 'canvas.school.edu';
const courseUrl = `https://${connectionHost}/courses/1`;
const assignmentsUrl = `${courseUrl}/assignments`;
const assignmentUrl = `${assignmentsUrl}/lab-1`;
const materialUrl = `${courseUrl}/files/syllabus`;
const firstTime = '2026-11-01T12:00:00.000Z';
const nextCheck = '2026-11-01T12:05:00.000Z';

const assignment = (date: string, original: string): CourseChildItem => ({
  title: 'Lab report',
  body: null,
  dateValue: date,
  dateText: original,
  url: assignmentUrl,
  content: {
    title: 'Lab report',
    description: null,
    kind: 'assignment',
    state: 'active-unsubmitted',
    due: { kind: 'date', date, original },
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    sourceId: 'lab-1',
    url: assignmentUrl,
    resources: [],
    evidence: {
      sourceUrl: assignmentsUrl,
      excerpts: [`Lab report due ${original}`],
      targetIds: [],
    },
  },
});

const courseScan = (date: string, original: string): CourseSourceScan => {
  const observedAssignment = assignment(date, original);
  return {
    connectionId,
    outcome: 'complete',
    message: null,
    courses: [
      {
        externalId: 'biology-1',
        name: 'Biology 101',
        code: 'BIO-101',
        term: 'Fall 2026',
        instructor: null,
        description: null,
        url: courseUrl,
        overview: 'complete',
        announcements: { status: 'complete', items: [] },
        assignments: {
          status: 'complete',
          items: [observedAssignment, { ...observedAssignment }],
        },
      },
    ],
  };
};

const makeSnapshot = (text: string): WatchPageSnapshot => ({
  url: assignmentsUrl,
  title: 'Biology assignments',
  text,
  links: [],
  statuses: [],
  complete: true,
  recipeVersion: 1,
});

beforeEach(() => {
  db.delete(WatchTargetTable).run();
  db.delete(CourseMaterialChunkTable).run();
  db.delete(CourseMaterialTable).run();
  db.delete(CourseAnnouncementTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(CourseSourceTable).run();
  db.delete(CourseTable).run();
  db.delete(SettingTable).run();
  db.delete(AcademicConnectionTable).run();
  db.insert(SettingTable)
    .values({ userId, consent: true, updatedAt: firstTime })
    .run();
  db.insert(AcademicConnectionTable)
    .values({
      id: connectionId,
      userId,
      name: 'Canvas',
      url: `https://${connectionHost}/`,
      host: connectionHost,
      kind: 'canvas',
      status: 'verified',
      verifiedAt: firstTime,
      isCourseResource: true,
    })
    .run();
});

afterAll(() =>
  rmSync(electronTestState.userData, { recursive: true, force: true }),
);

describe('synthetic course context and watch flow', () => {
  it('keeps reconciled work stable, retrieves a cited material passage, and retains a failed watch change', async () => {
    applyCourseRefresh(userId, [courseScan('2026-11-05', 'November 5, 2026')], {
      now: firstTime,
    });
    const initialCourse = getCourseDetail(
      userId,
      db.select({ id: CourseTable.id }).from(CourseTable).get()!.id,
    )!;
    expect(initialCourse.assignments).toHaveLength(1);
    const assignmentId = initialCourse.assignments[0]!.id;
    expect(
      db
        .select()
        .from(CourseAssignmentTable)
        .where(eq(CourseAssignmentTable.userId, userId))
        .all(),
    ).toHaveLength(1);

    applyCourseRefresh(userId, [courseScan('2026-11-05', 'November 5, 2026')], {
      now: '2026-11-01T12:01:00.000Z',
    });
    expect(getCourseDetail(userId, initialCourse.id)?.assignments[0]?.id).toBe(
      assignmentId,
    );
    applyCourseRefresh(userId, [courseScan('2026-11-06', 'November 6, 2026')], {
      now: '2026-11-01T12:02:00.000Z',
    });
    expect(
      getCourseDetail(userId, initialCourse.id)?.assignments[0],
    ).toMatchObject({
      id: assignmentId,
      dateValue: '2026-11-06',
    });

    const sourceText = '# Syllabus\nFinal paper due December 4, 2026.';
    const savedMaterial = saveCourseMaterial({
      userId,
      connectionId,
      courseId: initialCourse.id,
      source: {
        url: materialUrl,
        title: 'Biology syllabus',
        sourceType: 'syllabus',
        extractionStatus: 'complete',
        completeness: 100,
        summary: null,
        summaryEvidence: [],
        retrievedAt: firstTime,
        verifiedAt: firstTime,
      },
      content: buildMaterialContent({
        sourceUrl: materialUrl,
        text: sourceText,
      }),
    });
    expect(savedMaterial).not.toBeNull();
    const search = searchCourseMaterialPassages({
      userId,
      connectionId,
      courseId: initialCourse.id,
      query: 'final paper',
    });
    expect(search?.passages[0]).toMatchObject({
      sourceUrl: materialUrl,
      text: expect.stringContaining('Final paper due December 4'),
    });
    expect(search?.retrievalMs).toBeGreaterThanOrEqual(0);
    const passage = search!.passages[0]!;
    expect(
      readCourseMaterialPassages({
        userId,
        connectionId,
        courseId: initialCourse.id,
        selections: [{ id: passage.id, version: passage.version }],
      }),
    ).toMatchObject([{ sourceUrl: materialUrl, version: passage.version }]);

    saveWatchSettings(userId, {
      watchEnabled: true,
      watchUrls: [assignmentsUrl],
    });
    const target = upsertWatchTarget(userId, {
      connectionId,
      courseId: initialCourse.id,
      requestedUrl: assignmentsUrl,
      recipeVersion: 1,
    })!;
    const baseline = makeSnapshot('Lab report due November 5, 2026');
    const baselineFingerprint = createPageFingerprint(baseline);
    expect(
      recordWatchObservation({
        userId,
        targetId: target.id,
        fingerprint: baselineFingerprint,
        checkedAt: firstTime,
        nextCheckAt: nextCheck,
        verifiedUrl: assignmentsUrl,
        recipeVersion: 1,
      }),
    ).toMatchObject({
      detectedFingerprint: baselineFingerprint,
      pendingChange: true,
    });
    expect(
      markWatchTargetProcessed({
        userId,
        targetId: target.id,
        fingerprint: baselineFingerprint,
        processedAt: firstTime,
      }),
    ).toMatchObject({
      processedFingerprint: baselineFingerprint,
      pendingChange: false,
    });

    let processSucceeds = false;
    let refreshAttempts = 0;
    let watchNow = Date.parse('2026-11-01T12:03:00.000Z');
    let releaseCapacity: () => void = () => {};
    const controller = createWatchController({
      now: () => watchNow,
      getSettings: getWatchSettings,
      getTargets: getWatchTargets,
      checkTarget: async () => makeSnapshot('Lab report due November 6, 2026'),
      recordObservation: recordWatchObservation,
      recordFailure: recordWatchFailure,
      scheduleCheck: scheduleWatchTargetCheck,
      processChange: async (watchTarget, fingerprint, signal) => {
        refreshAttempts += 1;
        if (!processSucceeds) return false;
        signal.throwIfAborted();
        applyCourseRefresh(
          userId,
          [courseScan('2026-11-06', 'November 6, 2026')],
          { now: '2026-11-01T12:03:00.000Z' },
        );
        return !!markWatchTargetProcessed({
          userId,
          targetId: watchTarget.id,
          fingerprint,
          processedAt: '2026-11-01T12:03:00.000Z',
        });
      },
      subscribeCapacity: (_accountId, listener) => {
        releaseCapacity = listener;
        return () => undefined;
      },
    });

    await controller.start(userId);
    await controller.requestCheck(userId, target.id);
    await vi.waitFor(() =>
      expect(getWatchTargets(userId)[0]?.pendingChange).toBe(true),
    );
    expect(getWatchTargets(userId)[0]?.processedFingerprint).toBe(
      baselineFingerprint,
    );
    expect(getWatchSettings(userId).watchEnabled).toBe(true);
    expect(refreshAttempts).toBe(1);
    expect(controller.getMetrics(userId)).toMatchObject({
      changesDetected: 1,
      changesProcessed: 0,
    });

    releaseCapacity();
    await controller.tick(userId);
    expect(refreshAttempts).toBe(1);
    expect(getWatchTargets(userId)[0]?.pendingChange).toBe(true);

    processSucceeds = true;
    watchNow += 5 * 60_000;
    releaseCapacity();
    await vi.waitFor(() =>
      expect(getWatchTargets(userId)[0]?.pendingChange).toBe(false),
    );
    expect(controller.getMetrics(userId)).toMatchObject({
      changesDetected: 1,
      changesProcessed: 1,
      pendingChangeAgeMs: null,
    });
    expect(refreshAttempts).toBe(2);
    expect(
      getCourseDetail(userId, initialCourse.id)?.assignments[0],
    ).toMatchObject({
      id: assignmentId,
      dateValue: '2026-11-06',
    });
    await controller.stop(userId);
  });
});
