import { validateMaterialExtraction } from '@scholaros/services/ai/resources/material';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import { buildMaterialContent } from '../lib/material-content';
import {
  reconcileMaterialCollection,
  saveCourseMaterial,
} from './material-store';
import { extractPdfContent } from './pdf-content';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import type { NavigationLocationSelectData } from '../../../db/schema';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseListContext } from '../../onboarding/services/connection-scan';
import type { HostCourseCollectionCoverageEvidence } from '../../courses/types';
import {
  getNavigationLocations,
  saveNavigationLocation,
} from './navigation-store';

const maxMaterialPages = 20;
const maxMaterialDepth = 4;
const maxMaterialCalls = 40;
const materialPagePattern =
  /\b(?:book|books|chapter|chapters|content|document|documents|file|files|lecture|lectures|lesson|lessons|material|materials|module|modules|reading|readings|resource|resources|syllabus|textbook|unit|week)\b/i;

type MaterialPathStep = {
  label: string;
  url: string;
  parentUrl: string;
  targetId: string;
  isCollection?: boolean;
  context?: string;
};

type MaterialTarget = {
  url: string;
  path: MaterialPathStep[];
  title: string;
  sourceType: 'pdf' | 'other';
};

type MaterialCourseContext = CourseListContext & {
  visitKnownLocation?: (
    scopedRecord: NavigationLocationSelectData,
  ) => Promise<ObservedPage>;
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
  context: Pick<CourseListContext, 'assertReadable' | 'navigation'> & {
    visitKnownLocation?: MaterialCourseContext['visitKnownLocation'];
  };
  runOnCoursePage: (
    run: (context: MaterialCourseContext) => Promise<void>,
  ) => Promise<void>;
  request: (body: AgentRequestSchema) => Promise<unknown>;
  signal: AbortSignal;
  isCurrent: () => boolean;
};

type MaterialRefreshResult = {
  status: 'complete' | 'partial';
  materialsSaved: number;
  pagesRead: number;
  navigationLocationsReused: number;
  navigationLocationsRepaired: number;
  navigationLocationsSaved: number;
  hostCoverage: HostCourseCollectionCoverageEvidence;
};

const isWithinCoursePath = (pageUrl: string, courseUrl: string) => {
  const pageIdentity = academicPageIdentity(pageUrl);
  const courseIdentity = academicPageIdentity(courseUrl);
  if (!pageIdentity || !courseIdentity) return false;
  try {
    const page = new URL(pageIdentity);
    const course = new URL(courseIdentity);
    const coursePath = course.pathname.replace(/\/+$/, '') || '/';
    return (
      page.origin === course.origin &&
      (page.pathname === coursePath ||
        page.pathname.startsWith(`${coursePath}/`))
    );
  } catch {
    return false;
  }
};

const coursePathIdentifier = (value: string) => {
  const identity = academicPageIdentity(value);
  if (!identity) return null;
  try {
    const segments = new URL(identity).pathname.split('/').filter(Boolean);
    const markerIndex = segments.findIndex((segment) =>
      [
        'course',
        'courses',
        'class',
        'classes',
        'section',
        'sections',
        'classroom',
        'classrooms',
      ].includes(segment.toLowerCase()),
    );
    return markerIndex < 0 ? null : (segments[markerIndex + 1] ?? null);
  } catch {
    return null;
  }
};

const assertMaterialMembership = (
  from: ObservedPage,
  targetUrl: string,
  courseUrl: string,
  relationshipVerified: boolean,
) => {
  const targetIdentity = academicPageIdentity(targetUrl);
  if (
    !targetIdentity ||
    !from.links.some(
      (link) => academicPageIdentity(link.url) === targetIdentity,
    ) ||
    (!relationshipVerified && !isWithinCoursePath(from.url, courseUrl))
  ) {
    const membershipError = new Error(
      'The material is not linked from the selected course.',
    );
    membershipError.name = 'CourseMembershipError';
    throw membershipError;
  }
  const courseIdentifier = coursePathIdentifier(courseUrl);
  const targetIdentifier = coursePathIdentifier(targetIdentity);
  if (
    courseIdentifier &&
    targetIdentifier &&
    courseIdentifier !== targetIdentifier
  ) {
    const membershipError = new Error(
      'The material belongs to a different course.',
    );
    membershipError.name = 'CourseMembershipError';
    throw membershipError;
  }
};

