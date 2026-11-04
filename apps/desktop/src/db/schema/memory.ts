import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type {
  MemoryContent,
  MemoryProvenance,
  MemoryType,
} from '@scholaros/services/learning/memory-contracts';

export const MemoryTable = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id'),
    type: text('type').$type<MemoryType>().notNull(),
    content: text('content', { mode: 'json' }).$type<MemoryContent>().notNull(),
    provenance: text('provenance').$type<MemoryProvenance>().notNull(),
    evidenceIds: text('evidence_ids', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    confidence: real('confidence'),
    revision: integer('revision').notNull().default(0),
    supersedesId: text('supersedes_id'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('memories_user_type_updated_idx').on(
      table.userId,
      table.type,
      table.deletedAt,
      table.updatedAt,
    ),
    index('memories_user_course_idx').on(
      table.userId,
      table.courseId,
      table.deletedAt,
    ),
  ],
);
export type MemorySelectData = typeof MemoryTable.$inferSelect;
export type MemoryInsertData = typeof MemoryTable.$inferInsert;
