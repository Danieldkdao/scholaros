import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-courses-'));
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
  return {
    app,
    net,
    shell,
    default: { app, net },
  };
});

vi.mock('../../onboarding/services/browser-model', () => ({
  createBrowserModel: vi.fn(),
}));

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  AcademicContextTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseRecordTombstoneTable,
  CourseSourceTable,
  CourseTable,
  SettingTable,
} = await import('../../../db/schema');
const {
  applyCourseRefresh,
  detachCourseSource,
  getCourseDetail,
  getCoursesSnapshot,
} = await import('../services/store');
const { setCourseResource } =
  await import('../../onboarding/services/connections');
const { removeAcademicConnection } =
  await import('../../onboarding/services/store');
const { sortAssignments } = await import('../lib/formatters');
import type {
  CourseChildItem,
  CourseSourceScan,
  ObservedCourse,
} from '../types';

const student = 'student-a';
const other = 'student-b';
const canvasHost = 'canvas.school.edu';
const portalHost = 'portal.school.edu';
const biologyUrl = `https://${canvasHost}/courses/1`;
const announcementsUrl = `${biologyUrl}/announcements`;
const assignmentsUrl = `${biologyUrl}/assignments`;
const chemistryUrl = `https://${portalHost}/course/9`;
const first = '2026-03-01T09:00:00.000Z';
const second = '2026-03-08T09:00:00.000Z';

const insertConnection = (
  userId: string,
  id: string,
  host: string,
  isCourseResource = true,
) =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id,
      userId,
      name: host === canvasHost ? 'Canvas' : 'Portal',
      url: `https://${host}/`,
      host,
      kind: 'canvas',
      status: 'verified',
      verifiedAt: first,
      isCourseResource,
    })
    .run();

const child = (
  title: string,
  overrides: Partial<CourseChildItem> = {},
): CourseChildItem => ({
  title,
  body: null,
  dateValue: null,
  dateText: null,
  url: announcementsUrl,
  ...overrides,
});

const pending = { status: 'pending' as const, items: [] };

const observedCourse = (
  overrides: Partial<ObservedCourse> = {},
): ObservedCourse => ({
  externalId: null,
  name: 'Biology 101',
  code: null,
  term: null,
  instructor: null,
  description: null,
  url: biologyUrl,
  overview: 'complete',
  announcements: pending,
  assignments: pending,
  ...overrides,
});

const sourceScan = (
  overrides: Partial<CourseSourceScan> = {},
): CourseSourceScan => ({
  connectionId: 'connection-a',
  outcome: 'complete',
  message: null,
  courses: [observedCourse()],
  ...overrides,
});

const savedCourses = (userId = student) => getCoursesSnapshot(userId).courses;
const savedSources = (userId = student) => getCoursesSnapshot(userId).sources;
const onlyCourse = (userId = student) => savedCourses(userId)[0]!;
const detailOf = (userId = student) =>
  getCourseDetail(userId, onlyCourse(userId).id)!;

const saveBoth = () =>
  applyCourseRefresh(
    student,
    [
      sourceScan({
        courses: [
          observedCourse({
            announcements: { status: 'complete', items: [child('Welcome')] },
            assignments: {
              status: 'complete',
              items: [child('Essay', { url: assignmentsUrl })],
            },
          }),
        ],
      }),
    ],
    { now: first },
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
  db.delete(CourseAnnouncementTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(CourseRecordTombstoneTable).run();
  db.delete(CourseTable).run();
  db.delete(CourseSourceTable).run();
  db.delete(AcademicConnectionTable).run();
  db.delete(AcademicContextTable).run();
  db.delete(SettingTable).run();
  insertConnection(student, 'connection-a', canvasHost);
  insertConnection(student, 'connection-b', portalHost);
});

afterEach(() => vi.useRealTimers());

describe('saving a course refresh', () => {
  it('reports committed record creates, content updates, and retirements', () => {
    const onMetrics = vi.fn();
    const course = observedCourse({
      assignments: { status: 'complete', items: [child('Lab report')] },
    });
    applyCourseRefresh(student, [sourceScan({ courses: [course] })], {
      now: first,
      onMetrics,
    });

    expect(onMetrics).toHaveBeenLastCalledWith({
      recordsCreated: 2,
      recordsUpdated: 0,
      recordsRetired: 0,
    });
    onMetrics.mockClear();
    applyCourseRefresh(
      student,
      [
        sourceScan({
          courses: [
            observedCourse({
              name: 'Biology 101 revised',
              assignments: {
                status: 'complete',
                items: [child('Lab report', { body: 'Revised instructions' })],
              },
            }),
          ],
        }),
      ],
      { now: second, onMetrics },
    );

    expect(onMetrics).toHaveBeenLastCalledWith({
      recordsCreated: 0,
      recordsUpdated: 2,
      recordsRetired: 0,
    });
    onMetrics.mockClear();
    applyCourseRefresh(
      student,
      [
        sourceScan({
          courses: [
            observedCourse({
              name: 'Biology 101 revised',
              assignments: { status: 'complete', items: [] },
            }),
          ],
        }),
      ],
      { now: second, onMetrics },
    );

    expect(onMetrics).toHaveBeenLastCalledWith({
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsRetired: 1,
    });
    onMetrics.mockClear();
    applyCourseRefresh(student, [sourceScan({ courses: [] })], {
      now: second,
      onMetrics,
    });
    onMetrics.mockClear();
    applyCourseRefresh(student, [sourceScan()], { now: second, onMetrics });

    expect(onMetrics).toHaveBeenLastCalledWith({
      recordsCreated: 0,
      recordsUpdated: 1,
      recordsRetired: 0,
    });
  });

  it('restores background-sync eligibility after a previously signed-out source is read', () => {
    db.update(AcademicConnectionTable).set({ status: 'needs-sign-in' }).run();
    applyCourseRefresh(student, [sourceScan()]);
    expect(
      db
        .select()
        .from(AcademicConnectionTable)
        .all()
        .find((connection) => connection.id === 'connection-a')?.status,
    ).toBe('confirmed');
  });
  it('keeps one record per course across repeated identical refreshes', () => {
    applyCourseRefresh(student, [sourceScan()], { now: first });
    applyCourseRefresh(student, [sourceScan()], { now: second });
    expect(savedCourses()).toHaveLength(1);
    expect(onlyCourse().lastSeenAt).toBe(second);
    expect(onlyCourse().overviewSyncedAt).toBe(second);
  });

  it('leaves the overview unsynced when the course page was never read', () => {
    applyCourseRefresh(student, [
      sourceScan({ courses: [observedCourse({ overview: 'pending' })] }),
    ]);
    expect(onlyCourse().overviewSyncedAt).toBeNull();
    expect(getCourseDetail(student, onlyCourse().id)?.instructor).toBeNull();
  });

  it('keeps the local id and a stored field the next scan could not read', () => {
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({ instructor: 'Dr. Chen', description: 'Cells' }),
        ],
      }),
    ]);
    const savedId = onlyCourse().id;
    applyCourseRefresh(student, [
      sourceScan({
        courses: [observedCourse({ instructor: null, term: 'Fall 2026' })],
      }),
    ]);
    const detail = getCourseDetail(student, savedId)!;
    expect(detail.id).toBe(savedId);
    expect(detail.instructor).toBe('Dr. Chen');
    expect(detail.description).toBe('Cells');
    expect(detail.term).toBe('Fall 2026');
  });

  it('keeps the same course title from two connections separate', () => {
    applyCourseRefresh(student, [
      sourceScan(),
      sourceScan({
        connectionId: 'connection-b',
        courses: [observedCourse({ url: chemistryUrl })],
      }),
    ]);
    expect(savedCourses()).toHaveLength(2);
    expect(
      savedCourses()
        .map((course) => course.sourceName)
        .sort(),
    ).toEqual(['Canvas', 'Portal']);
  });

  it('records an external course identity when the source provides one', () => {
    applyCourseRefresh(student, [
      sourceScan({ courses: [observedCourse({ externalId: 'canvas-1' })] }),
    ]);
    const savedId = onlyCourse().id;
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            externalId: 'canvas-1',
            name: 'Biology 101 (Fall)',
            url: `${biologyUrl}/home`,
          }),
        ],
      }),
    ]);
    expect(savedCourses()).toHaveLength(1);
    expect(getCourseDetail(student, savedId)!.name).toBe('Biology 101 (Fall)');
  });

  it('keeps a learned course source key through a thin checkpoint and moved URL', () => {
    const save = (course: ObservedCourse) =>
      applyCourseRefresh(student, [
        sourceScan({ outcome: 'partial', courses: [course] }),
      ]);
    save(observedCourse({ externalId: 'stable-course' }));
    const savedId = onlyCourse().id;
    const originalSourceKey = db
      .select({ sourceKey: CourseTable.sourceKey })
      .from(CourseTable)
      .get()?.sourceKey;

    save(
      observedCourse({
        externalId: null,
        overview: 'pending',
        announcements: pending,
        assignments: pending,
      }),
    );
    save(
      observedCourse({
        externalId: 'stable-course',
        url: `${biologyUrl}/home`,
      }),
    );

    expect(savedCourses()).toHaveLength(1);
    expect(onlyCourse().id).toBe(savedId);
    expect(
      db.select({ sourceKey: CourseTable.sourceKey }).from(CourseTable).get()
        ?.sourceKey,
    ).toBe(originalSourceKey);
  });

  it('keeps repeated same-name courses with distinct IDs and sections separate', () => {
    const course = (
      externalId: string,
      section: string,
      term: string,
    ): ObservedCourse =>
      observedCourse({
        externalId,
        term,
        content: {
          name: 'Biology 101',
          code: 'BIO 101',
          section,
          term,
          description: null,
          instructors: [],
          sourceId: externalId,
          url: biologyUrl,
          evidence: {
            sourceUrl: biologyUrl,
            excerpts: [`Biology 101 ${externalId}`],
            targetIds: [],
          },
        },
      });
    const first = course('course-a', 'A', 'Fall 2026');
    const second = course('course-b', 'B', 'Spring 2027');

    applyCourseRefresh(student, [
      sourceScan({ courses: [first, second, first, second] }),
    ]);
    const ids = new Map(savedCourses().map((item) => [item.id, item.term]));
    applyCourseRefresh(student, [
      sourceScan({ courses: [second, first, second, first] }),
    ]);

    expect(savedCourses()).toHaveLength(2);
    expect(new Map(savedCourses().map((item) => [item.id, item.term]))).toEqual(
      ids,
    );
  });

  it('treats a url differing only by a credential parameter as one course', () => {
    applyCourseRefresh(student, [sourceScan()]);
    applyCourseRefresh(student, [
      sourceScan({
        courses: [observedCourse({ url: `${biologyUrl}?token=secret` })],
      }),
    ]);
    expect(savedCourses()).toHaveLength(1);
    expect(onlyCourse().url).toBe(biologyUrl);
  });
});

