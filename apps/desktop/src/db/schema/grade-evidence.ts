import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  ObservedGrade,
  EvidenceTriState,
} from '@scholaros/services/learning/grade-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';

export const GradeEvidenceTable = sqliteTable(
  'grade_evidence',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    courseId: text('course_id').notNull(),
    assignmentIdentity: text('assignment_identity').notNull(),
    sourceVersion: text('source_version').notNull(),
    observedAt: text('observed_at').notNull(),
    consentRevision: integer('consent_revision').notNull(),
    completed: text('completed').$type<EvidenceTriState>().notNull(),
    grade: text('grade', { mode: 'json' }).$type<ObservedGrade | null>(),
    remainingOpportunity: text('remaining_opportunity')
      .$type<EvidenceTriState>()
      .notNull(),
    conflicts: text('conflicts', { mode: 'json' })
      .$type<JsonValue>()
      .notNull()
      .default([]),
    sourceReferences: text('source_references', { mode: 'json' })
      .$type<SourceReference[]>()
      .notNull()
      .default([]),
    revokedAt: text('revoked_at'),
  },
  (table) => [
    index('grade_evidence_user_consent_idx').on(
      table.userId,
      table.consentRevision,
      table.revokedAt,
    ),
    index('grade_evidence_assignment_idx').on(
      table.userId,
      table.connectionId,
      table.courseId,
      table.assignmentIdentity,
      table.observedAt,
    ),
  ],
);
export type GradeEvidenceSelectData = typeof GradeEvidenceTable.$inferSelect;
export type GradeEvidenceInsertData = typeof GradeEvidenceTable.$inferInsert;
