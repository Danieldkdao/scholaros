import { academicTasks } from '../../onboarding/services/academic-tasks';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-refresh-'));
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

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  applyDiscovery: vi.fn(),
  scan: vi.fn(),
  policy: vi.fn(),
  agent: vi.fn(),
  opened: [] as string[],
  workers: vi.fn(),
}));
vi.mock('../../onboarding/services/store', () => ({
  getOnboardingState: mocks.getState,
  applyAcademicDiscovery: mocks.applyDiscovery,
}));
vi.mock('../../onboarding/services/browser-workspace', () => ({
  getWorkspace: async () => ({
    cdpUrl: 'http://127.0.0.1:9222',
    browser: {
      context: { setDomainPolicy: mocks.policy, newPage: async () => ({}) },
    },
  }),
}));
vi.mock('../../onboarding/services/connection-scan', () => ({
  scanConnection: mocks.scan,
}));
vi.mock('../../onboarding/services/mission-navigation', () => ({
  createMissionNavigator: () => async () => undefined,
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: mocks.agent,
}));

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseSourceTable,
  CourseTable,
  NavigationLocationTable,
} = await import('../../../db/schema');
const { getCoursesSnapshot } = await import('../services/store');
const {
  cancelCourseRefresh,
  startConnectionRefresh,
  startConnectionRefreshWithReceipt,
  startCourseRefresh,
  refreshSingleCourse,
  refreshSingleCourseWithReceipt,
} = await import('../services/refresh');
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';

const student = 'student';
const host = 'canvas.school.edu';
const listUrl = `https://${host}/courses`;
const biologyUrl = `https://${host}/courses/1`;
const announcementsUrl = `${biologyUrl}/announcements`;
const assignmentsUrl = `${biologyUrl}/assignments`;

type ScanFixture = {
  outcome: 'courses' | 'empty' | 'inconclusive' | 'blocked' | 'needs-sign-in';
  entries: Array<{ label: string; url: string }>;
  listPage: ObservedPage;
  pages: Record<string, ObservedPage>;
  errors?: Record<string, string | Error>;
};
const fixtures = new Map<string, ScanFixture>();

const observedPage = (
  url: string,
  overrides: Partial<ObservedPage> = {},
): ObservedPage => ({ url, title: url, text: '', links: [], ...overrides });

const listFixture = (overrides: Partial<ScanFixture> = {}): ScanFixture => ({
  outcome: 'courses',
  entries: [{ label: 'Biology 101', url: biologyUrl }],
  listPage: observedPage(listUrl, {
    title: 'Courses',
    text: 'Biology 101',
    links: [{ label: 'Biology 101', url: biologyUrl }],
  }),
  pages: {
    [biologyUrl]: observedPage(biologyUrl, {
      title: 'Biology 101',
      links: [
        { label: 'Announcements', url: announcementsUrl },
        { label: 'Assignments', url: assignmentsUrl },
      ],
    }),
    [announcementsUrl]: observedPage(announcementsUrl, {
      title: 'Announcements',
      text: 'Midterm moved, posted 2026-03-05',
    }),
    [assignmentsUrl]: observedPage(assignmentsUrl, {
      title: 'Assignments',
      text: 'Lab report',
    }),
  },
  ...overrides,
});

const insertConnection = (
  id: string,
  connectionHost: string,
  overrides: Partial<typeof AcademicConnectionTable.$inferInsert> = {},
) =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id,
      userId: student,
      name: id,
      url: `https://${connectionHost}/`,
      host: connectionHost,
      kind: 'canvas',
      status: 'verified',
      verifiedAt: null,
      isCourseResource: true,
      ...overrides,
    })
    .run();

const stateFrom = () => ({
  accountId: student,
  settings: { consent: true, notes: '', backgroundSync: true },
  workspace: { ready: true },
  connections: db
    .select()
    .from(AcademicConnectionTable)
    .all()
    .map(
      ({
        id,
        name,
        url,
        host: connectionHost,
        kind,
        status,
        verifiedAt,
        notes,
        favicon,
        isCourseResource,
      }) => ({
        id,
        name,
        url,
        host: connectionHost,
        kind,
        status,
        verifiedAt,
        notes,
        favicon,
        isCourseResource,
      }),
    ),
  discovery: {
    status: 'pending',
    message: null,
    discoveredAt: null,
    entries: [],
  },
});

const chooseCourseCollection = (body: {
  goal: string;
  targets?: Array<{ id: string; url: string }>;
}) => {
  const wantedUrl = body.goal.includes('assignments')
    ? assignmentsUrl
    : announcementsUrl;
  const target = body.targets?.find((item) => item.url === wantedUrl);
  return target
    ? { operation: 'NAVIGATE' as const, target: target.id }
    : { operation: 'DONE' as const, target: null };
};

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.clear();
  mocks.opened.length = 0;
  mocks.policy.mockResolvedValue(undefined);
  mocks.applyDiscovery.mockImplementation((_userId, results) => ({
    discovery: { status: 'complete', results },
  }));
  mocks.agent.mockImplementation(async (_path, body) =>
    body.kind === 'choose'
      ? { operation: 'DONE', target: null }
      : {
          [body.kind]: [],
          coverage: body.pages[0].text.includes('no announcements')
            ? 'complete'
            : 'unavailable',
        },
  );
  mocks.scan.mockImplementation(
    async ({
      connection,
      withCourseList,
    }: {
      connection: { id: string };
      withCourseList?: (context: unknown) => Promise<unknown>;
    }) => {
      const fixture = fixtures.get(connection.id);
      if (!fixture)
        return {
          outcome: 'blocked',
          entries: [],
          observed: null,
          notesOmitted: false,
          followed: null,
        };
      const visitKnownLocation = async (
        location: { destinationUrl: string; parentUrl: string | null },
        target: 'destination' | 'parent' = 'destination',
      ) => {
        const url =
          target === 'parent' ? location.parentUrl : location.destinationUrl;
        if (!url) throw new Error('The saved route has no parent.');
        mocks.opened.push(url);
        const opened = fixture.pages[url];
        if (!opened) throw new Error('The page could not be loaded.');
        return opened;
      };
      const followed = withCourseList
        ? await withCourseList({
            withCoursePage: async (
              _url: string,
              run: (context: unknown) => Promise<void>,
            ) => {
              mocks.workers(_url);
              await run({
                assertReadable: () => undefined,
                openFrom: async (_from: ObservedPage, url: string) => {
                  mocks.opened.push(url);
                  const failure = fixture.errors?.[url];
                  if (failure)
                    throw failure instanceof Error
                      ? failure
                      : new Error(failure);
                  const opened = fixture.pages[url];
                  if (!opened) throw new Error('The page could not be loaded.');
                  return opened;
                },
                visitKnownLocation,
              });
            },
            observed: fixture.listPage,
            entries: fixture.entries.map((entry) => ({
              ...entry,
              role: 'course',
              connectionId: connection.id,
              evidenceUrl: fixture.listPage.url,
            })),
            assertReadable: () => undefined,
            openFrom: async (_from: ObservedPage, url: string) => {
              mocks.opened.push(url);
              const failure = fixture.errors?.[url];
              if (failure)
                throw failure instanceof Error ? failure : new Error(failure);
              const opened = fixture.pages[url];
              if (!opened) throw new Error('The page could not be loaded.');
              return opened;
            },
            visitKnownLocation,
          })
        : null;
      return {
        outcome: fixture.outcome,
        entries: fixture.entries,
        observed: fixture.listPage,
        notesOmitted: false,
        followed,
      };
    },
  );
  db.delete(CourseAnnouncementTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(CourseMaterialChunkTable).run();
  db.delete(CourseMaterialTable).run();
  db.delete(NavigationLocationTable).run();
  db.delete(CourseTable).run();
  db.delete(CourseSourceTable).run();
  db.delete(AcademicConnectionTable).run();
  mocks.getState.mockImplementation(() => stateFrom());
});