describe('retiring and reviving courses', () => {
  it('retires only the courses of a source reporting a complete empty list', () => {
    applyCourseRefresh(student, [
      sourceScan(),
      sourceScan({
        connectionId: 'connection-b',
        courses: [observedCourse({ url: chemistryUrl })],
      }),
    ]);
    applyCourseRefresh(student, [sourceScan({ courses: [] })], { now: second });
    expect(
      savedCourses().map((course) => [course.sourceName, course.active]),
    ).toEqual([
      ['Canvas', false],
      ['Portal', true],
    ]);
  });

  it('keeps courses active after a partial, blocked, or cancelled scan', () => {
    applyCourseRefresh(student, [sourceScan()], { now: first });
    for (const outcome of ['partial', 'blocked', 'cancelled'] as const)
      applyCourseRefresh(student, [sourceScan({ outcome, courses: [] })], {
        now: second,
      });
    expect(onlyCourse().active).toBe(true);
    expect(onlyCourse().lastSeenAt).toBe(first);
  });

  it('revives a course that comes back with the same identity', () => {
    applyCourseRefresh(student, [sourceScan()]);
    const savedId = onlyCourse().id;
    applyCourseRefresh(student, [sourceScan({ courses: [] })]);
    expect(onlyCourse().active).toBe(false);
    applyCourseRefresh(student, [sourceScan()]);
    expect(onlyCourse().id).toBe(savedId);
    expect(onlyCourse().active).toBe(true);
  });

  it('retires a course that moved to a new address on the same source', () => {
    applyCourseRefresh(student, [sourceScan()]);
    applyCourseRefresh(student, [
      sourceScan({
        courses: [observedCourse({ url: `https://${canvasHost}/courses/2` })],
      }),
    ]);
    expect(
      savedCourses()
        .map((course) => course.active)
        .sort(),
    ).toEqual([false, true]);
  });
});

describe('announcements and assignments stay independent', () => {
  it('replaces an old exact date when the source now gives only date wording', () => {
    for (const date of [
      { dateValue: '2026-03-01', dateText: null },
      { dateValue: null, dateText: 'Due Friday' },
    ])
      applyCourseRefresh(student, [
        sourceScan({
          courses: [
            observedCourse({
              announcements: {
                status: 'complete',
                items: [child('Welcome', date)],
              },
            }),
          ],
        }),
      ]);
    expect(detailOf().announcements[0]).toMatchObject({
      dateValue: null,
      dateText: 'Due Friday',
    });
  });

  it('reconciles announcements without changing saved assignments', () => {
    saveBoth();
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            announcements: { status: 'complete', items: [] },
            assignments: { status: 'blocked', items: [] },
          }),
        ],
      }),
    ]);
    const detail = detailOf();
    expect(detail.announcements).toHaveLength(0);
    expect(detail.assignments.map((item) => item.title)).toEqual(['Essay']);
    expect(detail.announcementsStatus).toBe('complete');
    expect(detail.assignmentsStatus).toBe('blocked');
  });

  it('keeps saved children when their own scan fails', () => {
    saveBoth();
    applyCourseRefresh(
      student,
      [
        sourceScan({
          courses: [
            observedCourse({
              announcements: { status: 'needs-sign-in', items: [] },
              assignments: { status: 'cancelled', items: [] },
            }),
          ],
        }),
      ],
      { now: second },
    );
    const detail = detailOf();
    expect(detail.announcements.map((item) => item.title)).toEqual(['Welcome']);
    expect(detail.assignments.map((item) => item.title)).toEqual(['Essay']);
    expect(detail.announcementsSyncedAt).toBe(first);
    expect(detail.assignmentsSyncedAt).toBe(first);
  });

  it('saves new children from a partial scan without retiring the rest', () => {
    saveBoth();
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            announcements: { status: 'partial', items: [child('Snow day')] },
          }),
        ],
      }),
    ]);
    const detail = detailOf();
    expect(detail.announcements.map((item) => item.title).sort()).toEqual([
      'Snow day',
      'Welcome',
    ]);
    expect(detail.announcementsStatus).toBe('partial');
    expect(detail.announcementsSyncedAt).toBe(first);
  });

  it('keeps one record per announcement across repeated refreshes', () => {
    saveBoth();
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            announcements: {
              status: 'complete',
              items: [child('Welcome', { body: 'Read chapter 1' })],
            },
          }),
        ],
      }),
    ]);
    const detail = detailOf();
    expect(detail.announcements).toHaveLength(1);
    expect(detail.announcements[0]?.body).toBe('Read chapter 1');
  });

  it('drops a child whose source url leaves the approved site', () => {
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            announcements: {
              status: 'complete',
              items: [
                child('Welcome'),
                child('Off site', { url: 'https://evil.example/steal' }),
              ],
            },
          }),
        ],
      }),
    ]);
    expect(detailOf().announcements.map((item) => item.title)).toEqual([
      'Welcome',
    ]);
  });
});

describe('refusing a course the source did not really show', () => {
  it('downgrades a complete claim rejected by the store without advancing success', () => {
    applyCourseRefresh(student, [sourceScan()], { now: first });
    applyCourseRefresh(
      student,
      [
        sourceScan({
          courses: [
            observedCourse({ url: 'https://outside.example/course/1' }),
          ],
        }),
      ],
      { now: second },
    );

    expect(savedSources()).toMatchObject([
      { outcome: 'partial', lastSuccessfulAt: first },
    ]);
    expect(onlyCourse().active).toBe(true);
  });

  it('drops an observed course whose url is outside the marked connection', () => {
    applyCourseRefresh(student, [
      sourceScan({
        courses: [observedCourse({ url: 'https://evil.example/c/1' })],
      }),
    ]);
    expect(savedCourses()).toHaveLength(0);
  });

  it('drops an observed course with a malformed url', () => {
    applyCourseRefresh(student, [
      sourceScan({ courses: [observedCourse({ url: 'not a url' })] }),
    ]);
    expect(savedCourses()).toHaveLength(0);
  });

  it('writes nothing for a source the student stopped selecting', () => {
    insertConnection(student, 'connection-plain', 'books.school.edu', false);
    applyCourseRefresh(student, [
      sourceScan({
        connectionId: 'connection-plain',
        courses: [observedCourse({ url: 'https://books.school.edu/c/1' })],
      }),
    ]);
    expect(savedCourses()).toHaveLength(0);
    expect(savedSources()).toHaveLength(0);
  });

  it('writes nothing for a connection that does not exist', () => {
    applyCourseRefresh(student, [
      sourceScan({ connectionId: 'connection-gone' }),
    ]);
    expect(savedCourses()).toHaveLength(0);
    expect(savedSources()).toHaveLength(0);
  });

  it('writes nothing against another account connection', () => {
    insertConnection(other, 'connection-z', canvasHost);
    applyCourseRefresh(student, [sourceScan({ connectionId: 'connection-z' })]);
    expect(savedCourses(student)).toHaveLength(0);
    expect(savedCourses(other)).toHaveLength(0);
  });
});

