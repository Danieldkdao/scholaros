import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db';
import {
  ConceptLinkTable,
  ConceptTable,
  CourseTable,
  LearningObservationTable,
  MemoryTable,
} from '../../../db/schema';
import {
  memorySchema,
  memoryTypes,
  observationSummarySchema,
  preferenceContentSchema,
} from '@scholaros/services/learning/memory-contracts';
import type { MemoryDTO } from '@scholaros/services/learning/memory-contracts';
import {
  idSchema,
  instantSchema,
  pageInputSchema,
  requestIdSchema,
  revisionSchema,
  type AuthorizedContext,
  type Page,
  type PageInput,
  type Revision,
} from '@scholaros/services/learning/product-contracts';
import type { MemoryInsertData, MemorySelectData } from '../../../db/schema';

export const memoryErrorCodes = [
  'invalid-input',
  'not-found',
  'scope-denied',
  'session-changed',
  'revision-conflict',
  'cancelled',
  'storage-failed',
] as const;
export type MemoryErrorCode = (typeof memoryErrorCodes)[number];
export class MemoryServiceError extends Error {
  constructor(readonly code: MemoryErrorCode) {
    super(code);
    this.name = 'MemoryServiceError';
  }
}

export type MemoryWriter = Omit<typeof db, '$client'>;
export type MemoryChange = {
  userId: string;
  courseId: string | null;
  revision: Revision;
};

type MemoryChangeListener = (change: MemoryChange) => void;
const memoryChangeListeners = new Set<MemoryChangeListener>();

export const subscribeMemoryChanges = (listener: MemoryChangeListener) => {
  memoryChangeListeners.add(listener);
  return () => memoryChangeListeners.delete(listener);
};

export const publishMemoryChange = (change: MemoryChange) => {
  for (const listener of memoryChangeListeners) {
    try {
      listener(change);
    } catch {
      continue;
    }
  }
};

const boundedPreferenceContentSchema = preferenceContentSchema.extend({
  value: z.string().trim().min(1).max(300),
});
export type BoundedPreferenceContentSchema = z.infer<
  typeof boundedPreferenceContentSchema
>;
const explicitPreferenceInputSchema = z.strictObject({
  requestId: requestIdSchema,
  preference: boundedPreferenceContentSchema,
  courseId: idSchema.optional(),
});
export type ExplicitPreferenceInputSchema = z.infer<
  typeof explicitPreferenceInputSchema
>;
const memoryListInputSchema = pageInputSchema.extend({
  type: z.enum(memoryTypes).optional(),
});
export type MemoryListInputSchema = z.infer<typeof memoryListInputSchema>;
const memoryCursorSchema = z.strictObject({
  createdAt: instantSchema,
  id: idSchema,
});
export type MemoryCursorSchema = z.infer<typeof memoryCursorSchema>;
const correctMemoryInputSchema = z.strictObject({
  memoryId: idSchema,
  expectedRevision: revisionSchema,
  preference: boundedPreferenceContentSchema,
});
export type CorrectMemoryInputSchema = z.infer<typeof correctMemoryInputSchema>;
const deleteMemoryInputSchema = z.strictObject({
  memoryId: idSchema,
  expectedRevision: revisionSchema,
});
export type DeleteMemoryInputSchema = z.infer<typeof deleteMemoryInputSchema>;

type ExplicitPreferenceInput = z.infer<typeof explicitPreferenceInputSchema>;

const assertCurrentContext = (context: AuthorizedContext) => {
  if (context.signal.aborted) throw new MemoryServiceError('cancelled');
  if (!context.isCurrent()) throw new MemoryServiceError('session-changed');
};

