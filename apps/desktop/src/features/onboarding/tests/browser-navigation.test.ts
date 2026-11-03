// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountRequest: vi.fn(),
  waitForTurn: vi.fn(),
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: mocks.accountRequest,
}));
vi.mock('../services/browser-mode', () => ({
  toBrowserCapabilityError: (error: unknown) => error,
}));
vi.mock('../services/mission-traffic', () => ({
  missionTraffic: {
    waitForTurn: mocks.waitForTurn,
    runTurn: async (
      url: string,
      signal: AbortSignal,
      action: () => Promise<unknown>,
      onWait: unknown,
    ) => {
      await mocks.waitForTurn(url, signal, onWait);
      return action();
    },
  },
}));

import { createBrowserNavigationAdapter } from '../services/browser-navigation';
import { academicPageIdentity, isReadNavigation } from '../lib/browser-policy';

const target = {
  id: '1',
  label: 'Assignments',
  url: 'https://canvas.school.edu/courses/1/assignments',
};
const pageEvidence = {
  url: 'https://canvas.school.edu/courses/1',
  title: 'Biology',
  text: 'Assignments',
};
const courseScope = {
  courseUrl: pageEvidence.url,
  observedResourceRelationships: [],
};
const memory = {
  navigation: 'Assignments live under Weekly Work',
  resources: [],
  truncated: false,
};

const action = {
  selector: '#assignments-link',
  description: 'Open assignments',
  method: 'click',
  arguments: [],
};

