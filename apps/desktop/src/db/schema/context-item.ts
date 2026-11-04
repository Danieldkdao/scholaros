import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  ContextKind,
  ContextProvenance,
  IngestionStatus,
} from '@scholaros/services/learning/context-contracts';

export const ContextItemTable = sqliteTable(
  'context_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),
    kind: text('kind').$type<ContextKind>().notNull(),
    provenance: text('provenance').$type<ContextProvenance>().notNull(),
    currentVersionId: text('current_version_id'),
    status: text('status').$type<IngestionStatus>().notNull(),
    revision: integer('revision').notNull().default(0),
    removedAt: text('removed_at'),
    originatingSessionId: text('originating_session_id'),
    originatingSourceId: text('originating_source_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('context_items_user_updated_idx').on(
      table.userId,
      table.removedAt,
      table.updatedAt,
      table.id,
    ),
    index('context_items_current_version_idx').on(table.currentVersionId),
  ],
);
export type ContextItemSelectData = typeof ContextItemTable.$inferSelect;
export type ContextItemInsertData = typeof ContextItemTable.$inferInsert;
