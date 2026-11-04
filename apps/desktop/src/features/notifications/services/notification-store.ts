import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ProductPreferences,
  SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import {
  notificationCategories,
  notificationSettingsSchema,
  safeRouteSchema,
} from '@scholaros/services/learning/notification-contracts';
import type {
  NotificationCategory,
  NotificationSettings,
  NotificationStatus,
  NotificationTargetKind,
  SafeRoute,
} from '@scholaros/services/learning/notification-contracts';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  ContextItemTable,
  CourseTable,
  NotificationEventTable,
  SettingTable,
  StudySessionTable,
} from '../../../db/schema';
import type { NotificationEventSelectData } from '../../../db/schema';
import {
  createDefaultNotificationSettings,
  evaluateNotificationPolicy,
} from './notification-policy';
import type { NotificationPermission } from './notification-policy';

export type NotificationEventTarget = {
  targetKind: NotificationTargetKind;
  targetId: string | null;
  safeRoute: SafeRoute;
};
export type NotificationEventInput = NotificationEventTarget & {
  category: NotificationCategory;
  outcomeId: string;
  expiresAt: string;
};
export type NotificationEventInsertResult = {
  event: NotificationEventSelectData;
  created: boolean;
};
export type NotificationClaimOptions = {
  now: Date;
  isFocused: boolean;
  permission: NotificationPermission;
};
export type NotificationEnqueueOptions = {
  now: Date;
  isFocused: boolean;
  permission: NotificationPermission;
};

const notificationClaimLeaseMilliseconds = 5 * 60_000;

const notificationSettingsInputSchema = notificationSettingsSchema.omit({
  revision: true,
});
export type NotificationSettingsInputSchema = z.infer<
  typeof notificationSettingsInputSchema
>;
export type NotificationSettingsInput = NotificationSettingsInputSchema;
const createNotificationError = (code: SafeErrorCode, message: string = code) =>
  Object.assign(new Error(message), { code });
type NotificationReader = Pick<typeof db, 'select'>;

const getSettingsInTransaction = (
  userId: string,
  reader: NotificationReader = db,
): NotificationSettings | null => {
  const existingSettings = reader
    .select({ productPreferences: SettingTable.productPreferences })
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get();
  if (!existingSettings) return null;
  const parsedSettings = notificationSettingsSchema.safeParse(
    existingSettings.productPreferences.notifications,
  );
  return parsedSettings.success ? parsedSettings.data : null;
};

export const getNotificationSettingsForUser = (
  userId: string,
): NotificationSettings | null => {
  try {
    const existingSettings = db
      .select({ productPreferences: SettingTable.productPreferences })
      .from(SettingTable)
      .where(eq(SettingTable.userId, userId))
      .get();
    if (!existingSettings) return createDefaultNotificationSettings();
    const parsedSettings = notificationSettingsSchema.safeParse(
      existingSettings.productPreferences.notifications,
    );
    return parsedSettings.success ? parsedSettings.data : null;
  } catch {
    return null;
  }
};