const savedCourses = () => getCoursesSnapshot(student).courses;
const savedSources = () => getCoursesSnapshot(student).sources;

describe('choosing what to scan', () => {
  it('refreshes only the source connection selected by a connection-level watcher', async () => {
    insertConnection('marked', host);
    insertConnection('other', 'portal.school.edu');
    fixtures.set('marked', listFixture());
    fixtures.set('other', listFixture());

    const refreshed = await startConnectionRefresh(student, 'marked');

    expect(refreshed.attemptedConnectionIds).toEqual(['marked']);
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(mocks.scan.mock.calls[0]?.[0].connection.id).toBe('marked');
  });

  it('scans only the connections marked as course resources', async () => {
    insertConnection('marked', host);
    insertConnection('unmarked', 'portal.school.edu', {
      isCourseResource: false,
    });
    fixtures.set('marked', listFixture());
    await startCourseRefresh(student);
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(mocks.scan.mock.calls[0][0].connection.id).toBe('marked');
    expect(savedCourses()).toHaveLength(1);
  });

  it('captures refresh counts and timing without storing academic text in metrics', async () => {
    insertConnection('marked', host);
    fixtures.set('marked', listFixture());
    mocks.agent.mockImplementation(async (_path, body) =>
      body.kind === 'assignments'
        ? {
            assignments: [
              {
                title: 'Lab report',
                description: null,
                kind: 'assignment',
                state: 'active-unsubmitted',
                due: null,
                availableFrom: null,
                availableUntil: null,
                pointsPossible: null,
                url: null,
                sourceId: null,
                resources: [],
                evidence: {
                  sourceUrl: body.pages[0]!.url,
                  excerpts: ['Lab report'],
                  targetIds: [],
                },
              },
            ],
            coverage: 'complete',
          }
        : body.kind === 'choose'
          ? { operation: 'DONE', target: null }
          : { [body.kind]: [], coverage: 'complete' },
    );

    await startCourseRefresh(student);

    const metrics = academicTasks
      .getActivity(student)
      .find((run) => run.key === 'courses')?.metrics;
    expect(metrics?.modelCalls).toBeGreaterThan(0);
    expect(metrics?.candidatesExtracted).toBeGreaterThan(0);
    expect(metrics?.firstFindingMs).toEqual(expect.any(Number));
    expect(metrics?.durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(metrics)).not.toContain('Lab report');
  });

  it('returns the connection ids attempted by this refresh run', async () => {
    insertConnection('marked', host);
    insertConnection('unmarked', 'portal.school.edu', {
      isCourseResource: false,
    });
    fixtures.set('marked', listFixture());

    const refreshed = await startCourseRefresh(student);

    expect(refreshed.attemptedConnectionIds).toEqual(['marked']);
  });

  it('rechecks a marked source with a previous sign-in status so notes can resume its account picker', async () => {
    insertConnection('signed-out', host, { status: 'needs-sign-in' });
    fixtures.set('signed-out', listFixture());
    mocks.applyDiscovery.mockImplementationOnce(() => stateFrom());
    const refreshed = await startCourseRefresh(student);
    expect(refreshed.state.connections[0].status).toBe('confirmed');
    expect(mocks.scan).toHaveBeenCalledOnce();
    expect(savedSources()).toEqual([
      expect.objectContaining({
        connectionId: 'signed-out',
        outcome: 'complete',
      }),
    ]);
  });

  it('keeps the actionable account-picker explanation from the protected scan', async () => {
    insertConnection('marked', host);
    const message =
      'Sign in manually in your study browser, or specify one account to choose in this resource’s notes.';
    mocks.scan.mockResolvedValueOnce({
      outcome: 'needs-sign-in',
      message,
      entries: [],
      observed: null,
      followed: null,
      truncated: false,
    });
    await startCourseRefresh(student);
    expect(savedSources()[0]).toMatchObject({
      outcome: 'needs-sign-in',
      message,
    });
  });

  it('refuses to run when nothing is marked', async () => {
    insertConnection('unmarked', host, { isCourseResource: false });
    await expect(startCourseRefresh(student)).rejects.toThrow(
      'Choose which connections hold your courses first.',
    );
  });
});

