import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const ContextLinkTable = sqliteTable(
  'context_links',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    itemId: text('item_id').notNull(),
    courseId: text('course_id'),
    sessionId: text('session_id'),
    retainedInLibrary: integer('retained_in_library', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('context_links_course_scope_idx')
      .on(table.userId, table.itemId, table.courseId)
      .where(sql`${table.courseId} is not null and ${table.sessionId} is null`),
    uniqueIndex('context_links_session_scope_idx')
      .on(table.userId, table.itemId, table.sessionId)
      .where(sql`${table.courseId} is null and ${table.sessionId} is not null`),
    uniqueIndex('context_links_course_session_scope_idx')
      .on(table.userId, table.itemId, table.courseId, table.sessionId)
      .where(
        sql`${table.courseId} is not null and ${table.sessionId} is not null`,
      ),
    uniqueIndex('context_links_library_scope_idx')
      .on(table.userId, table.itemId)
      .where(sql`${table.courseId} is null and ${table.sessionId} is null`),
    index('context_links_user_course_idx').on(
      table.userId,
      table.courseId,
      table.itemId,
    ),
    index('context_links_session_idx').on(
      table.userId,
      table.sessionId,
      table.itemId,
    ),
  ],
);
export type ContextLinkSelectData = typeof ContextLinkTable.$inferSelect;
export type ContextLinkInsertData = typeof ContextLinkTable.$inferInsert;
