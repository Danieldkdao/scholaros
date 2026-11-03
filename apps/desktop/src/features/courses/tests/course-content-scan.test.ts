import { describe, expect, it, vi } from 'vitest';
import { scanCourseCollection } from '../lib/course-content-scan';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { BrowserNavigationAdapter } from '../../onboarding/services/browser-navigation';

const root = 'https://school.edu/courses/1';
const page = (
  url: string,
  links: ObservedPage['links'] = [],
  text = 'Course content Open overdue Submitted Closed Unknown Submitted essay Unknown work One detail Verified work Saved before stop Work',
  title = 'Biology',
): ObservedPage => ({ url, title, text: `${text} ${url}`, links });
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
    excerpts: [title],
    targetIds: [],
  },
});
const run = (
  request: (body: AgentRequestSchema) => Promise<unknown>,
  pages: Map<string, ObservedPage>,
  controller = new AbortController(),
  options: {
    knownNavigationLocations?: Array<{
      purpose: 'assignments' | 'announcements';
      destinationUrl: string;
      status: 'tentative' | 'verified' | 'stale';
      destinationKind: 'summary' | 'collection' | 'detail';
    }>;
    onNavigationVerified?: (location: unknown) => void;
    onModelCall?: () => void;
    onError?: (message: string) => void;
    navigation?: BrowserNavigationAdapter;
    readCurrent?: () => Promise<ObservedPage>;
  } = {},
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
      context: {
        openFrom,
        assertReadable: () => undefined,
        ...(options.readCurrent ? { readCurrent: options.readCurrent } : {}),
        ...(options.navigation ? { navigation: options.navigation } : {}),
      },
      request,
      signal: controller.signal,
      isCurrent: () => true,
      ...options,
    }),
  };
};

