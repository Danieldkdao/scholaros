import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  ConnectionOutcome,
  DiscoveryStatus,
} from '../../features/onboarding/types';

export const AcademicContextTable = sqliteTable('academic_context', {
  userId: text('user_id').primaryKey(),
  primaryLms: text('primary_lms'),
  notes: text('notes').notNull().default(''),
  discoveryStatus: text('discovery_status')
    .$type<DiscoveryStatus>()
    .notNull()
    .default('pending'),
  discoveryMessage: text('discovery_message'),
  discoveredAt: text('discovered_at'),
  // Per-resource results keep partial coverage honest across restarts.
  discoveryCoverage: text('discovery_coverage', { mode: 'json' }).$type<Record<
    string,
    ConnectionOutcome
  > | null>(),
});
export type AcademicContextSelectData =
  typeof AcademicContextTable.$inferSelect;
export type AcademicContextInsertData =
  typeof AcademicContextTable.$inferInsert;