const assertCourseScope = (
  page: ObservedPage,
  allowedHosts: string[],
  courseUrl: string,
  courseMembershipVerified: boolean,
  signal: AbortSignal,
  isCurrent: () => boolean,
  assertReadable: () => void,
) => {
  signal.throwIfAborted();
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  assertReadable();
  if (!isReadNavigation(page.url, allowedHosts))
    throw new Error('The material page left your connected resources.');
  if (!courseMembershipVerified && !isWithinCoursePath(page.url, courseUrl))
    throw new Error('The material page is not verified for this course.');
};

const observedEmptyMaterialEvidence = (
  page: ObservedPage,
): HostCourseCollectionCoverageEvidence['explicitEmptyEvidence'] => {
  const text = page.text ?? '';
  if (
    !/\b(?:no|none)\b[^.!?\n]{0,100}\b(?:course\s+)?(?:materials?|files?|documents?|readings?|resources?)\b/i.test(
      text,
    )
  )
    return null;
  return {
    kind: 'observed-empty-list',
    pageUrl: page.url,
    observedAt: page.retrievedAt ?? new Date().toISOString(),
  };
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
  const collectionUrls: string[] = [];
  const visitedPageUrls: string[] = [];
  const seenMaterialIds = new Set<string>();
  const cachedMaterialRouteIdentities = new Set<string>();
  const truncatedContentPages = new Set<string>();
  const gaps = {
    pendingPagination: false,
    unreadable: false,
    blockedRequiredData: false,
    truncated: false,
    invalidRecords: false,
    ambiguousIdentity: false,
    scopeUnverified: false,
  };
  let explicitEmptyEvidence: HostCourseCollectionCoverageEvidence['explicitEmptyEvidence'] =
    null;
  let pendingPageUrl: string | null = null;
  let partial = false;
  let pagesRead = 0;
  let modelCalls = 0;
  let materialsSaved = 0;
  let navigationLocationsReused = 0;
  let navigationLocationsRepaired = 0;
  let navigationLocationsSaved = 0;
  const saveObservedMaterialLocation = (
    page: ObservedPage,
    parentStep: MaterialPathStep,
  ) => {
    const pageIdentity = academicPageIdentity(page.url);
    if (
      (pageIdentity && cachedMaterialRouteIdentities.has(pageIdentity)) ||
      !isReadNavigation(page.url, [args.host]) ||
      !isWithinCoursePath(page.url, args.courseUrl) ||
      !isReadNavigation(parentStep.parentUrl, [args.host]) ||
      !isWithinCoursePath(parentStep.parentUrl, args.courseUrl)
    )
      return;
    const observedAt = page.retrievedAt ?? new Date().toISOString();
    const savedLocation = saveNavigationLocation(
      args.userId,
      args.connectionId,
      {
        courseId: args.courseId,
        purpose: 'materials',
        destinationUrl: page.url,
        parentUrl: parentStep.parentUrl,
        label: parentStep.label.slice(0, 200),
        evidence: {
          sourceUrl: parentStep.parentUrl,
          excerpts: [parentStep.label.slice(0, 500)],
          targetIds: [parentStep.targetId],
        },
        status: 'verified',
        destinationKind: 'collection',
        observedAt,
        verifiedAt: observedAt,
      },
    );
    if (savedLocation) navigationLocationsSaved += 1;
  };
  const assertActive = (
    page: ObservedPage,
    assertReadable: () => void,
    courseMembershipVerified: boolean,
  ) =>
    assertCourseScope(
      page,
      args.allowedHosts,
      args.courseUrl,
      courseMembershipVerified,
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
      gaps.truncated = true;
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
    const pageIdentity = academicPageIdentity(page.url);
    const truncated =
      material.readability === 'truncated' ||
      (page.linksTruncated ?? false) ||
      pageText.length > 16000 ||
      (pageIdentity !== null && truncatedContentPages.has(pageIdentity));
    let sourceText = pageText.trim() ? pageText : '';
    let content = buildMaterialContent({
      sourceUrl: material.url,
      text: sourceText,
      pageLocators: material.sourceType === 'pdf',
    });
    const unreadable =
      material.readability === 'unreadable' ||
      !sourceText ||
      content.passages.length === 0;
    if (unreadable) {
      sourceText = '';
      content = buildMaterialContent({
        sourceUrl: material.url,
        text: '',
        pageLocators: material.sourceType === 'pdf',
      });
    }
    const extractionStatus = unreadable
      ? 'unreadable'
      : truncated
        ? 'partial'
        : 'complete';
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
        summary: unreadable ? null : material.summary,
        summaryEvidence: unreadable
          ? []
          : material.summaryEvidence.map((excerpt) => ({
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
      gaps.invalidRecords = true;
      return;
    }
    materialsSaved += 1;
    if (saved.material.currentUsableVersion)
      seenMaterialIds.add(saved.material.id);
    if (unreadable || saved.outcome === 'preserved-current') {
      partial = true;
      gaps.unreadable = true;
    } else if (extractionStatus === 'partial') {
      partial = true;
      gaps.truncated = true;
    }
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
    if (saved) {
      materialsSaved += 1;
      if (saved.material.currentUsableVersion)
        seenMaterialIds.add(saved.material.id);
    } else {
      gaps.invalidRecords = true;
    }
    gaps.unreadable = true;
    partial = true;
  };
  const visitPage = async (
    page: ObservedPage,
    path: MaterialPathStep[],
    context: Pick<CourseListContext, 'assertReadable' | 'navigation'>,
    synthetic = false,
  ) => {
    const { assertReadable } = context;
    const courseMembershipVerified = path.length > 0;
    const identity = academicPageIdentity(page.url);
    if (!identity || visited.has(identity)) return;
    if (
      !courseMembershipVerified &&
      !isWithinCoursePath(page.url, args.courseUrl)
    ) {
      gaps.scopeUnverified = true;
      partial = true;
      return;
    }
    assertActive(page, assertReadable, courseMembershipVerified);
    visited.add(identity);
    if (!visitedPageUrls.includes(identity)) visitedPageUrls.push(identity);
    const matchesMaterialPattern = materialPagePattern.test(
      `${page.title} ${page.url} ${page.text ?? ''} ${page.links
        .map((link) => link.label)
        .join(' ')}`,
    );
    if (path.length === 0 && !matchesMaterialPattern) {
      if (!collectionUrls.length) {
        partial = true;
        gaps.scopeUnverified = true;
      }
      return;
    }
    if (matchesMaterialPattern || path.at(-1)?.isCollection) {
      if (!collectionUrls.includes(identity)) collectionUrls.push(identity);
    }
    if (page.linksTruncated || (page.text?.length ?? 0) > 16000) {
      gaps.truncated = true;
      partial = true;
    }
    const nextPage = page.links.find(
      (link) =>
        /^(?:next|next page|older|load more)$/i.test(link.label.trim()) &&
        isReadNavigation(link.url, args.allowedHosts),
    );
    if (nextPage) {
      gaps.pendingPagination = true;
      pendingPageUrl ??= academicPageIdentity(nextPage.url);
      partial = true;
    }
    if (pagesRead >= maxMaterialPages || modelCalls >= maxMaterialCalls) {
      partial = true;
      gaps.truncated = true;
      return;
    }
    pagesRead += 1;
    modelCalls += 1;
    const body = requestForPage(page, args, path.at(-1));
    if (identity && truncatedContentPages.has(identity) && body.context)
      body.context.truncated = true;
    try {
      const raw =
        context.navigation && !synthetic
          ? await context.navigation.extract({ ...body, kind: 'materials' })
          : await args.request(body);
      assertActive(page, assertReadable, courseMembershipVerified);
      const extraction = validateMaterialExtraction(body, raw, {
        courseMembershipVerified,
      });
      const emptyEvidence = observedEmptyMaterialEvidence(page);
      if (extraction.coverage === 'partial') {
        if (!(extraction.materials.length === 0 && emptyEvidence)) {
          partial = true;
          gaps.invalidRecords = true;
        }
      }
      if (!extraction.materials.length && !seenMaterialIds.size) {
        if (emptyEvidence && collectionUrls.includes(identity))
          explicitEmptyEvidence = emptyEvidence;
        else {
          partial = true;
          gaps.blockedRequiredData = true;
        }
      } else if (emptyEvidence) {
        explicitEmptyEvidence = null;
        gaps.invalidRecords = true;
        partial = true;
      }
      let hasObservedMaterialTarget = false;
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
          gaps.invalidRecords = true;
          continue;
        }
        hasObservedMaterialTarget = true;
        enqueue(
          material.url,
          [
            ...path,
            {
              label: target.label.slice(0, 200),
              url: target.url,
              parentUrl: page.url,
              targetId: target.id,
              ...(target.context ? { context: target.context } : {}),
            },
          ],
          material.title,
          material.sourceType,
        );
      }
      const parentStep = path.at(-1);
      if (hasObservedMaterialTarget) {
        if (!collectionUrls.includes(identity)) collectionUrls.push(identity);
        if (parentStep) saveObservedMaterialLocation(page, parentStep);
      }
    } catch (error) {
      if (args.signal.aborted || !args.isCurrent()) throw error;
      partial = true;
      gaps.blockedRequiredData = true;
    }
  };
  const visitKnownMaterialCollections = async () => {
    const visitKnownLocation = args.context.visitKnownLocation;
    if (!visitKnownLocation) return;
    const knownLocations = getNavigationLocations({
      userId: args.userId,
      connectionId: args.connectionId,
      courseId: args.courseId,
      purpose: 'materials',
    });
    if (!knownLocations) {
      partial = true;
      gaps.blockedRequiredData = true;
      return;
    }
    const knownRouteIdentities = new Set(
      knownLocations.map((location) =>
        academicPageIdentity(location.destinationUrl),
      ),
    );
    for (const location of knownLocations) {
      if (
        location.userId !== args.userId ||
        location.connectionId !== args.connectionId ||
        location.courseId !== args.courseId ||
        location.purpose !== 'materials' ||
        location.status !== 'verified' ||
        location.destinationKind !== 'collection' ||
        !location.parentUrl ||
        location.parentUrl !== location.evidence.sourceUrl ||
        !isReadNavigation(location.destinationUrl, args.allowedHosts) ||
        !isWithinCoursePath(location.destinationUrl, args.courseUrl) ||
        !isReadNavigation(location.parentUrl, args.allowedHosts) ||
        !isWithinCoursePath(location.parentUrl, args.courseUrl)
      )
        continue;
      args.signal.throwIfAborted();
      if (!args.isCurrent())
        throw new Error('Your session changed; sign in again.');
      try {
        const page = await visitKnownLocation(location);
        const identity = academicPageIdentity(page.url);
        if (
          !identity ||
          !isReadNavigation(page.url, args.allowedHosts) ||
          !isWithinCoursePath(page.url, args.courseUrl)
        )
          throw Object.assign(
            new Error('The saved material destination changed.'),
            { failureClass: 'wrong-course' as const },
          );
        assertActive(page, args.context.assertReadable, true);
        let verifiedLocation = location;
        if (identity !== academicPageIdentity(location.destinationUrl)) {
          const updatedLocations = getNavigationLocations({
            userId: args.userId,
            connectionId: args.connectionId,
            courseId: args.courseId,
            purpose: 'materials',
          });
          const repairedLocation = updatedLocations?.find(
            (candidate) =>
              candidate.userId === args.userId &&
              candidate.connectionId === args.connectionId &&
              candidate.courseId === args.courseId &&
              candidate.purpose === 'materials' &&
              candidate.status === 'verified' &&
              candidate.destinationKind === 'collection' &&
              academicPageIdentity(candidate.destinationUrl) === identity &&
              candidate.parentUrl !== null &&
              candidate.parentUrl === candidate.evidence.sourceUrl &&
              isReadNavigation(candidate.destinationUrl, args.allowedHosts) &&
              isWithinCoursePath(candidate.destinationUrl, args.courseUrl) &&
              isReadNavigation(candidate.parentUrl, args.allowedHosts) &&
              isWithinCoursePath(candidate.parentUrl, args.courseUrl),
          );
          if (!repairedLocation) {
            partial = true;
            gaps.scopeUnverified = true;
            continue;
          }
          verifiedLocation = repairedLocation;
        }
        cachedMaterialRouteIdentities.add(identity);
        if (knownRouteIdentities.has(identity)) navigationLocationsReused += 1;
        else navigationLocationsRepaired += 1;
        await visitPage(
          page,
          [
            {
              label: verifiedLocation.label ?? 'Course Materials',
              url: verifiedLocation.destinationUrl,
              parentUrl: verifiedLocation.parentUrl!,
              targetId:
                verifiedLocation.evidence.targetIds[0] ??
                'cached-material-route',
              isCollection: true,
              ...(verifiedLocation.evidence.excerpts[0]
                ? { context: verifiedLocation.evidence.excerpts[0] }
                : {}),
            },
          ],
          args.context,
        );
      } catch (error) {
        if (args.signal.aborted || !args.isCurrent()) throw error;
        partial = true;
        if (
          error &&
          typeof error === 'object' &&
          'failureClass' in error &&
          error.failureClass === 'wrong-course'
        )
          gaps.scopeUnverified = true;
        else gaps.blockedRequiredData = true;
      }
    }
  };
  const buildHostCoverage = (): HostCourseCollectionCoverageEvidence => {
    const currentVisitedPages = [...visitedPageUrls];
    const pagination: HostCourseCollectionCoverageEvidence['pagination'] =
      gaps.pendingPagination && pendingPageUrl
        ? {
            state: 'pending',
            visitedPageUrls: currentVisitedPages,
            nextPageUrl: pendingPageUrl,
          }
        : { state: 'not-applicable', visitedPageUrls: currentVisitedPages };
    return {
      ownerId: args.userId,
      connectionId: args.connectionId,
      courseId: args.courseId,
      collectionKind: 'materials',
      collectionUrls: [...collectionUrls],
      observedAt: args.from.retrievedAt ?? new Date().toISOString(),
      usableItemCount: seenMaterialIds.size,
      pagination,
      explicitEmptyEvidence: seenMaterialIds.size
        ? null
        : explicitEmptyEvidence,
      gaps: { ...gaps },
    };
  };
  const finish = (): MaterialRefreshResult => {
    if (pending.length) {
      partial = true;
      gaps.truncated = true;
      pendingPageUrl ??= pending[0]?.url ?? null;
    }
    let status: MaterialRefreshResult['status'] =
      partial || Object.values(gaps).some(Boolean) || !collectionUrls.length
        ? 'partial'
        : 'complete';
    let hostCoverage = buildHostCoverage();
    if (status === 'complete') {
      const reconciled = reconcileMaterialCollection(
        {
          userId: args.userId,
          connectionId: args.connectionId,
          courseId: args.courseId,
        },
        {
          coverage: hostCoverage,
          seenIds: [...seenMaterialIds],
        },
      );
      if (!reconciled) {
        status = 'partial';
        gaps.scopeUnverified = true;
        hostCoverage = buildHostCoverage();
      }
    }
    return {
      status,
      materialsSaved,
      pagesRead,
      navigationLocationsReused,
      navigationLocationsRepaired,
      navigationLocationsSaved,
      hostCoverage,
    };
  };
  try {
    await visitKnownMaterialCollections();
    await visitPage(args.from, [], args.context);
    while (pending.length) {
      args.signal.throwIfAborted();
      if (!args.isCurrent())
        throw new Error('Your session changed; sign in again.');
      if (pagesRead >= maxMaterialPages || modelCalls >= maxMaterialCalls) {
        partial = true;
        gaps.truncated = true;
        pendingPageUrl ??= pending[0]?.url ?? null;
        break;
      }
      const target = pending.shift()!;
      queued.delete(target.url);
      const targetIdentity = academicPageIdentity(target.url);
      if (targetIdentity && visited.has(targetIdentity)) continue;
      try {
        await args.runOnCoursePage(async (courseContext) => {
          let current = courseContext.observed;
          if (!current) throw new Error('The course page could not be read.');
          for (const [index, step] of target.path.entries()) {
            assertActive(current, courseContext.assertReadable, index > 0);
            const link = current.links.find(
              (candidate) =>
                academicPageIdentity(candidate.url) ===
                academicPageIdentity(step.url),
            );
            assertMaterialMembership(
              current,
              step.url,
              args.courseUrl,
              index > 0,
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
                gaps.unreadable = true;
                saveUnreadablePdf(target);
                return;
              }
              const extracted = await extractPdfContent(downloaded.bytes, {
                signal: args.signal,
              });
              if (extracted.status === 'unreadable' || !extracted.text.trim()) {
                pagesRead += 1;
                gaps.unreadable = true;
                saveUnreadablePdf(target);
                return;
              }
              if (extracted.status === 'partial') {
                partial = true;
                gaps.truncated = true;
                const extractedIdentity = academicPageIdentity(downloaded.url);
                if (extractedIdentity)
                  truncatedContentPages.add(extractedIdentity);
              }
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
            assertActive(current, courseContext.assertReadable, true);
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
        if (error instanceof Error && error.name === 'CourseMembershipError')
          gaps.scopeUnverified = true;
        else gaps.blockedRequiredData = true;
      }
    }
    return finish();
  } catch (error) {
    if (args.signal.aborted || !args.isCurrent()) throw error;
    partial = true;
    gaps.blockedRequiredData = true;
    return finish();
  }
};
