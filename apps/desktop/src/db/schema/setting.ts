import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import type { OnboardingStep } from '../../features/onboarding/types';

export const SettingTable = sqliteTable('settings', {
  userId: text('user_id').primaryKey(),
  step: text('step').$type<OnboardingStep>().notNull().default('welcome'),
  consent: integer('consent', { mode: 'boolean' }).notNull().default(false),
  launchAtLogin: integer('launch_at_login', { mode: 'boolean' })
    .notNull()
    .default(false),
  backgroundSync: integer('background_sync', { mode: 'boolean' })
    .notNull()
    .default(false),
  watchEnabled: integer('watch_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  watchReconciledAt: text('watch_reconciled_at'),
  watchUrls: text('watch_urls', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  decisionTimeSeconds: real('decision_time_seconds').notNull().default(1),
  blockedWords: text('blocked_words', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  localSetupCompletedAt: text('local_setup_completed_at'),
  updatedAt: text('updated_at').notNull(),
});
export type SettingSelectData = typeof SettingTable.$inferSelect;
export type SettingInsertData = typeof SettingTable.$inferInsert;
