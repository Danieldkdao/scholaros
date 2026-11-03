import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  NotificationCategory,
  NotificationStatus,
  NotificationTargetKind,
  SafeRoute,
} from '@scholaros/services/learning/notification-contracts';

export const NotificationEventTable = sqliteTable(
  'notification_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    category: text('category').$type<NotificationCategory>().notNull(),
    targetKind: text('target_kind').$type<NotificationTargetKind>().notNull(),
    targetId: text('target_id'),
    outcomeId: text('outcome_id').notNull(),
    preferenceRevision: integer('preference_revision').notNull(),
    status: text('status').$type<NotificationStatus>().notNull(),
    deliverAfter: text('deliver_after'),
    expiresAt: text('expires_at').notNull(),
    claimedAt: text('claimed_at'),
    deliveredAt: text('delivered_at'),
    safeRoute: text('safe_route', { mode: 'json' })
      .$type<SafeRoute>()
      .notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('notification_events_outcome_idx').on(
      table.userId,
      table.category,
      table.outcomeId,
    ),
    index('notification_events_due_idx').on(
      table.userId,
      table.status,
      table.deliverAfter,
      table.expiresAt,
    ),
    index('notification_events_target_idx').on(
      table.userId,
      table.targetKind,
      table.targetId,
      table.status,
    ),
  ],
);
export type NotificationEventSelectData =
  typeof NotificationEventTable.$inferSelect;
export type NotificationEventInsertData =
  typeof NotificationEventTable.$inferInsert;
