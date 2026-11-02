import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const CourseMaterialChunkTable = sqliteTable(
  'course_material_chunks',
  {
    id: text('id').primaryKey(),
    materialId: text('material_id').notNull(),
    version: text('version').notNull(),
    ordinal: integer('ordinal').notNull(),
    heading: text('heading'),
    locator: text('locator'),
    text: text('text').notNull(),
    sourceUrl: text('source_url').notNull(),
  },
  (table) => [
    uniqueIndex('course_material_chunks_version_ordinal_idx').on(
      table.materialId,
      table.version,
      table.ordinal,
    ),
    index('course_material_chunks_material_version_idx').on(
      table.materialId,
      table.version,
    ),
  ],
);
export type CourseMaterialChunkSelectData =
  typeof CourseMaterialChunkTable.$inferSelect;
export type CourseMaterialChunkInsertData =
  typeof CourseMaterialChunkTable.$inferInsert;
