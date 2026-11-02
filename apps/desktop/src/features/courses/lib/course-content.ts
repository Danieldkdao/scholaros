import { isReadNavigation } from '../../onboarding/lib/browser-policy';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';

export const courseChildKinds = ['announcements', 'assignments'] as const;
export type CourseChildKind = (typeof courseChildKinds)[number];

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

export const isWithinCoursePath = (
  courseUrl: string,
  destinationUrl: string,
) => {
  try {
    const course = new URL(courseUrl);
    const destination = new URL(destinationUrl);
    const path = course.pathname.replace(/\/+$/, '') || '/';
    return (
      course.origin === destination.origin &&
      (destination.pathname === path ||
        (path !== '/' && destination.pathname.startsWith(`${path}/`)))
    );
  } catch {
    return false;
  }
};

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
