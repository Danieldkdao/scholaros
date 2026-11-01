import { describe, expect, it, vi } from 'vitest';
import { scanCourseCollection } from '../lib/course-content-scan';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';

const root = 'https://school.edu/courses/1';
const page = (
  url: string,
  links: ObservedPage['links'] = [],
  text = 'Course content Open overdue Submitted Closed Unknown Submitted essay Unknown work One detail Verified work Saved before stop Work',
): ObservedPage => ({ url, title: 'Biology', text: `${text} ${url}`, links });
const card = (
  title: string,
  sourceUrl: string,
  assignmentState = 'active-unsubmitted',
) => ({
  title,
  description: null,
  kind: 'assignment',
  state: assignmentState,
  due: null,
  availableFrom: null,
  availableUntil: null,
  pointsPossible: null,
  url: null,
  sourceId: null,
  resources: [],
  evidence: {
    sourceUrl,
    excerpts: [
      title === 'Late assignment'
        ? 'Late assignment'
        : title === 'Upcoming quiz'
          ? 'Upcoming quiz'
          : 'Course content',
    ],
    targetIds: [],
  },
});
const run = (
  request: (body: AgentRequestSchema) => Promise<unknown>,
  pages: Map<string, ObservedPage>,
  controller = new AbortController(),
) => {
  const openFrom = vi.fn(async (from: ObservedPage, url: string) => {
    expect(from.links.some((link) => link.url === url)).toBe(true);
    const next = pages.get(url);
    if (!next) throw new Error('The page could not be loaded.');
    return next;
  });
  return {
    openFrom,
    result: scanCourseCollection({
      from: pages.get(root)!,
      kind: 'assignments',
      host: 'school.edu',
      courseName: 'Biology',
      excludedUrls: [],
      notes: '',
      context: { openFrom, assertReadable: () => undefined },
      request,
      signal: controller.signal,
      isCurrent: () => true,
    }),
  };
};

describe('deep course content scanning', () => {
  it('follows nested modules and pagination beyond the old call budget without revisiting cycles', async () => {
    const pages = new Map(
      Array.from({ length: 16 }, (_, index) => {
        const url = index ? `${root}/modules/${index}` : root;
        return [
          url,
          page(url, [
            { label: 'Next module', url: `${root}/modules/${index + 1}` },
            { label: 'Course home', url: root },
          ]),
        ];
      }),
    );
    pages.get(`${root}/modules/15`)!.links = [{ label: 'Home', url: root }];
    const request = vi.fn(async (body) =>
      body.kind === 'choose'
        ? { operation: 'NAVIGATE', target: body.targets[0].id }
        : {
            assignments: [card(body.pages[0].url, body.pages[0].url)],
            coverage: 'complete',
          },
    );
    const { result, openFrom } = run(request, pages);
    expect(await result).toMatchObject({
      status: 'complete',
      items: expect.any(Array),
    });
    expect((await result).items).toHaveLength(16);
    expect(openFrom).toHaveBeenCalledTimes(15);
  });

  it('keeps only explicitly active and unsubmitted work, including overdue work still open', async () => {
    const request = vi.fn(async () => ({
      coverage: 'complete',
      assignments: [
        card('Open overdue', root),
        card('Submitted', root, 'submitted'),
        card('Closed', root, 'inactive'),
        card('Unknown', root, 'unknown'),
      ],
    }));
    const { result } = run(request, new Map([[root, page(root)]]));
    expect((await result).items.map((item) => item.title)).toEqual([
      'Open overdue',
    ]);
    expect((await result).status).toBe('partial');
  });

  it('accepts a verified empty active list so previously submitted work can retire', async () => {
    const { result } = run(
      vi.fn(async () => ({
        coverage: 'complete',
        assignments: [card('Submitted', root, 'submitted')],
      })),
      new Map([[root, page(root)]]),
    );
    expect(await result).toMatchObject({
      status: 'complete',
      items: [],
      inactiveItems: [expect.objectContaining({ title: 'Submitted' })],
    });
  });

  it.each(['active-unsubmitted', 'submitted', 'inactive', 'unknown'])(
    'verifies unknown work before accepting DONE when its detail reports %s',
    async (state) => {
      const savedUrl = `${root}/assignments/1`;
      const newUrl = `${root}/assignments/2`;
      const request = vi.fn(async (body: AgentRequestSchema) => {
        if (body.kind === 'choose') return { operation: 'DONE', target: null };
        if (body.pages[0].url === newUrl)
          return {
            coverage: 'detail',
            assignments: [
              { ...card('Unknown work', newUrl, state), url: newUrl },
            ],
          };
        return {
          coverage: 'partial',
          assignments: [
            {
              ...card('Open overdue', root),
              url: savedUrl,
              evidence: {
                sourceUrl: root,
                excerpts: ['Open overdue'],
                targetIds: ['1'],
              },
            },
            {
              ...card('Unknown work', root, 'unknown'),
              url: newUrl,
              evidence: {
                sourceUrl: root,
                excerpts: ['Unknown work'],
                targetIds: ['2'],
              },
            },
          ],
        };
      });
      const { result, openFrom } = run(
        request,
        new Map([
          [
            root,
            page(root, [
              { label: 'Open overdue', url: savedUrl },
              { label: 'Unknown work', url: newUrl },
            ]),
          ],
          [newUrl, page(newUrl)],
        ]),
      );
      expect((await result).items.map((item) => item.title)).toEqual(
        state === 'active-unsubmitted'
          ? ['Open overdue', 'Unknown work']
          : ['Open overdue'],
      );
      expect(openFrom).toHaveBeenCalledWith(expect.anything(), newUrl);
    },
  );

  it('lets the model finish and examines target batches beyond the first eighty', async () => {
    const links = Array.from({ length: 90 }, (_, index) => ({
      label: `Section ${index}`,
      url: `${root}/sections/${index}`,
    }));
    const request = vi.fn(async (body) =>
      body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : { coverage: 'complete', assignments: [] },
    );
    const { result, openFrom } = run(
      request,
      new Map([[root, page(root, links)]]),
    );
    expect(await result).toEqual({ status: 'partial', items: [] });
    expect(
      request.mock.calls.filter(([body]) => body.kind === 'choose'),
    ).toHaveLength(2);
    expect(openFrom).not.toHaveBeenCalled();
  });

  it('reads content after the old text cutoff and rejects invented sources', async () => {
    const request = vi.fn(async (body) => ({
      coverage: 'complete',
      assignments: body.pages[0].text.includes('Late assignment')
        ? [
            card('Late assignment', root),
            card('Invented', 'https://evil.example/'),
          ]
        : [],
    }));
    const { result } = run(
      request,
      new Map([[root, page(root, [], `${'a'.repeat(20000)} Late assignment`)]]),
    );
    expect((await result).items.map((item) => item.title)).toEqual([
      'Late assignment',
    ]);
    expect((await result).status).toBe('partial');
  });

  it('stops on cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      return { assignments: [], coverage: 'complete' };
    });
    const { result } = run(request, new Map([[root, page(root)]]), controller);
    await expect(result).rejects.toThrow();
  });
});