const createPage = () => ({
  url: vi.fn(async () => pageEvidence.url),
  evaluate: vi.fn(async () => ({
    url: target.url,
  })),
  waitForLoadState: vi.fn(async () => undefined),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountRequest.mockResolvedValue({
    assignments: [],
    coverage: 'complete',
  });
  mocks.waitForTurn.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('shared browser navigation adapters', () => {
  it.each(['xpath=//a[@id="assignments-link"]', '//a[@id="assignments-link"]'])(
    'inspects a supported Stagehand XPath action %s',
    async (selector) => {
      document.body.innerHTML = `<a id="assignments-link" href="${target.url}">Assignments</a>`;
      vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
        { width: 100, height: 20 },
      ] as never);
      const page = createPage();
      page.evaluate = vi.fn(
        async (read: (argument: unknown) => unknown, argument: unknown) =>
          read(argument),
      ) as never;
      const stagehand = {
        observe: vi.fn(async () => ({ data: [{ ...action, selector }] })),
        act: vi.fn(async (_action: unknown, options: unknown) => {
          page.url.mockResolvedValue(target.url);
          expect(options).toEqual({ page });
          return { data: { success: true } };
        }),
      };
      const adapter = createBrowserNavigationAdapter('inout', {
        page: page as never,
        stagehand: stagehand as never,
        hosts: ['canvas.school.edu'],
        signal: new AbortController().signal,
        isCurrent: () => true,
        assertReadable: () => undefined,
        courseScope,
      });
      try {
        const choice = await adapter.choose({
          goal: 'Find assignments',
          notes: '',
          memory,
          pages: [pageEvidence],
          targets: [target],
        });
        expect(choice).toMatchObject({
          operation: 'NAVIGATE',
          target: '1',
          navigationHandled: true,
        });
        expect(stagehand.act).toHaveBeenCalledOnce();
        expect(stagehand.observe).toHaveBeenCalledWith(
          expect.stringContaining(JSON.stringify(memory)),
          { page },
        );
      } finally {
        document.body.replaceChildren();
      }
    },
  );

  it('uses the bounded decision response and shared resource validation', async () => {
    const signal = new AbortController().signal;
    const adapter = createBrowserNavigationAdapter('decision', {
      page: createPage() as never,
      signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
      courseScope,
    });
    mocks.accountRequest.mockResolvedValueOnce({
      operation: 'NAVIGATE',
      target: '1',
    });

    await expect(
      adapter.choose({
        goal: 'Find assignments',
        notes: '',
        pages: [pageEvidence],
        targets: [target],
        memory,
      }),
    ).resolves.toEqual({ operation: 'NAVIGATE', target: '1' });
    await expect(
      adapter.extract({
        kind: 'assignments',
        goal: 'Extract assignments',
        notes: '',
        pages: [pageEvidence],
      }),
    ).resolves.toEqual({ assignments: [], coverage: 'complete' });
    expect(mocks.accountRequest).toHaveBeenCalledTimes(2);
    expect(mocks.accountRequest).toHaveBeenCalledWith(
      '/api/agent',
      expect.objectContaining({
        kind: 'assignments',
        browserNavigationMode: 'decision',
      }),
      signal,
    );
    expect(mocks.accountRequest).toHaveBeenCalledWith(
      '/api/agent',
      expect.objectContaining({
        kind: 'choose',
        memory,
        browserNavigationMode: 'decision',
      }),
      signal,
    );
  });

  it('classifies only offered course targets in decision mode', async () => {
    mocks.accountRequest.mockResolvedValueOnce({ courseTargetIds: ['1'] });
    const courseListPage = {
      ...pageEvidence,
      url: 'https://canvas.school.edu/courses',
      title: 'Courses',
    };
    const page = createPage();
    page.url.mockResolvedValue(courseListPage.url);
    const adapter = createBrowserNavigationAdapter('decision', {
      page: page as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
    });

    await expect(
      adapter.discoverCourses({
        goal: 'Find enrolled courses',
        notes: '',
        pages: [courseListPage],
        targets: [target],
      }),
    ).resolves.toEqual(['1']);
    expect(mocks.accountRequest).toHaveBeenCalledWith(
      '/api/agent',
      expect.objectContaining({
        kind: 'discover',
        targets: [target],
        browserNavigationMode: 'decision',
      }),
      expect.any(AbortSignal),
    );
  });

  it('filters non-read targets before course discovery inference', async () => {
    const courseListPage = {
      ...pageEvidence,
      url: 'https://canvas.school.edu/courses',
      title: 'Courses',
    };
    const page = createPage();
    page.url.mockResolvedValue(courseListPage.url);
    const adapter = createBrowserNavigationAdapter('decision', {
      page: page as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
    });

    await expect(
      adapter.discoverCourses({
        goal: 'Find enrolled courses',
        notes: '',
        pages: [courseListPage],
        targets: [
          {
            id: 'unsafe',
            label: 'Course action',
            url: 'https://canvas.school.edu/courses/101/delete',
          },
        ],
      }),
    ).resolves.toEqual([]);
    expect(mocks.accountRequest).not.toHaveBeenCalled();
  });

  it('inspects and paces one safe Stagehand link click on the explicit page', async () => {
    expect(isReadNavigation(target.url, ['canvas.school.edu'])).toBe(true);
    expect(academicPageIdentity(target.url)).toBe(target.url);
    expect(academicPageIdentity(pageEvidence.url)).not.toBe(
      academicPageIdentity(target.url),
    );
    const page = createPage();
    const stagehand = {
      observe: vi.fn(async (_instruction: string, options: unknown) => {
        expect(options).toEqual({ page });
        return { data: [action] };
      }),
      act: vi.fn(async (_action: unknown, options: unknown) => {
        page.url.mockResolvedValue(target.url);
        expect(options).toEqual({ page });
        return { data: { success: true } };
      }),
      extract: vi.fn(),
    };
    const adapter = createBrowserNavigationAdapter('inout', {
      page: page as never,
      stagehand: stagehand as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
      courseScope,
    });

    const choice = await adapter.choose({
      goal: 'Find assignments',
      notes: '',
      pages: [pageEvidence],
      targets: [target],
    });
    expect(mocks.waitForTurn).toHaveBeenCalledOnce();
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(stagehand.act).toHaveBeenCalledOnce();
    expect(choice).toEqual({
      operation: 'NAVIGATE',
      target: '1',
      navigationHandled: true,
    });
    expect(mocks.waitForTurn).toHaveBeenCalledWith(
      target.url,
      expect.any(AbortSignal),
      undefined,
    );
  });

  it.each([
    { ...action, method: 'type' },
    { ...action, arguments: ['secret'] },
  ])('refuses an unapproved Stagehand action', async (unsafeAction) => {
    const page = createPage();
    const stagehand = {
      observe: vi.fn(async () => ({ data: [unsafeAction] })),
      act: vi.fn(),
      extract: vi.fn(),
    };
    const adapter = createBrowserNavigationAdapter('inout', {
      page: page as never,
      stagehand: stagehand as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
      courseScope,
    });

    await expect(
      adapter.choose({
        goal: 'Find assignments',
        notes: '',
        pages: [pageEvidence],
        targets: [target],
      }),
    ).resolves.toEqual({ operation: 'BLOCKED', target: null });
    expect(stagehand.act).not.toHaveBeenCalled();
  });

  it('refuses a safe looking click when its destination is outside the offered targets', async () => {
    const page = createPage();
    page.evaluate.mockResolvedValue({
      url: 'https://outside.example/assignments',
    });
    const stagehand = {
      observe: vi.fn(async () => ({ data: [action] })),
      act: vi.fn(),
      extract: vi.fn(),
    };
    const adapter = createBrowserNavigationAdapter('inout', {
      page: page as never,
      stagehand: stagehand as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
      courseScope,
    });

    await expect(
      adapter.choose({
        goal: 'Find assignments',
        notes: '',
        pages: [pageEvidence],
        targets: [target],
      }),
    ).resolves.toEqual({ operation: 'BLOCKED', target: null });
    expect(mocks.waitForTurn).not.toHaveBeenCalled();
    expect(stagehand.act).not.toHaveBeenCalled();
  });

  it('extracts with the explicit page and runs the shared evidence validator', async () => {
    const page = createPage();
    const output = { assignments: [], coverage: 'complete' };
    const stagehand = {
      observe: vi.fn(),
      act: vi.fn(),
      extract: vi.fn(
        async (_instruction: string, _schema: unknown, options: unknown) => {
          expect(options).toEqual({ page });
          return { data: output };
        },
      ),
    };
    const adapter = createBrowserNavigationAdapter('inout', {
      page: page as never,
      stagehand: stagehand as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
      courseScope,
    });

    await expect(
      adapter.extract({
        kind: 'assignments',
        goal: 'Extract current assignments',
        notes: '',
        pages: [pageEvidence],
        targets: [target],
      }),
    ).resolves.toEqual(output);
    expect(stagehand.extract).toHaveBeenCalledOnce();
    expect(stagehand.extract).toHaveBeenCalledWith(
      expect.stringContaining('Extract only verified assignments'),
      expect.any(Object),
      { page },
    );
    expect(stagehand.extract).toHaveBeenCalledWith(
      expect.stringContaining('1 | Assignments'),
      expect.any(Object),
      { page },
    );
  });

  it('rejects extraction when the explicit page no longer matches its evidence', async () => {
    const page = createPage();
    page.url.mockReset();
    page.url.mockResolvedValue(`${pageEvidence.url}/assignments`);
    const stagehand = {
      observe: vi.fn(),
      act: vi.fn(),
      extract: vi.fn(),
    };
    const adapter = createBrowserNavigationAdapter('inout', {
      page: page as never,
      stagehand: stagehand as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
      courseScope,
    });

    await expect(
      adapter.extract({
        kind: 'assignments',
        goal: 'Extract current assignments',
        notes: '',
        pages: [pageEvidence],
      }),
    ).rejects.toThrow('The current page changed before browser inference.');
    expect(stagehand.extract).not.toHaveBeenCalled();
  });

  it('classifies offered course targets from the explicit Stagehand page', async () => {
    const page = createPage();
    const courseListPage = {
      ...pageEvidence,
      url: 'https://canvas.school.edu/courses',
      title: 'Courses',
    };
    page.url.mockResolvedValue(courseListPage.url);
    const stagehand = {
      observe: vi.fn(),
      act: vi.fn(),
      extract: vi.fn(
        async (_instruction: string, _schema: unknown, options: unknown) => {
          expect(options).toEqual({ page });
          return { data: { courseTargetIds: ['1'] } };
        },
      ),
    };
    const adapter = createBrowserNavigationAdapter('inout', {
      page: page as never,
      stagehand: stagehand as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
    });

    await expect(
      adapter.discoverCourses({
        goal: 'Find enrolled courses',
        notes: '',
        pages: [courseListPage],
        targets: [target],
      }),
    ).resolves.toEqual(['1']);
    expect(stagehand.extract).toHaveBeenCalledOnce();
    expect(stagehand.extract).toHaveBeenCalledWith(
      expect.stringContaining('1 | Assignments'),
      expect.any(Object),
      { page },
    );
  });

  it('filters same-host sibling-course targets before decision or inout inference', async () => {
    const siblingTarget = {
      id: 'sibling',
      label: 'Assignments',
      url: 'https://canvas.school.edu/courses/202/assignments',
    };
    const courseScope = {
      courseUrl: 'https://canvas.school.edu/courses/101',
      observedResourceRelationships: [],
    };
    const page = {
      url: vi.fn(async () => courseScope.courseUrl),
      evaluate: vi.fn(),
      waitForLoadState: vi.fn(),
    };
    const decision = createBrowserNavigationAdapter('decision', {
      page: page as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
      courseScope,
    });
    const inoutStagehand = {
      observe: vi.fn(),
      act: vi.fn(),
      extract: vi.fn(),
    };
    const inout = createBrowserNavigationAdapter('inout', {
      page: page as never,
      stagehand: inoutStagehand as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
      courseScope,
    });

    await expect(
      decision.choose({
        goal: 'Find assignments',
        notes: '',
        pages: [{ ...pageEvidence, url: courseScope.courseUrl }],
        targets: [siblingTarget],
      }),
    ).resolves.toEqual({ operation: 'BLOCKED', target: null });
    await expect(
      inout.choose({
        goal: 'Find assignments',
        notes: '',
        pages: [{ ...pageEvidence, url: courseScope.courseUrl }],
        targets: [siblingTarget],
      }),
    ).resolves.toEqual({ operation: 'BLOCKED', target: null });
    expect(mocks.accountRequest).not.toHaveBeenCalled();
    expect(inoutStagehand.observe).not.toHaveBeenCalled();
  });

  it('blocks resource extraction before inference when course proof is absent', async () => {
    const courseUrl = 'https://canvas.school.edu/courses/101';
    const page = {
      url: vi.fn(async () => courseUrl),
      evaluate: vi.fn(),
      waitForLoadState: vi.fn(),
    };
    const adapter = createBrowserNavigationAdapter('decision', {
      page: page as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu'],
      assertReadable: () => undefined,
    });

    await expect(
      adapter.choose({
        goal: 'Find assignments',
        notes: '',
        pages: [{ ...pageEvidence, url: courseUrl }],
        targets: [
          {
            id: 'sibling',
            label: 'Assignments',
            url: 'https://canvas.school.edu/courses/202/assignments',
          },
        ],
      }),
    ).resolves.toEqual({ operation: 'BLOCKED', target: null });
    await expect(
      adapter.extract({
        kind: 'assignments',
        goal: 'Extract assignments',
        notes: '',
        pages: [{ ...pageEvidence, url: courseUrl }],
        context: {
          retrievedAt: new Date().toISOString(),
          observedTimezone: null,
          locale: null,
          courseUrl,
          courseName: 'Biology 101',
          truncated: false,
        },
      }),
    ).rejects.toThrow(/course/i);
    expect(mocks.accountRequest).not.toHaveBeenCalled();
  });

  it('allows an observed external resource relationship in course-scoped navigation', async () => {
    const courseUrl = 'https://canvas.school.edu/courses/101';
    const externalTarget = {
      id: '1',
      label: 'Lab guide',
      url: 'https://docs.example.edu/biology/lab-guide',
    };
    mocks.accountRequest.mockResolvedValueOnce({
      operation: 'NAVIGATE',
      target: '1',
    });
    const adapter = createBrowserNavigationAdapter('decision', {
      page: { url: vi.fn(async () => courseUrl) } as never,
      signal: new AbortController().signal,
      isCurrent: () => true,
      hosts: ['canvas.school.edu', 'docs.example.edu'],
      assertReadable: () => undefined,
      courseScope: {
        courseUrl,
        observedResourceRelationships: [
          { parentUrl: courseUrl, targetUrl: externalTarget.url },
        ],
      },
    });

    await expect(
      adapter.choose({
        goal: 'Find course materials',
        notes: '',
        pages: [{ ...pageEvidence, url: courseUrl }],
        targets: [externalTarget],
      }),
    ).resolves.toEqual({ operation: 'NAVIGATE', target: '1' });
    expect(mocks.accountRequest).toHaveBeenCalledWith(
      '/api/agent',
      expect.objectContaining({ targets: [externalTarget] }),
      expect.any(AbortSignal),
    );
  });
});
