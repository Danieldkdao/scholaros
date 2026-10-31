import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { CourseScanStatus } from '../../features/courses/types';

export const CourseTable = sqliteTable(
  'courses',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    // Cleared when the student removes the connection so saved history stays.
    connectionId: text('connection_id'),
    sourceKey: text('source_key').notNull(),
    sourceName: text('source_name').notNull(),
    sourceHost: text('source_host').notNull(),
    externalId: text('external_id'),
    name: text('name').notNull(),
    code: text('code'),
    term: text('term'),
    instructor: text('instructor'),
    description: text('description'),
    url: text('url').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    overviewSyncedAt: text('overview_synced_at'),
    announcementsStatus: text('announcements_status')
      .$type<CourseScanStatus>()
      .notNull()
      .default('pending'),
    announcementsSyncedAt: text('announcements_synced_at'),
    assignmentsStatus: text('assignments_status')
      .$type<CourseScanStatus>()
      .notNull()
      .default('pending'),
    assignmentsSyncedAt: text('assignments_synced_at'),
  },
  (table) => [
    uniqueIndex('courses_user_source_key_idx').on(
      table.userId,
      table.sourceKey,
    ),
    index('courses_user_connection_idx').on(table.userId, table.connectionId),
  ],
);
export type CourseSelectData = typeof CourseTable.$inferSelect;
export type CourseInsertData = typeof CourseTable.$inferInsert;
