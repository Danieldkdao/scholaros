import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import type {
  AcademicConnection,
  ConnectionStatus,
} from '../../features/onboarding/types';

export const AcademicConnectionTable = sqliteTable(
  'academic_connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    host: text('host').notNull(),
    kind: text('kind').$type<AcademicConnection['kind']>().notNull(),
    status: text('status').$type<ConnectionStatus>().notNull(),
    verifiedAt: text('verified_at'),
  },
  (table) => [index('academic_connections_user_idx').on(table.userId)],
);
export type AcademicConnectionSelectData =
  typeof AcademicConnectionTable.$inferSelect;
export type AcademicConnectionInsertData =
  typeof AcademicConnectionTable.$inferInsert;
