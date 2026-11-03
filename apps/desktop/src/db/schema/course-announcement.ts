import type { ExtractedAnnouncementSchema } from '@scholaros/services/ai/resources/announcement';
import type { ResourceIdentityConflict } from '@scholaros/services/ai/resources/validation';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export type CourseAnnouncementLocalOverrides = Partial<{
  title: string;
  body: string | null;
  dateText: string | null;
  dateValue: string | null;
}>;

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
    content: text('content', {
      mode: 'json',
    }).$type<ExtractedAnnouncementSchema>(),
    identityConflicts: text('identity_conflicts', { mode: 'json' })
      .$type<Extract<ResourceIdentityConflict, { kind: 'announcements' }>[]>()
      .notNull()
      .default([]),
    localOverrides: text('local_overrides', {
      mode: 'json',
    }).$type<CourseAnnouncementLocalOverrides>(),
    localEditedAt: text('local_edited_at'),
    suppressionId: text('suppression_id'),
    suppressedAt: text('suppressed_at'),
    contentChangedAt: text('content_changed_at'),
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