describe('saving what the scan really saw', () => {
  it('does not retire courses when classification skipped some observed links', async () => {
    insertConnection('marked', host);
    mocks.scan.mockResolvedValueOnce({
      outcome: 'courses',
      entries: [],
      observed: observedPage(listUrl),
      followed: { courses: [], incomplete: false },
      truncated: true,
    });
    await startCourseRefresh(student);
    expect(savedSources()[0].outcome).toBe('partial');
  });

  it('saves the course and both collections from one scan', async () => {
    insertConnection('marked', host);
    fixtures.set('marked', listFixture());
    mocks.agent.mockImplementation(
      async (
        _path: string,
        body: {
          kind: string;
          goal: string;
          pages: Array<{ url: string }>;
          targets?: Array<{ id: string; url: string }>;
        },
      ) =>
        body.kind === 'choose'
          ? chooseCourseCollection(body)
          : body.pages[0].url === biologyUrl
            ? { coverage: 'complete', [body.kind]: [] }
            : {
                coverage: 'complete',
                [body.kind]: body.goal.includes('announcement')
                  ? [
                      {
                        title: 'Midterm moved',
                        body: null,
                        author: null,
                        published: {
                          kind: 'date',
                          date: '2026-03-05',
                          original: '2026-03-05',
                        },
                        updated: null,
                        url: null,
                        sourceId: null,
                        resources: [],
                        evidence: {
                          sourceUrl: announcementsUrl,
                          excerpts: ['Midterm moved, posted 2026-03-05'],
                          targetIds: [],
                        },
                      },
                    ]
                  : [
                      {
                        title: 'Lab report',
                        description: null,
                        kind: 'assignment',
                        state: 'active-unsubmitted',
                        due: null,
                        availableFrom: null,
                        availableUntil: null,
                        pointsPossible: null,
                        url: null,
                        sourceId: null,
                        resources: [],
                        evidence: {
                          sourceUrl: assignmentsUrl,
                          excerpts: ['Lab report'],
                          targetIds: [],
                        },
                      },
                    ],
              },
    );
    await startCourseRefresh(student);
    const [course] = savedCourses();
    expect(course).toMatchObject({
      name: 'Biology 101',
      active: true,
      announcementsStatus: 'complete',
      assignmentsStatus: 'complete',
    });
    expect([...mocks.opened].sort()).toEqual(
      [biologyUrl, biologyUrl, assignmentsUrl, announcementsUrl].sort(),
    );
  });

  it('persists verified collection routes and reuses them on the next refresh', async () => {
    insertConnection('marked', host);
    const rememberedUrl = `${biologyUrl}/modules/work`;
    fixtures.set(
      'marked',
      listFixture({
        pages: {
          [biologyUrl]: observedPage(biologyUrl, {
            title: 'Biology 101',
            text: 'Course home',
            links: [{ label: 'Work folder', url: rememberedUrl }],
          }),
          [rememberedUrl]: observedPage(rememberedUrl, {
            title: 'Assignments',
            text: 'Worksheet 1',
            links: [],
          }),
        },
      }),
    );
    mocks.agent.mockImplementation(async (_path, body) => {
      if (body.kind === 'choose') {
        const target = body.targets.find(
          (item: { id: string; url: string }) => item.url === rememberedUrl,
        );
        return target
          ? { operation: 'NAVIGATE', target: target.id }
          : { operation: 'DONE', target: null };
      }
      if (body.kind === 'courses') return { courses: [], coverage: 'partial' };
      if (body.kind === 'announcements')
        return { announcements: [], coverage: 'unavailable' };
      if (body.pages[0].url === rememberedUrl)
        return {
          coverage: 'complete',
          assignments: [
            {
              title: 'Worksheet 1',
              description: null,
              kind: 'assignment',
              state: 'active-unsubmitted',
              due: null,
              availableFrom: null,
              availableUntil: null,
              pointsPossible: null,
              url: null,
              sourceId: null,
              resources: [],
              evidence: {
                sourceUrl: rememberedUrl,
                excerpts: ['Worksheet 1'],
                targetIds: [],
              },
            },
          ],
        };
      return { coverage: 'partial', assignments: [] };
    });

    await startCourseRefresh(student);
    const [savedLocation] = db.select().from(NavigationLocationTable).all();
    expect(savedLocation).toMatchObject({
      userId: student,
      connectionId: 'marked',
      purpose: 'assignments',
      destinationUrl: rememberedUrl,
      destinationKind: 'collection',
      status: 'verified',
    });
    const firstOpenCount = mocks.opened.filter(
      (url) => url === rememberedUrl,
    ).length;
    expect(firstOpenCount).toBeGreaterThan(0);

    const previousAgentCalls = mocks.agent.mock.calls.length;
    mocks.opened.length = 0;
    await startCourseRefresh(student);

    expect(mocks.opened).toContain(rememberedUrl);
    expect(
      mocks.agent.mock.calls
        .slice(previousAgentCalls)
        .some(
          ([, body]) =>
            body.kind === 'choose' &&
            body.goal.includes('active, unsubmitted assignments') &&
            body.targets.some(
              (target: { url: string }) => target.url === rememberedUrl,
            ),
        ),
    ).toBe(false);
  });

  it('ingests readable course materials into versioned local passages', async () => {
    insertConnection('marked', host);
    const modulesUrl = `${biologyUrl}/modules/1`;
    const syllabusUrl = `${biologyUrl}/files/syllabus`;
    const syllabusText = 'Final exam: December 8, 2026.';
    fixtures.set(
      'marked',
      listFixture({
        pages: {
          [biologyUrl]: observedPage(biologyUrl, {
            title: 'Biology 101',
            text: 'Course home',
            links: [{ label: 'Modules', url: modulesUrl }],
          }),
          [modulesUrl]: observedPage(modulesUrl, {
            title: 'Week 1',
            text: 'Readings',
            links: [{ label: 'Biology syllabus', url: syllabusUrl }],
          }),
          [syllabusUrl]: observedPage(syllabusUrl, {
            title: 'Biology syllabus',
            text: syllabusText,
          }),
        },
      }),
    );
    mocks.agent.mockImplementation(async (_path, body) => {
      if (body.kind === 'courses') return { courses: [], coverage: 'partial' };
      if (body.kind === 'materials') {
        const sourceUrl = body.pages[0].url;
        if (sourceUrl === biologyUrl)
          return {
            materials: [
              {
                title: 'Modules',
                sourceType: 'page',
                url: modulesUrl,
                readability: 'unreadable',
                summary: null,
                summaryEvidence: [],
                evidence: {
                  sourceUrl,
                  excerpts: ['Modules'],
                  targetIds: ['1'],
                },
              },
            ],
            coverage: 'complete',
          };
        if (sourceUrl === modulesUrl)
          return {
            materials: [
              {
                title: 'Biology syllabus',
                sourceType: 'syllabus',
                url: syllabusUrl,
                readability: 'unreadable',
                summary: null,
                summaryEvidence: [],
                evidence: {
                  sourceUrl,
                  excerpts: ['Biology syllabus'],
                  targetIds: ['1'],
                },
              },
            ],
            coverage: 'complete',
          };
        return {
          materials: [
            {
              title: 'Biology syllabus',
              sourceType: 'syllabus',
              url: syllabusUrl,
              readability: 'readable',
              summary: 'Final exam December 8, 2026.',
              summaryEvidence: [syllabusText],
              evidence: {
                sourceUrl,
                excerpts: [syllabusText],
                targetIds: [],
              },
            },
          ],
          coverage: 'complete',
        };
      }
      if (body.kind === 'choose') return { operation: 'DONE', target: null };
      return { [body.kind]: [], coverage: 'unavailable' };
    });

    await startCourseRefresh(student);

    expect(db.select().from(CourseMaterialTable).all()).toMatchObject([
      {
        userId: student,
        connectionId: 'marked',
        title: 'Biology syllabus',
        url: syllabusUrl,
        extractionStatus: 'complete',
      },
    ]);
    expect(db.select().from(CourseMaterialChunkTable).all()).toMatchObject([
      { text: syllabusText, locator: null },
    ]);
  });

  it('saves the course when only one collection could be read', async () => {
    insertConnection('marked', host);
    fixtures.set(
      'marked',
      listFixture({
        pages: {
          [biologyUrl]: observedPage(biologyUrl, {
            links: [
              { label: 'Announcements', url: announcementsUrl },
              { label: 'Assignments', url: assignmentsUrl },
            ],
          }),
          [announcementsUrl]: observedPage(announcementsUrl, {
            text: 'There are no announcements.',
          }),
        },
      }),
    );
    mocks.agent.mockImplementation(async (_path, body) =>
      body.kind === 'choose'
        ? chooseCourseCollection(body)
        : {
            [body.kind]: [],
            coverage:
              body.pages[0].url === biologyUrl ||
              body.pages[0].text.includes('no announcements')
                ? 'complete'
                : 'unavailable',
          },
    );
    await startCourseRefresh(student);
    const [course] = savedCourses();
    expect(course?.announcementsStatus).toBe('complete');
    expect(course?.assignmentsStatus).toBe('blocked');
    expect(course?.active).toBe(true);
  });

  it('does not call a collection empty just because nothing was extracted', async () => {
    insertConnection('marked', host);
    fixtures.set('marked', listFixture());
    mocks.agent.mockImplementation(async (_path, body) =>
      body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : {
            [body.kind]: [],
            coverage: body.pages[0].text.includes('no announcements')
              ? 'complete'
              : 'unavailable',
          },
    );
    await startCourseRefresh(student);
    const [course] = savedCourses();
    expect(course?.announcementsStatus).toBe('partial');
    expect(course?.assignmentsStatus).toBe('partial');
    expect(course?.announcementsSyncedAt).toBeNull();
  });

  it('reads the course itself when there is no direct collection link', async () => {
    insertConnection('marked', host);
    fixtures.set(
      'marked',
      listFixture({
        pages: {
          [biologyUrl]: observedPage(biologyUrl, { links: [] }),
        },
      }),
    );
    await startCourseRefresh(student);
    const [course] = savedCourses();
    expect(course?.announcementsStatus).toBe('partial');
    expect(course?.assignmentsStatus).toBe('partial');
    expect(mocks.agent).toHaveBeenCalled();
  });

  it('reports a collection behind a sign-in wall without discarding the course', async () => {
    insertConnection('marked', host);
    fixtures.set(
      'marked',
      listFixture({
        errors: {
          [announcementsUrl]: 'This resource needs you to sign in again.',
        },
      }),
    );
    await startCourseRefresh(student);
    const [course] = savedCourses();
    expect(course?.active).toBe(true);
    expect(course?.overviewSyncedAt).not.toBeNull();
    expect(course?.announcementsStatus).toBe('needs-sign-in');
    expect(
      academicTasks.getActivity(student).find((run) => run.key === 'courses')
        ?.status,
    ).toBe('sign-in-required');
    expect(savedSources()).toEqual([
      expect.objectContaining({ outcome: 'complete' }),
    ]);
  });

  it('calls a paginated list partial so nothing is retired', async () => {
    insertConnection('marked', host);
    fixtures.set('marked', listFixture());
    await startCourseRefresh(student);
    expect(savedCourses()).toHaveLength(1);
    fixtures.set(
      'marked',
      listFixture({
        entries: [{ label: 'Chemistry 200', url: `https://${host}/courses/2` }],
        listPage: observedPage(listUrl, {
          links: [
            { label: 'Chemistry 200', url: `https://${host}/courses/2` },
            { label: 'Next', url: `${listUrl}?page=2` },
          ],
        }),
        pages: {
          [`https://${host}/courses/2`]: observedPage(
            `https://${host}/courses/2`,
            { links: [] },
          ),
        },
      }),
    );
    await startCourseRefresh(student);
    expect(savedSources()).toEqual([
      expect.objectContaining({ outcome: 'partial' }),
    ]);
    expect(
      academicTasks.getActivity(student).find((run) => run.key === 'courses')
        ?.status,
    ).toBe('partial');
    expect(savedCourses().map((course) => course.active)).toEqual([true, true]);
  });

  it('retires a course after a confirmed complete list', async () => {
    insertConnection('marked', host);
    fixtures.set('marked', listFixture());
    await startCourseRefresh(student);
    fixtures.set(
      'marked',
      listFixture({
        entries: [],
        outcome: 'empty',
        listPage: observedPage(listUrl, {
          text: 'You have no active courses.',
        }),
      }),
    );
    await startCourseRefresh(student);
    expect(savedCourses().map((course) => course.active)).toEqual([false]);
    expect(savedSources()).toEqual([
      expect.objectContaining({ outcome: 'complete' }),
    ]);
  });

  it('retains assignment freshness when collection evidence remains partial', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
      insertConnection('marked', host);
      fixtures.set(
        'marked',
        listFixture({
          pages: {
            [biologyUrl]: observedPage(biologyUrl, {
              title: 'Biology',
              text: 'Upcoming quiz',
              links: [
                { label: 'Announcements', url: announcementsUrl },
                { label: 'Assignments', url: assignmentsUrl },
              ],
            }),
            [announcementsUrl]: observedPage(announcementsUrl, {
              title: 'Announcements',
            }),
            [assignmentsUrl]: observedPage(assignmentsUrl, {
              title: 'Assignments',
              text: 'Old work Upcoming quiz',
              links: [
                { label: 'Old work', url: `${assignmentsUrl}/old-1` },
                { label: 'Upcoming quiz', url: `${assignmentsUrl}/new-1` },
              ],
            }),
          },
        }),
      );
      let pass: 'seed' | 'changed' = 'seed';
      const assignmentRecord = (
        sourceUrl: string,
        title: string,
        sourceId: string,
      ) => ({
        title,
        description: null,
        kind: 'assignment',
        state: 'active-unsubmitted',
        due: null,
        availableFrom: null,
        availableUntil: null,
        pointsPossible: null,
        url: `${assignmentsUrl}/${sourceId}`,
        sourceId,
        resources: [],
        evidence: {
          sourceUrl,
          excerpts: [title],
          targetIds: [sourceId === 'old-1' ? '1' : '2'],
        },
      });
      mocks.agent.mockImplementation(async (_path, body) => {
        if (body.kind === 'choose') return chooseCourseCollection(body);
        if (body.kind === 'announcements')
          return { coverage: 'complete', announcements: [] };
        if (body.pages[0].url === biologyUrl)
          return { coverage: 'complete', assignments: [] };
        return {
          coverage: 'complete',
          assignments: [
            pass === 'seed'
              ? assignmentRecord(assignmentsUrl, 'Old work', 'old-1')
              : assignmentRecord(assignmentsUrl, 'Upcoming quiz', 'new-1'),
          ],
        };
      });

      await startCourseRefresh(student);
      const before = getCoursesSnapshot(student).courses[0].assignmentsSyncedAt;
      expect(before).toBe('2026-10-31T12:00:00.000Z');
      expect(
        db
          .select()
          .from(CourseAssignmentTable)
          .all()
          .find((assignment) => assignment.content?.sourceId === 'old-1')
          ?.active,
      ).toBe(true);

      pass = 'changed';
      vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
      await startCourseRefresh(student);
      const after = getCoursesSnapshot(student).courses[0].assignmentsSyncedAt;
      const savedAssignments = db.select().from(CourseAssignmentTable).all();
      expect(after).toBe(before);
      expect(savedCourses()[0]?.assignmentsStatus).toBe('partial');
      expect(
        savedAssignments.find(
          (assignment) => assignment.content?.sourceId === 'old-1',
        )?.active,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open a course the list page never exposed', async () => {
    insertConnection('marked', host);
    fixtures.set(
      'marked',
      listFixture({
        entries: [{ label: 'Invented', url: 'https://evil.example/course' }],
      }),
    );
    await startCourseRefresh(student);
    expect(mocks.opened).not.toContain('https://evil.example/course');
    expect(savedCourses()).toHaveLength(0);
    expect(savedSources()).toEqual([
      expect.objectContaining({ outcome: 'partial' }),
    ]);
  });

  it('opens every observed course with a bounded course-list walk', async () => {
    insertConnection('marked', host);
    const many = Array.from({ length: 25 }, (_unused, index) => ({
      label: `Course ${index}`,
      url: `https://${host}/courses/${index}`,
    }));
    fixtures.set(
      'marked',
      listFixture({
        entries: many,
        listPage: observedPage(listUrl, {
          links: many.map((entry) => ({ label: entry.label, url: entry.url })),
        }),
        pages: Object.fromEntries(
          many.map((entry) => [
            entry.url,
            observedPage(entry.url, { links: [] }),
          ]),
        ),
      }),
    );
    await startCourseRefresh(student);
    expect(savedCourses()).toHaveLength(25);
    expect(mocks.opened.length).toBe(50);
    expect(mocks.agent).toHaveBeenCalledTimes(51);
    expect(mocks.scan.mock.calls[0]?.[0].maxPages).toBe(4);
    expect(
      savedCourses().filter((course) => course.overviewSyncedAt === null),
    ).toHaveLength(0);
    expect(savedSources()).toEqual([
      expect.objectContaining({ outcome: 'complete' }),
    ]);
  });
});

