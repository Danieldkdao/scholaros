import { sqliteTable, text, index, integer } from 'drizzle-orm/sqlite-core';
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
    notes: text('notes'),
    favicon: text('favicon'),
    // Separate from status: a marked site that needs sign-in stays marked.
    isCourseResource: integer('is_course_resource', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (table) => [index('academic_connections_user_idx').on(table.userId)],
);
export type AcademicConnectionSelectData =
  typeof AcademicConnectionTable.$inferSelect;
export type AcademicConnectionInsertData =
  typeof AcademicConnectionTable.$inferInsert;