describe('refresh coverage', () => {
  it('advances the last success only for a genuinely complete source', () => {
    applyCourseRefresh(student, [sourceScan()], { now: first });
    applyCourseRefresh(student, [sourceScan({ outcome: 'partial' })], {
      now: second,
    });
    const [source] = savedSources();
    expect(source?.lastAttemptedAt).toBe(second);
    expect(source?.lastSuccessfulAt).toBe(first);
    expect(getCoursesSnapshot(student).lastSuccessfulAt).toBe(first);
  });

  it('reports a source that needs sign-in without discarding saved courses', () => {
    applyCourseRefresh(student, [sourceScan()], { now: first });
    applyCourseRefresh(
      student,
      [
        sourceScan({
          outcome: 'needs-sign-in',
          message: 'Sign in in your study browser.',
          courses: [],
        }),
      ],
      { now: second },
    );
    expect(savedCourses()).toHaveLength(1);
    expect(onlyCourse().active).toBe(true);
    expect(savedSources()[0]).toMatchObject({
      outcome: 'needs-sign-in',
      message: 'Sign in in your study browser.',
      lastSuccessfulAt: first,
    });
  });

  it('reports the most recent success across every source', () => {
    applyCourseRefresh(student, [sourceScan()], { now: first });
    applyCourseRefresh(
      student,
      [
        sourceScan({
          connectionId: 'connection-b',
          courses: [observedCourse({ url: chemistryUrl })],
        }),
      ],
      { now: second },
    );
    expect(getCoursesSnapshot(student).lastSuccessfulAt).toBe(second);
  });
});

describe('account and source boundaries', () => {
  it('lists only the signed-in account courses', () => {
    insertConnection(other, 'connection-z', canvasHost);
    applyCourseRefresh(student, [sourceScan()]);
    applyCourseRefresh(other, [sourceScan({ connectionId: 'connection-z' })]);
    expect(savedCourses(student)).toHaveLength(1);
    expect(savedCourses(other)).toHaveLength(1);
    expect(savedCourses(student)[0]?.id).not.toBe(savedCourses(other)[0]?.id);
  });

  it('cannot read another account course by id', () => {
    applyCourseRefresh(student, [sourceScan()]);
    const savedId = onlyCourse().id;
    expect(getCourseDetail(other, savedId)).toBeNull();
    expect(getCourseDetail(student, 'missing')).toBeNull();
  });

  it('keeps course history when the connection is removed and labels it', () => {
    saveBoth();
    const savedId = onlyCourse().id;
    removeAcademicConnection(student, 'connection-a');
    const summary = onlyCourse();
    expect(summary.id).toBe(savedId);
    expect(summary.sourceState).toBe('removed');
    expect(summary.sourceName).toBe('Canvas');
    expect(summary.sourceHost).toBe(canvasHost);
    const detail = getCourseDetail(student, savedId)!;
    expect(detail.announcements.map((item) => item.title)).toEqual(['Welcome']);
    expect(detail.assignments.map((item) => item.title)).toEqual(['Essay']);
  });

  it('labels a source the student stopped selecting', () => {
    applyCourseRefresh(student, [sourceScan()]);
    setCourseResource(student, 'connection-a', false);
    expect(onlyCourse().sourceState).toBe('unmarked');
    expect(onlyCourse().active).toBe(true);
  });

  it('drops the removed source coverage but keeps the saved courses', () => {
    applyCourseRefresh(student, [sourceScan()]);
    removeAcademicConnection(student, 'connection-a');
    expect(savedSources()).toHaveLength(0);
    expect(savedCourses()).toHaveLength(1);
  });

  it('detaches only the removed connection courses', () => {
    applyCourseRefresh(student, [
      sourceScan(),
      sourceScan({
        connectionId: 'connection-b',
        courses: [observedCourse({ url: chemistryUrl })],
      }),
    ]);
    detachCourseSource(student, 'connection-a');
    expect(
      savedCourses()
        .map((course) => course.sourceState)
        .sort(),
    ).toEqual(['connected', 'removed']);
  });
});

it('retires explicitly submitted work on a partial scan without removing unobserved work', () => {
  saveBoth();
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: {
            status: 'partial',
            items: [],
            inactiveItems: [child('Essay', { url: assignmentsUrl })],
          },
        }),
      ],
    }),
  ]);
  expect(detailOf().assignments).toEqual([]);
  expect(detailOf().announcements.map((item) => item.title)).toEqual([
    'Welcome',
  ]);
});

it('preserves same-title course and detail links when no identity evidence connects them', () => {
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: {
            status: 'partial',
            items: [
              child('Essay', { url: biologyUrl }),
              child('Essay', {
                url: `${assignmentsUrl}/1`,
                body: 'Detailed requirements',
              }),
            ],
          },
        }),
      ],
    }),
  ]);
  expect(onlyCourse().assignmentCount).toBe(2);
  expect(detailOf().assignments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ title: 'Essay', url: biologyUrl }),
      expect.objectContaining({
        title: 'Essay',
        url: `${assignmentsUrl}/1`,
        body: 'Detailed requirements',
      }),
    ]),
  );
  expect(onlyCourse().assignmentsStatus).toBe('partial');
});

it('preserves different detailed assignments that happen to share a title', () => {
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: {
            status: 'partial',
            items: [
              child('Weekly quiz', { url: `${assignmentsUrl}/1` }),
              child('Weekly quiz', { url: `${assignmentsUrl}/2` }),
            ],
          },
        }),
      ],
    }),
  ]);
  expect(detailOf().assignments).toHaveLength(2);
});

it('preserves same-title fragment links when they have no shared identity evidence', () => {
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: {
            status: 'partial',
            items: [
              child('Upcoming quiz', { url: biologyUrl }),
              child('Upcoming quiz', { url: `${biologyUrl}#main` }),
            ],
          },
        }),
      ],
    }),
  ]);
  expect(detailOf().assignments).toHaveLength(2);
  expect(onlyCourse().assignmentsStatus).toBe('partial');
});

it('counts only active saved content on course summaries', () => {
  saveBoth();
  expect(onlyCourse()).toMatchObject({
    announcementCount: 1,
    assignmentCount: 1,
  });
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: { status: 'complete', items: [] },
        }),
      ],
    }),
  ]);
  expect(onlyCourse()).toMatchObject({
    announcementCount: 1,
    assignmentCount: 0,
  });
  expect(onlyCourse(other)).toBeUndefined();
});

it('advances freshness without reporting unchanged content as changed and retains identity when a platform item is renamed', () => {
  const content = {
    title: 'Essay',
    description: 'Read chapter one',
    kind: 'assignment' as const,
    state: 'active-unsubmitted' as const,
    due: { kind: 'date' as const, date: '2026-10-31', original: 'October 31' },
    availableFrom: null,
    availableUntil: null,
    pointsPossible: 10,
    sourceId: 'assignment-123',
    url: `${biologyUrl}/assignments/123`,
    resources: [],
    evidence: { sourceUrl: assignmentsUrl, excerpts: ['Essay'], targetIds: [] },
  };
  const save = (now: string, title = 'Essay') =>
    applyCourseRefresh(
      student,
      [
        sourceScan({
          courses: [
            observedCourse({
              assignments: {
                status: 'complete',
                items: [
                  child(title, {
                    url: content.url,
                    content: { ...content, title },
                  }),
                ],
              },
            }),
          ],
        }),
      ],
      { now },
    );
  save(first);
  const initial = detailOf().assignments[0];
  save(second);
  expect(detailOf().assignments[0]).toMatchObject({
    id: initial.id,
    lastSeenAt: second,
    contentChangedAt: first,
    content: { due: content.due },
  });
  save('2026-03-09T09:00:00.000Z', 'Revised essay');
  expect(detailOf().assignments).toHaveLength(1);
  expect(detailOf().assignments[0]).toMatchObject({
    id: initial.id,
    title: 'Revised essay',
    contentChangedAt: '2026-03-09T09:00:00.000Z',
  });
});

