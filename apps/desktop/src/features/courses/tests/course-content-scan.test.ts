import { describe, expect, it, vi } from 'vitest';
import { scanCourseCollection } from '../lib/course-content-scan';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';

const root = 'https://school.edu/courses/1';
const page = (
  url: string,
  links: ObservedPage['links'] = [],
  text = 'Course content',
): ObservedPage => ({ url, title: 'Biology', text, links });
const card = (
  title: string,
  sourceUrl: string,
  assignmentState = 'active-unsubmitted',
) => ({
  kind: 'assignment',
  title,
  sourceUrl,
  course: null,
  detail: null,
  date: null,
  assignmentState,
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
            cards: [card(body.pages[0].url, body.pages[0].url)],
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
      cards: [
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
        cards: [card('Submitted', root, 'submitted')],
      })),
      new Map([[root, page(root)]]),
    );
    expect(await result).toMatchObject({
      status: 'complete',
      items: [],
      inactiveItems: [expect.objectContaining({ title: 'Submitted' })],
    });
  });

  it('lets the model finish and examines target batches beyond the first eighty', async () => {
    const links = Array.from({ length: 90 }, (_, index) => ({
      label: `Section ${index}`,
      url: `${root}/sections/${index}`,
    }));
    const request = vi.fn(async (body) =>
      body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : { coverage: 'complete', cards: [] },
    );
    const { result, openFrom } = run(
      request,
      new Map([[root, page(root, links)]]),
    );
    expect(await result).toEqual({ status: 'complete', items: [] });
    expect(
      request.mock.calls.filter(([body]) => body.kind === 'choose'),
    ).toHaveLength(2);
    expect(openFrom).not.toHaveBeenCalled();
  });

  it('reads content after the old text cutoff and rejects invented sources', async () => {
    const request = vi.fn(async (body) => ({
      coverage: 'complete',
      cards: body.pages[0].text.includes('Late assignment')
        ? [
            card('Found at end', root),
            card('Invented', 'https://evil.example/'),
          ]
        : [],
    }));
    const { result } = run(
      request,
      new Map([[root, page(root, [], `${'a'.repeat(20000)} Late assignment`)]]),
    );
    expect((await result).items.map((item) => item.title)).toEqual([
      'Found at end',
    ]);
    expect((await result).status).toBe('partial');
  });

  it('stops on cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      return { cards: [], coverage: 'complete' };
    });
    const { result } = run(request, new Map([[root, page(root)]]), controller);
    await expect(result).rejects.toThrow();
  });
});

it('reports explicitly inactive assignments separately even when another item is uncertain', async () => {
  const { result } = run(
    vi.fn(async () => ({
      coverage: 'partial',
      cards: [
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
  const request = vi.fn(async () => ({ cards: [], coverage: 'complete' }));
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
      cards: [card('One detail', root)],
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
      : { coverage: 'complete', cards: [card('Verified work', root)] },
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
  const request = vi.fn(async () => ({ coverage: 'complete', cards: [] }));
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
          cards: [card('Saved before stop', root)],
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
        cards: [card('Work', root)],
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
            cards:
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
