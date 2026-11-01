import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { CourseScanStatus } from '../../features/courses/types';

export const CourseSourceTable = sqliteTable(
  'course_sources',
  {
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    outcome: text('outcome').$type<CourseScanStatus>().notNull(),
    message: text('message'),
    lastAttemptedAt: text('last_attempted_at').notNull(),
    lastSuccessfulAt: text('last_successful_at'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.connectionId] }),
    index('course_sources_user_idx').on(table.userId),
  ],
);
export type CourseSourceSelectData = typeof CourseSourceTable.$inferSelect;
export type CourseSourceInsertData = typeof CourseSourceTable.$inferInsert;
