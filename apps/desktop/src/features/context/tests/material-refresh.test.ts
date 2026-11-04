import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseListContext } from '../../onboarding/services/connection-scan';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  save: vi.fn(),
  reconcile: vi.fn(),
  extractPdf: vi.fn(),
  getLocations: vi.fn(),
  saveLocation: vi.fn(),
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: (_path: string, body: AgentRequestSchema) =>
    mocks.request(body),
}));
vi.mock('../services/material-store', () => ({
  reconcileMaterialCollection: mocks.reconcile,
  saveCourseMaterial: mocks.save,
}));
vi.mock('../services/navigation-store', () => ({
  getNavigationLocations: mocks.getLocations,
  saveNavigationLocation: mocks.saveLocation,
}));
vi.mock('../services/pdf-content', () => ({
  extractPdfContent: mocks.extractPdf,
}));

const { refreshCourseMaterials } = await import('../services/material-refresh');

const userId = 'material-student';
const connectionId = 'material-connection';
const courseId = 'material-course';
const courseUrl = 'https://canvas.school.edu/courses/1';
const moduleUrl = `${courseUrl}/modules/1`;
const syllabusUrl = `${courseUrl}/files/syllabus`;
const syllabusText = 'Final exam: December 8, 2026.';
const pdfUrl = `${courseUrl}/files/biology.pdf`;

const page = (
  url: string,
  overrides: Partial<ObservedPage> = {},
): ObservedPage => ({
  url,
  title: 'Biology',
  text: 'Course home',
  links: [],
  ...overrides,
});

const material = (overrides: Record<string, unknown> = {}) => ({
  title: 'Biology syllabus',
  sourceType: 'syllabus',
  url: syllabusUrl,
  readability: 'unreadable',
  summary: null,
  summaryEvidence: [],
  evidence: {
    sourceUrl: moduleUrl,
    excerpts: ['Biology syllabus'],
    targetIds: ['1'],
  },
  ...overrides,
});

type TestCourseContext = CourseListContext & {
  visitKnownLocation?: (location: unknown) => Promise<ObservedPage>;
};

const createContext = (
  observed: ObservedPage,
  pages: Map<string, ObservedPage>,
  visitKnownLocation?: (location: unknown) => Promise<ObservedPage>,
) => {
  const openFrom = vi.fn(async (from: ObservedPage, url: string) => {
    expect(from.links.some((link) => link.url === url)).toBe(true);
    const next = pages.get(url);
    if (!next) throw new Error('The page could not be loaded.');
    return next;
  });
  const downloadPdf = vi.fn(async () => ({
    status: 'complete' as const,
    url: pdfUrl,
    bytes: new TextEncoder().encode('%PDF-1.4'),
  }));
  const courseContext = (current: ObservedPage): TestCourseContext => ({
    observed: current,
    pages: [current],
    entries: [],
    withCoursePage: async (_url, run) => run(courseContext(current)),
    openFrom,
    downloadPdf,
    assertReadable: vi.fn(),
    ...(visitKnownLocation ? { visitKnownLocation } : {}),
  });
  return {
    openFrom,
    context: courseContext(observed),
    runOnCoursePage: async (
      run: (context: TestCourseContext) => Promise<void>,
    ) => run(courseContext(observed)),
    downloadPdf,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockImplementation((input: { source: { url: string } }) => ({
    outcome: 'saved',
    material: {
      id: input.source.url,
      currentUsableVersion: 'test-version-hash',
    },
    changed: true,
  }));
  mocks.reconcile.mockReturnValue({ retiredMaterialIds: [] });
  mocks.getLocations.mockReturnValue([]);
  mocks.saveLocation.mockReturnValue(null);
  mocks.extractPdf.mockResolvedValue({
    status: 'complete',
    pageCount: 1,
    text: 'Biology syllabus: Final exam is December 8, 2026.',
  });
});

