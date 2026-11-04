import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type {
  ObservationOutcome,
  LearningObservationKind,
} from '@scholaros/services/learning/memory-contracts';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';

export const LearningObservationTable = sqliteTable(
  'learning_observations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id').notNull(),
    conceptId: text('concept_id'),
    attemptId: text('attempt_id'),
    sourceSessionId: text('source_session_id'),
    kind: text('kind').$type<LearningObservationKind>().notNull(),
    responseOutcome: text('response_outcome')
      .$type<ObservationOutcome>()
      .notNull(),
    assisted: integer('assisted', { mode: 'boolean' }).notNull(),
    independentEvidence: integer('independent_evidence', { mode: 'boolean' })
      .notNull()
      .default(false),
    confidence: real('confidence'),
    evidenceSummary: text('evidence_summary', { mode: 'json' })
      .$type<JsonValue>()
      .notNull(),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (table) => [
    index('learning_observations_user_course_created_idx').on(
      table.userId,
      table.courseId,
      table.createdAt,
    ),
    index('learning_observations_attempt_idx').on(
      table.userId,
      table.attemptId,
    ),
  ],
);
export type LearningObservationSelectData =
  typeof LearningObservationTable.$inferSelect;
export type LearningObservationInsertData =
  typeof LearningObservationTable.$inferInsert;
