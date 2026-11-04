import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const ArtifactTable = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id'),
    currentVersionId: text('current_version_id'),
    originatingSessionId: text('originating_session_id'),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    retained: integer('retained', { mode: 'boolean' }).notNull().default(false),
    revision: integer('revision').notNull().default(0),
    removedAt: text('removed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('artifacts_user_course_idx').on(
      table.userId,
      table.courseId,
      table.removedAt,
    ),
    index('artifacts_session_idx').on(table.userId, table.originatingSessionId),
  ],
);
export type ArtifactSelectData = typeof ArtifactTable.$inferSelect;
export type ArtifactInsertData = typeof ArtifactTable.$inferInsert;
