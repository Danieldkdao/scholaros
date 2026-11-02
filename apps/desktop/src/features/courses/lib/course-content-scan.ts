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
import { outcomeFromError } from '../../onboarding/lib/discovery-outcomes';
import {
  childPageTarget,
  isWithinCoursePath,
  pageHasMorePages,
  type CourseChildKind,
} from './course-content';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseListContext } from '../../onboarding/services/connection-scan';
import type { CourseChildItem, CourseChildScan } from '../types';

type TrackedChildItem = {
  item: CourseChildItem;
  resource: ResourceIdentityRecord;
  inactive: boolean;
};

type KnownCourseLocation = {
  purpose: CourseChildKind;
  destinationUrl: string;
  destinationKind: 'summary' | 'collection' | 'detail';
  status: 'tentative' | 'verified' | 'stale';
};

type VerifiedCourseLocation = {
  purpose: CourseChildKind;
  destinationUrl: string;
  parentUrl: string | null;
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
  onNavigationVerified?: (location: VerifiedCourseLocation) => void;
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
  >;
  request: (body: AgentRequestSchema) => Promise<unknown>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onProgress?: (scan: CourseChildScan) => void;
}): Promise<CourseChildScan> => {
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
  const rememberedIdentities = new Set(
    knownNavigationLocations
      .filter(
        (location) =>
          location.purpose === kind &&
          location.status === 'verified' &&
          location.destinationKind === 'collection' &&
          isReadNavigation(location.destinationUrl, [host]) &&
          !isExcluded(location.destinationUrl),
      )
      .map((location) => academicPageIdentity(location.destinationUrl))
      .filter((url): url is string => !!url),
  );
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
  const navigationGaps = new Set<string>();
  const disclosureGaps = new Set<string>();
  const navigationFailures = new Set<string>();
  const extractionFailures = new Set<string>();
  let saving = false;
  let verified = false;
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
  const finish = (status: CourseChildScan['status']): CourseChildScan => {
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
    return {
      status: status === 'complete' && ambiguous ? 'partial' : status,
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
        navigationRepairs:
          rememberedIdentities.size && !reusedNavigationPages.size
            ? [...savedNavigationPages].filter(
                (identity) => !rememberedIdentities.has(identity),
              ).length
            : 0,
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
      frontier.delete(currentIdentity);
      if (current.linksTruncated) navigationGaps.add(currentIdentity);
      else navigationGaps.delete(currentIdentity);
      for (const link of current.links) {
        if (pageHasMorePages({ ...current, links: [link] }))
          pagination.add(academicPageIdentity(link.url) ?? link.url);
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
          result = validateResourceExtraction(body, kind, output);
        } catch (error) {
          extractionFailures.add(currentIdentity);
          throw error;
        }
        if (result.coverage === 'complete') {
          verified = true;
          collectionGaps.delete(currentIdentity);
          if (
            currentIdentity !== rootIdentity &&
            result.detailRecord !== true &&
            !savedNavigationPages.has(currentIdentity)
          ) {
            const evidenceText = current.text?.trim().slice(0, 500);
            const parent = parentByPage.get(currentIdentity);
            if (evidenceText && onNavigationVerified) {
              savedNavigationPages.add(currentIdentity);
              const verifiedAt = new Date().toISOString();
              onNavigationVerified({
                purpose: kind,
                destinationUrl: currentIdentity,
                parentUrl: parent?.parentUrl ?? null,
                label: parent?.label ?? current.title.slice(0, 200),
                evidence: {
                  sourceUrl: current.url,
                  excerpts: [evidenceText],
                  targetIds: [],
                },
                status: 'verified',
                destinationKind: 'collection',
                observedAt: current.retrievedAt ?? verifiedAt,
                verifiedAt,
              });
            }
          }
          if (directIdentity && currentIdentity === directIdentity) {
            for (const [pageIdentity, gap] of collectionGaps)
              if (
                gap.summary &&
                gap.collection === directIdentity &&
                (!gap.truncated || gap.collection === currentIdentity)
              )
                collectionGaps.delete(pageIdentity);
          }
        } else if (result.coverage === 'partial') {
          collectionGaps.set(currentIdentity, {
            collection:
              collectionByPage.get(currentIdentity) ?? currentIdentity,
            summary: currentIdentity === rootIdentity && !!directIdentity,
            truncated: !!body.context?.truncated,
          });
        }
        const records =
          'assignments' in result ? result.assignments : result.announcements;
        extractedCandidateCount += records.length;
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
            if (record.state !== 'active-unsubmitted') continue;
          }
          if (!inactiveItems.has(key)) items.set(key, item);
        }
        saving = true;
        onProgress?.(finish('partial'));
        saving = false;
      }
      if (direct && directIdentity && !seen.has(directIdentity)) {
        if (rememberedIdentities.has(directIdentity))
          reusedNavigationPages.add(directIdentity);
        pendingNavigation = directIdentity;
        parentByPage.set(directIdentity, {
          parentUrl: from.url,
          label:
            from.links.find((link) => link.url === direct)?.label ??
            'Collection',
        });
        current = await context.openFrom(from, direct);
        pendingNavigation = null;
        navigationFailures.delete(directIdentity);
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
        const remembered = [...frontier.entries()].find(([identity]) =>
          rememberedIdentities.has(identity),
        );
        if (remembered) {
          const [identity, selected] = remembered;
          reusedNavigationPages.add(identity);
          frontier.delete(identity);
          pendingNavigation = identity;
          seen.add(identity);
          next = selected;
          continue;
        }
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
      if (
        rememberedIdentities.has(academicPageIdentity(next.url) ?? next.url) &&
        !isWithinCoursePath(from.url, current.url)
      )
        throw new Error('The saved destination did not stay in this course.');
      pendingNavigation = null;
      navigationFailures.delete(academicPageIdentity(next.url) ?? next.url);
    }
  } catch (error) {
    if (pendingNavigation) navigationFailures.add(pendingNavigation);
    if (saving || signal.aborted || !isCurrent()) throw error;
    if (error instanceof Error)
      onError?.(error.message.split('\n')[0]!.slice(0, 300));
    return finish(
      items.size || inactiveItems.size ? 'partial' : outcomeFromError(error),
    );
  }
};
