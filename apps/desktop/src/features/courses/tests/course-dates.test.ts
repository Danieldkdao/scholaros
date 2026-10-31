import { describe, expect, it } from 'vitest';
import { storedDateFrom } from '../lib/dates';

describe('keeping what a source actually said about a date', () => {
  it.each(['2026-02-31T09:30:00Z', '2026-03-05T28:30:00Z'])(
    'keeps an invalid timestamp as wording instead of inventing an instant: %s',
    (raw) =>
      expect(storedDateFrom(raw)).toEqual({ dateValue: null, dateText: raw }),
  );

  it('keeps an ISO date as date-only without inventing a time', () => {
    expect(storedDateFrom('2026-03-05')).toEqual({
      dateValue: '2026-03-05',
      dateText: null,
    });
  });

  it('keeps a zoned timestamp as an unambiguous instant', () => {
    expect(storedDateFrom('2026-03-05T09:30:00-05:00')).toEqual({
      dateValue: '2026-03-05T09:30:00-05:00',
      dateText: null,
    });
    expect(storedDateFrom('2026-03-05T14:30:00Z')).toEqual({
      dateValue: '2026-03-05T14:30:00Z',
      dateText: null,
    });
  });

  it('reduces a named calendar date to date-only and keeps the wording', () => {
    expect(storedDateFrom('Mar 5, 2026')).toEqual({
      dateValue: '2026-03-05',
      dateText: 'Mar 5, 2026',
    });
    expect(storedDateFrom('March 5 2026')).toEqual({
      dateValue: '2026-03-05',
      dateText: 'March 5 2026',
    });
  });

  it('keeps a local time with no zone as display text only', () => {
    expect(storedDateFrom('2026-03-05T23:59')).toEqual({
      dateValue: null,
      dateText: '2026-03-05T23:59',
    });
    expect(storedDateFrom('Mar 5, 2026 at 11:59pm')).toEqual({
      dateValue: null,
      dateText: 'Mar 5, 2026 at 11:59pm',
    });
  });

  it('never guesses a numeric date that could be read two ways', () => {
    expect(storedDateFrom('3/5/2026')).toEqual({
      dateValue: null,
      dateText: '3/5/2026',
    });
  });

  it('keeps relative and missing dates as unknown', () => {
    expect(storedDateFrom('Due Friday')).toEqual({
      dateValue: null,
      dateText: 'Due Friday',
    });
    expect(storedDateFrom('')).toEqual({ dateValue: null, dateText: null });
    expect(storedDateFrom(null)).toEqual({ dateValue: null, dateText: null });
    expect(storedDateFrom('   ')).toEqual({ dateValue: null, dateText: null });
  });

  it('rejects a calendar date that does not exist', () => {
    expect(storedDateFrom('2026-02-31')).toEqual({
      dateValue: null,
      dateText: '2026-02-31',
    });
    expect(storedDateFrom('Feb 31, 2026')).toEqual({
      dateValue: null,
      dateText: 'Feb 31, 2026',
    });
  });
});
