import { isReadNavigation } from './browser-policy';
import type { AcademicConnection, AcademicContextEntryDraft } from '../types';

export type ObservedLink = { label: string; url: string; context?: string };
export type ObservedPage = {
  retrievedAt?: string;
  locale?: string | null;
  url: string;
  title: string;
  text?: string;
  links: ObservedLink[];
  linksTruncated?: boolean;
};

// Schoology publishes enrollment links under numeric course or section roots.
// Lesson pages, meeting links and resources do not become courses by their label.
export const isEnrolledCourseDestination = (
  connection: AcademicConnection,
  value: string,
) => {
  const schoology =
    connection.host.toLowerCase() === 'schoology.com' ||
    connection.host.toLowerCase().endsWith('.schoology.com');
  if (!schoology) return true;
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase() === connection.host.toLowerCase() &&
      /^\/(?:course|section)\/\d+(?:\/(?:materials|updates|info|members|calendar|grades))?\/?$/.test(
        url.pathname,
      ) &&
      !url.searchParams.has('f')
    );
  } catch {
    return false;
  }
};

const courseListWords = [
  'course',
  'courses',
  'class',
  'classes',
  'section',
  'sections',
];

// Site furniture never names a course, so any utility token disqualifies a
// label however the platform words it.
const utilityWords = [
  'account',
  'accessibility',
  'alert',
  'alerts',
  'allclassmaterials',
  'analytics',
  'app',
  'apps',
  'archiv',
  'archived',
  'browse',
  'calendar',
  'catalog',
  'clique',
  'community',
  'dashboard',
  'discover',
  'download',
  'expired',
  'feed',
  'feeds',
  'gettheapp',
  'group',
  'groups',
  'help',
  'home',
  'inbox',
  'install',
  'log',
  'login',
  'logout',
  'material',
  'materials',
  'message',
  'messages',
  'notification',
  'notifications',
  'out',
  'past',
  'privacy',
  'profile',
  'recommendations',
  'report',
  'reports',
  'search',
  'settings',
  'sign',
  'starred',
  'subscribe',
  'support',
  'terms',
  'todo',
];

// Subject names run long ("Geology 101", "Anthropology 200"), so the code
// allows up to twelve letters before the catalogue number.
export const courseCodePattern = /\b[a-z]{2,12}[ -]?\d{2,4}\b/i;
export const termPattern = /\b(?:fall|spring|summer|winter)\s+\d{4}\b/i;
const sectionPattern =
  /\b(?:section|period|block|honors|ap|ib|prep|seminar|lab|elective)\b/i;
const notEnrollmentPattern =
  /\b(?:catalog|browse|archiv|past|expired|group|community|club|recommend|suggested|discover|enroll in)\b/i;
const courseListAffordancePattern =
  /^(?:(?:view|show|open|browse)\s+)?(?:(?:all|my|your|current|active)\s+)?(?:courses|classes|sections|(?:course|class)\s+(?:list|dashboard))$/i;

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

const labelTokens = (value: string) => {
  const lowercased = value.toLowerCase();
  return [
    ...lowercased.split(/[^a-z]+/).filter(Boolean),
    lowercased.replace(/[^a-z]/g, ''),
  ];
};

const isUtilityLabel = (label: string) =>
  labelTokens(label).some((token) => utilityWords.includes(token));

export const pagePresentsCourseList = (page: ObservedPage) =>
  labelTokens(page.title).some((token) => courseListWords.includes(token)) ||
  courseListAffordancePattern.test(normalize(page.title).toLowerCase());

const looksLikeCourse = (link: ObservedLink, page: ObservedPage) => {
  const label = normalize(link.label);
  if (
    courseListAffordancePattern.test(label) ||
    /^(?:grades|syllabus|view all)$/i.test(label)
  )
    return false;
  const haystack = `${label} ${normalize(link.context ?? '')}`;
  if (
    courseCodePattern.test(label) ||
    termPattern.test(haystack) ||
    sectionPattern.test(haystack)
  )
    return true;
  // Page titles alone do not establish enrollment; ambiguous labels require
  // semantic selection against the observed page and link context.
  return (
    pagePresentsCourseList(page) &&
    /\b(?:enrolled|current course|your class|my class)\b/i.test(
      link.context ?? '',
    )
  );
};

const readDestination = (connection: AcademicConnection, url: string) => {
  try {
    return isReadNavigation(url, [connection.host]) ? url : null;
  } catch {
    return null;
  }
};

export const discoveryEntriesFromPage = (
  connection: AcademicConnection,
  page: ObservedPage,
): AcademicContextEntryDraft[] => {
  const entries = new Map<string, AcademicContextEntryDraft>();
  for (const link of page.links) {
    const label = normalize(link.label).slice(0, 300);
    const url = readDestination(connection, link.url);
    if (!label || !url || url === page.url || isUtilityLabel(label)) continue;
    // Catalogs, groups and archived lists are not evidence of a current course,
    // so they never enter the course map even as a plain entry point.
    if (notEnrollmentPattern.test(`${label} ${normalize(link.context ?? '')}`))
      continue;
    const role =
      isEnrolledCourseDestination(connection, url) &&
      looksLikeCourse(link, page)
        ? 'course'
        : 'resource';
    const existing = entries.get(url);
    if (existing) {
      // A course signal anywhere beats a weaker one for the same destination.
      if (existing.role !== 'course' && role === 'course')
        existing.role = 'course';
      continue;
    }
    entries.set(url, {
      connectionId: connection.id,
      label,
      url,
      role,
      evidenceUrl: page.url,
    });
  }
  // The observed page itself is an entry point, not a duplicate connection.
  const ownUrl = readDestination(connection, page.url);
  if (ownUrl && !entries.has(ownUrl))
    entries.set(ownUrl, {
      connectionId: connection.id,
      label: normalize(page.title).slice(0, 300) || ownUrl,
      url: ownUrl,
      role: 'resource',
      evidenceUrl: ownUrl,
    });
  return [...entries.values()];
};

// One bounded step from a home page toward the platform's course list, chosen
// only from destinations the page actually exposed.
export const nextCourseListTarget = (page: ObservedPage, seen: Set<string>) => {
  let host: string;
  try {
    host = new URL(page.url).hostname;
  } catch {
    return null;
  }
  for (const link of page.links) {
    const label = normalize(link.label);
    if (!courseListAffordancePattern.test(label.toLowerCase())) continue;
    if (!isReadNavigation(link.url, [host])) continue;
    if (seen.has(link.url) || link.url === page.url) continue;
    return { label, url: link.url };
  }
  return null;
};

// A model may choose among what the browser saw; it cannot add destinations.
export const onlyObservedDestinations = (
  observed: string[],
  proposed: string[],
) => {
  const allowed = new Set(observed);
  return proposed.filter((url) => allowed.has(url));
};