it('refreshes evidence without changing the academic content timestamp', () => {
  const save = (now: string, original: string) =>
    applyCourseRefresh(
      student,
      [
        sourceScan({
          courses: [
            observedCourse({
              assignments: {
                status: 'complete',
                items: [
                  child('Essay', {
                    dateValue: '2026-10-31',
                    dateText: original,
                    content: {
                      title: 'Essay',
                      description: null,
                      kind: 'assignment',
                      state: 'active-unsubmitted',
                      due: { kind: 'date', date: '2026-10-31', original },
                      availableFrom: null,
                      availableUntil: null,
                      pointsPossible: null,
                      sourceId: 'essay',
                      url: null,
                      resources: [],
                      evidence: {
                        sourceUrl: assignmentsUrl,
                        excerpts: [original],
                        targetIds: [],
                      },
                    },
                  }),
                ],
              },
            }),
          ],
        }),
      ],
      { now },
    );
  save(first, 'Oct 31');
  save(second, 'October 31');
  expect(detailOf().assignments[0]).toMatchObject({
    lastSeenAt: second,
    contentChangedAt: first,
    content: { evidence: { excerpts: ['October 31'] } },
  });
});

it('keeps the trusted page retrieval time separate from the time extraction was persisted', () => {
  applyCourseRefresh(
    student,
    [
      sourceScan({
        courses: [
          observedCourse({
            assignments: {
              status: 'complete',
              items: [child('Essay', { retrievedAt: first })],
            },
          }),
        ],
      }),
    ],
    { now: second },
  );
  expect(detailOf().assignments[0]).toMatchObject({
    lastSeenAt: first,
    contentChangedAt: second,
  });
});

it('exposes unknown normalized course fields without displaying legacy values as freshly confirmed', () => {
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          code: 'BIO',
          term: 'Autumn',
          instructor: 'Dr. Teacher',
          description: 'Earlier description',
        }),
      ],
    }),
  ]);
  const saved = detailOf();
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          content: {
            name: 'Biology 101',
            code: null,
            section: null,
            term: null,
            description: null,
            instructors: [],
            sourceId: null,
            url: biologyUrl,
            evidence: {
              sourceUrl: biologyUrl,
              excerpts: ['Biology 101'],
              targetIds: [],
            },
          },
        }),
      ],
    }),
  ]);
  expect(detailOf()).toMatchObject({
    id: saved.id,
    code: null,
    term: null,
    instructor: null,
    description: null,
  });
});

it('adopts an observed platform ID without changing a legacy item identity when its unique item URL is unchanged', () => {
  const url = `${biologyUrl}/assignments/123`;
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: {
            status: 'complete',
            items: [child('Old essay', { url })],
          },
        }),
      ],
    }),
  ]);
  const saved = detailOf().assignments[0];
  const content = {
    title: 'Renamed essay',
    description: null,
    kind: 'assignment' as const,
    state: 'active-unsubmitted' as const,
    due: null,
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    sourceId: '123',
    url,
    resources: [],
    evidence: { sourceUrl: url, excerpts: ['Renamed essay'], targetIds: [] },
  };
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: {
            status: 'complete',
            items: [child(content.title, { url, content })],
          },
        }),
      ],
    }),
  ]);
  expect(detailOf().assignments).toMatchObject([
    { id: saved.id, title: 'Renamed essay' },
  ]);
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: {
            status: 'partial',
            items: [],
            inactiveItems: [
              child(content.title, {
                url,
                content: { ...content, state: 'submitted' },
              }),
            ],
          },
        }),
      ],
    }),
  ]);
  expect(detailOf().assignments).toEqual([]);
});

it('ignores changing observed link references when the supporting resource itself is unchanged', () => {
  const content = {
    title: 'Essay',
    description: null,
    kind: 'assignment' as const,
    state: 'active-unsubmitted' as const,
    due: null,
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    sourceId: '123',
    url: `${biologyUrl}/assignments/123`,
    resources: [{ targetId: '1', label: 'Notes', url: `${biologyUrl}/notes` }],
    evidence: {
      sourceUrl: assignmentsUrl,
      excerpts: ['Essay'],
      targetIds: ['1'],
    },
  };
  const save = (now: string, targetId: string) =>
    applyCourseRefresh(
      student,
      [
        sourceScan({
          courses: [
            observedCourse({
              assignments: {
                status: 'complete',
                items: [
                  child('Essay', {
                    url: content.url,
                    content: {
                      ...content,
                      resources: [{ ...content.resources[0], targetId }],
                      evidence: { ...content.evidence, targetIds: [targetId] },
                    },
                  }),
                ],
              },
            }),
          ],
        }),
      ],
      { now },
    );
  save(first, '1');
  save(second, '9');
  expect(detailOf().assignments[0]).toMatchObject({
    lastSeenAt: second,
    contentChangedAt: first,
  });
});

it('keeps one assignment when a partial scan finds its detail link after its collection entry', () => {
  const save = (item: CourseChildItem) =>
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({ assignments: { status: 'partial', items: [item] } }),
        ],
      }),
    ]);
  save(child('Essay', { url: assignmentsUrl }));
  const id = detailOf().assignments[0].id;
  save(child('Essay', { url: `${assignmentsUrl}/123` }));
  expect(detailOf().assignments).toMatchObject([{ id, title: 'Essay' }]);
  expect(db.select().from(CourseAssignmentTable).all()).toHaveLength(1);
  expect(onlyCourse().assignmentsStatus).toBe('partial');
  save(child('Essay', { url: assignmentsUrl }));
  expect(db.select().from(CourseAssignmentTable).all()).toHaveLength(1);
});

it('connects a verified source ID to its later detail URL without changing the local ID', () => {
  const sourceUrl = assignmentsUrl;
  const content = (
    sourceId: string | null,
    url: string | null,
    excerpts: string[],
  ) => ({
    title: 'Worksheet 1',
    description: null,
    kind: 'assignment' as const,
    state: 'active-unsubmitted' as const,
    due: null,
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    sourceId,
    url,
    resources: [],
    evidence: { sourceUrl, excerpts, targetIds: [] },
  });
  const save = (item: CourseChildItem) =>
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            assignments: { status: 'partial', items: [item] },
          }),
        ],
      }),
    ]);

  save(
    child('Worksheet 1', {
      url: assignmentsUrl,
      content: content('123', null, ['Worksheet 1 assignment 123']),
    }),
  );
  const savedId = detailOf().assignments[0]?.id;
  save(
    child('Worksheet 1', {
      url: `${assignmentsUrl}/123`,
      content: content(null, `${assignmentsUrl}/123`, ['Worksheet 1']),
    }),
  );

  expect(detailOf().assignments).toMatchObject([
    { id: savedId, title: 'Worksheet 1', content: { sourceId: '123' } },
  ]);
  expect(db.select().from(CourseAssignmentTable).all()).toHaveLength(1);
});

it('persists same-page detail identity even when evidence has supporting targets', () => {
  const detailUrl = `${assignmentsUrl}/123`;
  const item = (title: string): CourseChildItem =>
    child(title, {
      url: detailUrl,
      content: {
        title,
        description: null,
        kind: 'assignment',
        state: 'active-unsubmitted',
        due: null,
        availableFrom: null,
        availableUntil: null,
        pointsPossible: null,
        sourceId: null,
        url: detailUrl,
        resources: [],
        evidence: {
          sourceUrl: detailUrl,
          excerpts: [title],
          targetIds: ['supporting-link'],
        },
      },
    });
  const save = (assignment: CourseChildItem) =>
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            assignments: { status: 'partial', items: [assignment] },
          }),
        ],
      }),
    ]);

  save(item('Worksheet'));
  const savedId = detailOf().assignments[0]?.id;
  save(item('Worksheet renamed'));

  expect(db.select().from(CourseAssignmentTable).all()).toHaveLength(1);
  expect(detailOf().assignments).toMatchObject([
    { id: savedId, title: 'Worksheet renamed' },
  ]);
  expect(db.select().from(CourseAssignmentTable).get()?.sourceKey).toBe(
    'id:123',
  );
});

it('keeps an explicit child ID from adopting a conflicting URL-derived ID', () => {
  const sharedUrl = `${assignmentsUrl}/source-b`;
  const item = (sourceId: string): CourseChildItem =>
    child(`Resource ${sourceId}`, {
      url: sharedUrl,
      content: {
        title: `Resource ${sourceId}`,
        description: null,
        kind: 'assignment',
        state: 'active-unsubmitted',
        due: null,
        availableFrom: null,
        availableUntil: null,
        pointsPossible: null,
        sourceId,
        url: sharedUrl,
        resources: [],
        evidence: {
          sourceUrl: assignmentsUrl,
          excerpts: [`Resource ${sourceId}`],
          targetIds: [],
        },
      },
    });
  const save = (assignment: CourseChildItem) =>
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            assignments: { status: 'partial', items: [assignment] },
          }),
        ],
      }),
    ]);

  save(item('source-a'));
  const sourceAId = detailOf().assignments[0]?.id;
  save(item('source-b'));

  expect(db.select().from(CourseAssignmentTable).all()).toHaveLength(2);
  expect(detailOf().assignments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: sourceAId,
        content: expect.objectContaining({ sourceId: 'source-a' }),
      }),
      expect.objectContaining({
        content: expect.objectContaining({ sourceId: 'source-b' }),
      }),
    ]),
  );
  expect(onlyCourse().assignmentsStatus).toBe('partial');
});