describe('stopping safely', () => {
  it('records a cancelled run without retiring saved courses', async () => {
    insertConnection('marked', host);
    fixtures.set('marked', listFixture());
    await startCourseRefresh(student);
    const controller = new AbortController();
    mocks.scan.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(
      startCourseRefresh(student, () => true, controller.signal),
    ).rejects.toThrow();
    expect(savedCourses().map((course) => course.active)).toEqual([true]);
    expect(savedSources()).toEqual([
      expect.objectContaining({ outcome: 'cancelled' }),
    ]);
  });

  it('writes nothing once the session is no longer current', async () => {
    insertConnection('marked', host);
    fixtures.set('marked', listFixture());
    await expect(startCourseRefresh(student, () => false)).rejects.toThrow();
    expect(savedCourses()).toHaveLength(0);
    expect(savedSources()).toHaveLength(0);
  });

  it('cancels the run that is currently holding the browser', async () => {
    insertConnection('marked', host);
    let release!: () => void;
    mocks.scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              outcome: 'blocked',
              entries: [],
              observed: null,
              notesOmitted: false,
              followed: null,
            });
        }),
    );
    const running = startCourseRefresh(student);
    // Cancelling only makes sense once the run really owns the browser.
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    cancelCourseRefresh();
    release();
    await expect(running).rejects.toThrow();
  });

  it('clears the domain policy even when a scan throws', async () => {
    insertConnection('marked', host);
    mocks.scan.mockRejectedValueOnce(new Error('browser closed'));
    await expect(startCourseRefresh(student)).rejects.toThrow();
    expect(mocks.policy).toHaveBeenLastCalledWith(null);
  });
});

