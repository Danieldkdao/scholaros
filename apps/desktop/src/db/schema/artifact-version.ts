import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';

export const ArtifactVersionTable = sqliteTable(
  'artifact_versions',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull(),
    userId: text('user_id').notNull(),
    contentDigest: text('content_digest').notNull(),
    html: text('html').notNull(),
    css: text('css').notNull(),
    javascript: text('javascript').notNull(),
    runtimeVersion: integer('runtime_version').notNull(),
    sourceReferences: text('source_references', { mode: 'json' })
      .$type<SourceReference[]>()
      .notNull(),
    policyDecision: text('policy_decision', { mode: 'json' })
      .$type<JsonValue>()
      .notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('artifact_versions_artifact_created_idx').on(
      table.userId,
      table.artifactId,
      table.createdAt,
    ),
    index('artifact_versions_digest_idx').on(table.userId, table.contentDigest),
  ],
);
export type ArtifactVersionSelectData =
  typeof ArtifactVersionTable.$inferSelect;
export type ArtifactVersionInsertData =
  typeof ArtifactVersionTable.$inferInsert;
