import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-browser-refresh-'));
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

const mocks = vi.hoisted(() => ({
  getOnboardingState: vi.fn(),
  applyAcademicDiscovery: vi.fn(),
  createPage: vi.fn(),
  readPage: vi.fn(),
  accountRequest: vi.fn(),
  setDomainPolicy: vi.fn(),
  assertReadable: vi.fn(),
  releaseProtection: vi.fn(async () => undefined),
  navigations: [] as string[],
  pages: new Map<string, unknown>(),
}));

vi.mock('../../onboarding/services/store', () => ({
  getOnboardingState: mocks.getOnboardingState,
  applyAcademicDiscovery: mocks.applyAcademicDiscovery,
}));

vi.mock('../../onboarding/services/browser-workspace', () => ({
  getWorkspace: vi.fn(async () => ({
    cdpUrl: 'http://127.0.0.1:9222',
    browser: { context: { setDomainPolicy: mocks.setDomainPolicy } },
  })),
  withMissionStagehand: vi.fn(async (_workspace, _options, run) => run({})),
}));

vi.mock('../../onboarding/services/background-page', () => ({
  openBackgroundPage: vi.fn(async () => mocks.createPage()),
}));

vi.mock('../../onboarding/services/mission-navigation', () => ({
  createMissionNavigator: vi.fn(() => async (page: unknown, url: string) => {
    mocks.navigations.push(url);
    (page as { navigateTo: (target: string) => void }).navigateTo(url);
  }),
}));

vi.mock('../../onboarding/services/page-content', () => ({
  readPage: mocks.readPage,
  revealCourseNavigation: vi.fn(async () => 'not-found'),
}));

vi.mock('../../onboarding/services/page-readiness', () => ({
  waitForMissionPage: vi.fn(async () => undefined),
}));

vi.mock('../../onboarding/services/mission-request-guard', () => ({
  protectMissionPage: vi.fn(async () =>
    Object.assign(mocks.releaseProtection, {
      assertReadable: mocks.assertReadable,
    }),
  ),
}));

vi.mock('../../onboarding/services/browser-mode', () => ({
  getBrowserNavigationMode: vi.fn(async () => 'decision'),
  toBrowserCapabilityError: (error: unknown) => {
    if (error instanceof Error && error.message === 'capability-changed')
      return Object.assign(new Error('Browser capability changed.'), {
        name: 'BrowserCapabilityChangedError',
        code: 'capability-changed',
      });
    return error;
  },
}));

vi.mock('../../context/services/material-refresh', () => ({
  refreshCourseMaterials: vi.fn(async () => ({
    status: 'complete',
    materialsSaved: 0,
  })),
}));

vi.mock('../../../lib/auth/main', () => ({
  accountRequest: mocks.accountRequest,
}));

vi.mock('../../onboarding/services/mission-traffic', () => ({
  missionTraffic: { waitForTurn: vi.fn(async () => undefined) },
}));

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseSourceTable,
  CourseTable,
  NavigationLocationTable,
} = await import('../../../db/schema');
const { applyCourseRefresh, getCoursesSnapshot } =
  await import('../services/store');
const { saveNavigationLocation } =
  await import('../../context/services/navigation-store');
const { refreshSingleCourseWithReceipt, startConnectionRefreshWithReceipt } =
  await import('../services/refresh');
const { academicTasks } =
  await import('../../onboarding/services/academic-tasks');
import type { AcademicConnection } from '../../onboarding/types';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { ObservedCourse } from '../types';

type BrowserFixturePage = {
  url: () => Promise<string>;
  navigateTo: (url: string) => void;
};

const studentId = 'synthetic-student';
const connectionId = 'synthetic-connection';
const host = 'canvas.school.edu';
const courseUrl = `https://${host}/courses/biology-101`;
const courseListUrl = `https://${host}/courses`;
const assignmentsUrl = `${courseUrl}/modules/work`;
const announcementsUrl = `${courseUrl}/announcements`;
const assignmentItemUrl = `${assignmentsUrl}/lab-report`;

const connection: AcademicConnection = {
  id: connectionId,
  name: 'Canvas',
  url: courseListUrl,
  host,
  kind: 'canvas',
  status: 'verified',
  verifiedAt: null,
  notes: null,
  favicon: null,
  isCourseResource: true,
};

const courseListPage: ObservedPage = {
  url: courseListUrl,
  title: 'Courses',
  text: 'Current courses',
  links: [{ label: 'Biology 101', url: courseUrl }],
};

const coursePage: ObservedPage = {
  url: courseUrl,
  title: 'Biology 101',
  text: 'Course home',
  links: [{ label: 'Announcements', url: announcementsUrl }],
};