export const saveNotificationSettingsForUser = (
  userId: string,
  input: { settings: NotificationSettingsInput; expectedRevision: number },
  now = new Date(),
): NotificationSettings => {
  const settings = notificationSettingsInputSchema.parse(input.settings);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    throw createNotificationError(
      'invalid-input',
      'Notification settings are invalid.',
    );
  return db.transaction((tx) => {
    tx.insert(SettingTable)
      .values({ userId, updatedAt: now.toISOString() })
      .onConflictDoNothing()
      .run();
    const existingSettings = tx
      .select()
      .from(SettingTable)
      .where(eq(SettingTable.userId, userId))
      .get();
    if (!existingSettings)
      throw createNotificationError(
        'storage-failed',
        'Notification settings are unavailable.',
      );
    const currentSettings = notificationSettingsSchema.safeParse(
      existingSettings.productPreferences.notifications,
    );
    if (!currentSettings.success)
      throw createNotificationError(
        'storage-failed',
        'Notification settings are unavailable.',
      );
    if (currentSettings.data.revision !== input.expectedRevision)
      throw createNotificationError(
        'revision-conflict',
        'Notification settings changed elsewhere; try your edit again.',
      );

    const updatedSettings: NotificationSettings = {
      ...settings,
      revision: currentSettings.data.revision + 1,
    };
    const productPreferences: ProductPreferences = {
      ...existingSettings.productPreferences,
      notifications: updatedSettings,
    };
    tx.update(SettingTable)
      .set({ productPreferences, updatedAt: now.toISOString() })
      .where(eq(SettingTable.userId, userId))
      .run();

    const quietHoursChanged =
      currentSettings.data.quietHours.enabled !==
        updatedSettings.quietHours.enabled ||
      currentSettings.data.quietHours.startMinute !==
        updatedSettings.quietHours.startMinute ||
      currentSettings.data.quietHours.endMinute !==
        updatedSettings.quietHours.endMinute ||
      currentSettings.data.quietHours.timeZone !==
        updatedSettings.quietHours.timeZone;
    const disabledCategories = notificationCategories.filter(
      (category) =>
        !updatedSettings.enabled || !updatedSettings.categories[category],
    );
    if (disabledCategories.length)
      tx.update(NotificationEventTable)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(NotificationEventTable.userId, userId),
            inArray(NotificationEventTable.category, disabledCategories),
            inArray(NotificationEventTable.status, [
              'queued',
              'claimed',
              'delivered',
            ]),
          ),
        )
        .run();

    if (quietHoursChanged && updatedSettings.enabled) {
      const queuedNotifications = tx
        .select()
        .from(NotificationEventTable)
        .where(
          and(
            eq(NotificationEventTable.userId, userId),
            eq(NotificationEventTable.status, 'queued'),
          ),
        )
        .all();
      for (const event of queuedNotifications) {
        const policy = evaluateNotificationPolicy({
          settings: updatedSettings,
          category: event.category,
          now,
          expiresAt: event.expiresAt,
          isFocused: false,
          permission: 'granted',
          targetAvailable: isNotificationTargetAvailableWithReader(
            tx,
            userId,
            event,
          ),
        });
        if (policy.decision === 'deliver' || policy.decision === 'defer') {
          tx.update(NotificationEventTable)
            .set({
              deliverAfter:
                policy.decision === 'defer' ? policy.deliverAfter : null,
            })
            .where(
              and(
                eq(NotificationEventTable.userId, userId),
                eq(NotificationEventTable.id, event.id),
                eq(NotificationEventTable.status, 'queued'),
              ),
            )
            .run();
        } else {
          tx.update(NotificationEventTable)
            .set({
              status:
                policy.reason === 'target-unavailable'
                  ? 'cancelled'
                  : 'suppressed',
            })
            .where(
              and(
                eq(NotificationEventTable.userId, userId),
                eq(NotificationEventTable.id, event.id),
                eq(NotificationEventTable.status, 'queued'),
              ),
            )
            .run();
        }
      }
    }
    return updatedSettings;
  });
};

export const enqueueNotificationEventForUser = (
  userId: string,
  input: NotificationEventInput,
  options: NotificationEnqueueOptions,
): NotificationEventInsertResult =>
  db.transaction((tx) => {
    const safeRoute = safeRouteSchema.parse(input.safeRoute);
    const storedSettings = tx
      .select({ productPreferences: SettingTable.productPreferences })
      .from(SettingTable)
      .where(eq(SettingTable.userId, userId))
      .get();
    const parsedSettings = storedSettings
      ? notificationSettingsSchema.safeParse(
          storedSettings.productPreferences.notifications,
        )
      : null;
    if (storedSettings && !parsedSettings?.success)
      throw createNotificationError(
        'storage-failed',
        'Notification settings are unavailable.',
      );
    const settings = parsedSettings?.success
      ? parsedSettings.data
      : createDefaultNotificationSettings();
    const policy = evaluateNotificationPolicy({
      settings,
      category: input.category,
      now: options.now,
      expiresAt: input.expiresAt,
      isFocused: options.isFocused,
      permission: options.permission,
      targetAvailable: isNotificationTargetAvailableWithReader(tx, userId, {
        ...input,
        safeRoute,
      }),
    });
    const status: NotificationStatus =
      policy.decision === 'suppress' ? 'suppressed' : 'queued';
    const insertedNotification = tx
      .insert(NotificationEventTable)
      .values({
        id: randomUUID(),
        userId,
        category: input.category,
        targetKind: input.targetKind,
        targetId: input.targetId,
        outcomeId: input.outcomeId,
        preferenceRevision: settings.revision,
        status,
        deliverAfter: policy.decision === 'defer' ? policy.deliverAfter : null,
        expiresAt: input.expiresAt,
        claimedAt: null,
        deliveredAt: null,
        safeRoute,
        createdAt: options.now.toISOString(),
      })
      .onConflictDoNothing()
      .run();
    const event = tx
      .select()
      .from(NotificationEventTable)
      .where(
        and(
          eq(NotificationEventTable.userId, userId),
          eq(NotificationEventTable.category, input.category),
          eq(NotificationEventTable.outcomeId, input.outcomeId),
        ),
      )
      .get();
    if (!event)
      throw createNotificationError(
        'storage-failed',
        'Notification settings are unavailable.',
      );
    return { event, created: insertedNotification.changes > 0 };
  });

