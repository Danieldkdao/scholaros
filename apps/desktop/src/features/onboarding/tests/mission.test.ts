import { configureBrowserPolicy } from '../lib/browser-policy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runReadOnlyMission } from '../services/mission';
import type { AcademicConnection } from '../types';

const hosts = ['canvas.school.edu'];

const connection: AcademicConnection = {
  id: 'connection',
  name: 'Canvas',
  url: 'https://canvas.school.edu/courses',
  host: 'canvas.school.edu',
  kind: 'canvas',
  status: 'verified',
  verifiedAt: null,
  notes: null,
  favicon: null,
  isCourseResource: false,
};

type PageState = {
  title: string;
  text: string;
  links: Array<{ label: string; url: string }>;
  password?: boolean;
};

const createHarness = (
  states: Record<string, PageState>,
  search: Record<string, string | null>,
) => {
  let current = 'https://canvas.school.edu/courses';
  const read = vi.fn(async () => ({
    url: current,
    title: states[current]?.title ?? 'Untitled',
    text: states[current]?.text ?? '',
    links: states[current]?.links ?? [],
    password: states[current]?.password ?? false,
  }));
  const waitForReady = vi.fn(async () => undefined);
  const page = {
    goto: vi.fn(async (url: string) => {
      current = url;
      return null;
    }),
    url: vi.fn(async () => current),
  };
  const choose = vi.fn(
    async (
      _evidence: unknown,
      targets: Array<{ id: string; url: string; label: string }>,
    ) => {
      const targetUrl = search[current] ?? null;
      if (!targetUrl) return { operation: 'DONE' as const, target: null };
      const target = targets.find((item) => item.url === targetUrl);
      if (!target) throw new Error('Missing target');
      return { operation: 'NAVIGATE' as const, target: target.id };
    },
  );
  const addActivity = vi.fn();
  const setCurrentUrl = (url: string) => {
    current = url;
  };
  return { page, read, waitForReady, choose, addActivity, setCurrentUrl };
};

