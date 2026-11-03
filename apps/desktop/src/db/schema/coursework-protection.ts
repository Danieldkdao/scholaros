import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { GradeVerificationState } from '@scholaros/services/learning/grade-contracts';
import type { Id } from '@scholaros/services/learning/product-contracts';

export const CourseworkProtectionTable = sqliteTable(
  'coursework_protections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id').notNull(),
    connectionId: text('connection_id'),
    canonicalIdentity: text('canonical_identity').notNull(),
    aliases: text('aliases', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    questionFingerprint: text('question_fingerprint'),
    state: text('state')
      .$type<GradeVerificationState>()
      .notNull()
      .default('unknown'),
    policyRevision: integer('policy_revision').notNull().default(0),
    verifiedAt: text('verified_at'),
    sourceEvidenceId: text('source_evidence_id').$type<Id | null>(),
    suppressed: integer('suppressed', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex('coursework_protections_identity_idx').on(
      table.userId,
      table.courseId,
      table.canonicalIdentity,
    ),
    index('coursework_protections_scope_idx').on(
      table.userId,
      table.connectionId,
      table.courseId,
      table.suppressed,
    ),
  ],
);
export type CourseworkProtectionSelectData =
  typeof CourseworkProtectionTable.$inferSelect;
export type CourseworkProtectionInsertData =
  typeof CourseworkProtectionTable.$inferInsert;
