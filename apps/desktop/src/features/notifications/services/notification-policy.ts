import {
  notificationCategories,
  notificationSettingsSchema,
} from '@scholaros/services/learning/notification-contracts';
import type {
  NotificationCategory,
  NotificationSettings,
} from '@scholaros/services/learning/notification-contracts';

export const notificationPermissionStates = [
  'granted',
  'denied',
  'unsupported',
  'unknown',
] as const;
export type NotificationPermission =
  (typeof notificationPermissionStates)[number];

export type NotificationPolicyInput = {
  settings: NotificationSettings;
  category: NotificationCategory;
  now: Date;
  expiresAt: string;
  isFocused: boolean;
  permission: NotificationPermission;
  targetAvailable: boolean;
};

export type NotificationPolicyResult =
  | { decision: 'deliver' }
  | {
      decision: 'defer';
      reason: 'quiet-hours';
      deliverAfter: string | null;
    }
  | {
      decision: 'suppress';
      reason:
        | 'disabled'
        | 'category-disabled'
        | 'focused'
        | 'permission-unavailable'
        | 'target-unavailable'
        | 'expired'
        | 'invalid-settings';
    };

const minuteMilliseconds = 60_000;

export const createDefaultNotificationSettings = (): NotificationSettings => ({
  enabled: false,
  categories: Object.fromEntries(
    notificationCategories.map((category) => [category, false]),
  ) as Record<NotificationCategory, boolean>,
  quietHours: {
    enabled: false,
    startMinute: 22 * 60,
    endMinute: 8 * 60,
    timeZone: 'UTC',
  },
  revision: 0,
});

const createQuietHoursFormatter = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

const getLocalMinute = (date: Date, formatter: Intl.DateTimeFormat): number => {
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
};

const isWithinQuietHours = (
  date: Date,
  settings: NotificationSettings,
  formatter?: Intl.DateTimeFormat,
) => {
  if (!settings.quietHours.enabled) return false;
  const { startMinute, endMinute, timeZone } = settings.quietHours;
  if (startMinute === endMinute) return true;
  const localMinute = getLocalMinute(
    date,
    formatter ?? createQuietHoursFormatter(timeZone),
  );
  return startMinute < endMinute
    ? localMinute >= startMinute && localMinute < endMinute
    : localMinute >= startMinute || localMinute < endMinute;
};

const findNextAllowedInstant = (now: Date, settings: NotificationSettings) => {
  if (
    settings.quietHours.startMinute === settings.quietHours.endMinute &&
    settings.quietHours.enabled
  )
    return null;
  let candidate =
    Math.floor(now.getTime() / minuteMilliseconds) * minuteMilliseconds +
    minuteMilliseconds;
  const formatter = createQuietHoursFormatter(settings.quietHours.timeZone);
  for (let minute = 0; minute < 48 * 60; minute += 1) {
    const candidateDate = new Date(candidate);
    if (!isWithinQuietHours(candidateDate, settings, formatter))
      return candidateDate.toISOString();
    candidate += minuteMilliseconds;
  }
  return null;
};

export const evaluateNotificationPolicy = (
  input: NotificationPolicyInput,
): NotificationPolicyResult => {
  const { settings, category, now } = input;
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(Date.parse(input.expiresAt)) ||
    !notificationSettingsSchema.safeParse(settings).success
  )
    return { decision: 'suppress', reason: 'invalid-settings' };
  if (Date.parse(input.expiresAt) <= now.getTime())
    return { decision: 'suppress', reason: 'expired' };
  if (!settings.enabled) return { decision: 'suppress', reason: 'disabled' };
  if (!settings.categories[category])
    return { decision: 'suppress', reason: 'category-disabled' };
  if (!input.targetAvailable)
    return { decision: 'suppress', reason: 'target-unavailable' };
  if (input.permission !== 'granted')
    return { decision: 'suppress', reason: 'permission-unavailable' };
  if (input.isFocused) return { decision: 'suppress', reason: 'focused' };
  if (!isWithinQuietHours(now, settings)) return { decision: 'deliver' };

  const deliverAfter = findNextAllowedInstant(now, settings);
  if (
    deliverAfter !== null &&
    Date.parse(deliverAfter) >= Date.parse(input.expiresAt)
  )
    return { decision: 'suppress', reason: 'expired' };
  return { decision: 'defer', reason: 'quiet-hours', deliverAfter };
};
