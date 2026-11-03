import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ConceptRelationshipKind } from '@scholaros/services/learning/memory-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';

export const ConceptLinkTable = sqliteTable(
  'concept_links',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    courseId: text('course_id').notNull(),
    fromConceptId: text('from_concept_id').notNull(),
    toConceptId: text('to_concept_id').notNull(),
    relationship: text('relationship')
      .$type<ConceptRelationshipKind>()
      .notNull(),
    sourceReferences: text('source_references', { mode: 'json' })
      .$type<SourceReference[]>()
      .notNull()
      .default([]),
    uncertainty: text('uncertainty').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('concept_links_identity_idx').on(
      table.userId,
      table.courseId,
      table.fromConceptId,
      table.toConceptId,
      table.relationship,
    ),
    index('concept_links_from_idx').on(
      table.userId,
      table.courseId,
      table.fromConceptId,
    ),
    index('concept_links_to_idx').on(
      table.userId,
      table.courseId,
      table.toConceptId,
    ),
  ],
);
export type ConceptLinkSelectData = typeof ConceptLinkTable.$inferSelect;
export type ConceptLinkInsertData = typeof ConceptLinkTable.$inferInsert;
