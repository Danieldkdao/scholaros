import { describe, expect, it } from 'vitest';
import {
  formatCourseDate,
  formatAcademicDateResolution,
  formatCourseScanStatus,
  formatCourseSourceState,
  formatRefreshActivity,
  isPastDate,
  refreshActivityKinds,
  sortAnnouncements,
  sortAssignments,
} from '../lib/formatters';
import { courseScanStatuses } from '../types';
import type { CourseChildItem } from '../types';

const item = (
  title: string,
  overrides: Partial<CourseChildItem> = {},
): CourseChildItem & { id: string; active: boolean; lastSeenAt: string } => ({
  id: title,
  title,
  body: null,
  dateValue: null,
  dateText: null,
  url: 'https://canvas.school.edu/courses/1',
  active: true,
  lastSeenAt: '2026-03-01T00:00:00.000Z',
  ...overrides,
});

describe('naming every course scan status', () => {
  it('gives each status a label and an icon', () => {
    for (const status of courseScanStatuses) {
      const formatted = formatCourseScanStatus(status);
      expect(formatted.label.length).toBeGreaterThan(0);
      expect(formatted.Icon).toBeTruthy();
    }
  });

  it('separates a confirmed empty collection from one never fetched', () => {
    expect(formatCourseScanStatus('pending').label).not.toBe(
      formatCourseScanStatus('complete').label,
    );
  });
});

describe('naming where a course came from', () => {
  it.each(['connected', 'unmarked', 'removed'] as const)(
    'labels a %s source',
    (state) => {
      expect(formatCourseSourceState(state).label.length).toBeGreaterThan(0);
    },
  );
});

describe('showing a date the way the source meant it', () => {
  it('shows a date-only value without a time', () => {
    expect(formatCourseDate({ dateValue: '2026-03-05', dateText: null })).toBe(
      'Mar 5, 2026',
    );
  });

  it('shows a zoned timestamp with its time', () => {
    expect(
      formatCourseDate({
        dateValue: '2026-03-05T14:30:00Z',
        dateText: null,
      }),
    ).toContain('2026');
  });

  it('shows the numeric source offset as the date timezone label', () => {
    expect(
      formatAcademicDateResolution({
        kind: 'instant',
        instant: '2026-11-10T04:59:00Z',
        timezone: '-05:00',
        original: '2026-11-09T23:59:00-05:00',
      }).label,
    ).toBe('-05:00');
  });

  it('falls back to the wording the source used', () => {
    expect(formatCourseDate({ dateValue: null, dateText: 'Due Friday' })).toBe(
      'Due Friday',
    );
  });

  it('returns nothing when the date is unknown', () => {
    expect(formatCourseDate({ dateValue: null, dateText: null })).toBeNull();
  });
});

describe('ordering saved collections', () => {
  it('keeps date-only assignments current through the last millisecond of the local due day', () => {
    expect(
      isPastDate(
        '2026-03-05',
        new Date(2026, 2, 5, 23, 59, 59, 999).toISOString(),
      ),
    ).toBe(false);
    expect(isPastDate('2026-03-05', new Date(2026, 2, 6).toISOString())).toBe(
      true,
    );
  });
  it('puts the newest announcement first and undated ones last', () => {
    expect(
      sortAnnouncements([
        item('Old', { dateValue: '2026-01-01' }),
        item('Undated'),
        item('New', { dateValue: '2026-03-01' }),
      ]).map((entry) => entry.title),
    ).toEqual(['New', 'Old', 'Undated']);
  });

  it('puts the soonest assignment first and undated ones last', () => {
    expect(
      sortAssignments([
        item('Later', { dateValue: '2026-03-01' }),
        item('Undated'),
        item('Sooner', { dateValue: '2026-01-01' }),
      ]).map((entry) => entry.title),
    ).toEqual(['Sooner', 'Later', 'Undated']);
  });

  it('keeps a text-only date in the undated group', () => {
    expect(
      sortAssignments([
        item('Worded', { dateText: 'Due Friday' }),
        item('Dated', { dateValue: '2026-01-01' }),
      ]).map((entry) => entry.title),
    ).toEqual(['Dated', 'Worded']);
  });

  it('knows a date that has already passed', () => {
    expect(isPastDate('2026-01-01', '2026-03-01T00:00:00.000Z')).toBe(true);
    expect(isPastDate('2026-05-01', '2026-03-01T00:00:00.000Z')).toBe(false);
    expect(isPastDate(null, '2026-03-01T00:00:00.000Z')).toBe(false);
  });
});

it('leaves unnormalized source wording in stable order after known dates', () => {
  const items = [
    item('Later wording', { dateText: 'November 9, 2026' }),
    item('Earlier wording', { dateText: 'November 2, 2026' }),
    item('Known date', { dateValue: '2026-11-01' }),
  ];
  expect(sortAssignments(items).map((entry) => entry.title)).toEqual([
    'Known date',
    'Later wording',
    'Earlier wording',
  ]);
});

it('orders normalized local times without assigning a device timezone', () => {
  const local = (title: string, time: string) =>
    item(title, {
      content: {
        title,
        description: null,
        kind: 'assignment',
        state: 'active-unsubmitted',
        due: {
          kind: 'local',
          date: '2026-11-02',
          time,
          original: `November 2 at ${time}`,
        },
        availableFrom: null,
        availableUntil: null,
        pointsPossible: null,
        url: null,
        sourceId: null,
        resources: [],
        evidence: {
          sourceUrl: 'https://canvas.school.edu/courses/1',
          excerpts: [title],
          targetIds: [],
        },
      },
    });
  expect(
    sortAssignments([local('Evening', '23:59'), local('Morning', '09:00')]).map(
      (entry) => entry.title,
    ),
  ).toEqual(['Morning', 'Evening']);
  expect(formatCourseDate(local('Morning', '09:00'))).toBe(
    'November 2 at 09:00',
  );
});

it('labels completed refreshes consistently and separates sign-in issues', () => {
  expect(formatRefreshActivity('complete').label).toBe('Refresh complete');
  for (const status of ['partial', 'failed', 'cancelled'] as const) {
    expect(formatRefreshActivity(status)).toEqual(
      formatRefreshActivity('complete'),
    );
  }
  expect(formatRefreshActivity('sign-in-required').label).toBe(
    'Sign in required',
  );
  expect(formatRefreshActivity('partial').Icon).toBeTruthy();
});

it.each(refreshActivityKinds)('formats refresh activity state %s', (state) => {
  const formatted = formatRefreshActivity(state);
  expect(formatted.label).not.toBe('');
  expect(formatted.Icon).toBeTruthy();
});

it('shows a manually entered local timestamp in a readable format', () => {
  expect(
    formatCourseDate({ dateValue: null, dateText: '2026-11-02T15:44:44' }),
  ).toBe('Nov 2, 2026, 3:44 PM');
});