it('reports explicitly inactive assignments separately even when another item is uncertain', async () => {
  const { result } = run(
    vi.fn(async () => ({
      coverage: 'partial',
      assignments: [
        card('Submitted essay', root, 'submitted'),
        card('Unknown work', root, 'unknown'),
      ],
    })),
    new Map([[root, page(root)]]),
  );
  expect(await result).toMatchObject({
    status: 'partial',
    items: [],
    inactiveItems: [expect.objectContaining({ title: 'Submitted essay' })],
  });
});

it('continues through changing content disclosures without a navigation or depth cap', async () => {
  const revealContent = vi
    .fn()
    .mockResolvedValueOnce(page(root, [], 'Expanded module'))
    .mockResolvedValueOnce(page(root, [], 'More assignments loaded'))
    .mockResolvedValue(null);
  const request = vi.fn(async () => ({
    assignments: [],
    coverage: 'complete',
  }));
  const result = await scanCourseCollection({
    from: page(root),
    kind: 'assignments',
    host: 'school.edu',
    courseName: 'Biology',
    excludedUrls: [],
    notes: '',
    context: {
      assertReadable: () => undefined,
      openFrom: vi.fn(),
      revealContent,
    },
    request,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result.status).toBe('complete');
  expect(revealContent).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenCalledTimes(3);
});

it('does not claim a collection is complete after reading only an individual detail', async () => {
  const { result } = run(
    vi.fn(async () => ({
      assignments: [card('One detail', root)],
      coverage: 'detail',
    })),
    new Map([[root, page(root)]]),
  );
  expect(await result).toMatchObject({
    status: 'partial',
    items: [expect.objectContaining({ title: 'One detail' })],
  });
});

it('keeps verified findings partial when a deeper page fails', async () => {
  const request = vi.fn(async (body) =>
    body.kind === 'choose'
      ? { operation: 'NAVIGATE', target: '1' }
      : { coverage: 'complete', assignments: [card('Verified work', root)] },
  );
  const { result } = run(
    request,
    new Map([
      [root, page(root, [{ label: 'More', url: `${root}/unavailable` }])],
    ]),
  );
  expect(await result).toMatchObject({
    status: 'partial',
    items: [expect.objectContaining({ title: 'Verified work' })],
  });
});

it('excludes other courses and their descendants before offering navigation', async () => {
  const request = vi.fn(async () => ({
    coverage: 'complete',
    assignments: [],
  }));
  const other = 'https://school.edu/courses/2';
  const result = await scanCourseCollection({
    from: page(root, [
      { label: 'Other course assignments', url: `${other}/assignments` },
    ]),
    kind: 'assignments',
    host: 'school.edu',
    courseName: 'Biology',
    excludedUrls: [other],
    notes: '',
    context: { assertReadable: () => undefined, openFrom: vi.fn() },
    request,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result.status).toBe('complete');
  expect(request).toHaveBeenCalledOnce();
});

it('checkpoints extracted assignments before a later cancellation', async () => {
  const controller = new AbortController();
  const checkpoint = vi.fn();
  await expect(
    scanCourseCollection({
      from: page(root, [{ label: 'Details', url: `${root}/details` }]),
      kind: 'assignments',
      host: 'school.edu',
      courseName: 'Biology',
      excludedUrls: [],
      notes: '',
      context: { assertReadable: () => undefined, openFrom: vi.fn() },
      request: async (body) => {
        if (body.kind === 'choose') {
          controller.abort();
          throw new Error('Cancelled');
        }
        return {
          coverage: 'complete',
          assignments: [card('Saved before stop', root)],
        };
      },
      signal: controller.signal,
      isCurrent: () => true,
      onProgress: checkpoint,
    }),
  ).rejects.toThrow();
  expect(checkpoint).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'partial',
      items: [expect.objectContaining({ title: 'Saved before stop' })],
    }),
  );
});