export const getNotificationEventForUser = (
  userId: string,
  eventId: string,
): NotificationEventSelectData | null => {
  try {
    return (
      db
        .select()
        .from(NotificationEventTable)
        .where(
          and(
            eq(NotificationEventTable.userId, userId),
            eq(NotificationEventTable.id, eventId),
          ),
        )
        .get() ?? null
    );
  } catch {
    return null;
  }
};

export const getNotificationEventsForUser = (
  userId: string,
): NotificationEventSelectData[] | null => {
  try {
    return db
      .select()
      .from(NotificationEventTable)
      .where(eq(NotificationEventTable.userId, userId))
      .all();
  } catch {
    return null;
  }
};

const routeMatchesEventTarget = (
  event: NotificationEventTarget,
  route: SafeRoute,
) => {
  switch (event.targetKind) {
    case 'context':
      return route.kind === 'context' && route.itemId === event.targetId;
    case 'study':
      return route.kind === 'study' && route.sessionId === event.targetId;
    case 'course':
      return route.kind === 'course' && route.courseId === event.targetId;
    case 'connection':
      return (
        event.targetId !== null &&
        (route.kind === 'today' ||
          (route.kind === 'settings' && route.section === 'connections'))
      );
    case 'device':
      return (
        event.targetId === null &&
        (route.kind === 'today' ||
          (route.kind === 'settings' && route.section === 'device'))
      );
  }
};

const isNotificationTargetAvailableWithReader = (
  reader: NotificationReader,
  userId: string,
  event: NotificationEventTarget,
): boolean => {
  const parsedRoute = safeRouteSchema.safeParse(event.safeRoute);
  if (!parsedRoute.success || !routeMatchesEventTarget(event, parsedRoute.data))
    return false;
  switch (event.targetKind) {
    case 'context':
      if (event.targetId === null) return true;
      return !!reader
        .select({ id: ContextItemTable.id })
        .from(ContextItemTable)
        .where(
          and(
            eq(ContextItemTable.userId, userId),
            eq(ContextItemTable.id, event.targetId),
            isNull(ContextItemTable.removedAt),
          ),
        )
        .get();
    case 'study':
      return !!reader
        .select({ id: StudySessionTable.id })
        .from(StudySessionTable)
        .where(
          and(
            eq(StudySessionTable.userId, userId),
            eq(StudySessionTable.id, event.targetId ?? ''),
            isNull(StudySessionTable.deletedAt),
          ),
        )
        .get();
    case 'course':
      return !!reader
        .select({ id: CourseTable.id })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.id, event.targetId ?? ''),
            eq(CourseTable.active, true),
          ),
        )
        .get();
    case 'connection':
      return !!reader
        .select({ id: AcademicConnectionTable.id })
        .from(AcademicConnectionTable)
        .where(
          and(
            eq(AcademicConnectionTable.userId, userId),
            eq(AcademicConnectionTable.id, event.targetId ?? ''),
          ),
        )
        .get();
    case 'device':
      return true;
  }
};

export const isNotificationTargetAvailable = (
  userId: string,
  event: NotificationEventTarget,
): boolean => isNotificationTargetAvailableWithReader(db, userId, event);