describe('course material refresh', () => {
  it('replays every ancestor when materials are nested more than two links deep', async () => {
    const urls = [
      courseUrl,
      `${courseUrl}/modules`,
      `${courseUrl}/modules/week`,
      syllabusUrl,
    ];
    const pages = urls.map((url, index) =>
      page(url, {
        title: 'Course Materials',
        text: index === 3 ? syllabusText : 'Course Materials',
        links:
          index < 3
            ? [{ label: 'Course Materials', url: urls[index + 1]! }]
            : [],
      }),
    );
    const { context, runOnCoursePage } = createContext(
      pages[0]!,
      new Map(pages.map((value) => [value.url, value])),
    );
    mocks.request.mockImplementation(async (body: AgentRequestSchema) => {
      const index = urls.indexOf(body.pages[0]!.url);
      return {
        materials: [
          material({
            title: 'Course Materials',
            url: urls[Math.min(index + 1, 3)],
            readability: index === 3 ? 'readable' : 'unreadable',
            evidence: {
              sourceUrl: urls[index],
              excerpts: [index === 3 ? syllabusText : 'Course Materials'],
              targetIds: index === 3 ? [] : ['1'],
            },
          }),
        ],
        coverage: 'complete',
      };
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: pages[0]!,
      context,
      runOnCoursePage,
      request: mocks.request,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result).toMatchObject({
      status: 'complete',
      materialsSaved: 1,
      pagesRead: 4,
    });
  });

  it('persists only observed in-course material collection routes', async () => {
    const rootPage = page(courseUrl, {
      title: 'Course Materials',
      text: 'Biology course materials include Biology syllabus.',
      links: [{ label: 'Biology syllabus', url: moduleUrl }],
    });
    const modulePage = page(moduleUrl, {
      title: 'Course Materials',
      text: 'Biology syllabus',
      links: [{ label: 'Syllabus', url: syllabusUrl }],
    });
    const syllabusPage = page(syllabusUrl, {
      title: 'Biology syllabus',
      text: syllabusText,
    });
    const pages = new Map([
      [moduleUrl, modulePage],
      [syllabusUrl, syllabusPage],
    ]);
    const { context, runOnCoursePage } = createContext(rootPage, pages);
    mocks.saveLocation.mockReturnValue({ id: 'saved-material-route' });
    mocks.request.mockImplementation(async (body: AgentRequestSchema) => {
      const sourceUrl = body.pages[0]!.url;
      if (sourceUrl === courseUrl)
        return {
          materials: [
            material({
              title: 'Biology syllabus',
              sourceType: 'page',
              url: moduleUrl,
              evidence: {
                sourceUrl,
                excerpts: ['Biology syllabus'],
                targetIds: ['1'],
              },
            }),
          ],
          coverage: 'complete',
        };
      if (sourceUrl === moduleUrl)
        return {
          materials: [
            material({
              title: 'Biology syllabus',
              sourceType: 'page',
              url: syllabusUrl,
              evidence: {
                sourceUrl,
                excerpts: ['Syllabus'],
                targetIds: ['1'],
              },
            }),
          ],
          coverage: 'complete',
        };
      return {
        materials: [
          material({
            title: 'Biology syllabus',
            sourceType: 'page',
            url: syllabusUrl,
            readability: 'readable',
            evidence: {
              sourceUrl,
              excerpts: [syllabusText],
              targetIds: [],
            },
          }),
        ],
        coverage: 'complete',
      };
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(mocks.saveLocation).toHaveBeenCalledWith(
      userId,
      connectionId,
      expect.objectContaining({
        courseId,
        purpose: 'materials',
        destinationUrl: moduleUrl,
        parentUrl: courseUrl,
        evidence: expect.objectContaining({
          sourceUrl: courseUrl,
          targetIds: ['1'],
        }),
        status: 'verified',
        destinationKind: 'collection',
      }),
    );
    expect(result).toMatchObject({
      status: 'complete',
      navigationLocationsReused: 0,
      navigationLocationsSaved: 1,
    });
  });

  it('reuses a verified cached material collection before root discovery', async () => {
    const cachedUrl = `${courseUrl}/modules`;
    const rootPage = page(courseUrl, {
      title: 'Course Home',
      text: 'Course home',
    });
    const cachedPage = page(cachedUrl, {
      title: 'Course Materials',
      text: 'Biology syllabus',
    });
    const location = {
      id: 'cached-material-collection',
      userId,
      connectionId,
      courseId,
      purpose: 'materials',
      destinationUrl: cachedUrl,
      parentUrl: courseUrl,
      recipe: null,
      label: 'Course Materials',
      evidence: {
        sourceUrl: courseUrl,
        excerpts: ['Course Materials'],
        targetIds: ['1'],
      },
      status: 'verified',
      destinationKind: 'collection',
      observedAt: '2026-11-01T12:00:00.000Z',
      verifiedAt: '2026-11-01T12:00:00.000Z',
      failureCount: 0,
      lastFailureClass: null,
    };
    mocks.getLocations.mockReturnValue([location]);
    const visitKnownLocation = vi.fn(async () => cachedPage);
    const { context, runOnCoursePage } = createContext(
      rootPage,
      new Map([[cachedUrl, cachedPage]]),
      visitKnownLocation,
    );
    mocks.request.mockResolvedValue({
      materials: [
        material({
          title: 'Biology syllabus',
          sourceType: 'page',
          url: cachedUrl,
          readability: 'readable',
          evidence: {
            sourceUrl: cachedUrl,
            excerpts: ['Biology syllabus'],
            targetIds: [],
          },
        }),
      ],
      coverage: 'complete',
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(visitKnownLocation).toHaveBeenCalledWith(location);
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: [expect.objectContaining({ url: cachedUrl })],
      }),
    );
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(result.status).toBe('complete');
    expect(result.navigationLocationsReused).toBe(1);
  });

  it('repairs a lost material route from its verified parent', async () => {
    const cachedUrl = `${courseUrl}/modules`;
    const replacementUrl = `${courseUrl}/modules/week-one`;
    const readingUrl = `${courseUrl}/files/biology-reading`;
    const rootPage = page(courseUrl, {
      title: 'Course Materials',
      text: 'Biology syllabus Course Materials',
      links: [{ label: 'Biology syllabus', url: replacementUrl }],
    });
    const replacementPage = page(replacementUrl, {
      title: 'Course Materials',
      text: 'Biology syllabus',
      links: [{ label: 'Syllabus', url: readingUrl }],
    });
    const readingPage = page(readingUrl, {
      title: 'Biology syllabus',
      text: syllabusText,
    });
    const location = {
      id: 'stale-material-collection',
      userId,
      connectionId,
      courseId,
      purpose: 'materials',
      destinationUrl: cachedUrl,
      parentUrl: courseUrl,
      recipe: null,
      label: 'Course Materials',
      evidence: {
        sourceUrl: courseUrl,
        excerpts: ['Course Materials'],
        targetIds: ['1'],
      },
      status: 'verified',
      destinationKind: 'collection',
      observedAt: '2026-11-01T12:00:00.000Z',
      verifiedAt: '2026-11-01T12:00:00.000Z',
      failureCount: 0,
      lastFailureClass: null,
    };
    const replacementLocation = {
      ...location,
      id: 'replacement-material-collection',
      destinationUrl: replacementUrl,
      label: 'Biology syllabus',
      evidence: {
        sourceUrl: courseUrl,
        excerpts: ['Biology syllabus'],
        targetIds: ['1'],
      },
    };
    let knownLocations = [location];
    mocks.getLocations.mockImplementation(() => knownLocations);
    const visitKnownLocation = vi.fn(async () => {
      knownLocations = [replacementLocation];
      return replacementPage;
    });
    const { context, runOnCoursePage } = createContext(
      rootPage,
      new Map([
        [replacementUrl, replacementPage],
        [readingUrl, readingPage],
      ]),
      visitKnownLocation,
    );
    mocks.saveLocation.mockReturnValue({ id: 'replacement-material-route' });
    mocks.request.mockImplementation(async (body: AgentRequestSchema) => {
      const sourceUrl = body.pages[0]!.url;
      if (sourceUrl === courseUrl)
        return {
          materials: [
            material({
              title: 'Biology syllabus',
              sourceType: 'page',
              url: replacementUrl,
              evidence: {
                sourceUrl,
                excerpts: ['Biology syllabus'],
                targetIds: ['1'],
              },
            }),
          ],
          coverage: 'complete',
        };
      if (sourceUrl === replacementUrl)
        return {
          materials: [
            material({
              title: 'Biology syllabus',
              sourceType: 'page',
              url: readingUrl,
              evidence: {
                sourceUrl,
                excerpts: ['Syllabus'],
                targetIds: ['1'],
              },
            }),
          ],
          coverage: 'complete',
        };
      return {
        materials: [
          material({
            title: 'Biology syllabus',
            sourceType: 'page',
            url: readingUrl,
            readability: 'readable',
            evidence: {
              sourceUrl,
              excerpts: [syllabusText],
              targetIds: [],
            },
          }),
        ],
        coverage: 'complete',
      };
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(visitKnownLocation).toHaveBeenCalledOnce();
    expect(visitKnownLocation).toHaveBeenCalledWith(location);
    expect(mocks.getLocations).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'complete',
      navigationLocationsReused: 0,
      navigationLocationsRepaired: 1,
      navigationLocationsSaved: 0,
    });
  });

  it('keeps keyword-skipped course roots partial and performs no model call', async () => {
    const rootPage = page(courseUrl, { text: 'Course home' });
    const { context, runOnCoursePage } = createContext(rootPage, new Map());

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result.status).toBe('partial');
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('does not treat model-empty complete output as host-proven empty coverage', async () => {
    const rootPage = page(courseUrl, {
      title: 'Course Materials',
      text: 'Course Materials',
    });
    const { context, runOnCoursePage } = createContext(rootPage, new Map());
    mocks.request.mockResolvedValue({ materials: [], coverage: 'complete' });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result.status).toBe('partial');
    expect(result.hostCoverage).toMatchObject({
      collectionKind: 'materials',
      explicitEmptyEvidence: null,
      gaps: { scopeUnverified: false },
    });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('associates explicit-empty evidence with the observed nested collection', async () => {
    const collectionUrl = `${courseUrl}/modules`;
    const rootPage = page(courseUrl, {
      title: 'Course Home',
      text: 'Open the Course Materials list.',
      links: [{ label: 'Course Materials', url: collectionUrl }],
    });
    const collectionPage = page(collectionUrl, {
      title: 'Course Materials',
      text: 'No course materials are available.',
    });
    const { context, runOnCoursePage } = createContext(
      rootPage,
      new Map([[collectionUrl, collectionPage]]),
    );
    mocks.request.mockImplementation(async (body: AgentRequestSchema) => {
      const sourceUrl = body.pages[0]!.url;
      if (sourceUrl === courseUrl)
        return {
          materials: [
            material({
              title: 'Course Materials',
              sourceType: 'page',
              url: collectionUrl,
              evidence: {
                sourceUrl,
                excerpts: ['Course Materials'],
                targetIds: ['1'],
              },
            }),
          ],
          coverage: 'complete',
        };
      return { materials: [], coverage: 'complete' };
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result).toMatchObject({
      status: 'complete',
      hostCoverage: {
        collectionUrls: expect.arrayContaining([courseUrl, collectionUrl]),
        explicitEmptyEvidence: { pageUrl: collectionUrl },
      },
    });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      { userId, connectionId, courseId },
      expect.objectContaining({
        coverage: expect.objectContaining({
          collectionUrls: expect.arrayContaining([collectionUrl]),
          explicitEmptyEvidence: expect.objectContaining({
            pageUrl: collectionUrl,
          }),
        }),
      }),
    );
  });

  it('retires unseen material only with observed explicit empty evidence', async () => {
    const rootPage = page(courseUrl, {
      title: 'Course Materials',
      text: 'No course materials are available.',
    });
    const { context, runOnCoursePage } = createContext(rootPage, new Map());
    mocks.request.mockResolvedValue({ materials: [], coverage: 'complete' });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result.status).toBe('complete');
    expect(result.hostCoverage.explicitEmptyEvidence).toMatchObject({
      kind: 'observed-empty-list',
      pageUrl: courseUrl,
    });
    expect(mocks.reconcile).toHaveBeenCalledWith(
      { userId, connectionId, courseId },
      expect.objectContaining({
        coverage: expect.objectContaining({
          collectionKind: 'materials',
          explicitEmptyEvidence: expect.objectContaining({
            kind: 'observed-empty-list',
          }),
        }),
        seenIds: [],
      }),
    );
  });

  it('reads a course page whose only material signal is Course Materials', async () => {
    const rootPage = page(courseUrl, {
      text: 'Course Materials. Mitochondria convert glucose into ATP.',
    });
    const { context, runOnCoursePage } = createContext(rootPage, new Map());
    mocks.request.mockResolvedValue({
      materials: [
        material({
          title: 'Biology',
          sourceType: 'page',
          url: courseUrl,
          readability: 'readable',
          evidence: {
            sourceUrl: courseUrl,
            excerpts: [rootPage.text!],
            targetIds: [],
          },
        }),
      ],
      coverage: 'complete',
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result.materialsSaved).toBe(1);
  });

  it('follows observed material links and saves source text separately from a supported summary', async () => {
    const rootPage = page(courseUrl, {
      title: 'Course Materials',
      links: [{ label: 'Modules', url: moduleUrl }],
    });
    const modulePage = page(moduleUrl, {
      title: 'Week 1',
      text: 'Readings',
      links: [{ label: 'Biology syllabus', url: syllabusUrl }],
    });
    const syllabusPage = page(syllabusUrl, {
      title: 'Biology syllabus',
      text: syllabusText,
    });
    const pages = new Map([
      [courseUrl, rootPage],
      [moduleUrl, modulePage],
      [syllabusUrl, syllabusPage],
    ]);
    const { context, runOnCoursePage, openFrom } = createContext(
      rootPage,
      pages,
    );
    const rootExtract = vi.fn((body: AgentRequestSchema) =>
      mocks.request(body),
    );
    const childExtract = vi.fn((body: AgentRequestSchema) =>
      mocks.request(body),
    );
    context.navigation = {
      discoverCourses: vi.fn(),
      choose: vi.fn(),
      extract: rootExtract,
    };
    mocks.request.mockImplementation(async (body: AgentRequestSchema) => {
      if (body.pages[0]!.url === courseUrl)
        return {
          materials: [
            material({
              title: 'Modules',
              sourceType: 'page',
              url: moduleUrl,
              evidence: {
                sourceUrl: courseUrl,
                excerpts: ['Modules'],
                targetIds: ['1'],
              },
            }),
          ],
          coverage: 'complete',
        };
      if (body.pages[0]!.url === moduleUrl)
        return {
          materials: [
            material({
              evidence: {
                sourceUrl: moduleUrl,
                excerpts: ['Biology syllabus'],
                targetIds: ['1'],
              },
            }),
          ],
          coverage: 'complete',
        };
      return {
        materials: [
          material({
            url: syllabusUrl,
            readability: 'readable',
            summary: 'Final exam December 8, 2026.',
            summaryEvidence: [syllabusText],
            evidence: {
              sourceUrl: syllabusUrl,
              excerpts: [syllabusText],
              targetIds: [],
            },
          }),
        ],
        coverage: 'complete',
      };
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage: (run) =>
        runOnCoursePage((current) =>
          run({
            ...current,
            navigation: {
              discoverCourses: vi.fn(),
              choose: vi.fn(),
              extract: childExtract,
            },
          }),
        ),
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result).toMatchObject({ status: 'complete', materialsSaved: 1 });
    expect(rootExtract).toHaveBeenCalledTimes(1);
    expect(childExtract).toHaveBeenCalledTimes(2);
    expect(openFrom).toHaveBeenCalledWith(rootPage, moduleUrl);
    expect(openFrom).toHaveBeenCalledWith(modulePage, syllabusUrl);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        connectionId,
        courseId,
        source: expect.objectContaining({
          url: syllabusUrl,
          extractionStatus: 'complete',
          summary: 'Final exam December 8, 2026.',
        }),
        content: expect.objectContaining({
          normalizedText: syllabusText,
          passages: [expect.objectContaining({ text: syllabusText })],
        }),
      }),
    );
  });

  it('does not navigate to a same-host material from another course', async () => {
    const wrongCourseUrl = 'https://canvas.school.edu/courses/2/files/syllabus';
    const rootPage = page(courseUrl, {
      title: 'Course Materials',
      text: 'Biology syllabus Course Materials',
      links: [{ label: 'Course Materials', url: wrongCourseUrl }],
    });
    const { context, openFrom, runOnCoursePage } = createContext(
      rootPage,
      new Map(),
    );
    mocks.request.mockResolvedValue({
      materials: [
        material({
          title: 'Biology syllabus',
          sourceType: 'page',
          url: wrongCourseUrl,
          readability: 'readable',
          evidence: {
            sourceUrl: courseUrl,
            excerpts: ['Course Materials'],
            targetIds: ['1'],
          },
        }),
      ],
      coverage: 'complete',
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result.status).toBe('partial');
    expect(openFrom).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('saves an explicitly observed external material through its current host', async () => {
    const externalUrl = 'https://files.school.edu/biology/reading';
    const rootPage = page(courseUrl, {
      title: 'Course Materials',
      links: [{ label: 'Week 1 Reading', url: externalUrl }],
    });
    const externalPage = page(externalUrl, {
      title: 'Week 1 Reading',
      text: syllabusText,
    });
    const { context, runOnCoursePage, openFrom } = createContext(
      rootPage,
      new Map([[externalUrl, externalPage]]),
    );
    mocks.request.mockImplementation(async (body: AgentRequestSchema) =>
      body.pages[0]!.url === courseUrl
        ? {
            materials: [
              material({
                title: 'Week 1 Reading',
                url: externalUrl,
                sourceType: 'page',
                readability: 'readable',
                evidence: {
                  sourceUrl: courseUrl,
                  excerpts: ['Week 1 Reading'],
                  targetIds: ['1'],
                },
              }),
            ],
            coverage: 'complete',
          }
        : {
            materials: [
              material({
                title: 'Week 1 Reading',
                url: externalUrl,
                sourceType: 'page',
                readability: 'readable',
                evidence: {
                  sourceUrl: externalUrl,
                  excerpts: [syllabusText],
                  targetIds: [],
                },
              }),
            ],
            coverage: 'complete',
          },
    );

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu', 'files.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result.status).toBe('complete');
    expect(openFrom).toHaveBeenCalledWith(rootPage, externalUrl);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ url: externalUrl }),
      }),
    );
  });

  it('does not persist an external material after its host is revoked', async () => {
    const externalUrl = 'https://files.school.edu/biology/reading';
    const rootPage = page(courseUrl, {
      title: 'Course Materials',
      links: [{ label: 'Week 1 Reading', url: externalUrl }],
    });
    const { context, runOnCoursePage } = createContext(rootPage, new Map());
    mocks.request.mockResolvedValue({
      materials: [
        material({
          url: externalUrl,
          evidence: {
            sourceUrl: courseUrl,
            excerpts: ['Week 1 Reading'],
            targetIds: ['1'],
          },
        }),
      ],
      coverage: 'complete',
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result.status).toBe('partial');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('keeps failures partial and does not replace previously saved material', async () => {
    const rootPage = page(courseUrl, { title: 'Course syllabus' });
    const { context, runOnCoursePage } = createContext(rootPage, new Map());
    mocks.request.mockRejectedValue(new Error('temporary model failure'));

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result.status).toBe('partial');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('reads an observed PDF through the protected course page and stores page text', async () => {
    const rootPage = page(courseUrl, {
      title: 'Biology syllabus',
      links: [{ label: 'Biology syllabus PDF', url: pdfUrl }],
    });
    const { context, runOnCoursePage, openFrom, downloadPdf } = createContext(
      rootPage,
      new Map([[courseUrl, rootPage]]),
    );
    mocks.request.mockImplementation(async (body: AgentRequestSchema) =>
      body.pages[0]!.url === courseUrl
        ? {
            materials: [
              material({
                sourceType: 'pdf',
                url: pdfUrl,
                readability: 'readable',
                evidence: {
                  sourceUrl: courseUrl,
                  excerpts: ['Biology syllabus PDF'],
                  targetIds: ['1'],
                },
              }),
            ],
            coverage: 'complete',
          }
        : {
            materials: [
              material({
                sourceType: 'pdf',
                url: pdfUrl,
                readability: 'readable',
                summary: 'Final exam December 8 2026.',
                summaryEvidence: [
                  'Biology syllabus: Final exam is December 8, 2026.',
                ],
                evidence: {
                  sourceUrl: pdfUrl,
                  excerpts: [
                    'Biology syllabus: Final exam is December 8, 2026.',
                  ],
                  targetIds: [],
                },
              }),
            ],
            coverage: 'complete',
          },
    );

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result).toMatchObject({ status: 'complete', materialsSaved: 1 });
    expect(downloadPdf).toHaveBeenCalledWith(rootPage, pdfUrl);
    expect(openFrom).not.toHaveBeenCalledWith(rootPage, pdfUrl);
    expect(mocks.extractPdf).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          url: pdfUrl,
          sourceType: 'pdf',
          extractionStatus: 'complete',
        }),
        content: expect.objectContaining({
          normalizedText: 'Biology syllabus: Final exam is December 8, 2026.',
          passages: [expect.objectContaining({ locator: 'Page 1' })],
        }),
      }),
    );
  });

  it('stores a scanned PDF as unreadable without inventing text', async () => {
    const rootPage = page(courseUrl, {
      title: 'Biology syllabus',
      links: [{ label: 'Biology syllabus PDF', url: pdfUrl }],
    });
    const { context, runOnCoursePage } = createContext(
      rootPage,
      new Map([[courseUrl, rootPage]]),
    );
    mocks.extractPdf.mockResolvedValue({
      status: 'unreadable',
      pageCount: 2,
      text: '',
    });
    mocks.request.mockResolvedValue({
      materials: [
        material({
          sourceType: 'pdf',
          url: pdfUrl,
          readability: 'readable',
          evidence: {
            sourceUrl: courseUrl,
            excerpts: ['Biology syllabus PDF'],
            targetIds: ['1'],
          },
        }),
      ],
      coverage: 'complete',
    });

    const result = await refreshCourseMaterials({
      userId,
      connectionId,
      courseId,
      courseUrl,
      courseName: 'Biology',
      host: 'canvas.school.edu',
      allowedHosts: ['canvas.school.edu'],
      notes: '',
      from: rootPage,
      context,
      runOnCoursePage,
      request: (body) => mocks.request(body),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });

    expect(result).toMatchObject({ status: 'partial', materialsSaved: 1 });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          url: pdfUrl,
          extractionStatus: 'unreadable',
          summary: null,
          summaryEvidence: [],
        }),
        content: expect.objectContaining({ normalizedText: '', passages: [] }),
      }),
    );
  });
});
