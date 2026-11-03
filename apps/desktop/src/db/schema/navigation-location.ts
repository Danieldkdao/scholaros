import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  NavigationDestinationKind,
  NavigationEvidence,
  NavigationFailureClass,
  NavigationLocationStatus,
  NavigationPurpose,
  NavigationRecipe,
} from '../../features/context/types';

export const NavigationLocationTable = sqliteTable(
  'navigation_locations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    connectionId: text('connection_id').notNull(),
    courseId: text('course_id'),
    purpose: text('purpose').$type<NavigationPurpose>().notNull(),
    destinationUrl: text('destination_url').notNull(),
    parentUrl: text('parent_url'),
    recipe: text('recipe', { mode: 'json' }).$type<NavigationRecipe>(),
    label: text('label'),
    evidence: text('evidence', { mode: 'json' })
      .$type<NavigationEvidence>()
      .notNull(),
    status: text('status')
      .$type<NavigationLocationStatus>()
      .notNull()
      .default('tentative'),
    destinationKind: text('destination_kind')
      .$type<NavigationDestinationKind>()
      .notNull(),
    observedAt: text('observed_at').notNull(),
    verifiedAt: text('verified_at'),
    failureCount: integer('failure_count').notNull().default(0),
    lastFailureClass:
      text('last_failure_class').$type<NavigationFailureClass>(),
  },
  (table) => [
    uniqueIndex('navigation_locations_course_identity_idx')
      .on(
        table.userId,
        table.connectionId,
        table.courseId,
        table.purpose,
        table.destinationUrl,
      )
      .where(sql`${table.courseId} is not null`),
    uniqueIndex('navigation_locations_connection_identity_idx')
      .on(table.userId, table.connectionId, table.purpose, table.destinationUrl)
      .where(sql`${table.courseId} is null`),
    index('navigation_locations_lookup_idx').on(
      table.userId,
      table.connectionId,
      table.courseId,
      table.purpose,
      table.status,
    ),
  ],
);
export type NavigationLocationSelectData =
  typeof NavigationLocationTable.$inferSelect;
export type NavigationLocationInsertData =
  typeof NavigationLocationTable.$inferInsert;
