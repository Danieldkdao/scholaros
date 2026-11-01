import { validateResourceExtraction } from '@scholaros/services/ai/resources/validation';
import { resourceItem, resourceRequest } from './resource-content';
import { navigationDecisionSchema } from '@scholaros/services/ai/schemas';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import { outcomeFromError } from '../../onboarding/lib/discovery-outcomes';
import {
  childPageTarget,
  pageHasMorePages,
  type CourseChildKind,
} from './course-content';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import type { CourseListContext } from '../../onboarding/services/connection-scan';
import type { CourseChildItem, CourseChildScan } from '../types';

export const scanCourseCollection = async ({
  from,
  kind,
  host,
  allowedHosts = [host],
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
  courseName: string;
  excludedUrls: string[];
  notes: string;
  context: Pick<
    CourseListContext,
    'openFrom' | 'assertReadable' | 'revealContent'
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
  const navigationGaps = new Set<string>();
  const disclosureGaps = new Set<string>();
  const navigationFailures = new Set<string>();
  const extractionFailures = new Set<string>();
  let saving = false;
  let verified = false;
  let pendingNavigation: string | null = null;
  let currentIdentity = rootIdentity;
  let calls = 0;
  const pagination = new Set<string>();
  const requestBounded = (body: AgentRequestSchema) => {
    if (++calls > 100)
      throw new Error(
        'The refresh reached its reading limit; refresh again to continue.',
      );
    return request(body);
  };
  const assertActive = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    context.assertReadable();
  };
  const goal = `Find all ${kind === 'assignments' ? 'currently active, unsubmitted assignments with their own due dates (including overdue work still open)' : 'announcements'} for ${courseName.slice(0, 100)} only; stay within this course and stop when this task is done, as of ${new Date().toISOString()}; verify lists and item details.`;
  const finish = (status: CourseChildScan['status']): CourseChildScan => ({
    status,
    items: [...items.values()],
    ...(inactiveItems.size
      ? { inactiveItems: [...inactiveItems.values()] }
      : {}),
  });
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
        pendingNavigation = directIdentity;
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
      while (frontier.size && !next) {
        assertActive();
        const batch = [...frontier.entries()].slice(0, 80);
        const targets = batch.map(([, link], index) => ({
          id: String(index + 1),
          label: link.label.slice(0, 300),
          url: link.url,
        }));
        const choice = navigationDecisionSchema.parse(
          await requestBounded({
            kind: 'choose',
            goal: `${goal} Explore modules, folders and pagination; open details to resolve unknown statuses; DONE only when no offered link adds evidence.`,
            notes,
            pages: [
              {
                url: current.url,
                title: current.title.slice(0, 500),
                text: text.slice(0, 12000),
              },
            ],
            targets,
          }),
        );
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
      current = await context.openFrom(next.from, next.url);
      pendingNavigation = null;
      navigationFailures.delete(academicPageIdentity(next.url) ?? next.url);
    }
  } catch (error) {
    if (pendingNavigation) navigationFailures.add(pendingNavigation);
    if (saving || signal.aborted || !isCurrent()) throw error;
    return finish(
      items.size || inactiveItems.size ? 'partial' : outcomeFromError(error),
    );
  }
};