describe('read-only mission', () => {
  it('does not repeat a navigation already completed by the inout adapter', async () => {
    const origin = 'https://canvas.school.edu/courses';
    const destination = 'https://canvas.school.edu/courses/1';
    const harness = createHarness(
      {
        [origin]: {
          title: 'Courses',
          text: 'Biology',
          links: [{ label: 'Biology', url: destination }],
        },
        [destination]: { title: 'Biology', text: 'Assignments', links: [] },
      },
      {},
    );
    harness.choose.mockImplementationOnce(async () => {
      harness.setCurrentUrl(destination);
      return {
        operation: 'NAVIGATE' as const,
        target: '1',
        navigationHandled: true,
      };
    });

    const result = await runReadOnlyMission({
      connection: { ...connection, url: origin },
      hosts,
      page: harness.page,
      read: harness.read,
      waitForReady: harness.waitForReady,
      choose: harness.choose,
      addActivity: harness.addActivity,
      signal: new AbortController().signal,
    });

    expect(harness.page.goto).toHaveBeenCalledTimes(1);
    expect(result.evidence.map((page) => page.url)).toContain(destination);
  });

  it('waits for delayed provider content before reading', async () => {
    const harness = createHarness(
      {
        'https://canvas.school.edu/courses': {
          title: 'Courses',
          text: 'Biology 101',
          links: [],
        },
      },
      {},
    );
    let loaded = false;
    harness.read.mockImplementation(async () => {
      if (!loaded) throw new Error('Read before content loaded');
      return {
        url: 'https://canvas.school.edu/courses',
        title: 'Courses',
        text: 'Biology 101',
        links: [],
        password: false,
      };
    });
    harness.waitForReady.mockImplementation(async () => {
      await Promise.resolve();
      loaded = true;
    });

    const result = await runReadOnlyMission({
      connection,
      hosts,
      page: harness.page,
      read: harness.read,
      waitForReady: harness.waitForReady,
      choose: harness.choose,
      addActivity: harness.addActivity,
      signal: new AbortController().signal,
    });

    expect(harness.waitForReady).toHaveBeenCalledOnce();
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.text).toBe('Biology 101');
    expect(result.outcome).toBe('empty');
  });

  it('observes the final permitted destination before extraction', async () => {
    const harness = createHarness(
      {
        'https://canvas.school.edu/courses': {
          title: 'Courses',
          text: 'Course list',
          links: [
            {
              label: 'Biology 101',
              url: 'https://canvas.school.edu/courses/1',
            },
          ],
        },
        'https://canvas.school.edu/courses/1': {
          title: 'Biology 101',
          text: 'Week one',
          links: [
            {
              label: 'Assignments',
              url: 'https://canvas.school.edu/courses/1/assignments',
            },
          ],
        },
        'https://canvas.school.edu/courses/1/assignments': {
          title: 'Assignments',
          text: 'Lab report due May 3',
          links: [],
        },
      },
      {
        'https://canvas.school.edu/courses':
          'https://canvas.school.edu/courses/1',
        'https://canvas.school.edu/courses/1':
          'https://canvas.school.edu/courses/1/assignments',
      },
    );

    const result = await runReadOnlyMission({
      connection,
      hosts,
      page: harness.page,
      read: harness.read,
      waitForReady: harness.waitForReady,
      choose: harness.choose,
      addActivity: harness.addActivity,
      signal: new AbortController().signal,
      maxSteps: 2,
    });

    expect(result.outcome).toBe('budget');
    expect(result.evidence.map((page) => page.url)).toContain(
      'https://canvas.school.edu/courses/1/assignments',
    );
    expect(result.evidence.at(-1)?.text).toBe('Lab report due May 3');
    // Each page is read once for evidence and once to confirm its links are fresh.
    expect(harness.read.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('stops while waiting for a page when the mission is cancelled', async () => {
    const harness = createHarness(
      {
        'https://canvas.school.edu/courses': {
          title: 'Courses',
          text: 'Biology 101',
          links: [],
        },
      },
      {},
    );
    const controller = new AbortController();
    harness.waitForReady.mockImplementation(
      () =>
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const mission = runReadOnlyMission({
      connection,
      hosts,
      page: harness.page,
      read: harness.read,
      waitForReady: harness.waitForReady,
      choose: harness.choose,
      addActivity: harness.addActivity,
      signal: controller.signal,
    });
    controller.abort();

    await expect(mission).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.read).not.toHaveBeenCalled();
  });

  it('reports a truly empty resource as empty', async () => {
    const harness = createHarness(
      {
        'https://canvas.school.edu/courses': {
          title: 'Courses',
          text: '',
          links: [],
        },
      },
      {},
    );

    const result = await runReadOnlyMission({
      connection,
      hosts,
      page: harness.page,
      read: harness.read,
      waitForReady: harness.waitForReady,
      choose: harness.choose,
      addActivity: harness.addActivity,
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe('empty');
    expect(result.evidence).toHaveLength(1);
    expect(harness.choose).not.toHaveBeenCalled();
  });

  it('rejects a browser error page before using its content', async () => {
    const harness = createHarness(
      {
        'https://canvas.school.edu/courses': {
          title: 'This site can’t be reached',
          text: 'A long browser error explanation that must not reach a model.',
          links: [],
        },
      },
      {},
    );
    harness.read.mockImplementation(async () => ({
      url: 'https://canvas.school.edu/courses',
      title: 'This site can’t be reached',
      text: 'A long browser error explanation that must not reach a model.',
      links: [],
      password: false,
      error: true,
    }));

    await expect(
      runReadOnlyMission({
        connection,
        hosts,
        page: harness.page,
        read: harness.read,
        waitForReady: harness.waitForReady,
        choose: harness.choose,
        addActivity: harness.addActivity,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('couldn’t load');
    expect(harness.choose).not.toHaveBeenCalled();
  });

  it('rejects a redirect to a sign-in page before reading its content', async () => {
    let current = 'https://canvas.school.edu/courses';
    const read = vi.fn(async () => ({
      url: current,
      title: 'Sign in',
      text: 'Secret password form content',
      links: [],
      password: true,
    }));
    const page = {
      goto: vi.fn(async () => {
        current = 'https://canvas.school.edu/login';
        return null;
      }),
      url: vi.fn(async () => current),
    };

    await expect(
      runReadOnlyMission({
        connection,
        hosts,
        page,
        read,
        waitForReady: vi.fn(async () => undefined),
        choose: vi.fn(),
        addActivity: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('read-only course area');
    expect(read).not.toHaveBeenCalled();
  });
});

it('re-observes disclosed course navigation before asking the decision model', async () => {
  const url = 'https://canvas.school.edu/courses';
  const states: Record<string, PageState> = {
    [url]: { title: 'Home', text: 'Open Courses', links: [] },
    'https://canvas.school.edu/courses/1': {
      title: 'Biology',
      text: 'Biology 101',
      links: [],
    },
  };
  const harness = createHarness(states, {
    [url]: 'https://canvas.school.edu/courses/1',
  });
  const disclose = vi.fn(async () => {
    states[url].links = [
      { label: 'Biology 101', url: 'https://canvas.school.edu/courses/1' },
    ];
    states[url].text = 'Biology 101';
    return 'opened' as const;
  });
  const result = await runReadOnlyMission({
    ...harness,
    connection,
    hosts: [connection.host],
    signal: new AbortController().signal,
    disclose,
  });
  expect(disclose).toHaveBeenCalled();
  expect(harness.page.goto).toHaveBeenCalledWith(
    'https://canvas.school.edu/courses/1',
    expect.any(Object),
  );
  expect(result.evidence.find((page) => page.url === url)?.text).toBe(
    'Biology 101',
  );
});

it('does not revisit the connected home URL after its redirect', async () => {
  const host = 'redirected.example';
  const root = `https://${host}/`;
  const courses = `https://${host}/courses`;
  let current = root;
  const page = {
    goto: vi.fn(async (url: string) => {
      current = url === root ? `https://${host}/home` : url;
    }),
    url: async () => current,
  };
  const read = async () => ({
    url: current,
    title: 'Home',
    text: 'Courses',
    password: false,
    links:
      current === courses
        ? []
        : [
            { label: 'Home', url: root },
            { label: 'Courses', url: courses },
          ],
  });
  await runReadOnlyMission({
    connection: { ...connection, host, url: root, kind: 'resource' },
    hosts: [host],
    page,
    read,
    waitForReady: async () => undefined,
    choose: async (_pages, targets) => ({
      operation: 'NAVIGATE',
      target: targets[0].id,
    }),
    signal: new AbortController().signal,
    addActivity: () => undefined,
  });
  expect(page.goto.mock.calls.map(([url]) => url)).toEqual([root, courses]);
});

beforeEach(() => configureBrowserPolicy(['login']));