it('starts independent assignment and announcement workers for every course before any model request finishes', async () => {
  insertConnection('marked', host, { notes: 'Read the weekly modules' });
  const entries = [1, 2].map((id) => ({
    label: `Course ${id}`,
    url: `${listUrl}/${id}`,
  }));
  fixtures.set(
    'marked',
    listFixture({
      entries,
      listPage: observedPage(listUrl, { links: entries }),
      pages: Object.fromEntries(
        entries.map((entry) => [entry.url, observedPage(entry.url)]),
      ),
    }),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.agent.mockImplementation(async (_path, body) => {
    expect(body.notes).toContain('Read the weekly modules');
    await gate;
    return { coverage: 'complete', [body.kind]: [] };
  });
  const running = startCourseRefresh(student);
  try {
    await vi.waitFor(() => expect(mocks.workers).toHaveBeenCalledTimes(4));
    expect(mocks.agent).toHaveBeenCalledTimes(5);
  } finally {
    release();
    await running;
  }
});

it('retains assignments in SQLite when cancelled after extraction but before navigation finishes', async () => {
  insertConnection('marked', host);
  fixtures.set(
    'marked',
    listFixture({
      pages: {
        [biologyUrl]: observedPage(biologyUrl, {
          links: [{ label: 'Assignments', url: assignmentsUrl }],
        }),
        [assignmentsUrl]: observedPage(assignmentsUrl, {
          text: 'Lab report',
          links: [{ label: 'Details', url: `${biologyUrl}/detail` }],
        }),
      },
    }),
  );
  const controller = new AbortController();
  mocks.agent.mockImplementation(async (_path, body) => {
    if (body.kind === 'choose' && !body.goal.includes('assignments'))
      return { operation: 'DONE', target: null };
    if (body.kind === 'choose') {
      controller.abort();
      throw new Error('Cancelled');
    }
    return {
      coverage: 'complete',
      [body.kind]: body.goal.includes('assignments')
        ? [
            {
              title: 'Lab report',
              description: null,
              kind: 'assignment',
              state: 'active-unsubmitted',
              due: null,
              availableFrom: null,
              availableUntil: null,
              pointsPossible: null,
              url: null,
              sourceId: null,
              resources: [],
              evidence: {
                sourceUrl: assignmentsUrl,
                excerpts: ['Lab report'],
                targetIds: [],
              },
            },
          ]
        : [],
    };
  });
  await expect(
    startCourseRefresh(student, () => true, controller.signal),
  ).rejects.toThrow();
  expect(db.select().from(CourseAssignmentTable).all()).toEqual([
    expect.objectContaining({ title: 'Lab report', active: true }),
  ]);
});

it('refreshes learning materials during a targeted course refresh', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  await startCourseRefresh(student);
  const target = savedCourses()[0]!;
  const text = 'Lecture notes explain photosynthesis.';
  const openedRoots: string[] = [];
  mocks.scan.mockImplementation(async ({ withCourseList }) => ({
    followed: await withCourseList({
      observed: observedPage(biologyUrl, { title: 'Lecture notes', text }),
      assertReadable: () => undefined,
      openFrom: vi.fn(),
      withCoursePage: async (
        url: string,
        run: (context: unknown) => Promise<void>,
      ) => {
        openedRoots.push(url);
        await run({
          observed: observedPage(biologyUrl, { title: 'Lecture notes', text }),
          assertReadable: () => undefined,
          openFrom: vi.fn(),
        });
      },
    }),
  }));
  mocks.agent.mockImplementation(async (_path, body) =>
    body.kind === 'materials'
      ? {
          coverage: 'complete',
          materials: [
            {
              title: 'Lecture notes',
              sourceType: 'page',
              url: biologyUrl,
              readability: 'readable',
              summary: null,
              summaryEvidence: [],
              evidence: {
                sourceUrl: biologyUrl,
                excerpts: [text],
                targetIds: [],
              },
            },
          ],
        }
      : body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : { coverage: 'unavailable', [body.kind]: [] },
  );

  const refreshed = await refreshSingleCourse(student, target.id);

  expect(db.select().from(CourseMaterialChunkTable).all()).toMatchObject([
    { text },
  ]);
  expect(openedRoots).toEqual([biologyUrl, biologyUrl]);
  expect(refreshed).toMatchObject({ materialRefreshStatus: 'complete' });
});

