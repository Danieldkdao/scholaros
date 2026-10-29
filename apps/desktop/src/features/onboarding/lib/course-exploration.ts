import {
  discoveryEntriesFromPage,
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
      const existing = entries.get(entry.url);
      if (existing?.role === 'course') continue;
      entries.set(entry.url, entry);
      if (entry.role === 'course') foundCourses = true;
    }
    if (foundCourses || sawExplicitEmptyList || step + 1 >= maxPages) break;
    const target = nextCourseListTarget(observed, new Set(visited));
    if (target && target.url !== observed.url) {
      assertActive();
      await navigate(target.url);
      assertActive();
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
    entries: [...entries.values()]
      .sort((a, b) => Number(b.role === 'course') - Number(a.role === 'course'))
      .slice(0, 30),
    visited,
    disclosed,
  };
};
