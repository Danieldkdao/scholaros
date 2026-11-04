import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  PracticeFeedbackMode,
  PracticeMode,
  PracticeQuestionDTO,
  PracticeStatus,
} from '@scholaros/services/learning/practice-contracts';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';

export const PracticeAttemptTable = sqliteTable(
  'practice_attempts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id').notNull(),
    sessionId: text('session_id'),
    artifactId: text('artifact_id'),
    versionId: text('version_id').notNull(),
    objectiveIds: text('objective_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    mode: text('mode').$type<PracticeMode>().notNull(),
    feedbackMode: text('feedback_mode').$type<PracticeFeedbackMode>().notNull(),
    status: text('status').$type<PracticeStatus>().notNull(),
    assisted: integer('assisted', { mode: 'boolean' }).notNull().default(false),
    priorAttemptId: text('prior_attempt_id'),
    rubricVersion: text('rubric_version').notNull(),
    questionSet: text('question_set', { mode: 'json' })
      .$type<PracticeQuestionDTO[]>()
      .notNull(),
    hostAnswerKey: text('host_answer_key', { mode: 'json' })
      .$type<JsonValue>()
      .notNull(),
    revision: integer('revision').notNull().default(0),
    startedAt: text('started_at').notNull(),
    submittedAt: text('submitted_at'),
  },
  (table) => [
    index('practice_attempts_user_course_status_idx').on(
      table.userId,
      table.courseId,
      table.status,
      table.startedAt,
    ),
    index('practice_attempts_session_idx').on(
      table.userId,
      table.sessionId,
      table.startedAt,
    ),
  ],
);
export type PracticeAttemptSelectData =
  typeof PracticeAttemptTable.$inferSelect;
export type PracticeAttemptInsertData =
  typeof PracticeAttemptTable.$inferInsert;
