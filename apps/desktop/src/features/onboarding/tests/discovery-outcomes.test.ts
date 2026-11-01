import { describe, expect, it } from 'vitest';
import {
  outcomeFromExploration,
  summarizeDiscovery,
  courseRefreshFailureMessage,
  syncFailureMessage,
  type ConnectionResult,
} from '../lib/discovery-outcomes';
import type { AcademicDiscovery, DiscoveryStatus } from '../types';

const now = '2026-10-29T12:00:00.000Z';
const earlier = '2026-10-28T09:00:00.000Z';

const result = (
  connectionId: string,
  outcome: ConnectionResult['outcome'],
  courseCount = 0,
): ConnectionResult => ({ connectionId, outcome, courseCount });

const summarize = (
  input: Omit<Parameters<typeof summarizeDiscovery>[0], 'now'>,
) => summarizeDiscovery({ ...input, now });

describe('blocked and walled observations', () => {
  it('reports a sign-in wall instead of an empty course list', () => {
    expect(outcomeFromExploration('empty', true, 0)).toBe('needs-sign-in');
    expect(outcomeFromExploration('courses', true, 0)).toBe('needs-sign-in');
  });

  it('turns a withheld data request into an inconclusive observation', () => {
    expect(outcomeFromExploration('empty', false, 2)).toBe('inconclusive');
    expect(outcomeFromExploration('empty', false, 0)).toBe('empty');
    expect(outcomeFromExploration('courses', false, 3)).toBe('courses');
  });
});

describe('discovery outcome reporting', () => {
  it('does not call a run where every resource was skipped a success', () => {
    const summary = summarize({
      results: [result('a', 'skipped'), result('b', 'blocked')],
      previous: null,
    });
    expect(summary.status).toBe('blocked');
    expect(summary.discoveredAt).toBeNull();
    expect(summary.message).not.toMatch(/up to date|complete/i);
  });

  it('reports success only when a readable resource showed courses', () => {
    const summary = summarize({
      results: [result('a', 'courses', 3), result('b', 'courses', 1)],
      previous: null,
    });
    expect(summary).toMatchObject({
      status: 'complete',
      discoveredAt: now,
      coverage: { a: 'courses', b: 'courses' },
    });
    expect(summary.message).toContain('4');
  });

  it('separates a readable list with no courses from an unreadable page', () => {
    expect(
      summarize({ results: [result('a', 'empty')], previous: null }).status,
    ).toBe('empty');
    expect(
      summarize({ results: [result('a', 'blocked')], previous: null }).status,
    ).toBe('blocked');
    expect(
      summarize({ results: [result('a', 'empty')], previous: null }).message,
    ).toContain('no courses');
  });

  it('reports partial coverage when one resource succeeds and another fails', () => {
    const summary = summarize({
      results: [result('a', 'courses', 2), result('b', 'blocked')],
      previous: null,
    });
    expect(summary.status).toBe('partial');
    expect(summary.discoveredAt).toBe(now);
    expect(summary.message).toContain('1 of 2');
  });

  it('keeps a sign-in wall distinct from a failure', () => {
    const summary = summarize({
      results: [result('a', 'needs-sign-in')],
      previous: null,
    });
    expect(summary.status).toBe('needs-sign-in');
    expect(summary.message).toMatch(/sign in/i);
  });

  it('treats readable pages with no course list as inconclusive', () => {
    const summary = summarize({
      results: [result('a', 'inconclusive'), result('b', 'blocked')],
      previous: null,
    });
    expect(summary.status).toBe('inconclusive');
  });

  it('preserves earlier freshness when nothing could be read this run', () => {
    const summary = summarize({
      results: [result('a', 'blocked')],
      previous: { coverage: { a: 'courses' }, discoveredAt: earlier },
    });
    expect(summary.discoveredAt).toBe(earlier);
    expect(summary.status).toBe('blocked');
    // The previous successful observation is still described by coverage.
    expect(summary.coverage.a).toBe('blocked');
  });

  it('keeps coverage for resources that were not part of this run', () => {
    const summary = summarize({
      results: [result('b', 'courses', 2)],
      previous: { coverage: { a: 'inconclusive' }, discoveredAt: earlier },
    });
    expect(summary.coverage).toEqual({ a: 'inconclusive', b: 'courses' });
  });

  it('marks a cancelled run without claiming a refresh happened', () => {
    const summary = summarize({
      results: [],
      previous: { coverage: { a: 'courses' }, discoveredAt: earlier },
      cancelled: true,
    });
    expect(summary.status).toBe('cancelled');
    expect(summary.discoveredAt).toBe(earlier);
    expect(summary.coverage).toEqual({ a: 'courses' });
    expect(summary.message).toMatch(/kept|unchanged/i);
  });

  it('reports a running attempt separately from a finished one', () => {
    expect(
      summarize({
        results: [],
        previous: { coverage: { a: 'courses' }, discoveredAt: earlier },
        running: true,
      }).status,
    ).toBe('running');
  });
});

