import { configureBrowserPolicy } from '../lib/browser-policy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanConnection } from '../services/connection-scan';
import type { AcademicConnection } from '../types';
import type { ActiveWorkspace } from '../services/browser-workspace';
import { protectMissionPage } from '../services/mission-request-guard';
import { missionTraffic } from '../services/mission-traffic';

const mocks = vi.hoisted(() => ({
  readPage: vi.fn(),
  navigations: [] as string[],
  release: vi.fn(async () => undefined),
  browserMode: vi.fn(),
  withStagehand: vi.fn(),
  navigation: vi.fn(),
  accountRequest: vi.fn(),
  page: {
    close: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    url: vi.fn(),
    evaluate: vi.fn(),
    locator: vi.fn(),
  },
}));
vi.mock('../services/background-page', () => ({
  openBackgroundPage: async () => mocks.page,
}));
vi.mock('../services/page-content', () => ({
  readPage: mocks.readPage,
  readPageUrl: () => mocks.page.url(),
  revealCourseNavigation: vi.fn(async () => 'not-found'),
}));
vi.mock('../services/page-readiness', () => ({
  waitForMissionPage: vi.fn(async () => undefined),
}));
vi.mock('../services/mission-request-guard', () => ({
  protectMissionPage: vi.fn(async () =>
    Object.assign(mocks.release, { assertReadable: () => undefined }),
  ),
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: mocks.accountRequest,
}));
vi.mock('../services/browser-mode', () => ({
  getBrowserNavigationMode: mocks.browserMode,
}));
vi.mock('../services/browser-workspace', () => ({
  withMissionStagehand: mocks.withStagehand,
}));
vi.mock('../services/browser-navigation', () => ({
  createBrowserNavigationAdapter: mocks.navigation,
}));

const host = 'canvas.school.edu';
const listUrl = `https://${host}/courses`;
const courseUrl = `https://${host}/courses/1`;

const connection: AcademicConnection = {
  id: 'connection-a',
  name: 'Canvas',
  url: listUrl,
  host,
  kind: 'canvas',
  status: 'verified',
  verifiedAt: null,
  notes: null,
  favicon: null,
  isCourseResource: true,
};

const listPage = {
  url: listUrl,
  title: 'Courses',
  text: 'Your courses',
  links: [{ label: 'Biology 101', url: courseUrl }],
  password: false,
  error: false,
};
const coursePage = {
  url: courseUrl,
  title: 'Biology 101',
  text: 'Course home',
  links: [],
  password: false,
  error: false,
};

const workspace = {
  cdpUrl: 'http://127.0.0.1:9222',
  browser: { context: { newPage: async () => mocks.page } },
} as unknown as ActiveWorkspace;

const scan = (
  withCourseList?: Parameters<typeof scanConnection>[0]['withCourseList'],
) =>
  scanConnection({
    connection,
    workspace,
    hosts: [host],
    notes: '',
    navigatePage: async (_page, url) => void mocks.navigations.push(url),
    isCurrent: () => true,
    signal: new AbortController().signal,
    withCourseList,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.navigations.length = 0;
  // A walk that never opens a course leaves an unused page behind, so the queue
  // is reset rather than cleared before the next walk is armed.
  mocks.readPage.mockReset();
  mocks.readPage
    .mockResolvedValueOnce(listPage)
    .mockResolvedValueOnce(coursePage)
    .mockResolvedValue(coursePage);
  mocks.accountRequest.mockResolvedValue({ courseTargetIds: ['1'] });
  mocks.page.url.mockResolvedValue(listUrl);
  mocks.page.evaluate.mockReset();
  mocks.page.locator.mockReset();
  mocks.browserMode.mockResolvedValue('decision');
  mocks.withStagehand.mockImplementation(async (_workspace, _options, run) =>
    run({ mission: true }),
  );
  mocks.navigation.mockReturnValue({
    setCourseScope: vi.fn(),
    discoverCourses: vi.fn(async (request) => {
      const result = await mocks.accountRequest('/api/agent', {
        kind: 'discover',
        ...request,
      });
      return result.courseTargetIds;
    }),
    choose: vi.fn(),
    extract: vi.fn(),
  });
});