it('reports incomplete material processing independently of collection coverage', async () => {
  insertConnection('lms', host);
  const fixture = listFixture();
  fixture.pages[biologyUrl]!.text = 'Course materials';
  fixtures.set('lms', fixture);
  const originalAgent = mocks.agent.getMockImplementation()!;
  mocks.agent.mockImplementation(async (path, body) =>
    body.kind === 'materials'
      ? { materials: [], coverage: 'partial' }
      : originalAgent(path, body),
  );

  const refreshed = await startConnectionRefresh(student, 'lms');

  expect(refreshed).toMatchObject({ materialRefreshStatus: 'partial' });
  expect(
    academicTasks
      .getActivity(student)
      .find((run) => run.key === 'connection:lms')?.status,
  ).toBe('partial');
});

it('refreshes only the saved course directly, preserving other courses and source coverage', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  await startCourseRefresh(student);
  const target = savedCourses()[0];
  db.insert(CourseAssignmentTable)
    .values({
      id: 'saved-lab',
      userId: student,
      courseId: target.id,
      sourceKey: 'saved-lab',
      title: 'Lab report',
      url: assignmentsUrl,
      lastSeenAt: new Date().toISOString(),
    })
    .run();
  const sources = savedSources();
  const other = {
    ...db.select().from(CourseTable).get()!,
    id: 'other-course',
    sourceKey: 'other-course',
    name: 'Other',
    url: `https://${host}/courses/2`,
  };
  db.insert(CourseTable).values(other).run();
  mocks.scan.mockClear();
  mocks.policy.mockClear();
  mocks.scan.mockImplementation(async ({ courseUrl, withCourseList }) => {
    expect(courseUrl).toBe(target.url);
    return {
      followed: await withCourseList({
        observed: listFixture().pages[biologyUrl],
        assertReadable: () => undefined,
        openFrom: async (_from: unknown, url: string) =>
          listFixture().pages[url],
        withCoursePage: async (
          _url: string,
          run: (context: unknown) => Promise<void>,
        ) =>
          run({
            observed: listFixture().pages[biologyUrl],
            assertReadable: () => undefined,
            openFrom: async (_from: unknown, url: string) =>
              listFixture().pages[url],
          }),
      }),
    };
  });
  const refreshed = await refreshSingleCourse(student, target.id);
  expect(refreshed?.id).toBe(target.id);
  expect(mocks.scan).toHaveBeenCalledOnce();
  expect(mocks.policy).not.toHaveBeenCalled();
  expect(savedCourses().find((course) => course.id === other.id)?.active).toBe(
    true,
  );
  expect(savedSources()).toEqual(sources);
  const assignmentRequest = mocks.agent.mock.calls.findLast(
    ([, body]) => body.kind === 'assignments',
  )?.[1];
  expect(assignmentRequest?.memory?.resources).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Lab report' })]),
  );
  await expect(
    refreshSingleCourse('another-student', target.id),
  ).rejects.toThrow('no longer available');
});

it('uses one authenticated tab for both collections after account selection', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  await startCourseRefresh(student);
  const target = savedCourses()[0];
  mocks.scan.mockClear();
  mocks.agent.mockImplementation(async (_path, body) => {
    if (body.kind === 'choose') return chooseCourseCollection(body);
    if (body.kind === 'assignments')
      return body.pages[0].url === assignmentsUrl
        ? {
            coverage: 'complete',
            assignments: [
              {
                title: 'Lab report',
                description: null,
                kind: 'assignment',
                state: 'active-unsubmitted',
                due: null,
                availableFrom: null,
                availableUntil: null,
                pointsPossible: null,
                url: null,
                sourceId: null,
                resources: [],
                evidence: {
                  sourceUrl: assignmentsUrl,
                  excerpts: ['Lab report'],
                  targetIds: [],
                },
              },
            ],
          }
        : { coverage: 'complete', assignments: [] };
    if (body.kind === 'announcements')
      return body.pages[0].url === announcementsUrl
        ? {
            coverage: 'complete',
            announcements: [
              {
                title: 'Midterm moved',
                body: null,
                author: null,
                published: {
                  kind: 'date',
                  date: '2026-03-05',
                  original: '2026-03-05',
                },
                updated: null,
                url: null,
                sourceId: null,
                resources: [],
                evidence: {
                  sourceUrl: announcementsUrl,
                  excerpts: ['Midterm moved, posted 2026-03-05'],
                  targetIds: [],
                },
              },
            ],
          }
        : { coverage: 'complete', announcements: [] };
    return { coverage: 'partial', courses: [] };
  });
  mocks.scan.mockImplementation(async ({ withCourseList }) => {
    if (mocks.scan.mock.calls.length > 1)
      return {
        outcome: 'needs-sign-in',
        message: 'Sign in again.',
        followed: null,
      };
    return {
      followed: await withCourseList({
        observed: listFixture().pages[biologyUrl],
        assertReadable: () => undefined,
        openFrom: async (_from: ObservedPage, url: string) =>
          listFixture().pages[url],
        withCoursePage: async (
          _url: string,
          run: (context: unknown) => Promise<void>,
        ) =>
          run({
            observed: listFixture().pages[biologyUrl],
            assertReadable: () => undefined,
            openFrom: async (_from: ObservedPage, url: string) =>
              listFixture().pages[url],
          }),
      }),
    };
  });
  const refreshed = await refreshSingleCourse(student, target.id);
  expect(refreshed).toMatchObject({
    assignmentsStatus: 'complete',
    announcementsStatus: 'complete',
  });
  expect(mocks.scan).toHaveBeenCalledOnce();
});

