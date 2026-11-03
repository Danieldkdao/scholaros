import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  IngestionStatus,
  Locator,
} from '@scholaros/services/learning/context-contracts';

export const ContextVersionTable = sqliteTable(
  'context_versions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    itemId: text('item_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    originalHash: text('original_hash').notNull(),
    contentHash: text('content_hash').notNull(),
    mimeType: text('mime_type').notNull(),
    byteLength: integer('byte_length').notNull(),
    originalStorageKey: text('original_storage_key'),
    extractedText: text('extracted_text'),
    extractionStatus: text('extraction_status')
      .$type<IngestionStatus>()
      .notNull(),
    uncertainty: text('uncertainty'),
    pageCount: integer('page_count'),
    interpretedPages: text('interpreted_pages', { mode: 'json' })
      .$type<number[]>()
      .notNull()
      .default([]),
    locators: text('locators', { mode: 'json' })
      .$type<Locator[]>()
      .notNull()
      .default([]),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('context_versions_item_attempt_idx').on(
      table.itemId,
      table.attemptId,
    ),
    index('context_versions_item_original_idx').on(
      table.userId,
      table.itemId,
      table.originalHash,
    ),
    index('context_versions_content_hash_idx').on(
      table.userId,
      table.contentHash,
    ),
  ],
);
export type ContextVersionSelectData = typeof ContextVersionTable.$inferSelect;
export type ContextVersionInsertData = typeof ContextVersionTable.$inferInsert;
