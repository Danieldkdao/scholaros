import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db';
import {
  CourseTable,
  LearningObservationTable,
  MemoryTable,
} from '../../../db/schema';
import {
  memorySchema,
  preferenceContentSchema,
  preferenceFields,
  personalContextSchema,
} from '@scholaros/services/learning/memory-contracts';
import type {
  MemoryDTO,
  PersonalContext,
} from '@scholaros/services/learning/memory-contracts';
import {
  idSchema,
  type AuthorizedContext,
} from '@scholaros/services/learning/product-contracts';
import { getMemoryRevision, MemoryServiceError } from './memory-store';

const preparePersonalContextInputSchema = z.strictObject({
  courseId: idSchema.nullable().optional(),
});
export type PreparePersonalContextInputSchema = z.infer<
  typeof preparePersonalContextInputSchema
>;

const toMemoryDTO = (row: typeof MemoryTable.$inferSelect): MemoryDTO => {
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

const memoryPriority = (memory: MemoryDTO) => {
  const provenancePriority = (() => {
    switch (memory.type) {
      case 'explicit-preference':
        return 2;
      case 'provisional-preference':
        return 1;
      case 'learning-observation':
        return 0;
    }
  })();
  return [
    provenancePriority,
    memory.courseId === null ? 0 : 1,
    memory.revision,
    memory.updatedAt,
    memory.id,
  ] as const;
};

const outranks = (candidate: MemoryDTO, current: MemoryDTO) => {
  const candidatePriority = memoryPriority(candidate);
  const currentPriority = memoryPriority(current);
  for (let index = 0; index < candidatePriority.length; index += 1) {
    const difference = String(candidatePriority[index]).localeCompare(
      String(currentPriority[index]),
      undefined,
      { numeric: true },
    );
    if (difference !== 0) return difference > 0;
  }
  return false;
};

export const preparePersonalContext = (
  context: AuthorizedContext,
  input: z.infer<typeof preparePersonalContextInputSchema> = {},
): PersonalContext | null => {
  if (context.signal.aborted || !context.isCurrent()) return null;
  const parsedInput = preparePersonalContextInputSchema.safeParse(input);
  if (!parsedInput.success) return null;
  const courseId = parsedInput.data.courseId ?? null;

  try {
    if (
      courseId &&
      !db
        .select({ id: CourseTable.id })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, context.userId),
            eq(CourseTable.id, courseId),
          ),
        )
        .get()
    )
      return null;

    const preferenceRows = db
      .select()
      .from(MemoryTable)
      .where(
        and(
          eq(MemoryTable.userId, context.userId),
          isNull(MemoryTable.deletedAt),
          inArray(MemoryTable.type, [
            'explicit-preference',
            'provisional-preference',
          ]),
          courseId
            ? or(
                isNull(MemoryTable.courseId),
                eq(MemoryTable.courseId, courseId),
              )!
            : isNull(MemoryTable.courseId),
        ),
      )
      .orderBy(desc(MemoryTable.revision), desc(MemoryTable.id))
      .limit(500)
      .all()
      .map(toMemoryDTO);
    const tombstoneConditions = [
      eq(MemoryTable.userId, context.userId),
      isNotNull(MemoryTable.deletedAt),
      inArray(MemoryTable.type, [
        'explicit-preference',
        'provisional-preference',
      ]),
    ];
    if (courseId)
      tombstoneConditions.push(
        or(isNull(MemoryTable.courseId), eq(MemoryTable.courseId, courseId))!,
      );
    else tombstoneConditions.push(isNull(MemoryTable.courseId));
    const preferenceTombstones = db
      .select()
      .from(MemoryTable)
      .where(and(...tombstoneConditions))
      .orderBy(desc(MemoryTable.updatedAt))
      .limit(501)
      .all();
    if (preferenceTombstones.length > 500) return null;
    const tombstoneTimeByScopeField = new Map<string, number>();
    for (const tombstone of preferenceTombstones) {
      const parsedPreference = preferenceContentSchema.safeParse(
        tombstone.content,
      );
      if (!parsedPreference.success) return null;
      const key = JSON.stringify([
        tombstone.courseId,
        parsedPreference.data.field,
      ]);
      const updatedAt = Date.parse(tombstone.updatedAt);
      const previousUpdatedAt = tombstoneTimeByScopeField.get(key);
      if (previousUpdatedAt === undefined || updatedAt > previousUpdatedAt)
        tombstoneTimeByScopeField.set(key, updatedAt);
    }
    const selectedPreferences = new Map<string, MemoryDTO>();
    for (const memory of preferenceRows) {
      const parsedPreference = preferenceContentSchema.safeParse(
        memory.content,
      );
      if (!parsedPreference.success) return null;
      if (memory.type === 'provisional-preference') {
        const scopes =
          memory.courseId === null ? [null] : [null, memory.courseId];
        const inferredAt = Date.parse(memory.createdAt);
        const fenced = scopes.some((scope) => {
          const tombstoneTime = tombstoneTimeByScopeField.get(
            JSON.stringify([scope, parsedPreference.data.field]),
          );
          return tombstoneTime !== undefined && tombstoneTime >= inferredAt;
        });
        if (fenced) continue;
      }
      const current = selectedPreferences.get(parsedPreference.data.field);
      if (!current || outranks(memory, current))
        selectedPreferences.set(parsedPreference.data.field, memory);
    }
    const preferences = preferenceFields.flatMap((field) => {
      const memory = selectedPreferences.get(field);
      return memory ? [memory] : [];
    });

    const observations = courseId
      ? (() => {
          const eligibleObservations = db
            .select()
            .from(LearningObservationTable)
            .where(
              and(
                eq(LearningObservationTable.userId, context.userId),
                eq(LearningObservationTable.courseId, courseId),
                isNull(LearningObservationTable.revokedAt),
              ),
            )
            .orderBy(
              desc(LearningObservationTable.createdAt),
              desc(LearningObservationTable.id),
            )
            .limit(100)
            .all();
          const observationIds = eligibleObservations.map(({ id }) => id);
          if (!observationIds.length) return [];
          const activeMemories = db
            .select()
            .from(MemoryTable)
            .where(
              and(
                eq(MemoryTable.userId, context.userId),
                eq(MemoryTable.courseId, courseId),
                eq(MemoryTable.type, 'learning-observation'),
                isNull(MemoryTable.deletedAt),
                inArray(MemoryTable.id, observationIds),
              ),
            )
            .all();
          const memoryById = new Map(
            activeMemories.map((memory) => [memory.id, memory]),
          );
          return eligibleObservations
            .flatMap((observation) => {
              const memory = memoryById.get(observation.id);
              if (!memory || !memory.evidenceIds.includes(observation.id))
                return [];
              return [toMemoryDTO(memory)];
            })
            .slice(0, 10);
        })()
      : [];

    return personalContextSchema.parse({
      preferences: preferences.slice(0, 20),
      observations,
      revision: getMemoryRevision(db, context.userId),
    });
  } catch {
    return null;
  }
};