it('stores each member of repeated duplicate pairs once across checkpoints', () => {
  const assignment = (sourceId: string) => {
    const url = `${assignmentsUrl}/${sourceId}`;
    return child(`Worksheet ${sourceId}`, {
      url,
      content: {
        title: `Worksheet ${sourceId}`,
        description: null,
        kind: 'assignment',
        state: 'active-unsubmitted',
        due: null,
        availableFrom: null,
        availableUntil: null,
        pointsPossible: null,
        sourceId,
        url,
        resources: [],
        evidence: {
          sourceUrl: assignmentsUrl,
          excerpts: [`Worksheet ${sourceId} ${sourceId}`],
          targetIds: [],
        },
      },
    });
  };
  const first = assignment('a1');
  const second = assignment('a2');
  const save = (items: CourseChildItem[]) =>
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            assignments: { status: 'complete', items },
          }),
        ],
      }),
    ]);

  save([first, second, first, second]);
  const savedIds = new Map(
    detailOf().assignments.map((item) => [item.content?.sourceId, item.id]),
  );
  save([second, first, second, first]);

  expect(db.select().from(CourseAssignmentTable).all()).toHaveLength(2);
  expect(
    new Map(
      detailOf().assignments.map((item) => [item.content?.sourceId, item.id]),
    ),
  ).toEqual(savedIds);
});

it('stores repeated source-ID pairs once for assignments and announcements', () => {
  const makeItem = (
    kind: 'assignments' | 'announcements',
    sourceId: string,
  ): CourseChildItem => {
    const collectionUrl =
      kind === 'assignments' ? assignmentsUrl : announcementsUrl;
    const url = `${collectionUrl}/${sourceId}`;
    const evidence = {
      sourceUrl: collectionUrl,
      excerpts: [`Resource ${sourceId}`],
      targetIds: [],
    };
    const content =
      kind === 'assignments'
        ? {
            title: `Resource ${sourceId}`,
            description: null,
            kind: 'assignment' as const,
            state: 'active-unsubmitted' as const,
            due: null,
            availableFrom: null,
            availableUntil: null,
            pointsPossible: null,
            sourceId,
            url,
            resources: [],
            evidence,
          }
        : {
            title: `Resource ${sourceId}`,
            body: null,
            author: null,
            published: null,
            updated: null,
            sourceId,
            url,
            resources: [],
            evidence,
          };
    return child(`Resource ${sourceId}`, { url, content });
  };
  const save = (
    kind: 'assignments' | 'announcements',
    items: CourseChildItem[],
    status: 'complete' | 'partial',
  ) => {
    const collection = { status, items };
    const observed =
      kind === 'assignments'
        ? observedCourse({ assignments: collection })
        : observedCourse({ announcements: collection });
    applyCourseRefresh(student, [sourceScan({ courses: [observed] })]);
  };

  for (const kind of ['assignments', 'announcements'] as const) {
    const first = makeItem(kind, 'a1');
    const second = makeItem(kind, 'a2');
    save(kind, [first], 'partial');
    save(kind, [first, first], 'partial');
    const firstId = (
      kind === 'assignments' ? detailOf().assignments : detailOf().announcements
    )[0]?.id;
    save(kind, [first, second, first, second], 'complete');
    const savedIds = new Map(
      (kind === 'assignments'
        ? detailOf().assignments
        : detailOf().announcements
      ).map((item) => [item.content?.sourceId, item.id]),
    );
    save(kind, [second, first, second, first], 'complete');

    expect(
      kind === 'assignments'
        ? db.select().from(CourseAssignmentTable).all()
        : db.select().from(CourseAnnouncementTable).all(),
    ).toHaveLength(2);
    expect(
      new Map(
        (kind === 'assignments'
          ? detailOf().assignments
          : detailOf().announcements
        ).map((item) => [item.content?.sourceId, item.id]),
      ),
    ).toEqual(savedIds);
    expect(savedIds.get('a1')).toBe(firstId);
  }
});

it('keeps reversed ambiguous weak records bounded without choosing a first winner', () => {
  for (const kind of ['assignments', 'announcements'] as const) {
    const collectionUrl =
      kind === 'assignments' ? assignmentsUrl : announcementsUrl;
    const first = child('Weekly reflection', {
      body: 'Due Friday',
      url: collectionUrl,
    });
    const second = child('Weekly reflection', {
      body: 'Due Monday',
      url: collectionUrl,
    });
    const save = (items: CourseChildItem[]) => {
      const collection = { status: 'complete' as const, items };
      const observed =
        kind === 'assignments'
          ? observedCourse({ assignments: collection })
          : observedCourse({ announcements: collection });
      applyCourseRefresh(student, [sourceScan({ courses: [observed] })]);
    };
    const rows = () =>
      kind === 'assignments'
        ? detailOf().assignments
        : detailOf().announcements;

    save([first, second]);
    const savedIds = new Map(rows().map((item) => [item.body, item.id]));
    save([second, first]);

    expect(rows()).toHaveLength(2);
    expect(new Map(rows().map((item) => [item.body, item.id]))).toEqual(
      savedIds,
    );
    expect(
      onlyCourse()[
        kind === 'assignments' ? 'assignmentsStatus' : 'announcementsStatus'
      ],
    ).toBe('partial');
  }
});

it('preserves conflicting source IDs sharing a URL and lowers coverage to partial', () => {
  const sharedUrl = `${assignmentsUrl}/shared`;
  const content = (sourceId: string) => ({
    title: 'Weekly reflection',
    description: null,
    kind: 'assignment' as const,
    state: 'active-unsubmitted' as const,
    due: null,
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    sourceId,
    url: sharedUrl,
    resources: [],
    evidence: {
      sourceUrl: assignmentsUrl,
      excerpts: [`Weekly reflection ${sourceId}`],
      targetIds: [],
    },
  });

  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: {
            status: 'complete',
            items: [
              child('Weekly reflection', {
                url: sharedUrl,
                content: content('a1'),
              }),
              child('Weekly reflection', {
                url: sharedUrl,
                content: content('a2'),
              }),
            ],
          },
        }),
      ],
    }),
  ]);

  expect(db.select().from(CourseAssignmentTable).all()).toHaveLength(2);
  expect(detailOf().assignmentsStatus).toBe('partial');
});

it('edits and deletes local records within their account and course scope', async () => {
  const { updateCourseRecord, deleteCourseRecord } =
    await import('../services/store');
  saveBoth();
  const saved = detailOf();
  const target = {
    kind: 'assignments' as const,
    courseId: saved.id,
    id: saved.assignments[0].id,
  };
  expect(() =>
    updateCourseRecord(other, {
      ...target,
      values: { title: 'Changed', body: '', date: '' },
    }),
  ).toThrow();
  updateCourseRecord(student, {
    ...target,
    values: { title: 'Changed', body: 'Instructions', date: '2026-12-01' },
  });
  expect(detailOf().assignments[0]).toMatchObject({
    title: 'Changed',
    body: 'Instructions',
    dateValue: '2026-12-01',
  });
  expect(() => deleteCourseRecord(other, target)).toThrow();
  deleteCourseRecord(student, target);
  expect(detailOf().assignments).toEqual([]);
  deleteCourseRecord(student, {
    kind: 'courses',
    courseId: saved.id,
    id: saved.id,
  });
  expect(savedCourses()).toEqual([]);
  const hiddenCourse = db
    .select()
    .from(CourseTable)
    .where(eq(CourseTable.id, saved.id))
    .get()!;
  const hiddenAnnouncement = db
    .select()
    .from(CourseAnnouncementTable)
    .where(eq(CourseAnnouncementTable.id, saved.announcements[0]!.id))
    .get();
  expect(hiddenAnnouncement).toMatchObject({
    id: saved.announcements[0]!.id,
    suppressionId: hiddenCourse.suppressionId,
    suppressedAt: expect.any(String),
  });
});

