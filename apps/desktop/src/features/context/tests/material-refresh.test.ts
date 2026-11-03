import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseListContext } from '../../onboarding/services/connection-scan';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  save: vi.fn(),
  extractPdf: vi.fn(),
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: (_path: string, body: AgentRequestSchema) =>
    mocks.request(body),
}));
vi.mock('../services/material-store', () => ({
  saveCourseMaterial: mocks.save,
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

const createContext = (
  observed: ObservedPage,
  pages: Map<string, ObservedPage>,
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
  const courseContext = (current: ObservedPage): CourseListContext => ({
    observed: current,
    pages: [current],
    entries: [],
    withCoursePage: async (_url, run) => run(courseContext(current)),
    openFrom,
    downloadPdf,
    assertReadable: vi.fn(),
  });
  return {
    openFrom,
    context: courseContext(observed),
    runOnCoursePage: async (
      run: (context: CourseListContext) => Promise<void>,
    ) => run(courseContext(observed)),
    downloadPdf,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockReturnValue({ changed: true });
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