const toMemoryDTO = (row: MemorySelectData): MemoryDTO => {
  const parsedMemory = memorySchema.safeParse({
    id: row.id,
    courseId: row.courseId,
    type: row.type,
    content: row.content,
    provenance: row.provenance,
    evidenceIds: row.evidenceIds,
    confidence: row.confidence,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!parsedMemory.success) throw new MemoryServiceError('storage-failed');
  return parsedMemory.data;
};

export const getMemoryRevision = (
  writer: MemoryWriter,
  userId: string,
): Revision => {
  const memoryRevision = writer
    .select({
      revision: sql<number>`coalesce(max(${MemoryTable.revision}), 0)`,
    })
    .from(MemoryTable)
    .where(eq(MemoryTable.userId, userId))
    .get()?.revision;
  const conceptRevision = writer
    .select({
      revision: sql<number>`coalesce(max(${ConceptTable.revision}), 0)`,
    })
    .from(ConceptTable)
    .where(eq(ConceptTable.userId, userId))
    .get()?.revision;
  return Math.max(memoryRevision ?? 0, conceptRevision ?? 0);
};

export const nextMemoryRevision = (
  writer: MemoryWriter,
  userId: string,
): Revision => getMemoryRevision(writer, userId) + 1;

const assertCourseOwnership = (
  writer: MemoryWriter,
  userId: string,
  courseId: string | null,
) => {
  if (!courseId) return;
  const course = writer
    .select({ id: CourseTable.id })
    .from(CourseTable)
    .where(and(eq(CourseTable.userId, userId), eq(CourseTable.id, courseId)))
    .get();
  if (!course) throw new MemoryServiceError('scope-denied');
};

export const listMemories = (
  context: AuthorizedContext,
  input: PageInput & { type?: MemoryDTO['type'] },
): Page<MemoryDTO> | null => {
  if (context.signal.aborted || !context.isCurrent()) return null;
  const parsedInput = memoryListInputSchema.safeParse(input);
  if (!parsedInput.success) return null;
  const {
    cursor: cursorText,
    limit = 25,
    query,
    type,
    courseId,
  } = parsedInput.data;
  let cursor: z.infer<typeof memoryCursorSchema> | null = null;
  if (cursorText) {
    try {
      const decoded = Buffer.from(cursorText, 'base64url').toString('utf8');
      const parsedCursor = memoryCursorSchema.safeParse(JSON.parse(decoded));
      if (!parsedCursor.success) return null;
      cursor = parsedCursor.data;
    } catch {
      return null;
    }
  }

  try {
    const conditions: SQL[] = [
      eq(MemoryTable.userId, context.userId),
      isNull(MemoryTable.deletedAt),
    ];
    if (courseId !== undefined)
      conditions.push(
        courseId === null
          ? isNull(MemoryTable.courseId)
          : eq(MemoryTable.courseId, courseId),
      );
    if (type) conditions.push(eq(MemoryTable.type, type));
    if (query?.trim())
      conditions.push(
        sql`instr(lower(${MemoryTable.content}), lower(${query.trim()})) > 0`,
      );
    if (cursor)
      conditions.push(
        or(
          lt(MemoryTable.createdAt, cursor.createdAt),
          and(
            eq(MemoryTable.createdAt, cursor.createdAt),
            lt(MemoryTable.id, cursor.id),
          ),
        )!,
      );

    const rows = db
      .select()
      .from(MemoryTable)
      .where(and(...conditions))
      .orderBy(desc(MemoryTable.createdAt), desc(MemoryTable.id))
      .limit(limit + 1)
      .all();
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(toMemoryDTO);
    const lastMemory = pageRows.at(-1);
    const nextCursor =
      rows.length > limit && lastMemory
        ? Buffer.from(
            JSON.stringify({
              createdAt: lastMemory.createdAt,
              id: lastMemory.id,
            }),
          ).toString('base64url')
        : null;
    return {
      items,
      nextCursor,
      revision: nextMemoryRevision(db, context.userId) - 1,
    };
  } catch {
    return null;
  }
};

export const upsertExplicitPreference = (
  context: AuthorizedContext,
  input: ExplicitPreferenceInput,
): MemoryDTO => {
  assertCurrentContext(context);
  const parsedInput = explicitPreferenceInputSchema.safeParse(input);
  if (!parsedInput.success) throw new MemoryServiceError('invalid-input');
  const { requestId, preference, courseId = null } = parsedInput.data;
  const now = new Date().toISOString();

  try {
    const result = db.transaction((tx) => {
      assertCurrentContext(context);
      assertCourseOwnership(tx, context.userId, courseId);
      const existingRequest = tx
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            eq(MemoryTable.id, requestId),
          ),
        )
        .get();
      if (existingRequest) {
        if (
          existingRequest.deletedAt ||
          existingRequest.type !== 'explicit-preference' ||
          existingRequest.courseId !== courseId ||
          JSON.stringify(existingRequest.content) !== JSON.stringify(preference)
        )
          throw new MemoryServiceError('revision-conflict');
        const memory = toMemoryDTO(existingRequest);
        return {
          memory,
          changed: false,
          revision: memory.revision,
          courseId,
        };
      }

      const activePreferences = tx
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            isNull(MemoryTable.deletedAt),
            courseId
              ? eq(MemoryTable.courseId, courseId)
              : isNull(MemoryTable.courseId),
          ),
        )
        .all()
        .filter(
          (memory) =>
            memory.type === 'explicit-preference' ||
            memory.type === 'provisional-preference',
        );
      const supersededMemory = activePreferences.find((memory) => {
        const parsedContent = preferenceContentSchema.safeParse(memory.content);
        return (
          parsedContent.success && parsedContent.data.field === preference.field
        );
      });
      if (
        supersededMemory &&
        JSON.stringify(supersededMemory.content) === JSON.stringify(preference)
      )
        return {
          memory: toMemoryDTO(supersededMemory),
          changed: false,
          revision: supersededMemory.revision,
          courseId,
        };

      assertCurrentContext(context);
      const revision = nextMemoryRevision(tx, context.userId);
      if (supersededMemory)
        tx.update(MemoryTable)
          .set({ deletedAt: now, revision, updatedAt: now })
          .where(
            and(
              eq(MemoryTable.userId, context.userId),
              eq(MemoryTable.id, supersededMemory.id),
              isNull(MemoryTable.deletedAt),
            ),
          )
          .run();
      const insertedMemory: MemoryInsertData = {
        id: requestId,
        userId: context.userId,
        courseId,
        type: 'explicit-preference',
        content: preference,
        provenance: 'student-explicit',
        evidenceIds: [],
        confidence: null,
        revision,
        supersedesId: supersededMemory?.id ?? null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(MemoryTable).values(insertedMemory).run();
      const insertedPreference = tx
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            eq(MemoryTable.id, requestId),
          ),
        )
        .get();
      if (!insertedPreference) throw new MemoryServiceError('storage-failed');
      return {
        memory: toMemoryDTO(insertedPreference),
        changed: true,
        revision,
        courseId,
      };
    });
    if (result.changed)
      publishMemoryChange({
        userId: context.userId,
        courseId: result.courseId,
        revision: result.revision,
      });
    return result.memory;
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError('storage-failed');
  }
};

