import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';
import type { PracticeEvaluationDTO } from '@scholaros/services/learning/practice-contracts';

export const PracticeAnswerTable = sqliteTable(
  'practice_answers',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    questionId: text('question_id').notNull(),
    revision: integer('revision').notNull(),
    answer: text('answer', { mode: 'json' }).$type<JsonValue>().notNull(),
    assisted: integer('assisted', { mode: 'boolean' }).notNull().default(false),
    evaluation: text('evaluation', {
      mode: 'json',
    }).$type<PracticeEvaluationDTO | null>(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('practice_answers_revision_idx').on(
      table.attemptId,
      table.questionId,
      table.revision,
    ),
    index('practice_answers_user_attempt_idx').on(
      table.userId,
      table.attemptId,
    ),
  ],
);
export type PracticeAnswerSelectData = typeof PracticeAnswerTable.$inferSelect;
export type PracticeAnswerInsertData = typeof PracticeAnswerTable.$inferInsert;
