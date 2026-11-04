import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, isNull } from 'drizzle-orm';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-course-suppression-'));
  const app = {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn(),
    getLoginItemSettings: () => ({ openAtLogin: false }),
  };
  const net = { fetch: vi.fn() };
  const shell = { openExternal: vi.fn() };
  return { app, net, shell, default: { app, net } };
});

vi.mock('../../onboarding/services/browser-model', () => ({
  createBrowserModel: vi.fn(),
}));

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseRecordTombstoneTable,
  CourseSourceTable,
  CourseTable,
  SettingTable,
} = await import('../../../db/schema');
const {
  applyCourseRefresh,
  deleteCourseRecord,
  getCourseDetail,
  getCoursesSnapshot,
  listCourseRecordSuppressions,
  restoreCourseRecordSuppression,
} = await import('../services/store');
import type {
  CourseChildItem,
  CourseSourceScan,
  ObservedCourse,
} from '../types';

const userId = 'suppression-user';
const otherUserId = 'other-user';
const connectionId = 'suppression-connection';
const host = 'canvas.school.edu';
const courseUrl = `https://${host}/courses/1`;
const assignmentUrl = `${courseUrl}/assignments`;
const announcementUrl = `${courseUrl}/announcements`;
const now = '2026-10-01T12:00:00.000Z';
const later = '2026-10-02T12:00:00.000Z';

const insertConnection = (ownerId = userId) =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id: connectionId,
      userId: ownerId,
      name: 'Canvas',
      url: `https://${host}/`,
      host,
      kind: 'canvas',
      status: 'verified',
      verifiedAt: now,
      isCourseResource: true,
    })
    .run();

const child = (
  title: string,
  itemUrl: string,
  sourceId: string,
): CourseChildItem => ({
  title,
  body: `${title} body`,
  dateValue: null,
  dateText: null,
  url: itemUrl,
  content: {
    title,
    description: `${title} body`,
    kind: 'assignment',
    state: 'active-unsubmitted',
    due: null,
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    sourceId,
    url: itemUrl,
    resources: [],
    evidence: {
      sourceUrl: itemUrl,
      excerpts: [title],
      targetIds: [],
    },
  },
});

const observedCourse = (
  overrides: Partial<ObservedCourse> = {},
): ObservedCourse => ({
  externalId: 'course-source-1',
  name: 'Biology 101',
  code: 'BIO 101',
  term: 'Fall 2026',
  instructor: 'Dr. Source',
  description: 'Course description',
  url: courseUrl,
  overview: 'complete',
  announcements: {
    status: 'complete',
    items: [child('Welcome', announcementUrl, 'announcement-1')],
  },
  assignments: {
    status: 'complete',
    items: [child('Essay', `${assignmentUrl}/essay-1`, 'assignment-1')],
  },
  ...overrides,
});

const scan = (course = observedCourse()): CourseSourceScan => ({
  connectionId,
  outcome: 'complete',
  message: null,
  courses: [course],
});

const savedCourse = () => getCoursesSnapshot(userId).courses[0]!;
const savedDetail = () => getCourseDetail(userId, savedCourse().id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  db.delete(CourseAnnouncementTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(CourseRecordTombstoneTable).run();
  db.delete(CourseTable).run();
  db.delete(CourseSourceTable).run();
  db.delete(AcademicConnectionTable).run();
  db.delete(SettingTable).run();
  insertConnection();
});

afterEach(() => vi.useRealTimers());