export const correctMemory = (
  context: AuthorizedContext,
  input: z.infer<typeof correctMemoryInputSchema>,
): MemoryDTO => {
  assertCurrentContext(context);
  const parsedInput = correctMemoryInputSchema.safeParse(input);
  if (!parsedInput.success) throw new MemoryServiceError('invalid-input');
  const { memoryId, expectedRevision, preference } = parsedInput.data;
  const now = new Date().toISOString();

  try {
    const result = db.transaction((tx) => {
      assertCurrentContext(context);
      const previousMemory = tx
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            eq(MemoryTable.id, memoryId),
          ),
        )
        .get();
      if (!previousMemory) throw new MemoryServiceError('not-found');
      if (
        previousMemory.deletedAt ||
        previousMemory.revision !== expectedRevision
      )
        throw new MemoryServiceError('revision-conflict');
      if (
        previousMemory.type !== 'explicit-preference' &&
        previousMemory.type !== 'provisional-preference'
      )
        throw new MemoryServiceError('invalid-input');
      const previousPreference = preferenceContentSchema.safeParse(
        previousMemory.content,
      );
      if (!previousPreference.success)
        throw new MemoryServiceError('storage-failed');
      if (previousPreference.data.field !== preference.field)
        throw new MemoryServiceError('invalid-input');

      assertCurrentContext(context);
      const revision = nextMemoryRevision(tx, context.userId);
      const updatedMemory = tx
        .update(MemoryTable)
        .set({ deletedAt: now, revision, updatedAt: now })
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            eq(MemoryTable.id, memoryId),
            eq(MemoryTable.revision, expectedRevision),
            isNull(MemoryTable.deletedAt),
          ),
        )
        .run();
      if (updatedMemory.changes !== 1)
        throw new MemoryServiceError('revision-conflict');
      const insertedMemory: MemoryInsertData = {
        id: randomUUID(),
        userId: context.userId,
        courseId: previousMemory.courseId,
        type: 'explicit-preference',
        content: preference,
        provenance: 'student-explicit',
        evidenceIds: previousMemory.evidenceIds,
        confidence: null,
        revision,
        supersedesId: previousMemory.id,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(MemoryTable).values(insertedMemory).run();
      const correctedMemory = tx
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            eq(MemoryTable.id, insertedMemory.id),
          ),
        )
        .get();
      if (!correctedMemory) throw new MemoryServiceError('storage-failed');
      return {
        memory: toMemoryDTO(correctedMemory),
        revision,
        courseId: previousMemory.courseId,
      };
    });
    publishMemoryChange({
      userId: context.userId,
      courseId: result.courseId,
      revision: result.revision,
    });
    return result.memory;
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError('storage-failed');
  }
};

