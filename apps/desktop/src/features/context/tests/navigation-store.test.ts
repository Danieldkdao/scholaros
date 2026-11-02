import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-navigation-'));
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
const { AcademicConnectionTable, CourseTable, NavigationLocationTable } =
  await import('../../../db/schema');
const {
  getNavigationLocations,
  markNavigationLocationStale,
  recordNavigationLocationFailure,
  saveNavigationLocation,
} = await import('../services/navigation-store');
import type { NavigationRecipe } from '../types';

const student = 'student-a';
const other = 'student-b';
const now = '2026-11-01T12:00:00.000Z';
const destinationUrl = 'https://canvas.school.edu/courses/1/assignments';
const recipe: NavigationRecipe = {
  version: 1,
  steps: [
    {
      kind: 'click-link',
      label: 'Assignments',
      url: destinationUrl,
    },
  ],
};

const observation = (
  overrides: Partial<Parameters<typeof saveNavigationLocation>[2]> = {},
) => ({
  purpose: 'assignments' as const,
  destinationUrl,
  parentUrl: 'https://canvas.school.edu/courses/1',
  recipe,
  label: 'Assignments',
  evidence: {
    sourceUrl: 'https://canvas.school.edu/courses/1',
    excerpts: ['Assignments'],
    targetIds: ['assignment-link'],
  },
  status: 'verified' as const,
  destinationKind: 'collection' as const,
  observedAt: now,
  verifiedAt: now,
  ...overrides,
});

const insertConnection = (userId: string, id: string, host: string) =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id,
      userId,
      name: 'Canvas',
      url: `https://${host}/`,
      host,
      kind: 'canvas',
      status: 'verified',
      verifiedAt: now,
      isCourseResource: true,
    })
    .run();

const insertCourse = (userId: string, id: string, connectionId: string) =>
  db
    .insert(CourseTable)
    .values({
      id,
      userId,
      connectionId,
      sourceKey: `${connectionId} ${id}`,
      sourceName: 'Canvas',
      sourceHost: 'canvas.school.edu',
      externalId: id,
      name: id,
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: `https://canvas.school.edu/courses/${id}`,
      firstSeenAt: now,
      lastSeenAt: now,
      contentChangedAt: null,
      overviewSyncedAt: null,
      announcementsSyncedAt: null,
      assignmentsSyncedAt: null,
    })
    .run();

beforeEach(() => {
  db.delete(NavigationLocationTable).run();
  db.delete(CourseTable).run();
  db.delete(AcademicConnectionTable).run();
  insertConnection(student, 'connection-a', 'canvas.school.edu');
  insertConnection(other, 'connection-b', 'canvas.school.edu');
  insertCourse(student, 'course-1', 'connection-a');
  insertCourse(student, 'course-2', 'connection-a');
  insertCourse(other, 'course-other', 'connection-b');
});

afterEach(() => vi.useRealTimers());

describe('navigation location storage', () => {
  it('upserts one scoped destination and preserves verified knowledge on a thin observation', () => {
    const saved = saveNavigationLocation(
      student,
      'connection-a',
      observation({ courseId: 'course-1' }),
    )!;
    const updated = saveNavigationLocation(
      student,
      'connection-a',
      observation({
        courseId: 'course-1',
        status: 'tentative',
        recipe: null,
        parentUrl: null,
        label: null,
        evidence: undefined,
        observedAt: '2026-11-01T12:05:00.000Z',
        verifiedAt: null,
      }),
    )!;

    expect(updated).toMatchObject({
      id: saved.id,
      status: 'verified',
      destinationUrl,
      parentUrl: 'https://canvas.school.edu/courses/1',
      label: 'Assignments',
      recipe,
      evidence: {
        excerpts: ['Assignments'],
      },
      observedAt: '2026-11-01T12:05:00.000Z',
      verifiedAt: now,
    });
    expect(db.select().from(NavigationLocationTable).all()).toHaveLength(1);
  });

  it('returns connection and course locations for the requested account and course only', () => {
    saveNavigationLocation(
      student,
      'connection-a',
      observation({
        courseId: null,
        destinationUrl: 'https://canvas.school.edu/courses',
      }),
    );
    saveNavigationLocation(
      student,
      'connection-a',
      observation({ courseId: 'course-1', status: 'tentative' }),
    );
    saveNavigationLocation(
      student,
      'connection-a',
      observation({
        courseId: 'course-2',
        destinationUrl: 'https://canvas.school.edu/courses/2/assignments',
      }),
    );
    saveNavigationLocation(
      other,
      'connection-b',
      observation({ courseId: 'course-other' }),
    );

    const locations = getNavigationLocations({
      userId: student,
      connectionId: 'connection-a',
      courseId: 'course-1',
      purpose: 'assignments',
      limit: 5,
    });

    expect(locations).toHaveLength(2);
    expect(locations?.map((location) => location.status)).toEqual([
      'verified',
      'tentative',
    ]);
    expect(
      locations?.every(
        (location) =>
          location.courseId === null || location.courseId === 'course-1',
      ),
    ).toBe(true);
  });

  it('keeps failures separate from route staleness and supports explicit retirement', () => {
    const saved = saveNavigationLocation(
      student,
      'connection-a',
      observation({ courseId: 'course-1' }),
    )!;

    const failed = recordNavigationLocationFailure(
      student,
      saved.id,
      'rate-limited',
    );
    const stale = markNavigationLocationStale(student, saved.id);

    expect(failed).toMatchObject({
      status: 'verified',
      failureCount: 1,
      lastFailureClass: 'rate-limited',
    });
    expect(stale).toMatchObject({ status: 'stale', failureCount: 1 });
  });

  it('rejects locations that belong to another account or an unrelated course', () => {
    expect(
      saveNavigationLocation(
        student,
        'connection-b',
        observation({ courseId: 'course-1' }),
      ),
    ).toBeNull();
    expect(
      saveNavigationLocation(
        student,
        'connection-a',
        observation({ courseId: 'course-other' }),
      ),
    ).toBeNull();
    expect(db.select().from(NavigationLocationTable).all()).toHaveLength(0);
  });

  it('revalidates stored recipes and omits a corrupt recipe from reads', () => {
    const saved = saveNavigationLocation(
      student,
      'connection-a',
      observation({ courseId: 'course-1' }),
    )!;
    db.update(NavigationLocationTable)
      .set({
        recipe: {
          version: 99,
          steps: [{ kind: 'script', source: 'alert(1)' }],
        } as unknown as NavigationRecipe,
      })
      .where(eq(NavigationLocationTable.id, saved.id))
      .run();

    const [location] =
      getNavigationLocations({
        userId: student,
        connectionId: 'connection-a',
        courseId: 'course-1',
        purpose: 'assignments',
      }) ?? [];

    expect(location?.recipe).toBeNull();
    expect(location?.status).toBe('verified');
  });
});
