import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import type { AcademicContextEntryRole } from '../../features/onboarding/types';

export const AcademicContextEntryTable = sqliteTable(
  'academic_context_entries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    label: text('label').notNull(),
    url: text('url').notNull(),
    role: text('role').$type<AcademicContextEntryRole>().notNull(),
    evidenceUrl: text('evidence_url').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    index('academic_context_entries_user_idx').on(table.userId),
    index('academic_context_entries_connection_idx').on(table.connectionId),
  ],
);
export type AcademicContextEntrySelectData =
  typeof AcademicContextEntryTable.$inferSelect;
export type AcademicContextEntryInsertData =
  typeof AcademicContextEntryTable.$inferInsert;
