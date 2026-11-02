import { validateMaterialExtraction } from '@scholaros/services/ai/resources/material';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import { buildMaterialContent } from '../lib/material-content';
import { saveCourseMaterial } from './material-store';
import { extractPdfContent } from './pdf-content';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseListContext } from '../../onboarding/services/connection-scan';

const maxMaterialPages = 20;
const maxMaterialDepth = 4;
const maxMaterialCalls = 40;
const materialPagePattern =
  /\b(?:book|books|chapter|chapters|content|document|documents|file|files|lecture|lectures|lesson|lessons|material|materials|module|modules|reading|readings|resource|resources|syllabus|textbook|unit|week)\b/i;

type MaterialPathStep = {
  label: string;
  url: string;
  context?: string;
};

type MaterialTarget = {
  url: string;
  path: MaterialPathStep[];
  title: string;
  sourceType: 'pdf' | 'other';
};

type MaterialRefreshArgs = {
  userId: string;
  connectionId: string;
  courseId: string;
  courseUrl: string;
  courseName: string;
  host: string;
  allowedHosts: string[];
  notes: string;
  from: ObservedPage;
  context: Pick<CourseListContext, 'assertReadable' | 'navigation'>;
  runOnCoursePage: (
    run: (context: CourseListContext) => Promise<void>,
  ) => Promise<void>;
  request: (body: AgentRequestSchema) => Promise<unknown>;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

type MaterialRefreshResult = {
  status: 'complete' | 'partial';
  materialsSaved: number;
  pagesRead: number;
};

const assertCourseScope = (
  page: ObservedPage,
  allowedHosts: string[],
  signal: AbortSignal,
  isCurrent: () => boolean,
  assertReadable: () => void,
) => {
  signal.throwIfAborted();
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  assertReadable();
  if (!isReadNavigation(page.url, allowedHosts))
    throw new Error('The material page left your connected resources.');
};

const observedTargets = (
  page: ObservedPage,
  allowedHosts: string[],
  parentLink?: MaterialPathStep,
) => {
  const targets: NonNullable<AgentRequestSchema['targets']> = [];
  if (parentLink && parentLink.url !== page.url)
    targets.push({
      id: 'parent',
      label: parentLink.label.slice(0, 300),
      url: page.url,
      ...(parentLink.context
        ? { context: parentLink.context.slice(0, 500) }
        : {}),
    });
  let linkIndex = 0;
  for (const link of page.links) {
    if (!isReadNavigation(link.url, allowedHosts)) continue;
    const identity = academicPageIdentity(link.url);
    if (!identity || targets.some((target) => target.url === identity))
      continue;
    targets.push({
      id: String(++linkIndex),
      label: link.label.slice(0, 300),
      url: identity,
      ...(link.context ? { context: link.context.slice(0, 500) } : {}),
    });
    if (targets.length === 80) break;
  }
  return targets;
};

const requestForPage = (
  page: ObservedPage,
  args: MaterialRefreshArgs,
  parentLink?: MaterialPathStep,
): AgentRequestSchema & {
  context: NonNullable<AgentRequestSchema['context']>;
} => ({
  kind: 'materials',
  goal: `Find syllabus, reading, lecture and other course materials for ${args.courseName.slice(0, 100)}. Report only observed sources and cite exact text.`,
  notes: args.notes.slice(0, 2000),
  context: {
    retrievedAt: page.retrievedAt ?? new Date().toISOString(),
    observedTimezone: null,
    locale: page.locale ?? null,
    courseUrl: args.courseUrl,
    courseName: args.courseName,
    truncated: !!page.linksTruncated || (page.text?.length ?? 0) > 16000,
  },
  pages: [
    {
      url: page.url,
      title: page.title.slice(0, 500),
      text: (page.text ?? '').slice(0, 16000),
      ...(page.retrievedAt ? { retrievedAt: page.retrievedAt } : {}),
      ...(page.locale ? { locale: page.locale } : {}),
    },
  ],
  targets: observedTargets(page, args.allowedHosts, parentLink),
});

const pageMatchesRequestedTarget = (pageUrl: string, targetUrl: string) => {
  const pageIdentity = academicPageIdentity(pageUrl);
  const targetIdentity = academicPageIdentity(targetUrl);
  if (pageIdentity === targetIdentity) return true;
  if (!pageIdentity || !targetIdentity) return false;
  try {
    const page = new URL(pageIdentity);
    const target = new URL(targetIdentity);
    const path = target.pathname.replace(/\/+$/, '');
    return (
      page.origin === target.origin &&
      (page.pathname === path || page.pathname.startsWith(`${path}/`))
    );
  } catch {
    return false;
  }
};

export const refreshCourseMaterials = async (
  args: MaterialRefreshArgs,
): Promise<MaterialRefreshResult> => {
  const pending: MaterialTarget[] = [];
  const queued = new Set<string>();
  const visited = new Set<string>();
  let partial = false;
  let pagesRead = 0;
  let modelCalls = 0;
  let materialsSaved = 0;
  const assertActive = (page: ObservedPage, assertReadable: () => void) =>
    assertCourseScope(
      page,
      args.allowedHosts,
      args.signal,
      args.isCurrent,
      assertReadable,
    );
  const enqueue = (
    materialUrl: string,
    path: MaterialPathStep[],
    title: string,
    sourceType: string,
  ) => {
    const identity = academicPageIdentity(materialUrl);
    if (!identity || visited.has(identity) || queued.has(identity)) return;
    if (path.length > maxMaterialDepth) {
      partial = true;
      return;
    }
    queued.add(identity);
    pending.push({
      url: identity,
      path,
      title: title.slice(0, 300),
      sourceType: sourceType === 'pdf' ? 'pdf' : 'other',
    });
  };
  const saveMaterial = (
    material: ReturnType<
      typeof validateMaterialExtraction
    >['materials'][number],
    page: ObservedPage,
  ) => {
    const pageText = page.text ?? '';
    const unreadable =
      material.readability === 'unreadable' || !pageText.trim();
    const truncated =
      material.readability === 'truncated' ||
      (page.linksTruncated ?? false) ||
      pageText.length > 16000;
    const sourceText = unreadable ? '' : pageText;
    const extractionStatus = unreadable
      ? 'unreadable'
      : truncated
        ? 'partial'
        : 'complete';
    const content = buildMaterialContent({
      sourceUrl: material.url,
      text: sourceText,
      pageLocators: material.sourceType === 'pdf',
    });
    const retrievedAt = page.retrievedAt ?? new Date().toISOString();
    const saved = saveCourseMaterial({
      userId: args.userId,
      connectionId: args.connectionId,
      courseId: args.courseId,
      source: {
        url: material.url,
        title: material.title,
        sourceType: material.sourceType,
        extractionStatus,
        completeness: unreadable ? 0 : truncated ? 50 : 100,
        summary: material.summary,
        summaryEvidence: material.summaryEvidence.map((excerpt) => ({
          sourceUrl: material.evidence.sourceUrl,
          excerpts: [excerpt],
          locator: null,
        })),
        retrievedAt,
        verifiedAt: retrievedAt,
      },
      content,
    });
    if (!saved) {
      partial = true;
      return;
    }
    materialsSaved += 1;
    if (extractionStatus !== 'complete') partial = true;
  };
  const saveUnreadablePdf = (target: MaterialTarget) => {
    const retrievedAt = new Date().toISOString();
    const saved = saveCourseMaterial({
      userId: args.userId,
      connectionId: args.connectionId,
      courseId: args.courseId,
      source: {
        url: target.url,
        title: target.title,
        sourceType: 'pdf',
        extractionStatus: 'unreadable',
        completeness: 0,
        summary: null,
        summaryEvidence: [],
        retrievedAt,
        verifiedAt: retrievedAt,
      },
      content: buildMaterialContent({ sourceUrl: target.url, text: '' }),
    });
    if (saved) materialsSaved += 1;
    else partial = true;
    partial = true;
  };
  const visitPage = async (
    page: ObservedPage,
    path: MaterialPathStep[],
    context: Pick<CourseListContext, 'assertReadable' | 'navigation'>,
    synthetic = false,
  ) => {
    const { assertReadable } = context;
    assertActive(page, assertReadable);
    if (
      !materialPagePattern.test(
        `${page.title} ${page.url} ${page.text ?? ''} ${page.links
          .map((link) => link.label)
          .join(' ')}`,
      )
    )
      return;
    const identity = academicPageIdentity(page.url);
    if (!identity || visited.has(identity)) return;
    if (pagesRead >= maxMaterialPages || modelCalls >= maxMaterialCalls) {
      partial = true;
      return;
    }
    visited.add(identity);
    pagesRead += 1;
    modelCalls += 1;
    const body = requestForPage(page, args, path.at(-1));
    try {
      const raw =
        context.navigation && !synthetic
          ? await context.navigation.extract({ ...body, kind: 'materials' })
          : await args.request(body);
      assertActive(page, assertReadable);
      const extraction = validateMaterialExtraction(body, raw);
      if (extraction.coverage === 'partial') partial = true;
      for (const material of extraction.materials) {
        if (academicPageIdentity(material.url) === identity) {
          saveMaterial(material, page);
          continue;
        }
        const target = body.targets?.find(
          (candidate) =>
            candidate.url === material.url &&
            material.evidence.targetIds.includes(candidate.id),
        );
        if (!target) {
          partial = true;
          continue;
        }
        enqueue(
          material.url,
          [
            ...path,
            {
              label: target.label,
              url: target.url,
              ...(target.context ? { context: target.context } : {}),
            },
          ],
          material.title,
          material.sourceType,
        );
      }
    } catch (error) {
      if (args.signal.aborted || !args.isCurrent()) throw error;
      partial = true;
    }
  };
  try {
    await visitPage(args.from, [], args.context);
    while (pending.length) {
      args.signal.throwIfAborted();
      if (!args.isCurrent())
        throw new Error('Your session changed; sign in again.');
      if (pagesRead >= maxMaterialPages || modelCalls >= maxMaterialCalls) {
        partial = true;
        break;
      }
      const target = pending.shift()!;
      queued.delete(target.url);
      try {
        await args.runOnCoursePage(async (courseContext) => {
          let current = courseContext.observed;
          if (!current) throw new Error('The course page could not be read.');
          for (const [index, step] of target.path.entries()) {
            const link = current.links.find(
              (candidate) =>
                academicPageIdentity(candidate.url) ===
                academicPageIdentity(step.url),
            );
            if (!link)
              throw new Error('The saved material link is no longer visible.');
            if (
              target.sourceType === 'pdf' &&
              index === target.path.length - 1
            ) {
              const downloaded = await courseContext.downloadPdf(
                current,
                link.url,
              );
              if (downloaded.status !== 'complete') {
                pagesRead += 1;
                saveUnreadablePdf(target);
                return;
              }
              const extracted = await extractPdfContent(downloaded.bytes, {
                signal: args.signal,
              });
              if (extracted.status === 'unreadable' || !extracted.text.trim()) {
                pagesRead += 1;
                saveUnreadablePdf(target);
                return;
              }
              if (extracted.status === 'partial') partial = true;
              current = {
                url: downloaded.url,
                title: target.title,
                text: extracted.text,
                links: [],
                retrievedAt: new Date().toISOString(),
              };
              break;
            }
            current = await courseContext.openFrom(current, link.url);
            assertActive(current, courseContext.assertReadable);
          }
          if (!pageMatchesRequestedTarget(current.url, target.url))
            throw new Error(
              'The material destination changed after navigation.',
            );
          await visitPage(
            current,
            target.path,
            courseContext,
            target.sourceType === 'pdf',
          );
        });
      } catch (error) {
        if (args.signal.aborted || !args.isCurrent()) throw error;
        partial = true;
      }
    }
    if (pending.length) partial = true;
    return {
      status: partial ? 'partial' : 'complete',
      materialsSaved,
      pagesRead,
    };
  } catch (error) {
    if (args.signal.aborted || !args.isCurrent()) throw error;
    return { status: 'partial', materialsSaved, pagesRead };
  }
};
