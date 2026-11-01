import { expect, it } from 'vitest';
import { legacyDateFrom } from '../lib/dates';

it('carries forward validated ISO date precision without needing a fresh scan', () => {
  expect(
    legacyDateFrom({ dateValue: '2026-03-05', dateText: 'March 5' }),
  ).toEqual({ kind: 'date', date: '2026-03-05', original: 'March 5' });
  expect(
    legacyDateFrom({ dateValue: '2026-03-05T09:30:00-05:00', dateText: null }),
  ).toMatchObject({ kind: 'instant', instant: '2026-03-05T09:30:00-05:00' });
});
it.each(['Friday', 'Mar 5, 2026', '3/5/2026', '2026-03-05T23:59'])(
  'preserves legacy wording without interpreting it: %s',
  (dateText) => {
    expect(legacyDateFrom({ dateValue: null, dateText })).toMatchObject({
      kind: 'unresolved',
      original: dateText,
    });
  },
);
it.each(['2026-02-31', '2026-03-05T28:30:00Z'])(
  'does not promote invalid legacy dates: %s',
  (dateValue) => {
    expect(legacyDateFrom({ dateValue, dateText: null })).toMatchObject({
      kind: 'unresolved',
      original: dateValue,
    });
  },
);
it('keeps an absent date absent', () =>
  expect(legacyDateFrom({ dateValue: null, dateText: null })).toBeNull());

it('preserves a manually selected local time without assuming the device timezone', () => {
  expect(
    legacyDateFrom({ dateValue: '2026-11-08T23:59', dateText: null }),
  ).toEqual({
    kind: 'local',
    date: '2026-11-08',
    time: '23:59',
    original: '2026-11-08T23:59',
  });
  expect(
    legacyDateFrom({ dateValue: '2026-11-08T25:59', dateText: null })?.kind,
  ).toBe('unresolved');
});

it('rejects past days and combined times while allowing today without a time', async () => {
  const { isPastDateInput } = await import('../lib/dates');
  const now = new Date('2026-11-01T12:00:00');
  expect(isPastDateInput('2026-10-31', now)).toBe(true);
  expect(isPastDateInput('2026-11-01', now)).toBe(false);
  expect(isPastDateInput('2026-11-01T11:59:59', now)).toBe(true);
  expect(isPastDateInput('2026-11-01T12:00:01', now)).toBe(false);
  expect(isPastDateInput('', now)).toBe(false);
});

it('validates manual date inputs before submitting or persisting records', async () => {
  const { editCourseChildSchema } = await import('../schemas');
  const values = { title: 'Reading', body: '', date: '2000-01-01' };
  expect(editCourseChildSchema.safeParse(values).success).toBe(false);
  expect(
    editCourseChildSchema.safeParse({ ...values, date: '2000-01-01T12:00:00Z' })
      .success,
  ).toBe(false);
  expect(
    editCourseChildSchema.safeParse({ ...values, date: '2999-01-01' }).success,
  ).toBe(true);
  expect(editCourseChildSchema.safeParse({ ...values, date: '' }).success).toBe(
    true,
  );
});
