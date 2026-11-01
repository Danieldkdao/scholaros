import type { ExtractedAssignmentSchema } from '@scholaros/services/ai/resources/assignment';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const CourseAssignmentTable = sqliteTable(
  'course_assignments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id').notNull(),
    sourceKey: text('source_key').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    // A date-only value stays date-only; dateText keeps wording we could not
    // place in time without inventing a timezone.
    dateValue: text('date_value'),
    dateText: text('date_text'),
    url: text('url').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    lastSeenAt: text('last_seen_at').notNull(),
    content: text('content', {
      mode: 'json',
    }).$type<ExtractedAssignmentSchema>(),
    contentChangedAt: text('content_changed_at'),
  },
  (table) => [
    uniqueIndex('course_assignments_identity_idx').on(
      table.userId,
      table.courseId,
      table.sourceKey,
    ),
    index('course_assignments_course_idx').on(table.userId, table.courseId),
  ],
);
export type CourseAssignmentSelectData =
  typeof CourseAssignmentTable.$inferSelect;
export type CourseAssignmentInsertData =
  typeof CourseAssignmentTable.$inferInsert;