describe('course record suppression', () => {
  it('keeps a hidden course and descendants suppressed through repeated refreshes and restores the same IDs', () => {
    applyCourseRefresh(userId, [scan()], { now });
    const course = savedCourse();
    const assignment = savedDetail().assignments[0]!;
    const announcement = savedDetail().announcements[0]!;

    deleteCourseRecord(userId, {
      kind: 'courses',
      courseId: course.id,
      id: course.id,
    });

    expect(getCoursesSnapshot(userId).courses).toEqual([]);
    expect(
      db.select().from(CourseTable).where(eq(CourseTable.id, course.id)).get(),
    ).toMatchObject({ suppressionId: expect.any(String), active: true });
    expect(
      db
        .select()
        .from(CourseAssignmentTable)
        .where(eq(CourseAssignmentTable.id, assignment.id))
        .get(),
    ).toMatchObject({ suppressionId: expect.any(String), active: true });
    expect(
      db
        .select()
        .from(CourseAnnouncementTable)
        .where(eq(CourseAnnouncementTable.id, announcement.id))
        .get(),
    ).toMatchObject({ suppressionId: expect.any(String), active: true });

    applyCourseRefresh(userId, [scan()], { now: later });
    applyCourseRefresh(userId, [scan()], { now: later });
    expect(getCoursesSnapshot(userId).courses).toEqual([]);
    expect(
      db.select().from(CourseTable).where(eq(CourseTable.id, course.id)).get()
        ?.id,
    ).toBe(course.id);

    const suppressions = listCourseRecordSuppressions(userId, {
      connectionId,
      limit: 20,
    });
    expect(suppressions).toHaveLength(1);
    expect(suppressions?.[0]).toMatchObject({
      suppressionId: expect.any(String),
      kind: 'courses',
      title: 'Biology 101',
      legacy: false,
    });

    restoreCourseRecordSuppression(userId, {
      scope: 'group',
      suppressionId: suppressions![0]!.suppressionId,
    });
    restoreCourseRecordSuppression(userId, {
      scope: 'group',
      suppressionId: suppressions![0]!.suppressionId,
    });
    expect(savedCourse().id).toBe(course.id);
    expect(savedDetail().assignments.map((item) => item.id)).toEqual([
      assignment.id,
    ]);
    expect(savedDetail().announcements.map((item) => item.id)).toEqual([
      announcement.id,
    ]);

    applyCourseRefresh(userId, [scan()], { now: later });
    expect(savedCourse().id).toBe(course.id);
    expect(savedDetail().assignments).toHaveLength(1);
  });

  it('soft-hides source children but physically deletes manual children', async () => {
    applyCourseRefresh(userId, [scan()], { now });
    const course = savedCourse();
    const sourceAssignment = savedDetail().assignments[0]!;
    const { createCourseRecord } = await import('../services/store');
    const manualAssignmentId = createCourseRecord(userId, {
      kind: 'assignments',
      courseId: course.id,
      values: { title: 'Personal reminder', body: 'Keep this local', date: '' },
    });

    deleteCourseRecord(userId, {
      kind: 'assignments',
      courseId: course.id,
      id: sourceAssignment.id,
    });
    expect(
      db
        .select()
        .from(CourseAssignmentTable)
        .where(eq(CourseAssignmentTable.id, sourceAssignment.id))
        .get(),
    ).toMatchObject({ suppressionId: expect.any(String) });

    const sourceTombstoneCount = db
      .select()
      .from(CourseRecordTombstoneTable)
      .all().length;
    deleteCourseRecord(userId, {
      kind: 'assignments',
      courseId: course.id,
      id: manualAssignmentId,
    });
    expect(
      db
        .select()
        .from(CourseAssignmentTable)
        .where(eq(CourseAssignmentTable.id, manualAssignmentId))
        .get(),
    ).toBeUndefined();
    expect(db.select().from(CourseRecordTombstoneTable).all()).toHaveLength(
      sourceTombstoneCount,
    );
  });

  it('physically deletes a manual course and its local records without tombstones', async () => {
    const { createCourseRecord } = await import('../services/store');
    const courseId = createCourseRecord(userId, {
      kind: 'courses',
      values: {
        name: 'Manual course',
        code: '',
        term: '',
        instructor: '',
        description: '',
      },
    });
    const assignmentId = createCourseRecord(userId, {
      kind: 'assignments',
      courseId,
      values: { title: 'Local task', body: 'Personal notes', date: '' },
    });

    deleteCourseRecord(userId, {
      kind: 'courses',
      courseId,
      id: courseId,
    });

    expect(getCourseDetail(userId, courseId)).toBeNull();
    expect(
      db
        .select()
        .from(CourseAssignmentTable)
        .where(eq(CourseAssignmentTable.id, assignmentId))
        .get(),
    ).toBeUndefined();
    expect(db.select().from(CourseRecordTombstoneTable).all()).toEqual([]);
  });

  it('scopes suppression lists and restore effects to their owning account', () => {
    applyCourseRefresh(userId, [scan()], { now });
    const course = savedCourse();
    deleteCourseRecord(userId, {
      kind: 'courses',
      courseId: course.id,
      id: course.id,
    });
    const suppression = listCourseRecordSuppressions(userId, {
      connectionId,
      limit: 10,
    })![0]!;

    expect(listCourseRecordSuppressions(otherUserId, { limit: 10 })).toEqual(
      [],
    );
    expect(() =>
      restoreCourseRecordSuppression(otherUserId, {
        scope: 'group',
        suppressionId: suppression.suppressionId,
      }),
    ).not.toThrow();
    expect(getCoursesSnapshot(otherUserId).courses).toEqual([]);
    expect(getCoursesSnapshot(userId).courses).toEqual([]);
    restoreCourseRecordSuppression(userId, {
      scope: 'group',
      suppressionId: suppression.suppressionId,
    });
    expect(getCoursesSnapshot(userId).courses).toHaveLength(1);
  });

  it('keeps null-group legacy tombstones blocked until explicit scope-wide restore', async () => {
    applyCourseRefresh(userId, [scan()], { now });
    const course = savedCourse();
    const courseRow = db
      .select()
      .from(CourseTable)
      .where(eq(CourseTable.id, course.id))
      .get()!;
    db.insert(CourseRecordTombstoneTable)
      .values({
        id: 'legacy-tombstone',
        userId,
        connectionId,
        courseSourceKey: courseRow.sourceKey,
        kind: 'courses',
        resourceSourceKey: courseRow.sourceKey,
        suppressionId: null,
        createdAt: now,
      })
      .run();
    db.update(CourseTable)
      .set({ active: false })
      .where(eq(CourseTable.id, course.id))
      .run();
    db.delete(CourseAssignmentTable)
      .where(eq(CourseAssignmentTable.courseId, course.id))
      .run();
    db.delete(CourseAnnouncementTable)
      .where(eq(CourseAnnouncementTable.courseId, course.id))
      .run();
    db.delete(CourseTable).where(eq(CourseTable.id, course.id)).run();

    applyCourseRefresh(userId, [scan()], { now: later });
    expect(getCoursesSnapshot(userId).courses).toEqual([]);
    const legacy = listCourseRecordSuppressions(userId, {
      connectionId,
      kind: 'courses',
    });
    expect(legacy).toMatchObject([{ kind: 'courses', legacy: true }]);

    restoreCourseRecordSuppression(userId, {
      scope: 'legacy',
      connectionId,
      courseId: '*',
      kind: 'courses',
    });
    expect(
      db
        .select()
        .from(CourseRecordTombstoneTable)
        .where(isNull(CourseRecordTombstoneTable.suppressionId))
        .all(),
    ).toEqual([]);
    expect(
      db
        .select()
        .from(CourseRecordTombstoneTable)
        .where(eq(CourseRecordTombstoneTable.id, 'legacy-tombstone'))
        .get(),
    ).toBeUndefined();
    applyCourseRefresh(userId, [scan()], { now: later });
    expect(getCoursesSnapshot(userId).courses).toHaveLength(1);
  });
});
