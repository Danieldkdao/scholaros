import { validateResourceExtraction } from '@scholaros/services/ai/resources/validation';
import {
  reconcileResourceIdentities,
  type ResourceIdentityRecord,
  type ResourceIdentityScope,
} from '@scholaros/services/ai/resources/identity';
import { resourceItem, resourceRequest } from './resource-content';
import { navigationDecisionSchema } from '@scholaros/services/ai/schemas';
import type { ResourceExtractionRequest } from '../../onboarding/services/browser-navigation';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import {
  childPageTarget,
  pageHasMorePages,
  pageListsNothing,
  pageReportsZeroCount,
  type CourseChildKind,
} from './course-content';
import {
  getNavigationLocations,
  markNavigationLocationStale,
  recordNavigationLocationFailure,
} from '../../context/services/navigation-store';
import { navigationLocationRowSchema } from '../../context/schemas';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseListContext } from '../../onboarding/services/connection-scan';
import type {
  CourseChildItem,
  CourseChildScan,
  CourseCollectionInterruption,
  CourseCollectionInterruptionCategory,
  CourseScanStatus,
  HostCourseCollectionCoverageEvidence,
} from '../types';
import type { NavigationLocationSelectData } from '../../../db/schema';
import type { NavigationFailureClass } from '../../context/types';

type TrackedChildItem = {
  item: CourseChildItem;
  resource: ResourceIdentityRecord;
  inactive: boolean;
};

type KnownCourseLocation =
  | NavigationLocationSelectData
  | {
      purpose: CourseChildKind;
      destinationUrl: string;
      destinationKind: 'summary' | 'collection' | 'detail';
      status: 'tentative' | 'verified' | 'stale';
    };

const parsePersistedNavigationLocation = (
  location: unknown,
): NavigationLocationSelectData | null => {
  const parsed = navigationLocationRowSchema.safeParse(location);
  return parsed.success ? parsed.data : null;
};

type CourseChildScanWithCoverage = CourseChildScan & {
  interruption: CourseCollectionInterruption | null;
  hostCoverage: HostCourseCollectionCoverageEvidence | null;
};

type PendingNavigationRepair = {
  failedIdentity: string;
  failedLocationId: string;
};

const navigationFailureClass = (error: unknown): NavigationFailureClass => {
  const errorObject =
    error && typeof error === 'object'
      ? (error as { failureClass?: unknown; message?: unknown })
      : null;
  const failureClass = errorObject?.failureClass;
  if (
    failureClass === 'not-found' ||
    failureClass === 'wrong-account' ||
    failureClass === 'wrong-course' ||
    failureClass === 'missing-control' ||
    failureClass === 'rate-limited' ||
    failureClass === 'needs-sign-in' ||
    failureClass === 'network' ||
    failureClass === 'unknown'
  )
    return failureClass;
  const message =
    typeof errorObject?.message === 'string' ? errorObject.message : '';
  if (/sign in|password|authentication/i.test(message)) return 'needs-sign-in';
  if (/rate.?limit|429|too many requests/i.test(message)) return 'rate-limited';
  if (
    /network|timeout|timed out|fetch failed|could not be loaded|net::/i.test(
      message,
    )
  )
    return 'network';
  if (/not found|404|gone/i.test(message)) return 'not-found';
  if (/wrong course|unexpected course|course scope/i.test(message))
    return 'wrong-course';
  if (/missing (?:link|control)|no longer on the page/i.test(message))
    return 'missing-control';
  return 'unknown';
};

const interruptionCategory = (
  error: unknown,
): CourseCollectionInterruptionCategory => {
  const errorObject =
    error && typeof error === 'object'
      ? (error as { code?: unknown; name?: unknown })
      : null;
  if (
    errorObject?.code === 'capability-changed' ||
    errorObject?.name === 'BrowserCapabilityChangedError'
  )
    return 'capability-changed';
  if (errorObject?.code === 'cancelled') return 'cancelled';
  const failureClass = navigationFailureClass(error);
  switch (failureClass) {
    case 'needs-sign-in':
      return 'needs-sign-in';
    case 'rate-limited':
      return 'rate-limited';
    case 'network':
      return 'network';
    case 'wrong-account':
    case 'wrong-course':
      return 'scope-unverified';
    case 'not-found':
    case 'missing-control':
    case 'unknown':
      return 'navigation-changed';
  }
};

const collectionFailureReason = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  if (
    /Cannot find (?:execution )?context|Execution context (?:was )?destroyed/i.test(
      message,
    )
  )
    return 'document-context-replaced';
  if (/page changed|unexpected.*page|changed during navigation/i.test(message))
    return 'document-changed';
  if (
    /schema|unsupported browser response|unreadable course data/i.test(
      message,
    ) ||
    (error instanceof Error && error.name === 'ZodError')
  )
    return 'invalid-model-output';
  if (/scope|approved course|course membership/i.test(message))
    return 'course-scope-unverified';
  if (
    /not found|no longer.*(?:link|visible)|could not.*(?:open|load)/i.test(
      message,
    )
  )
    return 'destination-unavailable';
  if (/sign in|password/i.test(message)) return 'sign-in-required';
  if (/rate.?limit|quota|429|slow down/i.test(message)) return 'rate-limited';
  if (/timeout|timed out/i.test(message)) return 'timed-out';
  return 'unknown';
};

