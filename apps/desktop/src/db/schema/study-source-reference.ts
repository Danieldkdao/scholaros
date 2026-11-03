import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  Locator,
  SourceKind,
  SourceState,
} from '@scholaros/services/learning/context-contracts';

export const StudySourceReferenceTable = sqliteTable(
  'study_source_references',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    messageId: text('message_id').notNull(),
    sourceKind: text('source_kind').$type<SourceKind>().notNull(),
    sourceId: text('source_id').notNull(),
    versionId: text('version_id'),
    locator: text('locator', { mode: 'json' }).$type<Locator | null>(),
    state: text('state').$type<SourceState>().notNull(),
  },
  (table) => [
    index('study_source_references_scope_idx').on(
      table.userId,
      table.sessionId,
      table.messageId,
    ),
  ],
);
export type StudySourceReferenceSelectData =
  typeof StudySourceReferenceTable.$inferSelect;
export type StudySourceReferenceInsertData =
  typeof StudySourceReferenceTable.$inferInsert;
