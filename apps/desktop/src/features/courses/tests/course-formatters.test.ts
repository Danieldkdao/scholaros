import { describe, expect, it } from 'vitest';
import {
  formatCourseDate,
  formatCourseScanStatus,
  formatCourseSourceState,
  isPastDate,
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

it('orders explicit text deadlines with normalized dates, leaving invalid and ambiguous dates last', () => {
  const items = [
    item('Invalid', {
      dateValue: 'invalid',
      dateText: 'Feb 31, 2026 at 11:59 pm',
    }),
    item('Later', { dateText: 'Due Monday, November 9, 2026 at 11:59 pm' }),
    item('Evening', { dateText: 'Monday, November 2, 2026 11:59 pm' }),
    item('Morning', { dateText: 'Nov 2, 2026 at 9:00am' }),
    item('Normalized', { dateValue: '2026-11-01' }),
    item('Ambiguous', { dateText: '11/2/2026' }),
    item('Relative', { dateText: 'Due Monday' }),
  ];
  expect(sortAssignments(items).map((entry) => entry.title)).toEqual([
    'Normalized',
    'Morning',
    'Evening',
    'Later',
    'Invalid',
    'Ambiguous',
    'Relative',
  ]);
  expect(items[0]?.title).toBe('Invalid');
});