it('reports sign-in needs regardless of connection ordering', () => {
  expect(
    summarize({
      results: [result('a', 'blocked'), result('b', 'needs-sign-in')],
      previous: null,
    }).status,
  ).toBe('needs-sign-in');
});

describe('background sync reporting', () => {
  const discoveryFor = (
    status: DiscoveryStatus,
    message: string | null = null,
  ) =>
    ({
      status,
      message,
      discoveredAt: null,
      coverage: {},
      entries: [],
    }) as AcademicDiscovery;

  it.each([
    'blocked',
    'needs-sign-in',
    'cancelled',
    'failed',
    'pending',
    'inconclusive',
  ] as const)('treats a %s refresh as an unsuccessful sync', (status) => {
    expect(
      syncFailureMessage(discoveryFor(status, 'Nothing could be read.')),
    ).toBe('Nothing could be read.');
    expect(syncFailureMessage(discoveryFor(status))).toBeTruthy();
  });

  it('preserves freshness and reports the limitation when no course list was identified', () => {
    const summary = summarize({
      results: [result('a', 'inconclusive'), result('b', 'inconclusive')],
      previous: { coverage: { a: 'courses' }, discoveredAt: earlier },
    });

    expect(summary.discoveredAt).toBe(earlier);
    expect(syncFailureMessage({ ...summary, entries: [] })).toBe(
      summary.message,
    );
  });

  it.each(['', '   '])(
    'uses a failure message when the stored message is blank',
    (message) => {
      expect(
        syncFailureMessage(discoveryFor('blocked', message))?.trim(),
      ).toBeTruthy();
    },
  );

  it.each(['complete', 'partial', 'empty'] as const)(
    'treats a %s refresh as a successful sync',
    (status) => {
      expect(syncFailureMessage(discoveryFor(status, 'Read everything.'))).toBe(
        null,
      );
    },
  );

  it('ignores historical sign-in failures from a source not attempted this run', () => {
    expect(
      courseRefreshFailureMessage({
        attemptedConnectionIds: ['source-b'],
        connections: [{ id: 'source-a' }, { id: 'source-b' }],
        discovery: discoveryFor('complete'),
        courses: [
          {
            connectionId: 'source-a',
            assignmentsStatus: 'needs-sign-in',
            announcementsStatus: 'needs-sign-in',
          },
          {
            connectionId: 'source-b',
            assignmentsStatus: 'complete',
            announcementsStatus: 'complete',
          },
        ],
      }),
    ).toBeNull();
  });

  it('keeps current sign-in failures from an attempted source actionable', () => {
    expect(
      courseRefreshFailureMessage({
        attemptedConnectionIds: ['source-b'],
        connections: [{ id: 'source-b' }],
        discovery: discoveryFor('complete'),
        courses: [
          {
            connectionId: 'source-b',
            assignmentsStatus: 'needs-sign-in',
            announcementsStatus: 'complete',
          },
        ],
      }),
    ).toBe('Sign in in your study browser, then resume background sync.');
  });
});
