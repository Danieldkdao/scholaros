import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  JsonValue,
  Id,
} from '@scholaros/services/learning/product-contracts';

export const AssistanceLedgerTable = sqliteTable(
  'assistance_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id').notNull(),
    protectionId: text('protection_id').notNull(),
    questionFingerprint: text('question_fingerprint').notNull(),
    turnId: text('turn_id').$type<Id | null>(),
    allowedSupportSummary: text('allowed_support_summary', { mode: 'json' })
      .$type<JsonValue>()
      .notNull(),
    answerRiskTags: text('answer_risk_tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    assistanceUnits: integer('assistance_units').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('assistance_ledger_protection_created_idx').on(
      table.userId,
      table.protectionId,
      table.createdAt,
    ),
    index('assistance_ledger_question_idx').on(
      table.userId,
      table.courseId,
      table.questionFingerprint,
    ),
  ],
);
export type AssistanceLedgerSelectData =
  typeof AssistanceLedgerTable.$inferSelect;
export type AssistanceLedgerInsertData =
  typeof AssistanceLedgerTable.$inferInsert;
