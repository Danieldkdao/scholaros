import {
  discoveryEntriesFromPage,
  isEnrolledCourseDestination,
  onlyObservedDestinations,
  nextCourseListTarget,
  pagePresentsCourseList,
  type ObservedPage,
} from './academic-discovery';
import { isReadNavigation } from './browser-policy';
import type { AcademicConnection, AcademicContextEntryDraft } from '../types';

export type ExplorationFixtures = {
  connection: AcademicConnection;
  read: () => Promise<ObservedPage>;
  navigate: (url: string) => Promise<void>;
  disclose: () => Promise<'opened' | 'not-found' | 'refused'>;
  isCurrent: () => boolean;
  signal: AbortSignal;
  maxPages?: number;
  classify?: (page: ObservedPage) => Promise<string[]>;
};

export type ExplorationResult = {
  status: 'courses' | 'empty' | 'inconclusive';
  entries: AcademicContextEntryDraft[];
  visited: string[];
  disclosed: boolean;
};

const defaultMaxPages = 4;

const isSchoology = (connection: AcademicConnection) =>
  connection.host.toLowerCase() === 'schoology.com' ||
  connection.host.toLowerCase().endsWith('.schoology.com');

const entryIdentity = (
  connection: AcademicConnection,
  entry: AcademicContextEntryDraft,
) => {
  if (
    entry.role !== 'course' ||
    !isSchoology(connection) ||
    !isEnrolledCourseDestination(connection, entry.url)
  )
    return entry.url;
  const url = new URL(entry.url);
  const [, marker, id] = url.pathname.split('/');
  return `enrollment:${url.origin}/${marker}/${id}`;
};

const observedSchoologyRoster = (
  connection: AcademicConnection,
  page: ObservedPage,
  seen: Set<string>,
) => {
  if (!isSchoology(connection)) return null;
  return (
    page.links.find((link) => {
      if (
        !/^(?:(?:view|show|open)\s+)?(?:(?:my|all|your|current|active)\s+)?courses$/iu.test(
          link.label.trim(),
        ) ||
        !isReadNavigation(link.url, [connection.host]) ||
        seen.has(link.url)
      )
        return false;
      return /^\/courses\/?$/u.test(new URL(link.url).pathname);
    }) ?? null
  );
};

const abortError = () => new DOMException('Aborted', 'AbortError');

// A bounded walk from the connected page toward a course list. Destinations
// come only from what the page exposed, so nothing is navigated that the
// browser never observed.
export const exploreForCourses = async ({
  connection,
  read,
  navigate,
  disclose,
  isCurrent,
  signal,
  maxPages = defaultMaxPages,
  classify,
}: ExplorationFixtures): Promise<ExplorationResult> => {
  const entries = new Map<string, AcademicContextEntryDraft>();
  const visited: string[] = [];
  const requested = new Set<string>();
  let disclosed = false;
  let reReadPending = false;
  let sawExplicitEmptyList = false;
  let foundCourses = false;
  const assertActive = () => {
    if (signal.aborted) throw abortError();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  };
  for (let step = 0; step < maxPages; step += 1) {
    assertActive();
    const observed = await read();
    assertActive();
    const known = visited.includes(observed.url);
    if (known && !reReadPending) break;
    reReadPending = false;
    if (!known) visited.push(observed.url);
    if (
      pagePresentsCourseList(observed) &&
      /\b(?:you have no (?:active |current )?(?:courses|classes)|not enrolled in any (?:courses|classes)|no (?:active|enrolled|current) (?:courses|classes)|no (?:courses|classes) (?:enrolled|assigned|available to you))\b/i.test(
        observed.text ?? '',
      )
    )
      sawExplicitEmptyList = true;
    const observedEntries = discoveryEntriesFromPage(connection, observed);
    if (classify) {
      const proposed = await classify(observed);
      assertActive();
      const selected = new Set(
        onlyObservedDestinations(
          observed.links.map((link) => link.url),
          proposed,
        ),
      );
      for (const entry of observedEntries) entry.role = 'resource';
      for (const link of observed.links) {
        if (
          !selected.has(link.url) ||
          !isEnrolledCourseDestination(connection, link.url) ||
          !isReadNavigation(link.url, [connection.host])
        )
          continue;
        const existing = observedEntries.find(
          (entry) => entry.url === link.url,
        );
        if (existing) existing.role = 'course';
        else
          observedEntries.push({
            connectionId: connection.id,
            label: link.label,
            url: link.url,
            role: 'course',
            evidenceUrl: observed.url,
          });
      }
    }
    for (const entry of observedEntries) {
      const identity = entryIdentity(connection, entry);
      const existing = entries.get(identity);
      if (existing?.role === 'course') {
        if (entry.role !== 'course') continue;
        // Prefer the actually observed enrollment root over a preview tab alias.
        if (
          new URL(existing.url).pathname.split('/').filter(Boolean).length <
          new URL(entry.url).pathname.split('/').filter(Boolean).length
        )
          continue;
      }
      entries.set(identity, entry);
      if (entry.role === 'course') foundCourses = true;
    }
    if (sawExplicitEmptyList || step + 1 >= maxPages) break;
    if (foundCourses) {
      const roster = observedSchoologyRoster(
        connection,
        observed,
        new Set([...visited, ...requested]),
      );
      const pagination =
        roster ??
        observed.links.find(
          (link) =>
            /^(?:next|more|load more|show more|[›»>])/i.test(
              link.label.trim(),
            ) &&
            isReadNavigation(link.url, [connection.host]) &&
            !visited.includes(link.url) &&
            !requested.has(link.url),
        );
      if (!pagination) break;
      requested.add(pagination.url);
      await navigate(pagination.url);
      assertActive();
      reReadPending = true;
      continue;
    }
    const target = nextCourseListTarget(
      observed,
      new Set([...visited, ...requested]),
    );
    if (target && target.url !== observed.url) {
      assertActive();
      // Remember requests too: a redirect can restore a sign-in fragment.
      requested.add(target.url);
      await navigate(target.url);
      assertActive();
      reReadPending = true;
      continue;
    }
    assertActive();
    const disclosure = !disclosed ? await disclose() : 'not-found';
    assertActive();
    if (disclosure === 'opened') {
      disclosed = true;
      // A menu only counts once its destinations have been observed again.
      reReadPending = true;
      continue;
    }
    break;
  }
  return {
    status: foundCourses
      ? 'courses'
      : sawExplicitEmptyList
        ? 'empty'
        : 'inconclusive',
    entries: [...entries.values()].sort(
      (a, b) => Number(b.role === 'course') - Number(a.role === 'course'),
    ),
    visited,
    disclosed,
  };
};
