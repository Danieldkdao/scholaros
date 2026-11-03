import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { CourseRecordTombstoneKind } from '../shared';

export const CourseRecordTombstoneTable = sqliteTable(
  'course_record_tombstones',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    courseSourceKey: text('course_source_key').notNull(),
    kind: text('kind').$type<CourseRecordTombstoneKind>().notNull(),
    resourceSourceKey: text('resource_source_key').notNull(),
    suppressionId: text('suppression_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('course_record_tombstones_identity_idx').on(
      table.userId,
      table.connectionId,
      table.courseSourceKey,
      table.kind,
      table.resourceSourceKey,
    ),
    index('course_record_tombstones_scope_idx').on(
      table.userId,
      table.connectionId,
      table.courseSourceKey,
    ),
    index('course_record_tombstones_group_idx').on(
      table.userId,
      table.connectionId,
      table.courseSourceKey,
      table.kind,
      table.suppressionId,
    ),
  ],
);
export type CourseRecordTombstoneSelectData =
  typeof CourseRecordTombstoneTable.$inferSelect;
export type CourseRecordTombstoneInsertData =
  typeof CourseRecordTombstoneTable.$inferInsert;
