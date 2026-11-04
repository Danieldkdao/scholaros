import { expect, it } from 'vitest';
import {
  createDefaultNotificationSettings,
  evaluateNotificationPolicy,
} from '../services/notification-policy';
import type { NotificationSettings } from '@scholaros/services/learning/notification-contracts';

const enabledSettings = (): NotificationSettings => {
  const settings = createDefaultNotificationSettings();
  return {
    ...settings,
    enabled: true,
    categories: { ...settings.categories, 'sync-completed': true },
  };
};

const evaluate = (
  overrides: Partial<Parameters<typeof evaluateNotificationPolicy>[0]> = {},
) =>
  evaluateNotificationPolicy({
    settings: enabledSettings(),
    category: 'sync-completed',
    now: new Date('2026-11-03T16:00:00.000Z'),
    expiresAt: '2026-11-04T16:00:00.000Z',
    isFocused: false,
    permission: 'granted',
    targetAvailable: true,
    ...overrides,
  });

it('defaults the master switch and every notification category to off', () => {
  const settings = createDefaultNotificationSettings();

  expect(settings.enabled).toBe(false);
  expect(Object.values(settings.categories).every((enabled) => !enabled)).toBe(
    true,
  );
});

it('suppresses disabled, focused, unpermitted, expired, and stale-target alerts', () => {
  expect(
    evaluate({ settings: createDefaultNotificationSettings() }),
  ).toMatchObject({
    decision: 'suppress',
    reason: 'disabled',
  });
  expect(evaluate({ isFocused: true })).toMatchObject({
    decision: 'suppress',
    reason: 'focused',
  });
  expect(evaluate({ permission: 'denied' })).toMatchObject({
    decision: 'suppress',
    reason: 'permission-unavailable',
  });
  expect(evaluate({ targetAvailable: false })).toMatchObject({
    decision: 'suppress',
    reason: 'target-unavailable',
  });
  expect(evaluate({ expiresAt: '2026-11-03T15:59:59.000Z' })).toMatchObject({
    decision: 'suppress',
    reason: 'expired',
  });
});

it('defers a notification through quiet hours crossing midnight', () => {
  const settings = enabledSettings();
  settings.quietHours = {
    enabled: true,
    startMinute: 22 * 60,
    endMinute: 8 * 60,
    timeZone: 'America/Chicago',
  };

  expect(
    evaluate({
      settings,
      now: new Date('2026-11-03T04:00:00.000Z'),
      expiresAt: '2026-11-04T16:00:00.000Z',
    }),
  ).toEqual({
    decision: 'defer',
    reason: 'quiet-hours',
    deliverAfter: '2026-11-03T14:00:00.000Z',
  });
});

it('uses local wall time across spring-forward and both repeated fall-back hours', () => {
  const settings = enabledSettings();
  settings.quietHours = {
    enabled: true,
    startMinute: 22 * 60,
    endMinute: 4 * 60,
    timeZone: 'America/New_York',
  };

  expect(
    evaluate({
      settings,
      now: new Date('2026-03-08T07:30:00.000Z'),
      expiresAt: '2026-03-09T00:00:00.000Z',
    }),
  ).toMatchObject({
    decision: 'defer',
    deliverAfter: '2026-03-08T08:00:00.000Z',
  });

  const repeatedHourSettings = {
    ...settings,
    quietHours: {
      enabled: true,
      startMinute: 75,
      endMinute: 105,
      timeZone: 'America/New_York',
    },
  };
  expect(
    evaluate({
      settings: repeatedHourSettings,
      now: new Date('2026-11-01T05:30:00.000Z'),
      expiresAt: '2026-11-02T00:00:00.000Z',
    }),
  ).toMatchObject({
    decision: 'defer',
    deliverAfter: '2026-11-01T05:45:00.000Z',
  });
  expect(
    evaluate({
      settings: repeatedHourSettings,
      now: new Date('2026-11-01T06:30:00.000Z'),
      expiresAt: '2026-11-02T00:00:00.000Z',
    }),
  ).toMatchObject({
    decision: 'defer',
    deliverAfter: '2026-11-01T06:45:00.000Z',
  });
});

it('suppresses a deferred alert that will expire before quiet hours end', () => {
  const settings = enabledSettings();
  settings.quietHours = {
    enabled: true,
    startMinute: 22 * 60,
    endMinute: 8 * 60,
    timeZone: 'America/Chicago',
  };

  expect(
    evaluate({
      settings,
      now: new Date('2026-11-03T04:00:00.000Z'),
      expiresAt: '2026-11-03T13:59:59.000Z',
    }),
  ).toMatchObject({ decision: 'suppress', reason: 'expired' });
});
