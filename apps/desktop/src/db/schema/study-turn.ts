import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { SafeErrorCode } from '@scholaros/services/learning/product-contracts';
import type { StudyTurnStatus } from '@scholaros/services/learning/study-contracts';

export const StudyTurnTable = sqliteTable(
  'study_turns',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    requestId: text('request_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    generationEpoch: integer('generation_epoch').notNull(),
    status: text('status').$type<StudyTurnStatus>().notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    policyRevision: integer('policy_revision').notNull(),
    contextRevision: integer('context_revision').notNull(),
    errorCode: text('error_code').$type<SafeErrorCode>(),
    startedAt: text('started_at').notNull(),
    settledAt: text('settled_at'),
  },
  (table) => [
    uniqueIndex('study_turns_request_idx').on(
      table.userId,
      table.sessionId,
      table.requestId,
    ),
    index('study_turns_session_status_idx').on(
      table.userId,
      table.sessionId,
      table.status,
    ),
  ],
);
export type StudyTurnSelectData = typeof StudyTurnTable.$inferSelect;
export type StudyTurnInsertData = typeof StudyTurnTable.$inferInsert;