it('adds a newly visible assignment during a single-course refresh without replacing the saved assignment', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  const newUrl = `${assignmentsUrl}/2`;
  const assignment = (title: string) => ({
    title,
    description: null,
    kind: 'assignment',
    state: 'active-unsubmitted',
    due: null,
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    url: null,
    sourceId: null,
    resources: [],
    evidence: { sourceUrl: assignmentsUrl, excerpts: [title], targetIds: [] },
  });
  mocks.agent.mockImplementation(async (_path, body) => {
    if (body.kind === 'choose') return { operation: 'DONE', target: null };
    if (body.kind === 'assignments' && body.pages[0].url === newUrl)
      return {
        coverage: 'detail',
        assignments: [
          {
            ...assignment('New assignment'),
            url: newUrl,
            evidence: {
              sourceUrl: newUrl,
              excerpts: ['New assignment'],
              targetIds: [],
            },
          },
        ],
      };
    return {
      coverage: 'complete',
      [body.kind]:
        body.kind === 'assignments' && body.pages[0].url === assignmentsUrl
          ? body.pages[0].text.split('\n').map((title: string) =>
              title === 'New assignment'
                ? {
                    ...assignment(title),
                    state: 'unknown',
                    url: newUrl,
                    evidence: {
                      sourceUrl: assignmentsUrl,
                      excerpts: [title],
                      targetIds: ['1'],
                    },
                  }
                : assignment(title),
            )
          : [],
    };
  });
  await startCourseRefresh(student);
  const target = savedCourses()[0];
  const saved = db.select().from(CourseAssignmentTable).all();
  expect(saved).toHaveLength(1);
  const fixture = listFixture();
  fixture.pages[assignmentsUrl].text = 'Lab report\nNew assignment';
  fixture.pages[assignmentsUrl].links = [
    { label: 'New assignment', url: newUrl },
  ];
  fixture.pages[newUrl] = observedPage(newUrl, {
    title: 'New assignment',
    text: 'New assignment',
  });
  mocks.scan.mockImplementation(async ({ withCourseList }) => ({
    followed: await withCourseList({
      observed: fixture.pages[biologyUrl],
      assertReadable: () => undefined,
      openFrom: async (_from: ObservedPage, url: string) => fixture.pages[url],
      withCoursePage: async (
        _url: string,
        run: (context: unknown) => Promise<void>,
      ) =>
        run({
          observed: fixture.pages[biologyUrl],
          assertReadable: () => undefined,
          openFrom: async (_from: ObservedPage, url: string) =>
            fixture.pages[url],
        }),
    }),
  }));
  const refreshed = await refreshSingleCourse(student, target.id);
  expect(refreshed?.assignments).toHaveLength(2);
  expect(refreshed?.assignments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: saved[0].id, title: 'Lab report' }),
      expect.objectContaining({ title: 'New assignment' }),
    ]),
  );
});

it('starts separate course refreshes before either finishes and keeps completed work isolated', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  await startCourseRefresh(student);
  const target = savedCourses()[0];
  db.insert(CourseTable)
    .values({
      ...db.select().from(CourseTable).get()!,
      id: 'other-course',
      sourceKey: 'other-course',
      url: `https://${host}/courses/2`,
    })
    .run();
  const releases: (() => void)[] = [];
  mocks.scan.mockImplementation(
    () =>
      new Promise((resolve) =>
        releases.push(() => resolve({ followed: true })),
      ),
  );
  const a = refreshSingleCourse(student, target.id);
  const b = refreshSingleCourse(student, 'other-course');
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  for (const release of releases) release();
  await Promise.all([a, b]);
});

it('extracts explicit course metadata from observed list links instead of parsing the course name', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  mocks.agent.mockImplementation(async (_path, body) =>
    body.kind === 'courses'
      ? {
          coverage: 'complete',
          courses: [
            {
              name: 'Biology 101',
              code: 'BIO',
              section: 'A',
              term: 'Autumn',
              description: null,
              instructors: ['Dr. Teacher'],
              sourceId: 'course-1',
              url: biologyUrl,
              evidence: {
                sourceUrl: listUrl,
                excerpts: ['Biology 101'],
                targetIds: ['1'],
              },
            },
          ],
        }
      : body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : { [body.kind]: [], coverage: 'unavailable' },
  );
  await startCourseRefresh(student);
  expect(savedCourses()[0]).toMatchObject({
    code: 'BIO',
    term: 'Autumn',
    content: { section: 'A', instructors: ['Dr. Teacher'] },
  });
});

it('refreshes explicit course metadata directly without rediscovering the other courses', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  await startCourseRefresh(student);
  const saved = savedCourses()[0];
  mocks.scan.mockImplementation(async ({ withCourseList }) => ({
    followed: await withCourseList({
      observed: observedPage(biologyUrl, {
        title: 'Biology 101',
        text: 'Biology 101 section A BIO Autumn',
      }),
      assertReadable: () => undefined,
      openFrom: vi.fn(),
      withCoursePage: async (
        _url: string,
        run: (context: unknown) => Promise<void>,
      ) =>
        run({
          observed: observedPage(biologyUrl, {
            title: 'Biology 101',
            text: 'Biology 101 section A BIO Autumn',
          }),
          assertReadable: () => undefined,
          openFrom: vi.fn(),
        }),
    }),
  }));
  mocks.agent.mockImplementation(async (_path, body) =>
    body.kind === 'courses'
      ? {
          coverage: 'detail',
          courses: [
            {
              name: 'Biology 101',
              code: 'BIO',
              section: 'A',
              term: 'Autumn',
              description: null,
              instructors: [],
              sourceId: 'course-1',
              url: biologyUrl,
              evidence: {
                sourceUrl: biologyUrl,
                excerpts: ['Biology 101'],
                targetIds: [],
              },
            },
          ],
        }
      : { [body.kind]: [], coverage: 'complete' },
  );
  const refreshed = await refreshSingleCourse(student, saved.id);
  expect(refreshed).toMatchObject({
    id: saved.id,
    code: 'BIO',
    term: 'Autumn',
    content: { section: 'A' },
  });
});

it('returns the admitted revision receipt and keeps unread material partial', async () => {
  insertConnection('lms', host);
  const fixture = listFixture();
  fixture.pages[biologyUrl]!.text = 'Course materials';
  fixtures.set('lms', fixture);
  const originalScan = mocks.scan.getMockImplementation()!;
  let releaseScan!: () => void;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  mocks.scan.mockImplementationOnce(async (...args) => {
    await scanGate;
    return originalScan(...args);
  });
  mocks.agent.mockImplementation(async (_path, body) =>
    body.kind === 'materials'
      ? { materials: [], coverage: 'partial' }
      : body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : { [body.kind]: [], coverage: 'complete' },
  );
  const captureFirst = vi.fn(() => ({
    sessionEpoch: 7,
    coveredRevisions: { target: 'revision-a' },
  }));
  const captureJoiner = vi.fn(() => ({
    sessionEpoch: 8,
    coveredRevisions: { target: 'revision-b' },
  }));
  const first = startConnectionRefreshWithReceipt(student, 'lms', captureFirst);
  const joined = startConnectionRefreshWithReceipt(
    student,
    'lms',
    captureJoiner,
  );

  expect(joined).toBe(first);
  await vi.waitFor(() => expect(mocks.scan).toHaveBeenCalledOnce());
  releaseScan();
  const [firstExecution, joinedExecution] = await Promise.all([first, joined]);

  expect(captureFirst).toHaveBeenCalledOnce();
  expect(captureJoiner).not.toHaveBeenCalled();
  expect(joinedExecution.receipt).toEqual(firstExecution.receipt);
  expect(firstExecution.receipt).toMatchObject({
    runId: expect.any(String),
    sessionEpoch: 7,
    coveredRevisions: { target: 'revision-a' },
    status: 'partial',
  });
  expect(firstExecution.receipt.collections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'materials', status: 'partial' }),
    ]),
  );
  expect(firstExecution.result.materialRefreshStatus).toBe('partial');
  expect(firstExecution.result.status).toBe('partial');
});