it('keeps an explicitly deleted source assignment suppressed on later scans', async () => {
  const { deleteCourseRecord } = await import('../services/store');
  saveBoth();
  const saved = detailOf();
  deleteCourseRecord(student, {
    kind: 'assignments',
    courseId: saved.id,
    id: saved.assignments[0]!.id,
  });

  applyCourseRefresh(
    student,
    [
      sourceScan({
        courses: [
          observedCourse({
            announcements: { status: 'complete', items: [child('Welcome')] },
            assignments: {
              status: 'complete',
              items: [child('Essay', { url: assignmentsUrl })],
            },
          }),
        ],
      }),
    ],
    { now: second },
  );

  expect(getCourseDetail(student, saved.id)!.assignments).toEqual([]);
});

it('keeps a deleted assignment suppressed after its platform ID becomes known', async () => {
  const { deleteCourseRecord } = await import('../services/store');
  const url = `${biologyUrl}/work/essay`;
  const save = (sourceId: string | null) =>
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            assignments: {
              status: 'complete',
              items: [
                child('Essay', {
                  url,
                  content: {
                    title: 'Essay',
                    description: null,
                    kind: 'assignment',
                    state: 'active-unsubmitted',
                    due: null,
                    availableFrom: null,
                    availableUntil: null,
                    pointsPossible: null,
                    sourceId,
                    url,
                    resources: [],
                    evidence: {
                      sourceUrl: assignmentsUrl,
                      excerpts: ['Essay assignment essay-1'],
                      targetIds: [],
                    },
                  },
                }),
              ],
            },
          }),
        ],
      }),
    ]);
  save(null);
  const saved = detailOf();
  deleteCourseRecord(student, {
    kind: 'assignments',
    courseId: saved.id,
    id: saved.assignments[0]!.id,
  });

  save('essay-1');

  expect(getCourseDetail(student, saved.id)?.assignments).toEqual([]);
});

it('keeps deleted child records suppressed when their course adopts a platform ID', async () => {
  const { deleteCourseRecord } = await import('../services/store');
  saveBoth();
  const saved = detailOf();
  deleteCourseRecord(student, {
    kind: 'assignments',
    courseId: saved.id,
    id: saved.assignments[0]!.id,
  });
  deleteCourseRecord(student, {
    kind: 'announcements',
    courseId: saved.id,
    id: saved.announcements[0]!.id,
  });
  const existingTombstone = db
    .select()
    .from(CourseRecordTombstoneTable)
    .all()[0]!;
  db.insert(CourseRecordTombstoneTable)
    .values({
      ...existingTombstone,
      id: 'already-adopted-tombstone',
      courseSourceKey: 'connection-a course-1',
    })
    .run();

  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          externalId: 'course-1',
          assignments: {
            status: 'complete',
            items: [child('Essay', { url: assignmentsUrl })],
          },
          announcements: { status: 'complete', items: [child('Welcome')] },
        }),
      ],
    }),
  ]);

  expect(getCourseDetail(student, saved.id)).toMatchObject({
    assignments: [],
    announcements: [],
  });
});

it('keeps an explicitly deleted source course suppressed on later scans', async () => {
  const { deleteCourseRecord } = await import('../services/store');
  saveBoth();
  const saved = onlyCourse();
  deleteCourseRecord(student, {
    kind: 'courses',
    courseId: saved.id,
    id: saved.id,
  });

  applyCourseRefresh(student, [sourceScan()], { now: second });

  expect(savedCourses()).toEqual([]);
});

it('keeps a deleted course suppressed when a later scan learns its platform ID', async () => {
  const { deleteCourseRecord } = await import('../services/store');
  saveBoth();
  const saved = onlyCourse();
  deleteCourseRecord(student, {
    kind: 'courses',
    courseId: saved.id,
    id: saved.id,
  });

  applyCourseRefresh(
    student,
    [
      sourceScan({
        courses: [observedCourse({ externalId: 'new-platform-id' })],
      }),
    ],
    { now: second },
  );

  expect(savedCourses()).toEqual([]);
});

it('preserves existing collection and detail rows until their identity is verified', () => {
  const save = (url: string) =>
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            assignments: {
              status: 'partial',
              items: [child('Essay', { url })],
            },
          }),
        ],
      }),
    ]);
  save(assignmentsUrl);
  const saved = db.select().from(CourseAssignmentTable).get()!;
  const url = `${assignmentsUrl}/123`;
  db.insert(CourseAssignmentTable)
    .values({
      ...saved,
      id: 'existing-duplicate',
      url,
      sourceKey: `${url} essay`,
    })
    .run();
  save(url);
  expect(detailOf().assignments).toHaveLength(2);
  expect(onlyCourse().assignmentCount).toBe(2);
  expect(onlyCourse().assignmentsStatus).toBe('partial');
  save(assignmentsUrl);
  expect(detailOf().assignments).toHaveLength(2);
});

it('updates normalized course and announcement content without losing their source identity', async () => {
  const { updateCourseRecord } = await import('../services/store');
  saveBoth();
  const saved = detailOf();
  db.update(CourseTable)
    .set({
      content: {
        name: 'Biology',
        code: null,
        section: 'A',
        term: null,
        description: null,
        instructors: [],
        sourceId: 'course-1',
        url: biologyUrl,
        evidence: {
          sourceUrl: biologyUrl,
          excerpts: ['Biology'],
          targetIds: [],
        },
      },
    })
    .run();
  db.update(CourseAnnouncementTable)
    .set({
      content: {
        title: 'Welcome',
        body: null,
        author: 'Teacher',
        published: null,
        updated: null,
        sourceId: 'welcome',
        url: announcementsUrl,
        resources: [],
        evidence: {
          sourceUrl: announcementsUrl,
          excerpts: ['Welcome'],
          targetIds: [],
        },
      },
    })
    .run();
  updateCourseRecord(student, {
    kind: 'courses',
    courseId: saved.id,
    id: saved.id,
    values: {
      name: 'Updated biology',
      code: 'BIO',
      term: 'Fall',
      instructor: 'Dr. Chen',
      description: 'Cells',
    },
  });
  updateCourseRecord(student, {
    kind: 'announcements',
    courseId: saved.id,
    id: saved.announcements[0].id,
    values: { title: 'Updated welcome', body: 'Read this', date: '2026-11-01' },
  });
  expect(detailOf()).toMatchObject({
    name: 'Updated biology',
    code: 'BIO',
    instructor: 'Dr. Chen',
    description: 'Cells',
    content: { section: 'A', sourceId: 'course-1' },
    announcements: [
      {
        title: 'Updated welcome',
        body: 'Read this',
        dateValue: '2026-11-01',
        content: {
          title: 'Welcome',
          body: null,
          author: 'Teacher',
          sourceId: 'welcome',
          published: null,
        },
        local: {
          overriddenFields: ['title', 'body', 'dateValue', 'dateText'],
          source: {
            title: 'Welcome',
            body: null,
            dateValue: null,
            dateText: null,
          },
          effective: {
            title: 'Updated welcome',
            body: 'Read this',
            dateValue: '2026-11-01',
            dateText: '2026-11-01',
          },
        },
      },
    ],
  });
  expect(db.select().from(CourseTable).get()).toMatchObject({
    name: 'Biology 101',
    content: { name: 'Biology', section: 'A', sourceId: 'course-1' },
  });
  expect(db.select().from(CourseAnnouncementTable).get()).toMatchObject({
    title: 'Welcome',
    body: null,
    content: { title: 'Welcome', body: null, published: null },
  });
});

