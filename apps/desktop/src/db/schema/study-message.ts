import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  StudyMessageRole,
  StudyMessageStatus,
  MessagePart,
} from '@scholaros/services/learning/study-contracts';

export const StudyMessageTable = sqliteTable(
  'study_messages',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    sequence: integer('sequence').notNull(),
    turnId: text('turn_id'),
    role: text('role').$type<StudyMessageRole>().notNull(),
    status: text('status').$type<StudyMessageStatus>().notNull(),
    parts: text('parts', { mode: 'json' }).$type<MessagePart[]>().notNull(),
    gradeDerived: integer('grade_derived', { mode: 'boolean' })
      .notNull()
      .default(false),
    gradeConsentRevision: integer('grade_consent_revision'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('study_messages_session_sequence_idx').on(
      table.sessionId,
      table.sequence,
    ),
    index('study_messages_user_session_idx').on(
      table.userId,
      table.sessionId,
      table.sequence,
    ),
    index('study_messages_grade_derived_idx').on(
      table.userId,
      table.gradeDerived,
      table.gradeConsentRevision,
    ),
  ],
);
export type StudyMessageSelectData = typeof StudyMessageTable.$inferSelect;
export type StudyMessageInsertData = typeof StudyMessageTable.$inferInsert;
