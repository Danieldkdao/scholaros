import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';

export const ArtifactStateTable = sqliteTable(
  'artifact_states',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    versionId: text('version_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    stateRevision: integer('state_revision').notNull().default(0),
    state: text('state', { mode: 'json' }).$type<JsonValue>().notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('artifact_states_attempt_idx').on(
      table.artifactId,
      table.versionId,
      table.attemptId,
    ),
    index('artifact_states_user_updated_idx').on(table.userId, table.updatedAt),
  ],
);
export type ArtifactStateSelectData = typeof ArtifactStateTable.$inferSelect;
export type ArtifactStateInsertData = typeof ArtifactStateTable.$inferInsert;