it('keeps source facts separate from local display edits across refresh and reset', async () => {
  const { resetCourseRecordOverrides, updateCourseRecord } =
    await import('../services/store');
  const sourceCourse = observedCourse({
    externalId: 'course-1',
    name: 'Biology from source',
    term: 'Fall 2026',
    content: {
      name: 'Biology from source',
      code: 'BIO 101',
      section: 'A',
      term: 'Fall 2026',
      description: 'Source course description',
      instructors: ['Dr. Source'],
      sourceId: 'course-1',
      url: biologyUrl,
      evidence: {
        sourceUrl: biologyUrl,
        excerpts: ['Biology from source'],
        targetIds: [],
      },
    },
    assignments: {
      status: 'complete',
      items: [
        child('Essay from source', {
          body: 'Source assignment description',
          dateValue: '2026-12-15',
          dateText: 'December 15, 2026',
          url: `${assignmentsUrl}/essay-1`,
          content: {
            title: 'Essay from source',
            description: 'Source assignment description',
            kind: 'assignment',
            state: 'active-unsubmitted',
            due: {
              kind: 'date',
              date: '2026-12-15',
              original: 'December 15, 2026',
            },
            availableFrom: null,
            availableUntil: null,
            pointsPossible: null,
            sourceId: 'essay-1',
            url: `${assignmentsUrl}/essay-1`,
            resources: [],
            evidence: {
              sourceUrl: assignmentsUrl,
              excerpts: ['Essay from source essay-1'],
              targetIds: [],
            },
          },
        }),
      ],
    },
  });
  applyCourseRefresh(student, [sourceScan({ courses: [sourceCourse] })], {
    now: first,
  });
  const savedCourse = onlyCourse();
  const savedAssignment = detailOf().assignments[0]!;
  updateCourseRecord(student, {
    kind: 'courses',
    courseId: savedCourse.id,
    id: savedCourse.id,
    values: {
      name: 'My Biology',
      code: 'BIO 101',
      term: 'My term',
      instructor: 'Dr. Source',
      description: 'Source course description',
    },
  });
  updateCourseRecord(student, {
    kind: 'assignments',
    courseId: savedCourse.id,
    id: savedAssignment.id,
    values: {
      title: 'My essay title',
      body: 'My assignment notes',
      date: '2026-12-02',
    },
  });
  applyCourseRefresh(
    student,
    [
      sourceScan({
        courses: [
          observedCourse({
            ...sourceCourse,
            name: 'Biology refreshed',
            term: 'Spring 2027',
            content: {
              ...sourceCourse.content!,
              name: 'Biology refreshed',
              term: 'Spring 2027',
              description: 'Updated source course description',
            },
            assignments: {
              status: 'complete',
              items: [
                child('Essay refreshed', {
                  body: 'Updated source assignment description',
                  dateValue: '2026-12-20',
                  dateText: 'December 20, 2026',
                  url: `${assignmentsUrl}/essay-1`,
                  content: {
                    ...sourceCourse.assignments.items[0]!.content!,
                    title: 'Essay refreshed',
                    description: 'Updated source assignment description',
                    due: {
                      kind: 'date',
                      date: '2026-12-20',
                      original: 'December 20, 2026',
                    },
                  },
                }),
              ],
            },
          }),
        ],
      }),
    ],
    { now: second },
  );

  expect(getCourseDetail(student, savedCourse.id)).toMatchObject({
    id: savedCourse.id,
    name: 'My Biology',
    term: 'My term',
    local: {
      source: { name: 'Biology refreshed', term: 'Spring 2027' },
      effective: { name: 'My Biology', term: 'My term' },
      overriddenFields: ['name', 'term'],
    },
    assignments: [
      {
        id: savedAssignment.id,
        title: 'My essay title',
        body: 'My assignment notes',
        dateValue: '2026-12-02',
        local: {
          source: {
            title: 'Essay refreshed',
            body: 'Updated source assignment description',
            dateValue: '2026-12-20',
          },
          overriddenFields: ['title', 'body', 'dateValue', 'dateText'],
        },
      },
    ],
  });
  expect(db.select().from(CourseTable).get()?.name).toBe('Biology refreshed');
  expect(db.select().from(CourseTable).get()?.content?.name).toBe(
    'Biology refreshed',
  );
  expect(db.select().from(CourseAssignmentTable).get()?.content?.title).toBe(
    'Essay refreshed',
  );

  resetCourseRecordOverrides(student, {
    kind: 'courses',
    courseId: savedCourse.id,
    id: savedCourse.id,
    fields: ['name'],
  });
  resetCourseRecordOverrides(student, {
    kind: 'assignments',
    courseId: savedCourse.id,
    id: savedAssignment.id,
    fields: ['title', 'body', 'dateValue', 'dateText'],
  });

  expect(getCourseDetail(student, savedCourse.id)).toMatchObject({
    name: 'Biology refreshed',
    term: 'My term',
    assignments: [
      {
        title: 'Essay refreshed',
        body: 'Updated source assignment description',
        dateValue: '2026-12-20',
        local: { overriddenFields: [] },
      },
    ],
  });
});

it('keeps unknown legacy edit provenance uncertain until a source observation confirms it', async () => {
  const { updateCourseRecord } = await import('../services/store');
  saveBoth();
  const course = onlyCourse();
  db.update(CourseTable)
    .set({
      name: 'Possibly overwritten legacy name',
      localOverrides: null,
      localEditedAt: null,
      contentChangedAt: second,
      lastSeenAt: first,
    })
    .where(eq(CourseTable.id, course.id))
    .run();

  expect(getCourseDetail(student, course.id)?.local).toMatchObject({
    source: { name: 'Possibly overwritten legacy name' },
    sourceUncertain: true,
  });
  updateCourseRecord(student, {
    kind: 'courses',
    courseId: course.id,
    id: course.id,
    values: {
      name: 'My legacy override',
      code: '',
      term: '',
      instructor: '',
      description: '',
    },
  });
  expect(getCourseDetail(student, course.id)?.local).toMatchObject({
    source: { name: 'Possibly overwritten legacy name' },
    effective: { name: 'My legacy override' },
    sourceUncertain: true,
  });

  applyCourseRefresh(
    student,
    [
      sourceScan({
        courses: [observedCourse({ name: 'Biology from source' })],
      }),
    ],
    { now: second },
  );
  expect(getCourseDetail(student, course.id)?.local).toMatchObject({
    source: { name: 'Biology from source' },
    effective: { name: 'My legacy override' },
    sourceUncertain: false,
  });
});

it('creates owned manual records without a connection', async () => {
  const { createCourseRecord, updateCourseRecord } =
    await import('../services/store');
  const courseId = createCourseRecord(student, {
    kind: 'courses',
    values: {
      name: 'Manual biology',
      code: '',
      term: '',
      instructor: '',
      description: '',
    },
  });
  const id = createCourseRecord(student, {
    kind: 'assignments',
    courseId,
    values: {
      title: 'Read chapter one',
      body: 'Take notes',
      date: '2026-11-02',
    },
  });
  updateCourseRecord(student, {
    kind: 'courses',
    courseId,
    id: courseId,
    values: {
      name: 'My manual biology',
      code: 'BIO',
      term: 'Winter',
      instructor: 'Dr. Local',
      description: 'Manual course note',
    },
  });
  updateCourseRecord(student, {
    kind: 'assignments',
    courseId,
    id,
    values: {
      title: 'Read chapter one revised',
      body: 'My notes',
      date: '2026-11-03',
    },
  });
  expect(getCourseDetail(student, courseId)).toMatchObject({
    name: 'My manual biology',
    local: { origin: 'manual', overriddenFields: [] },
    assignments: [
      {
        id,
        title: 'Read chapter one revised',
        body: 'My notes',
        dateValue: '2026-11-03',
        local: { origin: 'manual', overriddenFields: [] },
      },
    ],
  });
  expect(db.select().from(CourseTable).get()).toMatchObject({
    name: 'My manual biology',
    localOverrides: null,
  });
  expect(db.select().from(CourseAssignmentTable).get()).toMatchObject({
    title: 'Read chapter one revised',
    body: 'My notes',
    localOverrides: null,
  });
  expect(getCourseDetail(other, courseId)).toBeNull();
  expect(() =>
    createCourseRecord(other, {
      kind: 'announcements',
      courseId,
      values: { title: 'No access', body: '', date: '' },
    }),
  ).toThrow();
  expect(() =>
    createCourseRecord(student, {
      kind: 'courses',
      values: { name: '', code: '', term: '', instructor: '', description: '' },
    }),
  ).toThrow();
});

it('round-trips a timed manual assignment and keeps it in the local-time sorting group', async () => {
  const { createCourseRecord } = await import('../services/store');
  const { academicDateFor } = await import('../lib/dates');
  const courseId = createCourseRecord(student, {
    kind: 'courses',
    values: {
      name: 'Manual biology',
      code: '',
      term: '',
      instructor: '',
      description: '',
    },
  });
  const id = createCourseRecord(student, {
    kind: 'assignments',
    courseId,
    values: {
      title: 'Timed assignment',
      body: '',
      date: '2026-11-08T23:59',
    },
  });
  const timedAssignment = getCourseDetail(student, courseId)!.assignments.find(
    (item) => item.id === id,
  )!;
  const dateOnly = child('Date only', { dateValue: '2026-11-08' });
  const unresolved = child('Unresolved', { dateText: 'Friday' });

  expect(timedAssignment).toMatchObject({
    dateValue: '2026-11-08T23:59',
    dateText: '2026-11-08T23:59',
    content: null,
  });
  expect(academicDateFor(timedAssignment)).toEqual({
    kind: 'local',
    date: '2026-11-08',
    time: '23:59',
    original: '2026-11-08T23:59',
  });
  expect(
    sortAssignments([unresolved, timedAssignment, dateOnly]).map(
      (item) => item.title,
    ),
  ).toEqual(['Date only', 'Timed assignment', 'Unresolved']);
});

