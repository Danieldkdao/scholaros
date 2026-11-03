import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';

export const ConceptTable = sqliteTable(
  'concepts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id').notNull(),
    label: text('label').notNull(),
    normalizedLabel: text('normalized_label').notNull(),
    description: text('description').notNull(),
    sourceReferences: text('source_references', { mode: 'json' })
      .$type<SourceReference[]>()
      .notNull()
      .default([]),
    uncertainty: text('uncertainty').notNull(),
    revision: integer('revision').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('concepts_user_course_label_idx').on(
      table.userId,
      table.courseId,
      table.normalizedLabel,
    ),
  ],
);
export type ConceptSelectData = typeof ConceptTable.$inferSelect;
export type ConceptInsertData = typeof ConceptTable.$inferInsert;