describe('one protected walk of a connected resource', () => {
  it('explains an inconclusive readable page without pretending an exception occurred', async () => {
    mocks.readPage.mockReset().mockResolvedValue({
      ...listPage,
      text: 'private student data',
      links: [],
    });
    mocks.accountRequest.mockResolvedValue({ courseTargetIds: [] });
    const result = await scan();
    expect(result.outcome).toBe('inconclusive');
    expect(result.message).toContain('exposed no readable course links');
    expect(result.message).not.toContain('private student data');
  });

  it('paces an observed PDF request through the shared host queue', async () => {
    const pdfUrl = `https://${host}/files/syllabus.pdf`;
    const events: string[] = [];
    mocks.readPage
      .mockReset()
      .mockResolvedValueOnce({
        ...listPage,
        links: [...listPage.links, { label: 'Syllabus PDF', url: pdfUrl }],
      })
      .mockResolvedValueOnce(coursePage)
      .mockResolvedValue(coursePage);
    mocks.page.evaluate.mockImplementation(async () => {
      events.push('fetch-pdf');
      return {
        status: 200,
        contentType: 'application/pdf',
        finalUrl: pdfUrl,
        base64: Buffer.from('%PDF-1.4\nsynthetic').toString('base64'),
      };
    });
    const waitForTurn = vi
      .spyOn(missionTraffic, 'waitForTurn')
      .mockImplementation(async (url) => {
        expect(url).toBe(pdfUrl);
        events.push('wait-for-turn');
      });

    try {
      await scan(async (context) => {
        expect(context.observed).not.toBeNull();
        return context.downloadPdf(context.observed!, pdfUrl);
      });

      expect(waitForTurn).toHaveBeenCalledOnce();
      expect(events).toEqual(['wait-for-turn', 'fetch-pdf']);
    } finally {
      waitForTurn.mockRestore();
    }
  });

  it('uses the server capability and scopes inout Stagehand to the scan mission', async () => {
    mocks.browserMode.mockResolvedValue('inout');
    const result = await scan();

    expect(result.outcome).toBe('courses');
    expect(mocks.withStagehand).toHaveBeenCalledOnce();
    expect(mocks.navigation).toHaveBeenCalledWith(
      'inout',
      expect.objectContaining({ stagehand: { mission: true } }),
    );
  });

  it('does not start browsing when the authenticated mode capability fails', async () => {
    mocks.browserMode.mockRejectedValueOnce(
      new Error('Capability unavailable'),
    );

    await expect(scan()).rejects.toThrow('Capability unavailable');
    expect(mocks.readPage).not.toHaveBeenCalled();
  });

  it('uses resource notes to continue an account picker before classifying the course list', async () => {
    mocks.page.url.mockResolvedValue(
      'https://accounts.google.com/v3/signin/accountchooser',
    );
    mocks.page.evaluate.mockImplementation(
      async (_read, input: { email: string }) => {
        expect(input.email).toBe('student@school.edu');
        return 'selected';
      },
    );
    mocks.page.locator.mockReturnValue({
      click: async () => {
        mocks.page.url.mockResolvedValue(listUrl);
      },
    });
    const result = await scanConnection({
      connection: {
        ...connection,
        notes:
          'If you see a Google account picker, I am still signed in; just choose student@school.edu.',
      },
      workspace,
      hosts: [host],
      notes: '',
      navigatePage: async () => undefined,
      isCurrent: () => true,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('courses');
    const { accountRequest } = await import('../../../lib/auth/main');
    expect(vi.mocked(accountRequest).mock.calls[0][1]).toMatchObject({
      pages: [expect.objectContaining({ url: listUrl })],
    });
  });

  it('preserves the actionable picker refusal and never sends the sign-in page to inference', async () => {
    mocks.page.url.mockResolvedValue(
      'https://accounts.google.com/v3/signin/accountchooser',
    );
    mocks.page.evaluate.mockResolvedValue('unmatched');
    const result = await scan();
    expect(result).toMatchObject({
      outcome: 'needs-sign-in',
      message: expect.stringMatching(/sign in manually.*notes/i),
    });
    const { accountRequest } = await import('../../../lib/auth/main');
    expect(accountRequest).not.toHaveBeenCalled();
  });

  it('reports snapshot truncation rather than claiming the entire list was read', async () => {
    mocks.readPage.mockReset().mockResolvedValue({
      ...listPage,
      linksTruncated: true,
      links: Array.from({ length: 81 }, (_, index) => ({
        label: `Course ${index}`,
        url: `https://${host}/courses/${index}`,
      })),
    });
    expect(await scan()).toMatchObject({ outcome: 'courses', truncated: true });
  });

  it('does not call the classifier after the shared model budget is exhausted', async () => {
    const { accountRequest } = await import('../../../lib/auth/main');
    await scanConnection({
      connection,
      workspace,
      hosts: [host],
      notes: '',
      navigatePage: async () => undefined,
      isCurrent: () => true,
      signal: new AbortController().signal,
      reserveModelCall: () => false,
    });
    expect(accountRequest).not.toHaveBeenCalled();
  });

  it('does not treat a blocked background authentication request as a sign-in wall', async () => {
    mocks.readPage.mockReset().mockImplementation(async () => {
      const onBlocked = vi.mocked(protectMissionPage).mock.calls.at(-1)![3]!;
      onBlocked({
        host: 'accounts.google.com',
        resourceType: 'XHR',
        signInWall: true,
        mainFrame: true,
      });
      return listPage;
    });
    expect((await scan()).outcome).toBe('courses');
  });

  it('keeps list coverage when a child page encounters a sign-in wall', async () => {
    const result = await scan(async () => {
      const onBlocked = vi.mocked(protectMissionPage).mock.calls.at(-1)![3]!;
      onBlocked({
        host,
        resourceType: 'Document',
        signInWall: true,
        mainFrame: true,
      });
      return { childStatus: 'needs-sign-in' };
    });
    expect(result.outcome).toBe('courses');
    expect(result.followed).toEqual({ childStatus: 'needs-sign-in' });
  });

  it('hands the follow-up the page the course list was read from', async () => {
    let seenListUrl = '';
    const result = await scan(async (context) => {
      seenListUrl = context.observed?.url ?? '';
      return null;
    });
    expect(seenListUrl).toBe(listUrl);
    expect(result.entries).toContainEqual(
      expect.objectContaining({ url: courseUrl, role: 'course' }),
    );
  });

  it('still reports the course list page after the follow-up navigated away', async () => {
    const result = await scan(async (context) => {
      await context.openFrom(context.observed!, courseUrl);
      return null;
    });
    expect(mocks.navigations).toContain(courseUrl);
    expect(result.observed?.url).toBe(listUrl);
  });

  it('refuses to open a destination the observed page never exposed', async () => {
    await expect(
      scan((context) =>
        context.openFrom(context.observed!, 'https://evil.example/course'),
      ),
    ).rejects.toThrow('That link is no longer on the page.');
    expect(mocks.navigations).not.toContain('https://evil.example/course');
  });

  it('releases the page protection after the walk', async () => {
    await scan();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('releases the page protection after a failure too', async () => {
    mocks.readPage.mockReset().mockRejectedValue(new Error('page crashed'));
    const result = await scan();
    expect(result.outcome).toBe('blocked');
    expect(result.message).toBe('page crashed');
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('skips a connection whose saved page cannot be read', async () => {
    const result = await scanConnection({
      // A generic resource has no provider course list to fall back on.
      connection: {
        ...connection,
        kind: 'resource',
        url: `https://${host}/login`,
      },
      workspace,
      hosts: [host],
      notes: '',
      navigatePage: async () => undefined,
      isCurrent: () => true,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('skipped');
    expect(mocks.release).not.toHaveBeenCalled();
  });
});

it('classifies links beyond the old eighty-target cutoff in complete batches', async () => {
  const { accountRequest } = await import('../../../lib/auth/main');
  const links = Array.from({ length: 95 }, (_, index) => ({
    label: `Biology ${100 + index}`,
    url: `https://${host}/courses/${index}`,
  }));
  mocks.readPage.mockReset().mockResolvedValue({ ...listPage, links });
  vi.mocked(accountRequest).mockImplementation(async (_path, body) => ({
    courseTargetIds: (body as { targets: { id: string }[] }).targets.map(
      (target) => target.id,
    ),
  }));
  const result = await scan();
  expect(
    result.entries.filter((entry) => entry.role === 'course'),
  ).toHaveLength(95);
  expect(result.truncated).toBe(false);
});

beforeEach(() => configureBrowserPolicy(['login']));

it('settles asynchronous course content before taking the snapshot', async () => {
  await scan();
  expect(mocks.page.waitForLoadState).toHaveBeenCalledWith('networkidle', 6000);
  expect(mocks.page.waitForLoadState.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.readPage.mock.invocationCallOrder[0],
  );
});

it('returns to the saved course after account selection lands on the course list', async () => {
  let current = listUrl;
  const navigatePage = vi.fn(async (_page, url: string) => {
    if (navigatePage.mock.calls.length > 1) current = url;
  });
  mocks.page.url.mockImplementation(async () => current);
  mocks.readPage.mockImplementation(async () =>
    current === courseUrl ? coursePage : listPage,
  );
  const followed = vi.fn(async (context) => context.observed.url);
  const result = await scanConnection({
    connection,
    workspace,
    hosts: [host],
    notes: '',
    navigatePage,
    isCurrent: () => true,
    signal: new AbortController().signal,
    courseUrl,
    withCourseList: followed,
  });
  expect(result.followed).toBe(courseUrl);
  expect(navigatePage).toHaveBeenCalledTimes(2);
});

it('rejects a cached location outside the active course URL before navigation', async () => {
  const outsideCourseUrl = 'https://school.edu/courses/2/assignments';
  const location = {
    id: 'location-other-course',
    userId: 'student-1',
    connectionId: connection.id,
    courseId: 'course-1',
    purpose: 'assignments' as const,
    destinationUrl: outsideCourseUrl,
    parentUrl: courseUrl,
    recipe: null,
    label: 'Assignments',
    evidence: {
      sourceUrl: courseUrl,
      excerpts: ['Assignments'],
      targetIds: [],
    },
    status: 'verified' as const,
    destinationKind: 'collection' as const,
    observedAt: '2026-11-01T12:00:00.000Z',
    verifiedAt: '2026-11-01T12:00:00.000Z',
    failureCount: 0,
    lastFailureClass: null,
  };
  mocks.readPage.mockReset().mockResolvedValue(coursePage);

  await expect(
    scanConnection({
      connection,
      workspace,
      hosts: [host],
      notes: '',
      navigatePage: async (_page, url) => void mocks.navigations.push(url),
      isCurrent: () => true,
      signal: new AbortController().signal,
      courseUrl,
      locationScope: { userId: 'student-1', courseId: 'course-1' },
      withCourseList: async (context) => context.visitKnownLocation!(location),
    }),
  ).rejects.toMatchObject({ failureClass: 'wrong-course' });

  expect(mocks.navigations).not.toContain(outsideCourseUrl);
});

it('visits a scoped saved destination even when the current course root no longer links it', async () => {
  const destinationUrl = `${courseUrl}/assignments`;
  const location = {
    id: 'location-1',
    userId: 'student-1',
    connectionId: connection.id,
    courseId: 'course-1',
    purpose: 'assignments' as const,
    destinationUrl,
    parentUrl: courseUrl,
    recipe: null,
    label: 'Assignments',
    evidence: {
      sourceUrl: courseUrl,
      excerpts: ['Assignments'],
      targetIds: [],
    },
    status: 'verified' as const,
    destinationKind: 'collection' as const,
    observedAt: '2026-11-01T12:00:00.000Z',
    verifiedAt: '2026-11-01T12:00:00.000Z',
    failureCount: 0,
    lastFailureClass: null,
  };
  const cachedPage = {
    ...coursePage,
    url: destinationUrl,
    title: 'Assignments',
    text: 'Assignments',
  };
  mocks.readPage
    .mockReset()
    .mockResolvedValueOnce(coursePage)
    .mockResolvedValueOnce(cachedPage);

  const result = await scanConnection({
    connection,
    workspace,
    hosts: [host],
    notes: '',
    navigatePage: async (_page, url) => void mocks.navigations.push(url),
    isCurrent: () => true,
    signal: new AbortController().signal,
    courseUrl,
    locationScope: { userId: 'student-1', courseId: 'course-1' },
    withCourseList: async (context) => context.visitKnownLocation!(location),
  });

  expect(result.followed).toMatchObject({ url: destinationUrl });
  expect(mocks.navigations).toContain(destinationUrl);
});
