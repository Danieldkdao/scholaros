import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type {
  CourseMaterialSourceType,
  CourseMaterialExtractionStatus,
} from '../shared';
import type { CourseMaterialSummaryEvidence } from '../../features/context/types';

export const CourseMaterialVersionTable = sqliteTable(
  'course_material_versions',
  {
    materialId: text('material_id').notNull(),
    contentHash: text('content_hash').notNull(),
    title: text('title'),
    sourceUrl: text('source_url'),
    sourceType: text('source_type').$type<CourseMaterialSourceType>(),
    extractionStatus:
      text('extraction_status').$type<CourseMaterialExtractionStatus>(),
    completeness: integer('completeness'),
    summary: text('summary'),
    summaryEvidence: text('summary_evidence', { mode: 'json' }).$type<
      CourseMaterialSummaryEvidence[]
    >(),
    retrievedAt: text('retrieved_at'),
    verifiedAt: text('verified_at'),
    contentChangedAt: text('content_changed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.materialId, table.contentHash] }),
    index('course_material_versions_material_idx').on(table.materialId),
  ],
);
export type CourseMaterialVersionSelectData =
  typeof CourseMaterialVersionTable.$inferSelect;
export type CourseMaterialVersionInsertData =
  typeof CourseMaterialVersionTable.$inferInsert;
