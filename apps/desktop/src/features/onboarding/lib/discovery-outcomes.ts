import type { DiscoveryStatus } from '../types';

export type ConnectionOutcome =
  | 'courses'
  | 'empty'
  | 'inconclusive'
  | 'blocked'
  | 'needs-sign-in'
  | 'skipped';

export type ConnectionResult = {
  connectionId: string;
  outcome: ConnectionOutcome;
  courseCount?: number;
};

export type DiscoveryPrevious = {
  coverage: Record<string, ConnectionOutcome>;
  discoveredAt: string | null;
} | null;

export type DiscoverySummary = {
  status: DiscoveryStatus;
  message: string | null;
  coverage: Record<string, ConnectionOutcome>;
  discoveredAt: string | null;
};

// A page whose data requests were withheld, or that redirected to a sign-in
// wall, must never be reported as "no courses found".
export const outcomeFromExploration = (
  status: 'courses' | 'empty' | 'inconclusive',
  signInWall: boolean,
  blockedRequests: number,
): ConnectionOutcome => {
  if (signInWall) return 'needs-sign-in';
  if (status === 'empty' && blockedRequests > 0) return 'inconclusive';
  return status;
};

const readableOutcomes: ConnectionOutcome[] = ['courses', 'empty'];
const signInOutcomes: ConnectionOutcome[] = ['needs-sign-in'];

// A finished attempt is not the same as an up-to-date course map: freshness and
// success follow only the resources that were actually read.
export const summarizeDiscovery = ({
  results,
  previous,
  now,
  cancelled = false,
  running = false,
}: {
  results: ConnectionResult[];
  previous: DiscoveryPrevious;
  now: string;
  cancelled?: boolean;
  running?: boolean;
}): DiscoverySummary => {
  const coverage = { ...previous?.coverage };
  for (const result of results) coverage[result.connectionId] = result.outcome;
  if (running)
    return {
      status: 'running',
      message: 'Checking your connected resources.',
      coverage,
      discoveredAt: previous?.discoveredAt ?? null,
    };
  if (cancelled)
    return {
      status: 'cancelled',
      message: 'Course map refresh stopped; your previous results are kept.',
      coverage,
      discoveredAt: previous?.discoveredAt ?? null,
    };
  const succeeded = results.filter((result) =>
    readableOutcomes.includes(result.outcome),
  );
  const courses = succeeded.reduce(
    (total, result) => total + (result.courseCount ?? 0),
    0,
  );
  const discoveredAt = succeeded.length
    ? now
    : (previous?.discoveredAt ?? null);
  if (results.length && succeeded.length === results.length)
    return {
      status: courses ? 'complete' : 'empty',
      message: courses
        ? `${courses} course entry point${courses === 1 ? '' : 's'} found across ${results.length} resource${results.length === 1 ? '' : 's'}.`
        : 'Your course lists were readable and contained no courses.',
      coverage,
      discoveredAt,
    };
  if (succeeded.length)
    return {
      status: 'partial',
      message: `${succeeded.length} of ${results.length} resources checked; the rest could not be read.`,
      coverage,
      discoveredAt,
    };
  if (results.some((result) => signInOutcomes.includes(result.outcome)))
    return {
      status: 'needs-sign-in',
      message: 'Sign in in your study browser, then refresh the course map.',
      coverage,
      discoveredAt,
    };
  if (results.some((result) => result.outcome === 'inconclusive'))
    return {
      status: 'inconclusive',
      message:
        'Pages were readable, but no course list could be identified yet.',
      coverage,
      discoveredAt,
    };
  return {
    status: results.length ? 'blocked' : 'pending',
    message: results.length
      ? 'None of your connected resources could be read safely.'
      : 'No resources were checked.',
    coverage,
    discoveredAt,
  };
};