it('preserves a local time when editing a content-null record by title only', async () => {
  const { updateCourseRecord } = await import('../services/store');
  saveBoth();
  const saved = detailOf().assignments[0];
  db.update(CourseAssignmentTable)
    .set({
      dateValue: '2026-11-08T11:59',
      dateText: 'November 8, 2026 at 11:59 AM',
      content: null,
    })
    .where(eq(CourseAssignmentTable.id, saved.id))
    .run();

  updateCourseRecord(student, {
    kind: 'assignments',
    courseId: onlyCourse().id,
    id: saved.id,
    values: {
      title: 'Renamed essay',
      body: '',
      date: 'November 8, 2026 at 11:59 AM',
    },
  });
  const updated = detailOf().assignments[0];

  expect(updated).toMatchObject({
    title: 'Renamed essay',
    dateValue: '2026-11-08T11:59',
    dateText: 'November 8, 2026 at 11:59 AM',
    content: null,
  });
});

it('allows historical announcements and unchanged overdue assignments but rejects new past assignment dates', async () => {
  const { createCourseRecord, updateCourseRecord } =
    await import('../services/store');
  saveBoth();
  const courseId = onlyCourse().id;
  const overdueAssignment = detailOf().assignments[0];
  db.update(CourseAssignmentTable)
    .set({
      dateValue: '2026-09-30',
      dateText: 'September 30, 2026',
      content: null,
    })
    .where(eq(CourseAssignmentTable.id, overdueAssignment.id))
    .run();

  const announcementId = createCourseRecord(student, {
    kind: 'announcements',
    courseId,
    values: {
      title: 'Yesterday’s update',
      body: 'A historical announcement.',
      date: '2026-09-30',
    },
  });
  updateCourseRecord(student, {
    kind: 'assignments',
    courseId,
    id: overdueAssignment.id,
    values: {
      title: 'Renamed overdue assignment',
      body: '',
      date: 'September 30, 2026',
    },
  });
  updateCourseRecord(student, {
    kind: 'announcements',
    courseId,
    id: announcementId,
    values: {
      title: 'Edited yesterday’s update',
      body: 'Updated history.',
      date: '2026-09-30',
    },
  });

  expect(detailOf().assignments[0]).toMatchObject({
    title: 'Renamed overdue assignment',
    dateValue: '2026-09-30',
  });
  expect(detailOf().announcements).toContainEqual(
    expect.objectContaining({
      id: announcementId,
      title: 'Edited yesterday’s update',
      dateValue: '2026-09-30',
    }),
  );
  expect(() =>
    createCourseRecord(student, {
      kind: 'assignments',
      courseId,
      values: {
        title: 'Past deadline',
        body: '',
        date: '2026-09-30',
      },
    }),
  ).toThrow('Choose a date and time in the future.');
  expect(() =>
    updateCourseRecord(student, {
      kind: 'assignments',
      courseId,
      id: overdueAssignment.id,
      values: {
        title: 'Renamed overdue assignment',
        body: '',
        date: '2026-09-29',
      },
    }),
  ).toThrow('Choose a date and time in the future.');
});

it('keeps manual children when a complete source sync retires missing source records', async () => {
  const { createCourseRecord } = await import('../services/store');
  saveBoth();
  const courseId = onlyCourse().id;
  for (const kind of ['assignments', 'announcements'] as const) {
    createCourseRecord(student, {
      kind,
      courseId,
      values: { title: 'Manual record', body: '', date: '' },
    });
  }
  applyCourseRefresh(
    student,
    [
      sourceScan({
        courses: [
          observedCourse({
            assignments: { status: 'complete', items: [] },
            announcements: { status: 'complete', items: [] },
          }),
        ],
      }),
    ],
    { now: second },
  );
  const detail = getCourseDetail(student, courseId)!;
  expect(detail.assignments.map((item) => item.title)).toEqual([
    'Manual record',
  ]);
  expect(detail.announcements.map((item) => item.title)).toEqual([
    'Manual record',
  ]);
});

it('preserves separate manual assignments with identical titles', async () => {
  const { createCourseRecord } = await import('../services/store');
  const courseId = createCourseRecord(student, {
    kind: 'courses',
    values: {
      name: 'Manual',
      code: '',
      term: '',
      instructor: '',
      description: '',
    },
  });
  for (let index = 0; index < 2; index++)
    createCourseRecord(student, {
      kind: 'assignments',
      courseId,
      values: { title: 'Reading', body: '', date: '' },
    });
  expect(getCourseDetail(student, courseId)?.assignments).toHaveLength(2);
});

it('persists uncertain assignments as protected visible work without marking them submitted', () => {
  const assignment = child('Observed work', {
    url: assignmentsUrl,
    content: {
      title: 'Observed work',
      description: null,
      kind: 'assignment',
      state: 'unknown',
      due: null,
      availableFrom: null,
      availableUntil: null,
      pointsPossible: null,
      url: assignmentsUrl,
      sourceId: 'uncertain-1',
      resources: [],
      evidence: {
        sourceUrl: biologyUrl,
        excerpts: ['Observed work'],
        targetIds: [],
      },
    },
  });
  applyCourseRefresh(student, [
    sourceScan({
      courses: [
        observedCourse({
          assignments: { status: 'partial', items: [assignment] },
        }),
      ],
    }),
  ]);

  expect(detailOf().assignments).toEqual([
    expect.objectContaining({
      active: true,
      title: 'Observed work',
      content: expect.objectContaining({ state: 'unknown' }),
    }),
  ]);
  expect(onlyCourse().assignmentsStatus).toBe('partial');
  expect(savedCourses(other)).toHaveLength(0);
  expect(db.select().from(CourseAssignmentTable).get()).toMatchObject({
    userId: student,
    active: true,
    content: { state: 'unknown' },
  });
});

it('adopts an observed Schoology course root alias without replacing saved identity or local work', () => {
  const host = 'example.schoology.com';
  db.update(AcademicConnectionTable)
    .set({ host, url: `https://${host}/` })
    .where(eq(AcademicConnectionTable.id, 'connection-a'))
    .run();
  const materials = `https://${host}/course/12345/materials`;
  applyCourseRefresh(
    student,
    [
      sourceScan({
        courses: [
          observedCourse({
            url: materials,
            term: 'Fall',
            assignments: {
              status: 'complete',
              items: [
                child('Saved assignment', { url: `${materials}/assignment/1` }),
              ],
            },
          }),
        ],
      }),
    ],
    { now: first },
  );
  const saved = db.select().from(CourseTable).get()!;
  const childId = db.select().from(CourseAssignmentTable).get()!.id;
  db.update(CourseTable)
    .set({ localOverrides: { name: 'My biology name' }, localEditedAt: first })
    .where(eq(CourseTable.id, saved.id))
    .run();
  const rescan = () =>
    applyCourseRefresh(
      student,
      [
        sourceScan({
          courses: [
            observedCourse({
              url: `https://${host}/course/12345`,
              term: 'Fall',
              name: 'Biology roster title',
            }),
          ],
        }),
      ],
      { now: second },
    );
  rescan();
  rescan();
  expect(savedCourses()).toHaveLength(1);
  const retained = db.select().from(CourseTable).get()!;
  expect(retained.id).toBe(saved.id);
  expect(retained.sourceKey).toBe(saved.sourceKey);
  expect(retained.localOverrides).toEqual({ name: 'My biology name' });
  expect(onlyCourse().name).toBe('My biology name');
  expect(db.select().from(CourseAssignmentTable).get()!.id).toBe(childId);
});

it.each([
  ['different ID', '/course/67890', 'Fall'],
  ['different marker', '/section/12345', 'Fall'],
  ['conflicting explicit query ID', '/course/12345?course_id=67890', 'Fall'],
  ['different term', '/course/12345', 'Spring'],
  ['different host', 'https://other.schoology.com/course/12345', 'Fall'],
] as const)(
  'does not merge Schoology aliases with a %s',
  (_reason, destination, term) => {
    const host = 'example.schoology.com';
    db.update(AcademicConnectionTable)
      .set({ host, url: `https://${host}/` })
      .where(eq(AcademicConnectionTable.id, 'connection-a'))
      .run();
    applyCourseRefresh(student, [
      sourceScan({
        courses: [
          observedCourse({
            url: `https://${host}/course/12345/materials`,
            term: 'Fall',
          }),
        ],
      }),
    ]);
    const savedId = onlyCourse().id;
    applyCourseRefresh(student, [
      sourceScan({
        outcome: 'partial',
        courses: [
          observedCourse({
            url: destination.startsWith('https:')
              ? destination
              : `https://${host}${destination}`,
            term,
          }),
        ],
      }),
    ]);
    expect(
      db
        .select()
        .from(CourseTable)
        .all()
        .find((course) => course.id === savedId)?.url,
    ).toBe(`https://${host}/course/12345/materials`);
  },
);
