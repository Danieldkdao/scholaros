import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { WatchTargetFailureCategory, WatchTargetStatus } from '../shared';

export const WatchTargetTable = sqliteTable(
  'watch_targets',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    courseId: text('course_id'),
    requestedUrl: text('requested_url').notNull(),
    verifiedUrl: text('verified_url'),
    urlIdentity: text('url_identity').notNull(),
    lastAttemptAt: text('last_attempt_at'),
    lastSuccessfulCheckAt: text('last_successful_check_at'),
    detectedFingerprint: text('detected_fingerprint'),
    processedFingerprint: text('processed_fingerprint'),
    pendingChange: integer('pending_change', { mode: 'boolean' })
      .notNull()
      .default(false),
    pendingSince: text('pending_since'),
    pendingSinceEstimated: integer('pending_since_estimated', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    lastFailureCategory: text(
      'last_failure_category',
    ).$type<WatchTargetFailureCategory>(),
    nextCheckAt: text('next_check_at'),
    status: text('status')
      .$type<WatchTargetStatus>()
      .notNull()
      .default('active'),
    failureCount: integer('failure_count').notNull().default(0),
    retryAt: text('retry_at'),
    recipeVersion: integer('recipe_version'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('watch_targets_identity_idx').on(
      table.userId,
      table.connectionId,
      table.urlIdentity,
    ),
    index('watch_targets_due_idx').on(
      table.userId,
      table.status,
      table.nextCheckAt,
    ),
    index('watch_targets_course_idx').on(
      table.userId,
      table.connectionId,
      table.courseId,
    ),
  ],
);

export type WatchTargetSelectData = typeof WatchTargetTable.$inferSelect;
export type WatchTargetInsertData = typeof WatchTargetTable.$inferInsert;