it('reports checkpoint failures instead of silently turning a database failure into a partial scan', async () => {
  await expect(
    scanCourseCollection({
      from: page(root),
      kind: 'assignments',
      host: 'school.edu',
      courseName: 'Biology',
      excludedUrls: [],
      notes: '',
      context: { assertReadable: () => undefined, openFrom: vi.fn() },
      request: async () => ({
        coverage: 'complete',
        assignments: [card('Work', root)],
      }),
      signal: new AbortController().signal,
      isCurrent: () => true,
      onProgress: () => {
        throw new Error('Database is full');
      },
    }),
  ).rejects.toThrow('Database is full');
});

it('keeps upcoming evidence on the course home before opening the collection', async () => {
  const assignments = `${root}/assignments`;
  const { result } = run(
    async (body) =>
      body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : {
            coverage: body.pages[0].url === root ? 'partial' : 'complete',
            assignments:
              body.pages[0].url === root ? [card('Upcoming quiz', root)] : [],
          },
    new Map([
      [
        root,
        page(
          root,
          [{ label: 'Assignments', url: assignments }],
          'Upcoming quiz due tomorrow',
        ),
      ],
      [assignments, page(assignments)],
    ]),
  );
  expect((await result).items.map((item) => item.title)).toEqual([
    'Upcoming quiz',
  ]);
});

it('keeps a valid normalized assignment while a forged item prevents complete reconciliation', async () => {
  const due = {
    kind: 'local',
    date: '2026-10-31',
    time: '23:59',
    original: 'October 31 at 11:59 PM',
  };
  const observed = page(root, [], 'Lab report due October 31 at 11:59 PM');
  const assignment = {
    title: 'Lab report',
    description: 'Write the report',
    kind: 'assignment',
    state: 'active-unsubmitted',
    due,
    availableFrom: null,
    availableUntil: null,
    pointsPossible: null,
    url: null,
    sourceId: null,
    resources: [],
    evidence: { sourceUrl: root, excerpts: ['Lab report'], targetIds: [] },
  };
  const result = await scanCourseCollection({
    from: observed,
    kind: 'assignments',
    host: 'school.edu',
    courseName: 'Biology',
    excludedUrls: [],
    notes: '',
    context: { assertReadable: () => undefined, openFrom: vi.fn() },
    request: async () => ({
      assignments: [
        assignment,
        {
          ...assignment,
          evidence: {
            ...assignment.evidence,
            sourceUrl: 'https://evil.example',
          },
        },
      ],
      coverage: 'complete',
    }),
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(result.status).toBe('partial');
  expect(result.items).toHaveLength(1);
  expect(result.items[0].content).toMatchObject({ due });
  expect(result.items[0].dateValue).toBeNull();
});
