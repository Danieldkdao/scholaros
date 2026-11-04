import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  StudyActivity,
  StudySessionStatus,
} from '@scholaros/services/learning/study-contracts';

export const StudySessionTable = sqliteTable(
  'study_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id').notNull(),
    title: text('title').notNull(),
    activity: text('activity').$type<StudyActivity>().notNull(),
    targetAssignmentId: text('target_assignment_id'),
    topic: text('topic'),
    status: text('status').$type<StudySessionStatus>().notNull(),
    revision: integer('revision').notNull().default(0),
    generationEpoch: integer('generation_epoch').notNull().default(0),
    draftText: text('draft_text').notNull().default(''),
    draftRevision: integer('draft_revision').notNull().default(0),
    deadlineAt: text('deadline_at'),
    timerRevision: integer('timer_revision').notNull().default(0),
    expiredRevision: integer('expired_revision'),
    resolvedExpiredRevision: integer('resolved_expired_revision'),
    finishedAt: text('finished_at'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastOpenedAt: text('last_opened_at').notNull(),
  },
  (table) => [
    index('study_sessions_user_course_status_idx').on(
      table.userId,
      table.courseId,
      table.status,
      table.updatedAt,
      table.id,
    ),
    index('study_sessions_user_updated_idx').on(
      table.userId,
      table.updatedAt,
      table.id,
    ),
  ],
);
export type StudySessionSelectData = typeof StudySessionTable.$inferSelect;
export type StudySessionInsertData = typeof StudySessionTable.$inferInsert;
