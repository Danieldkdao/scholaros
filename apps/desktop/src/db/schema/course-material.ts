import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  CourseMaterialExtractionStatus,
  CourseMaterialSourceType,
  CourseMaterialSummaryEvidence,
} from '../../features/context/types';

export const CourseMaterialTable = sqliteTable(
  'course_materials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    courseId: text('course_id').notNull(),
    sourceIdentity: text('source_identity').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    sourceType: text('source_type').$type<CourseMaterialSourceType>().notNull(),
    contentHash: text('content_hash'),
    extractionStatus: text('extraction_status')
      .$type<CourseMaterialExtractionStatus>()
      .notNull()
      .default('pending'),
    completeness: integer('completeness').notNull().default(0),
    summary: text('summary'),
    summaryEvidence: text('summary_evidence', { mode: 'json' }).$type<
      CourseMaterialSummaryEvidence[]
    >(),
    retrievedAt: text('retrieved_at'),
    verifiedAt: text('verified_at'),
    contentChangedAt: text('content_changed_at'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
  },
  (table) => [
    uniqueIndex('course_materials_source_identity_idx').on(
      table.userId,
      table.connectionId,
      table.courseId,
      table.sourceIdentity,
    ),
    index('course_materials_course_idx').on(
      table.userId,
      table.connectionId,
      table.courseId,
      table.active,
    ),
  ],
);
export type CourseMaterialSelectData = typeof CourseMaterialTable.$inferSelect;
export type CourseMaterialInsertData = typeof CourseMaterialTable.$inferInsert;
