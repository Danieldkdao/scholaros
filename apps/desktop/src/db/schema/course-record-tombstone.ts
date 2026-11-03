import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const courseRecordTombstoneKinds = [
  'courses',
  'assignments',
  'announcements',
] as const;
export type CourseRecordTombstoneKind =
  (typeof courseRecordTombstoneKinds)[number];

export const CourseRecordTombstoneTable = sqliteTable(
  'course_record_tombstones',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    courseSourceKey: text('course_source_key').notNull(),
    kind: text('kind').$type<CourseRecordTombstoneKind>().notNull(),
    resourceSourceKey: text('resource_source_key').notNull(),
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
  ],
);
export type CourseRecordTombstoneSelectData =
  typeof CourseRecordTombstoneTable.$inferSelect;
export type CourseRecordTombstoneInsertData =
  typeof CourseRecordTombstoneTable.$inferInsert;