export const authorizeNotificationClickForUser = (
  userId: string,
  eventId: string,
  now: Date,
): SafeRoute | null =>
  db.transaction((tx) => {
    const event = tx
      .select()
      .from(NotificationEventTable)
      .where(
        and(
          eq(NotificationEventTable.userId, userId),
          eq(NotificationEventTable.id, eventId),
          eq(NotificationEventTable.status, 'delivered'),
        ),
      )
      .get();
    const settings =
      getSettingsInTransaction(userId, tx) ??
      createDefaultNotificationSettings();
    if (
      !event ||
      Date.parse(event.expiresAt) <= now.getTime() ||
      !settings.enabled ||
      !settings.categories[event.category]
    )
      return null;
    const route = safeRouteSchema.safeParse(event.safeRoute);
    if (
      !route.success ||
      !isNotificationTargetAvailableWithReader(tx, userId, event)
    )
      return null;
    return route.data;
  });

const policyForEvent = (
  reader: NotificationReader,
  userId: string,
  event: NotificationEventSelectData,
  settings: NotificationSettings | null,
  options: NotificationClaimOptions,
) =>
  evaluateNotificationPolicy({
    settings: settings ?? createDefaultNotificationSettings(),
    category: event.category,
    now: options.now,
    expiresAt: event.expiresAt,
    isFocused: options.isFocused,
    permission: options.permission,
    targetAvailable: isNotificationTargetAvailableWithReader(
      reader,
      userId,
      event,
    ),
  });

export const claimNotificationEventsForUser = (
  userId: string,
  options: NotificationClaimOptions,
  limit = 100,
): NotificationEventSelectData[] =>
  db.transaction((tx) => {
    const leaseCutoff = new Date(
      options.now.getTime() - notificationClaimLeaseMilliseconds,
    ).toISOString();
    // An expired native-show claim may already have reached the OS, so recovery must not replay it.
    tx.update(NotificationEventTable)
      .set({ status: 'failed' })
      .where(
        and(
          eq(NotificationEventTable.userId, userId),
          eq(NotificationEventTable.status, 'claimed'),
          or(
            isNull(NotificationEventTable.claimedAt),
            lte(NotificationEventTable.claimedAt, leaseCutoff),
          ),
        ),
      )
      .run();
    const currentSettings = getSettingsInTransaction(userId, tx);
    const queuedNotifications = tx
      .select()
      .from(NotificationEventTable)
      .where(
        and(
          eq(NotificationEventTable.userId, userId),
          eq(NotificationEventTable.status, 'queued'),
        ),
      )
      .all()
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, limit);
    const claimedNotifications: NotificationEventSelectData[] = [];
    for (const event of queuedNotifications) {
      const policy = policyForEvent(
        tx,
        userId,
        event,
        currentSettings,
        options,
      );
      if (policy.decision === 'suppress') {
        tx.update(NotificationEventTable)
          .set({
            status:
              policy.reason === 'target-unavailable'
                ? 'cancelled'
                : 'suppressed',
          })
          .where(
            and(
              eq(NotificationEventTable.userId, userId),
              eq(NotificationEventTable.id, event.id),
              eq(NotificationEventTable.status, 'queued'),
            ),
          )
          .run();
        continue;
      }
      if (policy.decision === 'defer') {
        tx.update(NotificationEventTable)
          .set({ deliverAfter: policy.deliverAfter })
          .where(
            and(
              eq(NotificationEventTable.userId, userId),
              eq(NotificationEventTable.id, event.id),
              eq(NotificationEventTable.status, 'queued'),
            ),
          )
          .run();
        continue;
      }
      const updatedNotification = tx
        .update(NotificationEventTable)
        .set({
          status: 'claimed',
          claimedAt: options.now.toISOString(),
          deliverAfter: null,
        })
        .where(
          and(
            eq(NotificationEventTable.userId, userId),
            eq(NotificationEventTable.id, event.id),
            eq(NotificationEventTable.status, 'queued'),
          ),
        )
        .run();
      if (!updatedNotification.changes) continue;
      const claimedNotification = tx
        .select()
        .from(NotificationEventTable)
        .where(
          and(
            eq(NotificationEventTable.userId, userId),
            eq(NotificationEventTable.id, event.id),
          ),
        )
        .get();
      if (claimedNotification) claimedNotifications.push(claimedNotification);
    }
    return claimedNotifications;
  });

