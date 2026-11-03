import { z } from 'zod';
import { idSchema, revisionSchema } from './product-contracts';

export const notificationCategories = [
  'connection-attention',
  'sync-completed',
  'sync-failed',
  'context-completed',
  'context-failed',
  'tutor-ready',
  'activity-ready',
  'timer-expired',
  'deadline-reminder',
] as const;
export type NotificationCategory = (typeof notificationCategories)[number];
export const notificationStatuses = [
  'queued',
  'claimed',
  'delivered',
  'suppressed',
  'failed',
  'cancelled',
] as const;
export type NotificationStatus = (typeof notificationStatuses)[number];
export const notificationTargetKinds = [
  'context',
  'study',
  'course',
  'connection',
  'device',
] as const;
export type NotificationTargetKind = (typeof notificationTargetKinds)[number];
export const settingsSections = [
  'account',
  'device',
  'connections',
  'personal-context',
  'ai-navigation',
  'background',
  'grades',
  'notifications',
  'appearance',
  'local-data',
] as const;
export type SettingsSection = (typeof settingsSections)[number];
export const safeRouteSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('today') }),
  z.strictObject({
    kind: z.literal('settings'),
    section: z.enum(settingsSections),
  }),
  z.strictObject({ kind: z.literal('course'), courseId: idSchema }),
  z.strictObject({ kind: z.literal('context'), itemId: idSchema.nullable() }),
  z.strictObject({ kind: z.literal('study'), sessionId: idSchema }),
]);
export type SafeRoute = z.infer<typeof safeRouteSchema>;
const ianaTimeZoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, 'Expected an IANA time zone.');
export const notificationSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  categories: z.record(z.enum(notificationCategories), z.boolean()),
  quietHours: z.strictObject({
    enabled: z.boolean(),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(0).max(1439),
    timeZone: ianaTimeZoneSchema,
  }),
  revision: revisionSchema,
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
