import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { Locator } from '@scholaros/services/learning/context-contracts';

export const ContextChunkTable = sqliteTable(
  'context_chunks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    itemId: text('item_id').notNull(),
    versionId: text('version_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    locator: text('locator', { mode: 'json' }).$type<Locator | null>(),
    text: text('text').notNull(),
  },
  (table) => [
    uniqueIndex('context_chunks_version_ordinal_idx').on(
      table.versionId,
      table.ordinal,
    ),
    index('context_chunks_scope_idx').on(
      table.userId,
      table.itemId,
      table.versionId,
    ),
  ],
);
export type ContextChunkSelectData = typeof ContextChunkTable.$inferSelect;
export type ContextChunkInsertData = typeof ContextChunkTable.$inferInsert;