const assignmentsPage: ObservedPage = {
  url: assignmentsUrl,
  title: 'Assignments',
  text: 'Lab report',
  links: [{ label: 'Lab report', url: assignmentItemUrl }],
};

const announcementsPage: ObservedPage = {
  url: announcementsUrl,
  title: 'Announcements',
  text: 'Upcoming class update',
  links: [],
};

const onboardingState = {
  accountId: studentId,
  settings: { consent: true, notes: '' },
  workspace: { ready: true },
  connections: [connection],
  discovery: {
    status: 'complete',
    message: null,
    discoveredAt: null,
    entries: [],
  },
};

const assignmentRecord = (sourceUrl: string) => ({
  title: 'Lab report',
  description: 'Write a short lab report.',
  kind: 'assignment',
  state: 'active-unsubmitted',
  due: null,
  availableFrom: null,
  availableUntil: null,
  pointsPossible: null,
  url: assignmentItemUrl,
  sourceId: 'lab-report-1',
  resources: [],
  evidence: {
    sourceUrl,
    excerpts: ['Lab report'],
    targetIds: ['1'],
  },
});

const observedCourse: ObservedCourse = {
  externalId: null,
  name: 'Biology 101',
  code: null,
  term: null,
  instructor: null,
  description: null,
  url: courseUrl,
  overview: 'complete',
  announcements: { status: 'complete', items: [] },
  assignments: { status: 'complete', items: [] },
};

const captureExecutionScope = () => ({
  sessionEpoch: 11,
  coveredRevisions: { courses: 'courses-r4', assignments: 'assignments-r7' },
});

const seedExistingCourse = () => {
  db.insert(AcademicConnectionTable)
    .values({
      id: connectionId,
      userId: studentId,
      name: connection.name,
      url: connection.url,
      host,
      kind: 'canvas',
      status: 'verified',
      verifiedAt: null,
      isCourseResource: true,
    })
    .run();
  applyCourseRefresh(studentId, [
    {
      connectionId,
      outcome: 'complete',
      message: null,
      courses: [observedCourse],
    },
  ]);
  const savedCourse = getCoursesSnapshot(studentId).courses.find(
    (candidate) => candidate.url === courseUrl,
  );
  if (!savedCourse) throw new Error('Synthetic course seed was not persisted.');
  return savedCourse;
};

const seedExistingCourseAndDestination = () => {
  const savedCourse = seedExistingCourse();
  const savedNavigationLocation = saveNavigationLocation(
    studentId,
    connectionId,
    {
      courseId: savedCourse.id,
      purpose: 'assignments',
      destinationUrl: assignmentsUrl,
      parentUrl: courseUrl,
      recipe: null,
      label: 'Work folder',
      evidence: {
        sourceUrl: courseUrl,
        excerpts: ['Work folder'],
        targetIds: [],
      },
      status: 'verified',
      destinationKind: 'collection',
      observedAt: '2026-11-04T00:00:00.000Z',
      verifiedAt: '2026-11-04T00:00:00.000Z',
    },
  );
  if (!savedNavigationLocation)
    throw new Error('Synthetic saved destination was not persisted.');
  return savedCourse;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.navigations.length = 0;
  mocks.pages.clear();
  mocks.setDomainPolicy.mockResolvedValue(undefined);
  mocks.getOnboardingState.mockReturnValue(onboardingState);
  mocks.applyAcademicDiscovery.mockReturnValue(onboardingState);
  mocks.createPage.mockReset().mockImplementation(() => {
    let currentUrl = '';
    return {
      url: vi.fn(async () => currentUrl),
      navigateTo: (url: string) => {
        currentUrl = url;
      },
      close: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined),
      evaluate: vi.fn(),
      locator: vi.fn(),
    };
  });
  mocks.readPage.mockImplementation(async (page: BrowserFixturePage) => {
    const observed = mocks.pages.get(await page.url());
    if (!observed) throw new Error('Synthetic page was not found.');
    return observed;
  });
  mocks.pages.set(courseListUrl, courseListPage);
  mocks.pages.set(courseUrl, coursePage);
  mocks.pages.set(assignmentsUrl, assignmentsPage);
  mocks.pages.set(announcementsUrl, announcementsPage);
  mocks.accountRequest.mockImplementation(
    async (_path: string, body: unknown) => {
      const request = body as {
        kind?: string;
        targets?: Array<{ id: string; url: string }>;
        pages?: Array<{ url: string }>;
      };
      switch (request.kind) {
        case 'discover':
          return {
            courseTargetIds: (request.targets ?? [])
              .filter((target) => target.url === courseUrl)
              .map((target) => target.id),
          };
        case 'courses':
          return { courses: [], coverage: 'partial' };
        case 'assignments':
          return request.pages?.[0]?.url === assignmentsUrl
            ? {
                assignments: [assignmentRecord(assignmentsUrl)],
                coverage: 'complete',
              }
            : { assignments: [], coverage: 'unavailable' };
        case 'announcements':
          return { announcements: [], coverage: 'unavailable' };
        case 'choose': {
          const target = request.targets?.[0];
          return target
            ? { operation: 'NAVIGATE', target: target.id }
            : { operation: 'DONE', target: null };
        }
        default:
          throw new Error(`Unexpected synthetic request kind: ${request.kind}`);
      }
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
});

