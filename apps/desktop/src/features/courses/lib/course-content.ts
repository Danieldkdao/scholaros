import { isReadNavigation } from '../../onboarding/lib/browser-policy';
import {
  courseCodePattern,
  termPattern,
  type ObservedPage,
} from '../../onboarding/lib/academic-discovery';
import { storedDateFrom } from './dates';
import type { AcademicEvidenceSchema } from '@scholaros/services/ai/schemas';
import type { CourseChildItem } from '../types';

export const courseChildKinds = ['announcements', 'assignments'] as const;
export type CourseChildKind = (typeof courseChildKinds)[number];

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

// Platforms word these collections differently, but the label still has to name
// the whole collection rather than one item inside it.
const childLabelPatterns: Record<CourseChildKind, RegExp> = {
  announcements: /^(?:all\s+)?(?:announcements|updates)$/i,
  assignments:
    /^(?:all\s+)?(?:assignments|classwork|homework|due\s+dates|to-?do)$/i,
};

const emptyListPatterns: Record<CourseChildKind, RegExp> = {
  announcements: /\bno announcements\b/i,
  assignments: /\b(?:no assignments|no classwork|no homework|nothing due)\b/i,
};

const paginationLabelPattern =
  /^(?:next|older|newer|previous|more|load more|show more|page\s+\d+|[›»>])/i;
const paginationQueryPattern = /[?&](?:page|p|start|offset)=/i;

export const courseFieldsFrom = (name: string) => ({
  code: courseCodePattern.exec(name.replace(termPattern, ''))?.[0] ?? null,
  term: termPattern.exec(name)?.[0] ?? null,
});

// Only a destination the course page itself exposed, and that read-only policy
// allows, can be opened for its announcements or assignments.
export const childPageTarget = (
  page: ObservedPage,
  kind: CourseChildKind,
  host: string,
) => {
  const pattern = childLabelPatterns[kind];
  for (const link of page.links) {
    if (!pattern.test(normalize(link.label))) continue;
    if (!isReadNavigation(link.url, [host])) continue;
    return link.url;
  }
  return null;
};

// An empty collection has to be stated by the page; a page that failed to load,
// asked for sign-in, or showed nothing readable is not evidence of empty.
export const pageListsNothing = (page: ObservedPage, kind: CourseChildKind) =>
  emptyListPatterns[kind].test(page.text ?? '');

// Pagination means more items may exist, so the scan cannot be called complete.
export const pageHasMorePages = (page: ObservedPage) =>
  page.links.some(
    (link) =>
      paginationLabelPattern.test(normalize(link.label)) ||
      paginationQueryPattern.test(link.url),
  );

const childCardKind = (kind: CourseChildKind) =>
  kind === 'announcements' ? 'announcement' : 'assignment';

// A card is only kept when it came from the page that was actually read, so a
// model-invented source link cannot enter the catalog.
export const childItemsFrom = (
  cards: AcademicEvidenceSchema['cards'],
  kind: CourseChildKind,
  pageUrl: string,
): CourseChildItem[] => {
  const wanted = childCardKind(kind);
  const items = new Map<string, CourseChildItem>();
  for (const card of cards) {
    const title = normalize(card.title).slice(0, 300);
    if (card.kind !== wanted || !title || card.sourceUrl !== pageUrl) continue;
    if (items.has(title.toLowerCase())) continue;
    items.set(title.toLowerCase(), {
      title,
      body: card.detail ? normalize(card.detail).slice(0, 2_000) : null,
      ...storedDateFrom(card.date),
      url: card.sourceUrl,
    });
  }
  return [...items.values()];
};
