import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-courses-'));
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
const {
  AcademicConnectionTable,
  AcademicContextTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
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
  db.delete(CourseAnnouncementTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(CourseTable).run();
  db.delete(CourseSourceTable).run();
  db.delete(AcademicConnectionTable).run();
  db.delete(AcademicContextTable).run();
  db.delete(SettingTable).run();
  insertConnection(student, 'connection-a', canvasHost);
  insertConnection(student, 'connection-b', portalHost);
});

describe('saving a course refresh', () => {
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

it('shows a detailed assignment once when a course summary also lists it', () => {
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
  expect(onlyCourse().assignmentCount).toBe(1);
  expect(detailOf().assignments).toEqual([
    expect.objectContaining({
      title: 'Essay',
      url: `${assignmentsUrl}/1`,
      body: 'Detailed requirements',
    }),
  ]);
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

it('shows an upcoming assignment once across same-page fragment links', () => {
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
  expect(detailOf().assignments).toHaveLength(1);
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
