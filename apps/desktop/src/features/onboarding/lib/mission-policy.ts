import { academicPageIdentity, isReadNavigation } from './browser-policy';
import type { AcademicConnection } from '../types';

export type MissionEntry =
  | { kind: 'ready'; url: string }
  | { kind: 'unsupported'; message: string };

const isBareOrigin = (url: string) => {
  const parsed = new URL(url);
  return (
    (parsed.pathname === '/' || parsed.pathname === '') &&
    !parsed.search &&
    !parsed.hash
  );
};

// Provider list pages are an optimization, never a requirement for
// eligibility: any confirmed academic page can start work.
const providerEntry = (connection: AcademicConnection): string | null => {
  const origin = new URL(connection.url).origin;
  switch (connection.kind) {
    case 'canvas':
      return new URL('/courses', origin).href;
    case 'classroom':
      return new URL('/u/0/h', origin).href;
    case 'resource':
      return null;
  }
};

const unsupportedMessage =
  'ScholarOS can’t read the page you connected. It looks like a sign-in or account action link, so open a course or dashboard page in your study browser and connect that instead.';

// Confirming a site authorizes reading it; it never authorizes its sign-in or
// account paths.
export const resolveMissionEntry = (
  connection: AcademicConnection,
  hosts: string[],
): MissionEntry => {
  const provider = providerEntry(connection);
  const identity = academicPageIdentity(connection.url);
  const confirmed =
    identity && isReadNavigation(identity, hosts) ? identity : null;
  // A saved bare origin carries no page information, so the provider's course
  // list starts; otherwise use what the student actually confirmed.
  const entry = isBareOrigin(connection.url)
    ? (provider ?? confirmed)
    : (confirmed ?? provider);
  if (entry && isReadNavigation(entry, hosts))
    return { kind: 'ready', url: entry };
  return { kind: 'unsupported', message: unsupportedMessage };
};

export const assertMissionNavigation = (url: string, hosts: string[]) => {
  if (!isReadNavigation(url, hosts))
    throw new Error(
      'This page left the read-only course area. Sign in again in the study browser, then retry or skip for now.',
    );
};

// Links are offered from one snapshot; navigating is only safe while that page
// still shows the same target.
export const isStaleNavigation = (
  currentUrl: string,
  fresh: { url: string; links: Array<{ url: string; label: string }> },
  target: { url: string; label: string },
) =>
  fresh.url !== currentUrl ||
  !fresh.links.some(
    (link) => link.url === target.url && link.label === target.label,
  );