describe('deep course content scanning', () => {
  it('reports an extraction failure while preserving a blocked scan result', async () => {
    const onError = vi.fn();
    const { result } = run(
      async () => {
        throw new Error('The browser response schema is unsupported.');
      },
      new Map([[root, page(root)]]),
      new AbortController(),
      { onError },
    );
    expect(await result).toMatchObject({ status: 'blocked', items: [] });
    expect(onError).toHaveBeenCalledWith(
      'The browser response schema is unsupported.',
    );
  });
  it('uses a remembered verified collection link before asking the model to navigate', async () => {
    const rememberedUrl = `${root}/modules/work`;
    const assignmentUrl = `${rememberedUrl}/123`;
    const onNavigationVerified = vi.fn();
    const request = vi.fn(async (body: AgentRequestSchema) => {
      if (body.kind === 'choose') return { operation: 'DONE', target: null };
      if (body.pages[0].url === rememberedUrl) {
        const target = body.targets?.find((item) => item.url === assignmentUrl);
        return {
          coverage: 'complete',
          assignments: [
            {
              ...card('Worksheet 1', rememberedUrl),
              url: assignmentUrl,
              evidence: {
                sourceUrl: rememberedUrl,
                excerpts: ['Worksheet 1'],
                targetIds: target ? [target.id] : [],
              },
            },
          ],
        };
      }
      return { coverage: 'partial', assignments: [] };
    });
    const { result, openFrom } = run(
      request,
      new Map([
        [root, page(root, [{ label: 'Work folder', url: rememberedUrl }])],
        [
          rememberedUrl,
          page(
            rememberedUrl,
            [{ label: 'Worksheet 1', url: assignmentUrl }],
            'Worksheet 1',
          ),
        ],
      ]),
      new AbortController(),
      {
        knownNavigationLocations: [
          {
            purpose: 'assignments',
            destinationUrl: rememberedUrl,
            status: 'verified',
            destinationKind: 'collection',
          },
        ],
        onNavigationVerified,
      },
    );

    await result;
    expect(openFrom).toHaveBeenCalledWith(expect.anything(), rememberedUrl);
    expect(
      request.mock.calls.some(
        ([body]) =>
          body.kind === 'choose' &&
          body.targets?.some((target) => target.url === rememberedUrl),
      ),
    ).toBe(false);
    expect(onNavigationVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'assignments',
        destinationUrl: rememberedUrl,
        destinationKind: 'collection',
      }),
    );
    expect((await result).metrics).toMatchObject({
      knownDestinationsReused: 1,
      candidatesExtracted: 1,
      duplicatesReconciled: 0,
    });
  });

  it('counts a newly verified destination as a navigation repair when saved knowledge moved', async () => {
    const oldUrl = `${root}/modules/old-work`;
    const newUrl = `${root}/modules/current-work`;
    const request = vi.fn(async (body: AgentRequestSchema) =>
      body.kind === 'choose'
        ? {
            operation: 'NAVIGATE',
            target: body.targets?.find((target) => target.url === newUrl)?.id,
          }
        : { assignments: [], coverage: 'complete' },
    );
    const { result } = run(
      request,
      new Map([
        [root, page(root, [{ label: 'Current work', url: newUrl }])],
        [newUrl, page(newUrl, [], 'Current assignments')],
      ]),
      new AbortController(),
      {
        knownNavigationLocations: [
          {
            purpose: 'assignments',
            destinationUrl: oldUrl,
            status: 'verified',
            destinationKind: 'collection',
          },
        ],
        onNavigationVerified: vi.fn(),
      },
    );

    expect(await result).toMatchObject({
      status: 'complete',
      metrics: {
        navigationRepairs: 1,
        knownDestinationsReused: 0,
      },
    });
  });

  it('reports validated candidates without retaining their source content in metrics', async () => {
    const record = card('Worksheet 1', root);
    const { result } = run(
      vi.fn(async () => ({
        assignments: [record, record],
        coverage: 'complete',
      })),
      new Map([[root, page(root, [], 'Worksheet 1')]]),
    );

    const scanned = await result;
    expect(scanned.items).toHaveLength(1);
    expect(scanned.metrics).toMatchObject({
      candidatesExtracted: 1,
      duplicatesReconciled: 0,
      ambiguousIdentityConflicts: 0,
    });
    expect(JSON.stringify(scanned.metrics)).not.toContain('Worksheet 1');
  });

  it('uses the inout action already completed on the protected course page', async () => {
    const folderUrl = `${root}/modules/week-one`;
    const pages = new Map([
      [root, page(root, [{ label: 'Week one', url: folderUrl }], 'Week one')],
      [folderUrl, page(folderUrl, [], 'Worksheet 1')],
    ]);
    let currentUrl = root;
    const request = vi.fn(async (body: AgentRequestSchema) =>
      body.kind === 'assignments' && body.pages[0].url === folderUrl
        ? {
            assignments: [card('Worksheet 1', folderUrl)],
            coverage: 'complete',
          }
        : { assignments: [], coverage: 'partial' },
    );
    const navigation = {
      discoverCourses: vi.fn(),
      choose: vi.fn(async ({ targets }) => {
        currentUrl = folderUrl;
        return {
          operation: 'NAVIGATE' as const,
          target: targets[0]!.id,
          navigationHandled: true,
        };
      }),
      extract: vi.fn(async (body: AgentRequestSchema) => request(body)),
    } as unknown as BrowserNavigationAdapter;
    const onModelCall = vi.fn();
    const { result, openFrom } = run(request, pages, new AbortController(), {
      navigation,
      readCurrent: async () => pages.get(currentUrl)!,
      onModelCall,
    });

    const scanned = await result;
    expect(scanned.items.map((item) => item.title)).toContain('Worksheet 1');
    expect(navigation.choose).toHaveBeenCalledOnce();
    expect(onModelCall).toHaveBeenCalledTimes(3);
    expect(openFrom).not.toHaveBeenCalled();
  });

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
      new Map([[root, page(root, [], 'Submitted')]]),
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
          [newUrl, page(newUrl, [], undefined, 'Unknown work')],
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
    expect(await result).toMatchObject({ status: 'partial', items: [] });
    expect(
      request.mock.calls.filter(([body]) => body.kind === 'choose'),
    ).toHaveLength(2);
    expect(openFrom).not.toHaveBeenCalled();
  });

  it('keeps current-course assignment links offered under a broader course-list exclusion', async () => {
    const assignmentUrl = `${root}/assignments/123`;
    const sibling = 'https://school.edu/courses/2';
    const bodies: AgentRequestSchema[] = [];
    const request = vi.fn(async (body: AgentRequestSchema) => {
      bodies.push(body);
      if (body.kind === 'choose') return { operation: 'DONE', target: null };
      const target = body.targets?.find((item) => item.url === assignmentUrl);
      return {
        coverage: 'complete',
        assignments: [
          {
            ...card('Current assignment', root),
            url: assignmentUrl,
            evidence: {
              sourceUrl: root,
              excerpts: ['Current assignment'],
              targetIds: target ? [target.id] : [],
            },
          },
        ],
      };
    });
    const result = await scanCourseCollection({
      from: page(
        root,
        [
          { label: 'Courses', url: 'https://school.edu/courses' },
          { label: 'Current assignment', url: assignmentUrl },
          { label: 'Other course', url: sibling },
          { label: 'Other assignment', url: `${sibling}/assignments/1` },
        ],
        'Course content Current assignment',
      ),
      kind: 'assignments',
      host: 'school.edu',
      courseName: 'Biology',
      excludedUrls: ['https://school.edu/courses', sibling],
      notes: '',
      context: { assertReadable: () => undefined, openFrom: vi.fn() },
      request,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    const extraction = bodies.find((body) => body.kind === 'assignments');

    expect(extraction?.targets?.map((target) => target.url)).toContain(
      assignmentUrl,
    );
    expect(extraction?.targets?.map((target) => target.url)).not.toContain(
      'https://school.edu/courses',
    );
    expect(extraction?.targets?.map((target) => target.url)).not.toContain(
      sibling,
    );
    expect(extraction?.targets?.map((target) => target.url)).not.toContain(
      `${sibling}/assignments/1`,
    );
    expect(result).toMatchObject({
      status: 'complete',
      items: [expect.objectContaining({ title: 'Current assignment' })],
    });
  });

  it('resolves a partial home summary when its complete assignments collection is read', async () => {
    const assignmentsUrl = `${root}/assignments`;
    const request = vi.fn(async (body: AgentRequestSchema) => {
      if (body.kind === 'choose') return { operation: 'DONE', target: null };
      const record = {
        ...card('Upcoming quiz', body.pages[0].url),
        sourceId: 'quiz-1',
      };
      return body.pages[0].url === root
        ? { coverage: 'partial', assignments: [record] }
        : { coverage: 'complete', assignments: [record] };
    });
    const { result } = run(
      request,
      new Map([
        [
          root,
          page(
            root,
            [{ label: 'Assignments', url: assignmentsUrl }],
            'Upcoming quiz',
          ),
        ],
        [assignmentsUrl, page(assignmentsUrl, [], 'Upcoming quiz')],
      ]),
    );

    expect(await result).toMatchObject({
      status: 'complete',
      items: [expect.objectContaining({ title: 'Upcoming quiz' })],
    });
  });

  it('reconciles source-ID and individual-URL observations across collection pages', async () => {
    const assignmentsUrl = `${root}/assignments`;
    const assignmentUrl = `${assignmentsUrl}/a-1`;
    const request = vi.fn(async (body: AgentRequestSchema) => {
      if (body.kind === 'choose') return { operation: 'DONE', target: null };
      if (body.pages[0]?.url === root)
        return {
          coverage: 'partial',
          assignments: [
            {
              ...card('Upcoming quiz', root),
              sourceId: 'a-1',
              evidence: {
                sourceUrl: root,
                excerpts: ['Upcoming quiz a-1'],
                targetIds: [],
              },
            },
          ],
        };
      const target = body.targets?.find((item) => item.url === assignmentUrl);
      return {
        coverage: 'complete',
        assignments: [
          {
            ...card('Upcoming quiz', assignmentsUrl),
            url: assignmentUrl,
            evidence: {
              sourceUrl: assignmentsUrl,
              excerpts: ['Upcoming quiz'],
              targetIds: target ? [target.id] : [],
            },
          },
        ],
      };
    });
    const { result } = run(
      request,
      new Map([
        [
          root,
          page(
            root,
            [{ label: 'Assignments', url: assignmentsUrl }],
            'Upcoming quiz a-1',
          ),
        ],
        [
          assignmentsUrl,
          page(
            assignmentsUrl,
            [{ label: 'Upcoming quiz', url: assignmentUrl }],
            'Upcoming quiz',
          ),
        ],
      ]),
    );

    expect(await result).toMatchObject({
      status: 'complete',
      items: [expect.objectContaining({ title: 'Upcoming quiz' })],
    });
    expect((await result).items).toHaveLength(1);
    expect((await result).metrics).toMatchObject({
      candidatesExtracted: 2,
      duplicatesReconciled: 1,
      ambiguousIdentityConflicts: 0,
    });
  });

  it('clears an unknown assignment gap only after its detail page resolves the same item', async () => {
    const assignmentUrl = `${root}/assignments/123`;
    const request = vi.fn(async (body: AgentRequestSchema) => {
      if (body.kind === 'choose') return { operation: 'DONE', target: null };
      const detail = body.pages[0].url === assignmentUrl;
      return {
        coverage: detail ? 'detail' : 'complete',
        assignments: [
          {
            ...card(
              'Unknown work',
              body.pages[0].url,
              detail ? 'active-unsubmitted' : 'unknown',
            ),
            sourceId: 'assignment-1',
            url: assignmentUrl,
            evidence: {
              sourceUrl: body.pages[0].url,
              excerpts: ['Unknown work'],
              targetIds: detail ? [] : ['1'],
            },
          },
        ],
      };
    });
    const { result, openFrom } = run(
      request,
      new Map([
        [root, page(root, [{ label: 'Unknown work', url: assignmentUrl }])],
        [assignmentUrl, page(assignmentUrl, [], undefined, 'Unknown work')],
      ]),
    );

    expect(await result).toMatchObject({
      status: 'complete',
      items: [expect.objectContaining({ title: 'Unknown work' })],
    });
    expect(openFrom).toHaveBeenCalledWith(expect.anything(), assignmentUrl);
  });

  it('keeps an unknown assignment unresolved when its detail page remains unknown', async () => {
    const assignmentUrl = `${root}/assignments/123`;
    const request = vi.fn(async (body: AgentRequestSchema) => {
      if (body.kind === 'choose') return { operation: 'DONE', target: null };
      const detail = body.pages[0].url === assignmentUrl;
      return {
        coverage: detail ? 'detail' : 'complete',
        assignments: [
          {
            ...card('Unknown work', body.pages[0].url, 'unknown'),
            url: assignmentUrl,
            evidence: {
              sourceUrl: body.pages[0].url,
              excerpts: ['Unknown work'],
              targetIds: detail ? [] : ['1'],
            },
          },
        ],
      };
    });
    const { result } = run(
      request,
      new Map([
        [root, page(root, [{ label: 'Unknown work', url: assignmentUrl }])],
        [assignmentUrl, page(assignmentUrl, [], undefined, 'Unknown work')],
      ]),
    );

    expect(await result).toMatchObject({
      status: 'partial',
      items: [],
    });
  });

  it('keeps an unvisited pagination target unresolved after DONE', async () => {
    const next = `${root}/assignments?page=2`;
    const { result } = run(
      vi.fn(async (body: AgentRequestSchema) =>
        body.kind === 'choose'
          ? { operation: 'DONE', target: null }
          : { coverage: 'complete', assignments: [] },
      ),
      new Map([[root, page(root, [{ label: 'Next', url: next }])]]),
    );

    expect(await result).toMatchObject({ status: 'partial', items: [] });
  });

  it('keeps a truncated page incomplete when extraction reports complete', async () => {
    const request = vi.fn(async (body: AgentRequestSchema) =>
      body.kind === 'choose'
        ? { operation: 'DONE', target: null }
        : { coverage: 'complete', assignments: [] },
    );
    const { result } = run(
      request,
      new Map([[root, page(root, [], 'a'.repeat(15_000))]]),
    );

    expect(await result).toMatchObject({ status: 'partial', items: [] });
    expect(
      request.mock.calls.some(
        ([body]) => body.kind === 'assignments' && body.context?.truncated,
      ),
    ).toBe(true);
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
      assignments: [{ ...card('One detail', root), url: root }],
      coverage: 'detail',
    })),
    new Map([[root, page(root, [], 'One detail', 'One detail')]]),
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
    original: 'October 31, 2026 at 11:59 PM',
  };
  const observed = page(
    root,
    [],
    'Lab report due October 31, 2026 at 11:59 PM',
  );
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
    evidence: {
      sourceUrl: root,
      excerpts: ['Lab report due October 31, 2026 at 11:59 PM'],
      targetIds: [],
    },
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

