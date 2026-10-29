import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { BrowserId } from '../../features/onboarding/types';

export const BrowserWorkspaceTable = sqliteTable('browser_workspaces', {
  userId: text('user_id').primaryKey(),
  browser: text('browser').$type<BrowserId>().notNull(),
  browserName: text('browser_name').notNull(),
  executable: text('executable').notNull(),
  verifiedAt: text('verified_at').notNull(),
});
export type BrowserWorkspaceSelectData =
  typeof BrowserWorkspaceTable.$inferSelect;
export type BrowserWorkspaceInsertData =
  typeof BrowserWorkspaceTable.$inferInsert;
