import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const CourseAnnouncementTable = sqliteTable(
  'course_announcements',
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
  },
  (table) => [
    uniqueIndex('course_announcements_identity_idx').on(
      table.userId,
      table.courseId,
      table.sourceKey,
    ),
    index('course_announcements_course_idx').on(table.userId, table.courseId),
  ],
);
export type CourseAnnouncementSelectData =
  typeof CourseAnnouncementTable.$inferSelect;
export type CourseAnnouncementInsertData =
  typeof CourseAnnouncementTable.$inferInsert;