export const authorizeNotificationShowForUser = (
  userId: string,
  eventId: string,
  claimedAt: string,
  options: NotificationClaimOptions,
): boolean =>
  db.transaction((tx) => {
    const event = tx
      .select()
      .from(NotificationEventTable)
      .where(
        and(
          eq(NotificationEventTable.userId, userId),
          eq(NotificationEventTable.id, eventId),
          eq(NotificationEventTable.status, 'claimed'),
          eq(NotificationEventTable.claimedAt, claimedAt),
        ),
      )
      .get();
    if (!event) return false;
    if (
      !event.claimedAt ||
      Date.parse(event.claimedAt) + notificationClaimLeaseMilliseconds <=
        options.now.getTime()
    ) {
      tx.update(NotificationEventTable)
        .set({ status: 'failed' })
        .where(
          and(
            eq(NotificationEventTable.userId, userId),
            eq(NotificationEventTable.id, event.id),
            eq(NotificationEventTable.status, 'claimed'),
            eq(NotificationEventTable.claimedAt, claimedAt),
          ),
        )
        .run();
      return false;
    }
    const policy = policyForEvent(
      tx,
      userId,
      event,
      getSettingsInTransaction(userId, tx),
      options,
    );
    if (policy.decision === 'deliver') return true;
    if (policy.decision === 'defer') {
      tx.update(NotificationEventTable)
        .set({
          status: 'queued',
          deliverAfter: policy.deliverAfter,
          claimedAt: null,
        })
        .where(
          and(
            eq(NotificationEventTable.userId, userId),
            eq(NotificationEventTable.id, event.id),
            eq(NotificationEventTable.status, 'claimed'),
            eq(NotificationEventTable.claimedAt, claimedAt),
          ),
        )
        .run();
      return false;
    }
    tx.update(NotificationEventTable)
      .set({
        status:
          policy.reason === 'target-unavailable' ? 'cancelled' : 'suppressed',
      })
      .where(
        and(
          eq(NotificationEventTable.userId, userId),
          eq(NotificationEventTable.id, event.id),
          eq(NotificationEventTable.status, 'claimed'),
          eq(NotificationEventTable.claimedAt, claimedAt),
        ),
      )
      .run();
    return false;
  });

export const settleNotificationEventForUser = (
  userId: string,
  eventId: string,
  claimedAt: string,
  status: Extract<NotificationStatus, 'delivered' | 'failed' | 'cancelled'>,
  now = new Date(),
) => {
  const leaseExpired =
    Date.parse(claimedAt) + notificationClaimLeaseMilliseconds <= now.getTime();
  if (leaseExpired && status !== 'cancelled') {
    db.update(NotificationEventTable)
      .set({ status: 'failed' })
      .where(
        and(
          eq(NotificationEventTable.userId, userId),
          eq(NotificationEventTable.id, eventId),
          eq(NotificationEventTable.status, 'claimed'),
          eq(NotificationEventTable.claimedAt, claimedAt),
        ),
      )
      .run();
    return false;
  }
  return (
    db
      .update(NotificationEventTable)
      .set({
        status,
        ...(status === 'delivered' ? { deliveredAt: now.toISOString() } : {}),
      })
      .where(
        and(
          eq(NotificationEventTable.userId, userId),
          eq(NotificationEventTable.id, eventId),
          eq(NotificationEventTable.status, 'claimed'),
          eq(NotificationEventTable.claimedAt, claimedAt),
        ),
      )
      .run().changes > 0
  );
};

export const cancelNotificationEventsForUser = (
  userId: string,
  target?: Pick<NotificationEventTarget, 'targetKind' | 'targetId'>,
) => {
  const targetFilters = target
    ? [
        eq(NotificationEventTable.targetKind, target.targetKind),
        target.targetId === null
          ? isNull(NotificationEventTable.targetId)
          : eq(NotificationEventTable.targetId, target.targetId),
      ]
    : [];
  return db
    .update(NotificationEventTable)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(NotificationEventTable.userId, userId),
        inArray(NotificationEventTable.status, [
          'queued',
          'claimed',
          'delivered',
        ]),
        ...targetFilters,
      ),
    )
    .run().changes;
};