type VerifiedCourseLocation = {
  purpose: CourseChildKind;
  destinationUrl: string;
  parentUrl: string | null;
  recipe: NavigationLocationSelectData['recipe'];
  label: string | null;
  evidence: {
    sourceUrl: string;
    excerpts: string[];
    targetIds: string[];
  };
  status: 'verified';
  destinationKind: 'collection';
  observedAt: string;
  verifiedAt: string;
};

const contentConflicts = (resources: ResourceIdentityRecord[]) => {
  const fields = [
    'title',
    'description',
    'body',
    'author',
    'kind',
    'state',
    'due',
    'availableFrom',
    'availableUntil',
    'published',
    'updated',
    'pointsPossible',
  ];
  return fields.some((field) => {
    const values = resources.flatMap((resource) => {
      const value = (resource as unknown as Record<string, unknown>)[field];
      if (value === null || value === undefined || value === '') return [];
      if (field === 'state' && value === 'unknown') return [];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const { original, ...date } = value as Record<string, unknown>;
        return [
          JSON.stringify({
            ...date,
            ...(date.kind === 'unresolved' ? { original } : {}),
          }),
        ];
      }
      return [JSON.stringify(value)];
    });
    return new Set(values).size > 1;
  });
};

const mergeChildCandidate = (tracked: TrackedChildItem[]) => {
  const detailPages = tracked.filter(
    ({ resource }) =>
      !!resource.url &&
      new URL(resource.url).href === new URL(resource.evidence.sourceUrl).href,
  );
  const selected = detailPages[0] ?? tracked[0]!;
  const resources = tracked.map(({ resource }) => resource);
  const selectedContent = selected.item.content;
  if (!selectedContent) return selected.item;
  const content = { ...selectedContent } as unknown as Record<string, unknown>;
  for (const field of [
    'sourceId',
    'url',
    'description',
    'body',
    'author',
    'kind',
    'state',
    'due',
    'availableFrom',
    'availableUntil',
    'published',
    'updated',
    'pointsPossible',
  ]) {
    if (
      content[field] !== null &&
      content[field] !== undefined &&
      content[field] !== 'unknown'
    )
      continue;
    const available = resources
      .map(
        (resource) => (resource as unknown as Record<string, unknown>)[field],
      )
      .find(
        (value) => value !== null && value !== undefined && value !== 'unknown',
      );
    if (available !== undefined) content[field] = available;
  }
  content.resources = [
    ...new Map(
      tracked.flatMap(({ resource }) => {
        const links =
          (
            resource as unknown as {
              resources?: Array<{
                targetId: string;
                url: string;
                label: string;
              }>;
            }
          ).resources ?? [];
        return links.map(
          (link) => [`${link.url}\n${link.label}`, link] as const,
        );
      }),
    ).values(),
  ].slice(0, 30);
  const sameSourcePage = resources.every(
    (resource) =>
      resource.evidence.sourceUrl === selectedContent.evidence.sourceUrl,
  );
  if (sameSourcePage)
    content.evidence = {
      ...selectedContent.evidence,
      excerpts: [
        ...new Set(resources.flatMap((resource) => resource.evidence.excerpts)),
      ].slice(0, 4),
      targetIds: [
        ...new Set(
          resources.flatMap((resource) => resource.evidence.targetIds ?? []),
        ),
      ].slice(0, 30),
    };
  const retrievedAt = tracked
    .map(({ item }) => item.retrievedAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
  return resourceItem(
    content as unknown as NonNullable<CourseChildItem['content']>,
    retrievedAt,
  );
};

export const scanCourseCollection = async ({
  from,
  kind,
  host,
  allowedHosts = [host],
  identityScope,
  knownNavigationLocations = [],
  memory,
  onNavigationVerified,
  onModelCall,
  onError,
  courseName,
  excludedUrls,
  notes,
  context,
  request,
  signal,
  isCurrent,
  onProgress,
}: {
  from: ObservedPage;
  kind: CourseChildKind;
  host: string;
  allowedHosts?: string[];
  identityScope?: Omit<ResourceIdentityScope, 'kind'>;
  knownNavigationLocations?: KnownCourseLocation[];
  memory?: AgentRequestSchema['memory'];
  onNavigationVerified?: (
    location: VerifiedCourseLocation,
  ) =>
    | NavigationLocationSelectData
    | null
    | void
    | Promise<NavigationLocationSelectData | null | void>;
  onModelCall?: () => void;
  onError?: (message: string) => void;
  courseName: string;
  excludedUrls: string[];
  notes: string;
  context: Pick<
    CourseListContext,
    | 'openFrom'
    | 'assertReadable'
    | 'revealContent'
    | 'navigation'
    | 'readCurrent'
    | 'visitKnownLocation'
    | 'hasBlockedRequiredData'
  >;
  request: (body: AgentRequestSchema) => Promise<unknown>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onProgress?: (scan: CourseChildScanWithCoverage) => void;
}): Promise<CourseChildScanWithCoverage> => {
  const items = new Map<string, CourseChildItem>();
  const inactiveItems = new Map<string, CourseChildItem>();
  const unknownAssignments = new Map<
    string,
    { aliases: string[]; url: string | null }
  >();
  const rootIdentity = academicPageIdentity(from.url) ?? from.url;
  const direct = childPageTarget(from, kind, host);
  const directIdentity = direct
    ? (academicPageIdentity(direct) ?? direct)
    : null;
  const excludedIdentities = excludedUrls
    .map((url) => academicPageIdentity(url))
    .filter((url): url is string => !!url);
  const isExcluded = (url: string) => {
    const identity = academicPageIdentity(url);
    return (
      !!identity &&
      excludedIdentities.some(
        (excluded) =>
          identity === excluded ||
          (!rootIdentity.startsWith(`${excluded}/`) &&
            identity.startsWith(`${excluded}/`)),
      )
    );
  };
  const scopedKnownLocations = knownNavigationLocations.flatMap((candidate) => {
    const location = parsePersistedNavigationLocation(candidate);
    return location &&
      location.userId === identityScope?.accountId &&
      location.connectionId === identityScope?.connectionId &&
      location.courseId === identityScope?.courseId &&
      location.purpose === kind &&
      location.status === 'verified' &&
      location.destinationKind === 'collection' &&
      !!location.parentUrl &&
      location.parentUrl === location.evidence.sourceUrl &&
      isReadNavigation(location.destinationUrl, [host]) &&
      !isExcluded(location.destinationUrl)
      ? [location]
      : [];
  });
  const seen = new Set<string>([rootIdentity]);
  const visitedPages = new Set<string>();
  const frontier = new Map<
    string,
    { from: ObservedPage; label: string; url: string }
  >();
  const revealedStates = new Set<string>();
  const collectionGaps = new Map<
    string,
    { collection: string; summary: boolean; truncated: boolean }
  >();
  const collectionByPage = new Map<string, string>([
    [rootIdentity, directIdentity ?? rootIdentity],
  ]);
  if (directIdentity) collectionByPage.set(directIdentity, directIdentity);
  const parentByPage = new Map<string, { parentUrl: string; label: string }>();
  const savedNavigationPages = new Set<string>();
  const reusedNavigationPages = new Set<string>();
  const attemptedKnownLocations = new Set<string>();
  const visitedPageUrls = new Map<string, string>();
  const collectionUrls = new Map<string, string>();
  const paginationUrls = new Map<string, string>();
  const pendingNavigationRepairs = new Map<string, PendingNavigationRepair>();
  const emptyEvidencePages = new Map<
    string,
    NonNullable<HostCourseCollectionCoverageEvidence['explicitEmptyEvidence']>
  >();
  const navigationGaps = new Set<string>();
  const disclosureGaps = new Set<string>();
  const navigationFailures = new Set<string>();
  const extractionFailures = new Set<string>();
  let saving = false;
  let verified = false;
  let navigationRepairCount = 0;
  const unreadablePages = new Set<string>();
  let blockedRequiredData = false;
  let truncatedCoverage = false;
  let invalidRecordCoverage = false;
  const scopeUnverifiedPages = new Set<string>();
  let extractedCandidateCount = 0;
  let pendingNavigation: string | null = null;
  let currentIdentity = rootIdentity;
  let calls = 0;
  const pagination = new Set<string>();
  const reserveCall = () => {
    if (++calls > 100)
      throw new Error(
        'The refresh reached its reading limit; refresh again to continue.',
      );
  };
  const requestBounded = (body: AgentRequestSchema) => {
    reserveCall();
    if (context.navigation && body.kind !== 'choose') {
      onModelCall?.();
      return context.navigation.extract(body as ResourceExtractionRequest);
    }
    return request(body);
  };
  const assertActive = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    context.assertReadable();
  };
  const goal = `Find all ${kind === 'assignments' ? 'currently active, unsubmitted assignments with their own due dates (including overdue work still open)' : 'announcements'} for ${courseName.slice(0, 100)} only; stay within this course and stop when this task is done, as of ${new Date().toISOString()}; verify lists and item details.`;
  const finish = (
    status: CourseScanStatus,
    interruption: CourseCollectionInterruption | null = null,
    reportDiagnostic = true,
  ): CourseChildScanWithCoverage => {
    const tracked: TrackedChildItem[] = [
      ...[...items.values()].map((item) => ({ item, inactive: false })),
      ...[...inactiveItems.values()].map((item) => ({ item, inactive: true })),
    ].map(({ item, inactive }) => ({
      item,
      inactive,
      resource:
        item.content ??
        ({
          title: item.title,
          sourceId: null,
          url: null,
          evidence: { sourceUrl: item.url, excerpts: [] },
        } satisfies ResourceIdentityRecord),
    }));
    const resources = new Map(
      tracked.map((entry) => [entry.resource, entry] as const),
    );
    const reconciled = reconcileResourceIdentities(
      tracked.map(({ resource }) => ({
        scope: {
          accountId: identityScope?.accountId ?? 'scan',
          connectionId: identityScope?.connectionId ?? host,
          courseId: identityScope?.courseId ?? rootIdentity,
          kind,
        },
        resource,
      })),
    );
    const ambiguousResources = new Set(
      reconciled.ambiguities.flatMap((ambiguity) => ambiguity.resources),
    );
    const reconciledItems: CourseChildItem[] = [];
    const reconciledInactiveItems: CourseChildItem[] = [];
    let ambiguous = reconciled.ambiguities.length > 0;
    let contentConflictCount = 0;
    for (const candidate of reconciled.candidates) {
      const candidateTracked = candidate.resources
        .map((resource) => resources.get(resource)!)
        .filter(Boolean);
      if (
        candidateTracked.some(({ resource }) =>
          ambiguousResources.has(resource),
        )
      ) {
        for (const entry of candidateTracked)
          (entry.inactive ? reconciledInactiveItems : reconciledItems).push(
            entry.item,
          );
        continue;
      }
      if (
        candidateTracked.length > 1 &&
        contentConflicts(candidate.resources) &&
        candidateTracked.filter(
          ({ resource }) =>
            !!resource.url &&
            new URL(resource.url).href ===
              new URL(resource.evidence.sourceUrl).href,
        ).length !== 1
      ) {
        ambiguous = true;
        contentConflictCount += 1;
        for (const entry of candidateTracked)
          (entry.inactive ? reconciledInactiveItems : reconciledItems).push(
            entry.item,
          );
        continue;
      }
      const merged = mergeChildCandidate(candidateTracked);
      const inactive = candidateTracked.some(
        ({ inactive: itemInactive }) => itemInactive,
      );
      (inactive ? reconciledInactiveItems : reconciledItems).push(merged);
    }
    const usableItemCount =
      reconciledItems.length + reconciledInactiveItems.length;
    const allVisitedUrls = [...visitedPageUrls.values()];
    const paginationVisitedUrls = allVisitedUrls.slice(0, 100);
    const paginationVisitedSet = new Set(paginationVisitedUrls);
    const collectionPageUrls = [...collectionUrls.values()]
      .filter((url) => paginationVisitedSet.has(url))
      .slice(0, 30);
    const pendingPagination = [...pagination].find(
      (identity) => !visitedPages.has(identity),
    );
    if (collectionUrls.size > 30 || allVisitedUrls.length > 100)
      truncatedCoverage = true;
    const paginationEvidence = pendingPagination
      ? {
          state: 'pending' as const,
          visitedPageUrls: paginationVisitedUrls,
          nextPageUrl:
            paginationUrls.get(pendingPagination) ?? pendingPagination,
        }
      : pagination.size
        ? {
            state: 'exhausted' as const,
            visitedPageUrls: paginationVisitedUrls,
          }
        : {
            state: 'not-applicable' as const,
            visitedPageUrls: paginationVisitedUrls,
          };
    const explicitEmptyEvidence =
      usableItemCount === 0
        ? ([...emptyEvidencePages.values()].find((evidence) =>
            collectionPageUrls.includes(evidence.pageUrl),
          ) ?? null)
        : null;
    const hostCoverage =
      identityScope?.accountId &&
      identityScope.connectionId &&
      identityScope.courseId &&
      allVisitedUrls.length
        ? {
            ownerId: identityScope.accountId,
            connectionId: identityScope.connectionId,
            courseId: identityScope.courseId,
            collectionKind: kind,
            collectionUrls: collectionPageUrls,
            observedAt: from.retrievedAt ?? new Date().toISOString(),
            usableItemCount,
            pagination: paginationEvidence,
            explicitEmptyEvidence,
            gaps: {
              pendingPagination: !!pendingPagination,
              unreadable:
                unreadablePages.size > 0 || extractionFailures.size > 0,
              blockedRequiredData,
              truncated: truncatedCoverage,
              invalidRecords:
                invalidRecordCoverage || unknownAssignments.size > 0,
              ambiguousIdentity: ambiguous,
              scopeUnverified:
                scopeUnverifiedPages.size > 0 ||
                collectionPageUrls.length === 0 ||
                collectionGaps.size > 0 ||
                navigationGaps.size > 0 ||
                navigationFailures.size > 0 ||
                disclosureGaps.size > 0,
            },
          }
        : null;
    const completeCoverage =
      !!hostCoverage &&
      collectionPageUrls.length > 0 &&
      paginationEvidence.state !== 'pending' &&
      !Object.values(hostCoverage.gaps).some(Boolean) &&
      (usableItemCount > 0 || !!explicitEmptyEvidence);
    const finalStatus =
      status === 'complete' &&
      (!completeCoverage || ambiguous || interruption !== null)
        ? 'partial'
        : status;
    if (reportDiagnostic)
      console.info('[course-refresh] collection result', {
        kind,
        status: finalStatus,
        pagesVisited: visitedPages.size,
        modelCalls: calls,
        candidates: extractedCandidateCount,
        retainedRecords: usableItemCount,
        collectionPages: collectionPageUrls.length,
        unknownAssignments: unknownAssignments.size,
        gaps: hostCoverage?.gaps ?? null,
        navigationFailures: navigationFailures.size,
        extractionFailures: extractionFailures.size,
        disclosureGaps: disclosureGaps.size,
        interruption: interruption?.category ?? null,
      });
    return {
      status: finalStatus,
      interruption,
      hostCoverage,
      items: reconciledItems,
      metrics: {
        candidatesExtracted: extractedCandidateCount,
        duplicatesReconciled: Math.max(
          0,
          extractedCandidateCount - reconciled.candidates.length,
        ),
        ambiguousIdentityConflicts:
          reconciled.ambiguities.length + contentConflictCount,
        knownDestinationsReused: reusedNavigationPages.size,
        navigationRepairs: navigationRepairCount,
      },
      ...(reconciledInactiveItems.length
        ? { inactiveItems: reconciledInactiveItems }
        : {}),
    };
  };
  const assignmentAliases = (record: {
    sourceId: string | null;
    url: string | null;
    title: string;
    evidence: { sourceUrl: string };
  }) => {
    const aliases = [
      ...(record.sourceId ? [`id:${record.sourceId}`] : []),
      ...(record.url
        ? [`url:${academicPageIdentity(record.url) ?? record.url}`]
        : []),
      `item:${academicPageIdentity(record.evidence.sourceUrl) ?? record.evidence.sourceUrl}\n${record.title.toLowerCase()}`,
    ];
    return aliases;
  };
  const matchingUnknown = (aliases: string[]) =>
    [...unknownAssignments.entries()].find(([, unknown]) => {
      for (const prefix of ['id:', 'url:']) {
        const current = aliases.find((alias) => alias.startsWith(prefix));
        const previous = unknown.aliases.find((alias) =>
          alias.startsWith(prefix),
        );
        if (current && previous) return current === previous;
      }
      return unknown.aliases.some((alias) => aliases.includes(alias));
    })?.[0];
  const hasUnknownUrl = (url: string) => {
    const identity = academicPageIdentity(url) ?? url;
    return [...unknownAssignments.values()].some(
      (unknown) => unknown.url === identity,
    );
  };
  try {
    let current = from;
    while (true) {
      assertActive();
      currentIdentity = academicPageIdentity(current.url) ?? current.url;
      seen.add(currentIdentity);
      visitedPages.add(currentIdentity);
      visitedPageUrls.set(currentIdentity, current.url);
      blockedRequiredData ||= context.hasBlockedRequiredData?.() ?? false;
      frontier.delete(currentIdentity);
      if (current.linksTruncated) {
        navigationGaps.add(currentIdentity);
        truncatedCoverage = true;
      } else navigationGaps.delete(currentIdentity);
      for (const link of current.links) {
        if (pageHasMorePages({ ...current, links: [link] })) {
          const paginationIdentity = academicPageIdentity(link.url) ?? link.url;
          pagination.add(paginationIdentity);
          paginationUrls.set(paginationIdentity, link.url);
        }
        const identity = academicPageIdentity(link.url);
        if (identity && !collectionByPage.has(identity))
          collectionByPage.set(
            identity,
            pageHasMorePages({ ...current, links: [link] })
              ? (collectionByPage.get(currentIdentity) ?? currentIdentity)
              : identity,
          );
        if (
          !identity ||
          seen.has(identity) ||
          isExcluded(link.url) ||
          !isReadNavigation(link.url, [host])
        )
          continue;
        frontier.set(identity, {
          from: current,
          label: link.label,
          url: link.url,
        });
      }
      const text = current.text ?? '';
      // Overlap keeps an item split at a request boundary visible to extraction.
      for (let offset = 0; offset < Math.max(text.length, 1); offset += 11000) {
        assertActive();
        const body = resourceRequest({
          page: {
            ...current,
            text: text.slice(offset, offset + 12000),
            links: current.links.filter((link) => !isExcluded(link.url)),
          },
          kind,
          goal,
          notes,
          host,
          allowedHosts,
          courseUrl: from.url,
          courseName,
          truncated: text.length > 12000,
        });
        body.memory = memory;
        let result: ReturnType<typeof validateResourceExtraction>;
        try {
          const output = await requestBounded(body);
          assertActive();
          const modelClaimedComplete =
            !!output &&
            typeof output === 'object' &&
            'coverage' in output &&
            output.coverage === 'complete';
          result = validateResourceExtraction(body, kind, output);
          if (modelClaimedComplete && result.coverage === 'partial')
            invalidRecordCoverage = true;
        } catch (error) {
          extractionFailures.add(currentIdentity);
          throw error;
        }
        const records =
          'assignments' in result ? result.assignments : result.announcements;
        const hasObservedRecords = records.some(
          (record) =>
            (academicPageIdentity(record.evidence.sourceUrl) ??
              record.evidence.sourceUrl) === currentIdentity,
        );
        const hasZeroCount = pageReportsZeroCount(current, kind);
        const hasExplicitEmptyList = pageListsNothing(current, kind);
        const hasCollectionIdentity =
          currentIdentity === directIdentity ||
          scopedKnownLocations.some(
            (location) =>
              (academicPageIdentity(location.destinationUrl) ??
                location.destinationUrl) === currentIdentity,
          ) ||
          hasObservedRecords ||
          hasExplicitEmptyList ||
          hasZeroCount;
        if (hasCollectionIdentity)
          collectionUrls.set(currentIdentity, current.url);
        if ((hasExplicitEmptyList || hasZeroCount) && hasCollectionIdentity)
          emptyEvidencePages.set(
            currentIdentity,
            hasZeroCount
              ? {
                  kind: 'observed-zero-count',
                  pageUrl: current.url,
                  count: 0,
                  observedAt: current.retrievedAt ?? new Date().toISOString(),
                }
              : {
                  kind: 'observed-empty-list',
                  pageUrl: current.url,
                  observedAt: current.retrievedAt ?? new Date().toISOString(),
                },
          );
        extractedCandidateCount += records.length;
        if (body.context?.truncated) truncatedCoverage = true;
        if (result.coverage === 'complete') {
          if (hasCollectionIdentity) {
            verified = true;
            collectionGaps.delete(currentIdentity);
            const collectionIdentity =
              collectionByPage.get(currentIdentity) ?? currentIdentity;
            for (const [pageIdentity, gap] of collectionGaps)
              if (gap.summary && gap.collection === collectionIdentity) {
                collectionGaps.delete(pageIdentity);
                scopeUnverifiedPages.delete(pageIdentity);
                unreadablePages.delete(pageIdentity);
              }
          } else {
            scopeUnverifiedPages.add(currentIdentity);
            collectionGaps.set(currentIdentity, {
              collection:
                collectionByPage.get(currentIdentity) ?? currentIdentity,
              summary: currentIdentity === rootIdentity && !!directIdentity,
              truncated: !!body.context?.truncated,
            });
          }
          if (
            hasCollectionIdentity &&
            result.detailRecord !== true &&
            !savedNavigationPages.has(currentIdentity)
          ) {
            const parent = parentByPage.get(currentIdentity);
            const verifiedAt = new Date().toISOString();
            const evidenceText = current.text?.trim().slice(0, 500) ?? '';
            const observation: VerifiedCourseLocation = {
              purpose: kind,
              destinationUrl: current.url,
              parentUrl: parent?.parentUrl ?? null,
              recipe: parent
                ? {
                    version: 1,
                    steps: [
                      {
                        kind: 'click-link',
                        label: (parent.label || kind).slice(0, 200),
                        url: current.url,
                      },
                    ],
                  }
                : null,
              label: (parent?.label || current.title || kind).slice(0, 200),
              evidence: {
                sourceUrl: parent?.parentUrl ?? current.url,
                excerpts: parent?.label
                  ? [parent.label.slice(0, 500)]
                  : evidenceText
                    ? [evidenceText]
                    : [],
                targetIds: [],
              },
              status: 'verified',
              destinationKind: 'collection',
              observedAt: current.retrievedAt ?? verifiedAt,
              verifiedAt,
            };
            if (onNavigationVerified) {
              let returnedLocation: unknown = null;
              try {
                saving = true;
                returnedLocation = await onNavigationVerified(observation);
              } catch {
                navigationGaps.add(currentIdentity);
              } finally {
                saving = false;
              }
              const savedLocation =
                parsePersistedNavigationLocation(returnedLocation);
              const readbackLocation =
                savedLocation || !identityScope
                  ? null
                  : (getNavigationLocations({
                      userId: identityScope.accountId,
                      connectionId: identityScope.connectionId,
                      courseId: identityScope.courseId,
                      purpose: kind,
                    })?.find(
                      (location) =>
                        location.userId === identityScope.accountId &&
                        location.connectionId === identityScope.connectionId &&
                        location.courseId === identityScope.courseId &&
                        location.purpose === kind &&
                        location.status === 'verified' &&
                        location.destinationKind === 'collection' &&
                        location.verifiedAt === verifiedAt &&
                        (academicPageIdentity(location.destinationUrl) ??
                          location.destinationUrl) === currentIdentity,
                    ) ?? null);
              const persistedLocation = savedLocation ?? readbackLocation;
              if (
                persistedLocation &&
                identityScope &&
                persistedLocation.userId === identityScope.accountId &&
                persistedLocation.connectionId === identityScope.connectionId &&
                persistedLocation.courseId === identityScope.courseId &&
                persistedLocation.purpose === kind &&
                persistedLocation.status === 'verified' &&
                persistedLocation.destinationKind === 'collection' &&
                (academicPageIdentity(persistedLocation.destinationUrl) ??
                  persistedLocation.destinationUrl) === currentIdentity
              ) {
                savedNavigationPages.add(currentIdentity);
                const repair = pendingNavigationRepairs.get(currentIdentity);
                if (repair) {
                  navigationRepairCount += 1;
                  navigationFailures.delete(repair.failedIdentity);
                  navigationGaps.delete(repair.failedIdentity);
                  scopeUnverifiedPages.delete(rootIdentity);
                  pendingNavigationRepairs.delete(currentIdentity);
                }
              } else {
                navigationGaps.add(currentIdentity);
              }
            }
          }
          if (directIdentity && currentIdentity === directIdentity) {
            for (const [pageIdentity, gap] of collectionGaps)
              if (
                gap.summary &&
                gap.collection === directIdentity &&
                (!gap.truncated || gap.collection === currentIdentity)
              ) {
                collectionGaps.delete(pageIdentity);
                unreadablePages.delete(pageIdentity);
              }
          }
        } else if (result.coverage === 'partial') {
          if (body.context?.truncated) truncatedCoverage = true;
          collectionGaps.set(currentIdentity, {
            collection:
              collectionByPage.get(currentIdentity) ?? currentIdentity,
            summary: currentIdentity === rootIdentity && !!directIdentity,
            truncated: !!body.context?.truncated,
          });
        } else if (result.coverage === 'unavailable') {
          unreadablePages.add(currentIdentity);
          collectionGaps.set(currentIdentity, {
            collection:
              collectionByPage.get(currentIdentity) ?? currentIdentity,
            summary: currentIdentity === rootIdentity && !!directIdentity,
            truncated: !!body.context?.truncated,
          });
        }
        for (const record of records) {
          const item = resourceItem(record, body.context.retrievedAt);
          const key = record.sourceId
            ? `id:${record.sourceId}`
            : record.url
              ? `url:${record.url}`
              : `${item.url}\n${item.title.toLowerCase()}`;
          if ('state' in record) {
            const aliases = assignmentAliases(record);
            const previousUnknown = matchingUnknown(aliases);
            if (record.state === 'unknown') {
              if (previousUnknown) unknownAssignments.delete(previousUnknown);
              const identity =
                aliases.find((alias) => alias.startsWith('id:')) ??
                aliases.find((alias) => alias.startsWith('url:')) ??
                aliases[0];
              unknownAssignments.set(identity, {
                aliases,
                url: record.url
                  ? (academicPageIdentity(record.url) ?? record.url)
                  : null,
              });
            } else if (previousUnknown) {
              unknownAssignments.delete(previousUnknown);
            }
            if (record.state === 'submitted' || record.state === 'inactive') {
              items.delete(key);
              inactiveItems.set(key, item);
            }
            // Unknown completion keeps the work protected, not invisible.
            // The unresolved-state gap still prevents a complete collection receipt.
            if (
              record.state !== 'active-unsubmitted' &&
              record.state !== 'unknown'
            )
              continue;
          }
          if (!inactiveItems.has(key)) items.set(key, item);
        }
        saving = true;
        onProgress?.(finish('partial', null, false));
        saving = false;
      }
      const cachedLocation = scopedKnownLocations.find(
        (location) => !attemptedKnownLocations.has(location.id),
      );
      if (cachedLocation && context.visitKnownLocation) {
        const identity =
          academicPageIdentity(cachedLocation.destinationUrl) ??
          cachedLocation.destinationUrl;
        attemptedKnownLocations.add(cachedLocation.id);
        pendingNavigation = identity;
        try {
          const knownPage = await context.visitKnownLocation(cachedLocation);
          assertActive();
          if (
            (academicPageIdentity(knownPage.url) ?? knownPage.url) !== identity
          )
            throw new Error('The saved destination changed during navigation.');
          reusedNavigationPages.add(identity);
          seen.add(identity);
          frontier.delete(identity);
          parentByPage.set(identity, {
            parentUrl: cachedLocation.parentUrl!,
            label: cachedLocation.label ?? 'Collection',
          });
          current = knownPage;
          pendingNavigation = null;
          navigationFailures.delete(identity);
          continue;
        } catch (error) {
          pendingNavigation = null;
          seen.add(identity);
          frontier.delete(identity);
          const failureClass = navigationFailureClass(error);
          const failedLocation = identityScope
            ? recordNavigationLocationFailure(
                identityScope.accountId,
                cachedLocation.id,
                failureClass,
              )
            : null;
          navigationFailures.add(identity);
          const routeWasLost =
            failureClass === 'not-found' ||
            failureClass === 'wrong-course' ||
            failureClass === 'missing-control';
          if (!routeWasLost || !failedLocation || !context.visitKnownLocation) {
            navigationGaps.add(identity);
            throw error;
          }
          let parent: ObservedPage;
          try {
            parent = await context.visitKnownLocation(cachedLocation, 'parent');
            assertActive();
          } catch (parentError) {
            markNavigationLocationStale(
              identityScope!.accountId,
              cachedLocation.id,
            );
            navigationGaps.add(identity);
            throw parentError;
          }
          const staleLocation = markNavigationLocationStale(
            identityScope!.accountId,
            cachedLocation.id,
          );
          if (!staleLocation) {
            navigationGaps.add(identity);
            continue;
          }
          const replacementUrl = childPageTarget(
            parent,
            kind,
            host,
            knownNavigationLocations.map((location) => location.destinationUrl),
          );
          if (!replacementUrl || isExcluded(replacementUrl)) {
            navigationGaps.add(identity);
            continue;
          }
          const replacementIdentity =
            academicPageIdentity(replacementUrl) ?? replacementUrl;
          if (seen.has(replacementIdentity)) {
            navigationGaps.add(identity);
            continue;
          }
          const replacementLink = parent.links.find(
            (link) => link.url === replacementUrl,
          );
          parentByPage.set(replacementIdentity, {
            parentUrl: parent.url,
            label: replacementLink?.label.slice(0, 200) ?? kind,
          });
          collectionByPage.set(
            replacementIdentity,
            collectionByPage.get(identity) ?? identity,
          );
          pendingNavigationRepairs.set(replacementIdentity, {
            failedIdentity: identity,
            failedLocationId: cachedLocation.id,
          });
          pendingNavigation = replacementIdentity;
          try {
            current = await context.openFrom(parent, replacementUrl);
            assertActive();
            if (
              (academicPageIdentity(current.url) ?? current.url) !==
              replacementIdentity
            )
              throw Object.assign(
                new Error(
                  'The replacement collection changed during navigation.',
                ),
                { failureClass: 'wrong-course' as const },
              );
            seen.add(replacementIdentity);
            frontier.delete(replacementIdentity);
            pendingNavigation = null;
            navigationFailures.delete(replacementIdentity);
            continue;
          } catch (repairError) {
            pendingNavigation = null;
            navigationFailures.add(replacementIdentity);
            navigationGaps.add(identity);
            throw repairError;
          }
        }
      }
      if (
        direct &&
        directIdentity &&
        !seen.has(directIdentity) &&
        !navigationFailures.has(directIdentity)
      ) {
        pendingNavigation = directIdentity;
        parentByPage.set(directIdentity, {
          parentUrl: from.url,
          label:
            from.links.find((link) => link.url === direct)?.label ??
            'Collection',
        });
        current = await context.openFrom(from, direct);
        pendingNavigation = null;
        seen.add(directIdentity);
        frontier.delete(directIdentity);
        continue;
      }
      // Unknown work needs detail evidence before the model can end the scan.
      const unresolved = [...frontier.entries()].find(([, link]) =>
        hasUnknownUrl(link.url),
      );
      if (unresolved) {
        const [identity, link] = unresolved;
        frontier.delete(identity);
        pendingNavigation = identity;
        seen.add(identity);
        current = await context.openFrom(link.from, link.url);
        pendingNavigation = null;
        navigationFailures.delete(identity);
        continue;
      }
      if (context.revealContent) {
        const state = JSON.stringify([
          current.url,
          current.text,
          current.links,
        ]);
        if (!revealedStates.has(state)) {
          revealedStates.add(state);
          const revealed = await context.revealContent(current);
          assertActive();
          if (revealed) {
            const nextState = JSON.stringify([
              revealed.url,
              revealed.text,
              revealed.links,
            ]);
            if (!revealedStates.has(nextState)) {
              current = revealed;
              continue;
            }
            disclosureGaps.add(currentIdentity);
          }
        }
      }
      let next: { from: ObservedPage; label: string; url: string } | undefined;
      let nextNavigationHandled = false;
      while (frontier.size && !next) {
        assertActive();
        const batch = [...frontier.entries()].slice(0, 80);
        const targets = batch.map(([, link], index) => ({
          id: String(index + 1),
          label: link.label.slice(0, 300),
          url: link.url,
        }));
        const navigationGoal = `${goal} Explore modules, folders and pagination; open details to resolve unknown statuses; DONE only when no offered link adds evidence.`;
        reserveCall();
        let choiceResult: unknown;
        if (context.navigation) {
          onModelCall?.();
          choiceResult = await context.navigation.choose({
            memory,
            goal: navigationGoal,
            notes,
            pages: [
              {
                url: current.url,
                title: current.title.slice(0, 500),
                text: text.slice(0, 12000),
              },
            ],
            targets,
          });
        } else {
          choiceResult = await request({
            memory,
            kind: 'choose',
            goal: navigationGoal,
            notes,
            pages: [
              {
                url: current.url,
                title: current.title.slice(0, 500),
                text: text.slice(0, 12000),
              },
            ],
            targets,
          });
        }
        const navigationHandled =
          !!choiceResult &&
          typeof choiceResult === 'object' &&
          'navigationHandled' in choiceResult &&
          choiceResult.navigationHandled === true;
        const choice = navigationDecisionSchema.parse(choiceResult);
        assertActive();
        if (choice.operation === 'NAVIGATE') {
          const index = targets.findIndex(
            (target) => target.id === choice.target,
          );
          if (index < 0) throw new Error('The agent chose an unobserved page.');
          const [identity, selected] = batch[index];
          frontier.delete(identity);
          pendingNavigation = identity;
          seen.add(identity);
          parentByPage.set(identity, {
            parentUrl: selected.from.url,
            label: selected.label,
          });
          nextNavigationHandled = navigationHandled;
          next = selected;
        } else {
          if (choice.operation === 'BLOCKED')
            navigationGaps.add(currentIdentity);
          for (const [identity] of batch) frontier.delete(identity);
        }
      }
      if (!next)
        return finish(
          verified &&
            collectionGaps.size === 0 &&
            unknownAssignments.size === 0 &&
            navigationGaps.size === 0 &&
            disclosureGaps.size === 0 &&
            navigationFailures.size === 0 &&
            extractionFailures.size === 0 &&
            ![...pagination].some((identity) => !visitedPages.has(identity))
            ? 'complete'
            : 'partial',
        );
      try {
        if (nextNavigationHandled) {
          if (!context.readCurrent)
            throw new Error('The inout course page could not be checked.');
          current = await context.readCurrent();
          if (
            academicPageIdentity(current.url) !== academicPageIdentity(next.url)
          )
            throw new Error(
              'The inout action reached an unexpected course page.',
            );
        } else {
          current = await context.openFrom(next.from, next.url);
        }
      } catch (error) {
        const failureClass = navigationFailureClass(error);
        const identity = academicPageIdentity(next.url) ?? next.url;
        if (
          failureClass === 'not-found' ||
          failureClass === 'wrong-course' ||
          failureClass === 'missing-control'
        ) {
          pendingNavigation = null;
          navigationFailures.add(identity);
          navigationGaps.add(identity);
          continue;
        }
        throw error;
      }
      pendingNavigation = null;
      navigationFailures.delete(academicPageIdentity(next.url) ?? next.url);
    }
  } catch (error) {
    if (pendingNavigation) navigationFailures.add(pendingNavigation);
    if (saving || signal.aborted || !isCurrent()) throw error;
    if (error instanceof Error)
      onError?.(error.message.split('\n')[0]!.slice(0, 300));
    const category = interruptionCategory(error);
    if (category === 'capability-changed') throw error;
    console.warn('[course-refresh] collection interrupted', {
      kind,
      category,
      phase: pendingNavigation
        ? 'navigation'
        : extractionFailures.has(currentIdentity)
          ? 'extraction'
          : 'verification',
      reason: collectionFailureReason(error),
      pagesVisited: visitedPages.size,
      modelCalls: calls,
      candidates: extractedCandidateCount,
      retainedRecords: items.size + inactiveItems.size,
    });
    const status: CourseScanStatus =
      items.size || inactiveItems.size
        ? 'partial'
        : category === 'needs-sign-in'
          ? 'needs-sign-in'
          : category === 'cancelled'
            ? 'cancelled'
            : 'blocked';
    return finish(status, { category });
  }
};