export const deleteMemory = (
  context: AuthorizedContext,
  input: z.infer<typeof deleteMemoryInputSchema>,
): { revision: Revision; courseId: string | null } => {
  assertCurrentContext(context);
  const parsedInput = deleteMemoryInputSchema.safeParse(input);
  if (!parsedInput.success) throw new MemoryServiceError('invalid-input');
  const { memoryId, expectedRevision } = parsedInput.data;
  const now = new Date().toISOString();

  try {
    const deleted = db.transaction((tx) => {
      assertCurrentContext(context);
      const memory = tx
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            eq(MemoryTable.id, memoryId),
          ),
        )
        .get();
      if (!memory) throw new MemoryServiceError('not-found');
      if (memory.deletedAt || memory.revision !== expectedRevision)
        throw new MemoryServiceError('revision-conflict');

      assertCurrentContext(context);
      let tombstoneContent = memory.content;
      if (
        memory.type === 'explicit-preference' ||
        memory.type === 'provisional-preference'
      ) {
        const preference = preferenceContentSchema.safeParse(memory.content);
        if (!preference.success) throw new MemoryServiceError('storage-failed');
        tombstoneContent = { ...preference.data, value: '' };
      } else {
        const observation = observationSummarySchema.safeParse(memory.content);
        if (!observation.success)
          throw new MemoryServiceError('storage-failed');
        tombstoneContent = { ...observation.data, summary: '' };
      }
      const revision = nextMemoryRevision(tx, context.userId);
      const deletedMemory = tx
        .update(MemoryTable)
        .set({
          content: tombstoneContent,
          deletedAt: now,
          revision,
          updatedAt: now,
        })
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            eq(MemoryTable.id, memoryId),
            eq(MemoryTable.revision, expectedRevision),
            isNull(MemoryTable.deletedAt),
          ),
        )
        .run();
      if (deletedMemory.changes !== 1)
        throw new MemoryServiceError('revision-conflict');
      if (memory.type === 'learning-observation' && memory.evidenceIds.length)
        tx.update(LearningObservationTable)
          .set({ revokedAt: now, evidenceSummary: { deleted: true } })
          .where(
            and(
              eq(LearningObservationTable.userId, context.userId),
              inArray(LearningObservationTable.id, memory.evidenceIds),
              isNull(LearningObservationTable.revokedAt),
            ),
          )
          .run();
      return { revision, courseId: memory.courseId };
    });
    publishMemoryChange({
      userId: context.userId,
      courseId: deleted.courseId,
      revision: deleted.revision,
    });
    return deleted;
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError('storage-failed');
  }
};

export const purgeMemoryData = (
  context: AuthorizedContext,
): {
  memories: number;
  observations: number;
  concepts: number;
  links: number;
} => {
  assertCurrentContext(context);
  try {
    return db.transaction((tx) => {
      assertCurrentContext(context);
      const links = tx
        .delete(ConceptLinkTable)
        .where(eq(ConceptLinkTable.userId, context.userId))
        .run().changes;
      const concepts = tx
        .delete(ConceptTable)
        .where(eq(ConceptTable.userId, context.userId))
        .run().changes;
      const observations = tx
        .delete(LearningObservationTable)
        .where(eq(LearningObservationTable.userId, context.userId))
        .run().changes;
      const memories = tx
        .delete(MemoryTable)
        .where(eq(MemoryTable.userId, context.userId))
        .run().changes;
      return { memories, observations, concepts, links };
    });
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError('storage-failed');
  }
};