it('keeps incomplete material coverage in the receipt without a course row', async () => {
  insertConnection('lms', host);
  mocks.scan.mockResolvedValueOnce({
    outcome: 'courses',
    entries: [],
    observed: observedPage(listUrl),
    notesOmitted: false,
    followed: {
      courses: [],
      incomplete: false,
      materialRefreshStatus: 'partial',
    },
    truncated: false,
    message: null,
  });

  const execution = await startConnectionRefreshWithReceipt(
    student,
    'lms',
    () => ({ sessionEpoch: 4, coveredRevisions: {} }),
  );

  expect(execution.receipt.status).toBe('partial');
  expect(execution.receipt.collections).toContainEqual(
    expect.objectContaining({
      connectionId: 'lms',
      courseId: null,
      kind: 'materials',
      status: 'partial',
    }),
  );
});

it('settles a verified empty source as complete', async () => {
  insertConnection('lms', host);
  mocks.scan.mockResolvedValueOnce({
    outcome: 'empty',
    entries: [],
    observed: observedPage(listUrl),
    notesOmitted: false,
    followed: {
      courses: [],
      incomplete: false,
      materialRefreshStatus: 'complete',
    },
    truncated: false,
    message: null,
  });

  const execution = await startConnectionRefreshWithReceipt(
    student,
    'lms',
    () => ({ sessionEpoch: 4, coveredRevisions: {} }),
  );

  expect(execution.receipt.status).toBe('complete');
  expect(execution.result.status).toBe('complete');
  expect(execution.receipt.collections).toContainEqual(
    expect.objectContaining({
      connectionId: 'lms',
      kind: 'courses',
      status: 'complete',
    }),
  );
});

it('keeps targeted watch receipts scoped to the original coalesced course run', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  await startCourseRefresh(student);
  const target = savedCourses()[0]!;
  const fixture = listFixture();
  fixture.pages[biologyUrl]!.text = 'Course materials';
  fixtures.set('lms', fixture);
  mocks.agent.mockImplementation(async (_path, body) =>
    body.kind === 'materials'
      ? { materials: [], coverage: 'partial' }
      : body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : { [body.kind]: [], coverage: 'complete' },
  );
  mocks.scan.mockClear();
  let releaseScan!: () => void;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  mocks.scan.mockImplementationOnce(async (...args) => {
    await scanGate;
    const { withCourseList } = args[0] as {
      withCourseList: (context: unknown) => Promise<unknown>;
    };
    const pageContext: Record<string, unknown> = {
      observed: fixture.pages[biologyUrl],
      assertReadable: () => undefined,
      openFrom: async (_from: ObservedPage, url: string) => fixture.pages[url],
    };
    pageContext.withCoursePage = async (
      _url: string,
      run: (context: unknown) => Promise<void>,
    ) => run(pageContext);
    return { followed: await withCourseList(pageContext) };
  });
  const captureFirst = vi.fn(() => ({
    sessionEpoch: 12,
    coveredRevisions: { target: 'targeted-revision' },
  }));
  const captureJoiner = vi.fn(() => ({
    sessionEpoch: 13,
    coveredRevisions: { target: 'newer-targeted-revision' },
  }));
  const first = refreshSingleCourseWithReceipt(
    student,
    target.id,
    captureFirst,
  );
  const joined = refreshSingleCourseWithReceipt(
    student,
    target.id,
    captureJoiner,
  );

  expect(joined).toBe(first);
  await vi.waitFor(() => expect(mocks.scan).toHaveBeenCalledOnce());
  releaseScan();
  const [firstExecution, joinedExecution] = await Promise.all([first, joined]);

  expect(captureFirst).toHaveBeenCalledOnce();
  expect(captureJoiner).not.toHaveBeenCalled();
  expect(joinedExecution.receipt).toEqual(firstExecution.receipt);
  expect(firstExecution.receipt).toMatchObject({
    sessionEpoch: 12,
    coveredRevisions: { target: 'targeted-revision' },
    status: 'partial',
  });
  expect(firstExecution.receipt.collections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'materials', status: 'partial' }),
    ]),
  );
});

it('propagates fatal browser capability changes from course-page work', async () => {
  insertConnection('lms', host);
  const fixture = listFixture();
  fixture.errors = {
    [biologyUrl]: Object.assign(new Error('Capability changed.'), {
      name: 'BrowserCapabilityChangedError',
    }),
  };
  fixtures.set('lms', fixture);

  await expect(startConnectionRefresh(student, 'lms')).rejects.toMatchObject({
    name: 'BrowserCapabilityChangedError',
  });

  expect(savedCourses()).toHaveLength(1);
  expect(savedCourses()[0]?.assignmentsStatus).not.toBe('complete');
  expect(savedSources()[0]?.outcome).toBe('blocked');
});

it('keeps source error details out of refresh activity events', async () => {
  insertConnection('lms', host);
  fixtures.set('lms', listFixture());
  const privateDetail = 'student-one session-token-private';
  mocks.agent.mockRejectedValue(new Error(privateDetail));

  await startConnectionRefresh(student, 'lms');

  const activity = academicTasks
    .getActivity(student)
    .find((run) => run.key === 'connection:lms');
  expect(activity?.status).toBe('partial');
  expect(activity?.events.join(' ')).not.toContain(privateDetail);
  expect(activity?.events).toContain('Some course data could not be read.');
});

it('reports a bounded actionable provider failure without exposing private source details', async () => {
  insertConnection('lms', host);
  mocks.scan.mockResolvedValueOnce({
    outcome: 'blocked',
    entries: [],
    observed: null,
    notesOmitted: false,
    followed: null,
    truncated: false,
    message:
      'Meta API HTTP 429 quota exceeded student-one session-token-private',
  });
  const result = await startConnectionRefresh(student, 'lms');
  const activity = academicTasks
    .getActivity(student)
    .find((run) => run.key === 'connection:lms');
  expect(result.status).toBe('partial');
  expect(activity?.events).toContain(
    'The AI provider usage limit was reached. Retry after the limit resets.',
  );
  expect(activity?.events.join(' ')).not.toContain('session-token-private');
  expect(activity?.events.join(' ')).not.toContain('student-one');
});