describe('protected browser refresh composition', () => {
  it('reuses a scoped destination and preserves partial coverage in both refresh receipts', async () => {
    const savedCourse = seedExistingCourseAndDestination();

    const connectionExecution = await startConnectionRefreshWithReceipt(
      studentId,
      connectionId,
      captureExecutionScope,
    );

    expect(mocks.navigations).toContain(assignmentsUrl);
    expect(connectionExecution.receipt).toMatchObject({
      sessionEpoch: 11,
      coveredRevisions: {
        courses: 'courses-r4',
        assignments: 'assignments-r7',
      },
      status: 'partial',
      collections: expect.arrayContaining([
        expect.objectContaining({
          connectionId,
          courseId: savedCourse.id,
          kind: 'assignments',
          status: 'partial',
        }),
        expect.objectContaining({
          connectionId,
          courseId: savedCourse.id,
          kind: 'announcements',
          status: 'partial',
        }),
      ]),
    });
    expect(
      db
        .select()
        .from(CourseAssignmentTable)
        .all()
        .find((assignment) => assignment.url === assignmentItemUrl),
    ).toMatchObject({
      courseId: savedCourse.id,
      content: { evidence: { sourceUrl: assignmentsUrl } },
    });
    expect(
      db
        .select()
        .from(NavigationLocationTable)
        .all()
        .find((location) => location.destinationUrl === assignmentsUrl),
    ).toMatchObject({
      userId: studentId,
      connectionId,
      courseId: savedCourse.id,
      purpose: 'assignments',
      parentUrl: courseUrl,
      evidence: { sourceUrl: courseUrl },
      status: 'verified',
    });
    expect(
      academicTasks
        .getActivity(studentId)
        .find((task) => task.key === `connection:${connectionId}`)?.metrics
        ?.knownDestinationsReused,
    ).toBe(1);

    mocks.navigations.length = 0;
    const courseExecution = await refreshSingleCourseWithReceipt(
      studentId,
      savedCourse.id,
      captureExecutionScope,
    );

    expect(mocks.navigations).toContain(assignmentsUrl);
    expect(
      academicTasks
        .getActivity(studentId)
        .find((task) => task.key === savedCourse.id)?.metrics
        ?.knownDestinationsReused,
    ).toBe(1);
    expect(courseExecution.receipt).toMatchObject({
      sessionEpoch: 11,
      coveredRevisions: {
        courses: 'courses-r4',
        assignments: 'assignments-r7',
      },
      status: 'partial',
      collections: expect.arrayContaining([
        expect.objectContaining({
          connectionId,
          courseId: savedCourse.id,
          kind: 'assignments',
          status: 'partial',
        }),
        expect.objectContaining({
          connectionId,
          courseId: savedCourse.id,
          kind: 'announcements',
          status: 'partial',
        }),
      ]),
    });
  });

  it('persists observed parent evidence so a newly discovered route is reusable', async () => {
    const savedCourse = seedExistingCourse();
    mocks.pages.set(courseUrl, {
      ...coursePage,
      links: [
        { label: 'Assignments', url: assignmentsUrl },
        { label: 'Announcements', url: announcementsUrl },
      ],
    });

    await startConnectionRefreshWithReceipt(
      studentId,
      connectionId,
      captureExecutionScope,
    );

    expect(
      db
        .select()
        .from(NavigationLocationTable)
        .all()
        .find((location) => location.destinationUrl === assignmentsUrl),
    ).toMatchObject({
      userId: studentId,
      connectionId,
      courseId: savedCourse.id,
      purpose: 'assignments',
      parentUrl: courseUrl,
      evidence: { sourceUrl: courseUrl, excerpts: ['Assignments'] },
      status: 'verified',
    });

    mocks.pages.set(courseUrl, coursePage);
    mocks.navigations.length = 0;
    await refreshSingleCourseWithReceipt(
      studentId,
      savedCourse.id,
      captureExecutionScope,
    );

    expect(mocks.navigations).toContain(assignmentsUrl);
    expect(
      academicTasks
        .getActivity(studentId)
        .find((task) => task.key === savedCourse.id)?.metrics
        ?.knownDestinationsReused,
    ).toBe(1);
  });
});