it.each([true, false])(
  'keeps same-title assignments distinct when source IDs are present: %s',
  async (withIds) => {
    const firstUrl = `${root}/work/1`;
    const secondUrl = `${root}/work/2`;
    const request = vi.fn(async (body: AgentRequestSchema) => {
      if (body.kind === 'choose') return { operation: 'DONE', target: null };
      if (body.pages[0].url === firstUrl)
        return {
          coverage: 'detail',
          assignments: [
            {
              ...card('Essay', firstUrl, 'unknown'),
              url: firstUrl,
              sourceId: withIds ? 'one' : null,
            },
          ],
        };
      return {
        coverage: 'complete',
        assignments: [firstUrl, secondUrl].map((url, index) => ({
          ...card(
            'Essay',
            root,
            index === 0 ? 'unknown' : 'active-unsubmitted',
          ),
          url,
          sourceId: withIds ? (index === 0 ? 'one' : 'two') : null,
          evidence: {
            sourceUrl: root,
            excerpts: ['Essay'],
            targetIds: [String(index + 1)],
          },
        })),
      };
    });
    const { result, openFrom } = run(
      request,
      new Map([
        [
          root,
          page(
            root,
            [
              { label: 'Essay', url: firstUrl },
              { label: 'Essay', url: secondUrl },
            ],
            'Essay Essay',
          ),
        ],
        [firstUrl, page(firstUrl, [], 'Essay', 'Essay')],
      ]),
    );
    expect(await result).toMatchObject({
      status: 'partial',
      items: [{ url: secondUrl }],
    });
    expect(openFrom).toHaveBeenCalledWith(expect.anything(), firstUrl);
  },
);
