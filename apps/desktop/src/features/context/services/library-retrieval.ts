import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  contextKinds,
  contextProvenances,
  locatorSchema,
  sourcePassageSchema,
  type SourcePassage,
} from '@scholaros/services/learning/context-contracts';
import {
  idSchema,
  type AuthorizedContext,
} from '@scholaros/services/learning/product-contracts';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseMaterialTable,
  CourseTable,
  StudySessionTable,
} from '../../../db/schema';
import { searchCourseMaterialPassages } from './read-actions';
import {
  contextChunkScanLimit,
  contextPassageLimit,
  normalizeContextSearchQuery,
  truncateContextText,
} from './library-store';

const searchStudySourcesInputSchema = z.strictObject({
  sessionId: idSchema,
  query: z.string().max(2000),
  selectedIds: z.array(idSchema).max(20),
  limit: z.number().int().min(1).max(20).optional(),
  maxCharacters: z.number().int().min(0).max(24_000).optional(),
});
export type SearchStudySourcesInputSchema = z.infer<
  typeof searchStudySourcesInputSchema
>;

type ContextCandidate = {
  reference: SourcePassage['reference'];
  text: string;
  score: number | null;
};

type MaterialCandidate = {
  reference: SourcePassage['reference'];
  text: string;
  score: number | null;
};

const safeLocator = (value: unknown) => {
  if (typeof value === 'string') {
    const page = value.match(/\bpage\s*(\d+)\b/iu);
    if (page) {
      const parsed = locatorSchema.safeParse({
        kind: 'page',
        page: Number(page[1]),
      });
      if (parsed.success) return parsed.data;
    }
  }
  const parsed = locatorSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const selectedContextItemIds = (
  userId: string,
  sessionId: string,
  courseId: string,
  selectedIds: string[],
) => {
  if (!selectedIds.length) return null;
  const placeholders = selectedIds.map(() => '?').join(', ');
  const rows = db.$client
    .prepare(
      `SELECT DISTINCT items.id
       FROM context_items AS items
       JOIN context_links AS links
         ON links.user_id = items.user_id AND links.item_id = items.id
       WHERE items.user_id = ?
         AND items.removed_at IS NULL
         AND items.id IN (${placeholders})
         AND (
           links.session_id = ?
           OR links.course_id = ?
           OR (
             links.course_id IS NULL
             AND links.session_id IS NULL
             AND links.retained_in_library = 1
             AND NOT EXISTS (
               SELECT 1 FROM context_links AS assigned
               WHERE assigned.user_id = items.user_id
                 AND assigned.item_id = items.id
                 AND assigned.course_id IS NOT NULL
             )
           )
         )`,
    )
    .all(userId, ...selectedIds, sessionId, courseId) as Array<{ id: string }>;
  return new Set(rows.map(({ id }) => id));
};

const validSelectedIds = (
  userId: string,
  sessionId: string,
  courseId: string,
  selectedIds: string[],
) => {
  if (!selectedIds.length) return { contextIds: null, materialIds: null };
  const contextIds =
    selectedContextItemIds(userId, sessionId, courseId, selectedIds) ??
    new Set<string>();
  const materialIds = new Set<string>();
  for (const selectedId of selectedIds) {
    if (contextIds.has(selectedId)) continue;
    const material = db
      .select({ id: CourseMaterialTable.id })
      .from(CourseMaterialTable)
      .innerJoin(
        CourseTable,
        and(
          eq(CourseTable.id, CourseMaterialTable.courseId),
          eq(CourseTable.userId, userId),
          eq(CourseTable.connectionId, CourseMaterialTable.connectionId),
          eq(CourseTable.active, true),
        ),
      )
      .innerJoin(
        AcademicConnectionTable,
        and(
          eq(AcademicConnectionTable.id, CourseMaterialTable.connectionId),
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.isCourseResource, true),
        ),
      )
      .where(
        and(
          eq(CourseMaterialTable.userId, userId),
          eq(CourseMaterialTable.courseId, courseId),
          eq(CourseMaterialTable.active, true),
          eq(CourseMaterialTable.id, selectedId),
        ),
      )
      .get();
    if (material) {
      materialIds.add(material.id);
      continue;
    }
    return null;
  }
  return { contextIds, materialIds };
};

const searchContextCandidates = (input: {
  userId: string;
  sessionId: string;
  courseId: string;
  ftsQuery: string;
  limit: number;
  selectedIds: Set<string> | null;
}): ContextCandidate[] => {
  if (input.selectedIds?.size === 0) return [];
  const selectedClause =
    input.selectedIds === null
      ? ''
      : `AND items.id IN (${[...input.selectedIds].map(() => '?').join(', ')})`;
  const rows = db.$client
    .prepare(
      `SELECT
         chunks.id AS chunkId,
         chunks.item_id AS itemId,
         chunks.version_id AS versionId,
         chunks.locator AS locator,
         chunks.text AS text,
         items.title AS title,
         items.kind AS kind,
         items.provenance AS provenance,
         versions.created_at AS createdAt,
         links.course_id AS linkCourseId,
         bm25(context_chunks_fts, 0, 0, 0, 0, 0, 1.0) AS score
       FROM context_chunks_fts
       JOIN context_chunks AS chunks
         ON chunks.rowid = context_chunks_fts.rowid
       JOIN context_items AS items
         ON items.id = chunks.item_id AND items.user_id = chunks.user_id
       JOIN context_versions AS versions
         ON versions.id = chunks.version_id
         AND versions.item_id = chunks.item_id
         AND versions.user_id = chunks.user_id
       JOIN context_links AS links
         ON links.user_id = items.user_id AND links.item_id = items.id
       WHERE context_chunks_fts MATCH ?
         AND context_chunks_fts.user_id = ?
         AND items.user_id = ?
         AND items.removed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM context_links AS conflicting_course
           WHERE conflicting_course.user_id = items.user_id
             AND conflicting_course.item_id = items.id
             AND conflicting_course.course_id IS NOT NULL
             AND conflicting_course.course_id != ?
         )
          AND items.kind != 'preference'
         AND items.current_version_id = versions.id
         AND versions.extraction_status IN ('complete', 'partial')
         AND versions.extracted_text IS NOT NULL
         AND (
           (links.session_id = ? AND (links.course_id IS NULL OR links.course_id = ?))
           OR links.course_id = ?
           OR (
             links.course_id IS NULL
             AND links.session_id IS NULL
             AND links.retained_in_library = 1
             AND NOT EXISTS (
               SELECT 1 FROM context_links AS assigned
               WHERE assigned.user_id = items.user_id
                 AND assigned.item_id = items.id
                 AND assigned.course_id IS NOT NULL
             )
           )
         )
         ${selectedClause}
       ORDER BY score ASC, chunks.ordinal ASC
       LIMIT ?`,
    )
    .all(
      input.ftsQuery,
      input.userId,
      input.userId,
      input.courseId,
      input.sessionId,
      input.courseId,
      input.courseId,
      ...(input.selectedIds?.size ? [...input.selectedIds] : []),
      contextChunkScanLimit,
    ) as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const passages: ContextCandidate[] = [];
  for (const row of rows) {
    const itemId = String(row.itemId);
    const versionId = String(row.versionId);
    const text = truncateContextText(String(row.text), contextPassageLimit);
    const key = `${itemId}:${versionId}:${text.replace(/\s+/gu, ' ').trim()}`;
    if (seen.has(key) || !text.trim()) continue;
    seen.add(key);
    const kind = contextKinds.find((value) => value === row.kind);
    const provenance = contextProvenances.find(
      (value) => value === row.provenance,
    );
    const score = Number(row.score);
    if (!kind || !provenance) continue;
    const parsed = sourcePassageSchema.safeParse({
      reference: {
        sourceKind: 'context-version',
        sourceId: itemId,
        versionId,
        courseId:
          typeof row.linkCourseId === 'string' ? row.linkCourseId : null,
        locator: safeLocator(row.locator),
        title: String(row.title),
        provenance,
        observedAt: String(row.createdAt),
        state: 'current',
      },
      text,
      score: Number.isFinite(score) ? score : null,
    });
    if (parsed.success)
      passages.push({ ...parsed.data, score: parsed.data.score });
  }
  return passages;
};

const searchMaterialCandidates = (input: {
  userId: string;
  courseId: string;
  connectionId: string;
  query: string;
  selectedIds: Set<string> | null;
  limit: number;
  maxCharacters: number;
}): MaterialCandidate[] | null => {
  const result = searchCourseMaterialPassages({
    userId: input.userId,
    connectionId: input.connectionId,
    courseId: input.courseId,
    query: input.query,
    limit: Math.min(input.limit, 8),
    maxCharacters: input.maxCharacters,
  });
  if (!result) return null;
  return result.passages
    .filter(
      (passage) =>
        !input.selectedIds ||
        input.selectedIds.has(passage.materialId) ||
        input.selectedIds.has(passage.id),
    )
    .map((passage) => {
      const parsedLocator = safeLocator(passage.locator);
      const locator =
        parsedLocator ??
        (passage.heading
          ? {
              kind: 'heading' as const,
              heading: truncateContextText(passage.heading, 300),
            }
          : { kind: 'paragraph' as const, ordinal: passage.ordinal + 1 });
      const parsed = sourcePassageSchema.safeParse({
        reference: {
          sourceKind: 'course-material',
          sourceId: passage.materialId,
          versionId: passage.version,
          courseId: input.courseId,
          locator,
          title: passage.title,
          provenance: 'connected-source',
          observedAt: passage.verifiedAt ?? passage.retrievedAt,
          state: 'current',
        },
        text: truncateContextText(passage.text, contextPassageLimit),
        score: Number.isFinite(passage.score) ? passage.score : null,
      });
      return parsed.success ? parsed.data : null;
    })
    .filter((passage): passage is SourcePassage => passage !== null);
};

const mergeWithinBudget = (
  contextPassages: ContextCandidate[],
  materialPassages: MaterialCandidate[],
  limit: number,
  maxCharacters: number,
): SourcePassage[] => {
  const merged: SourcePassage[] = [];
  let contextIndex = 0;
  let materialIndex = 0;
  let characters = 0;
  let preferContext = true;
  while (
    merged.length < limit &&
    characters < maxCharacters &&
    (contextIndex < contextPassages.length ||
      materialIndex < materialPassages.length)
  ) {
    const chooseContext: boolean =
      (preferContext && contextIndex < contextPassages.length) ||
      materialIndex >= materialPassages.length;
    const candidate = chooseContext
      ? contextPassages[contextIndex++]
      : materialPassages[materialIndex++];
    preferContext = !chooseContext;
    if (!candidate) continue;
    const remaining = maxCharacters - characters;
    const remainingCandidates =
      contextPassages.length -
      contextIndex +
      materialPassages.length -
      materialIndex +
      1;
    const budgetedSlots = Math.min(remainingCandidates, limit - merged.length);
    if (remaining <= 0 || budgetedSlots <= 0) break;
    const textCharacters = Array.from(candidate.text);
    const selectedCharacters = textCharacters.slice(
      0,
      Math.min(
        contextPassageLimit,
        remaining,
        Math.ceil(remaining / budgetedSlots),
      ),
    );
    const text = selectedCharacters.join('');
    if (!text.trim()) continue;
    const passage = sourcePassageSchema.safeParse({
      reference: candidate.reference,
      text,
      score: candidate.score,
    });
    if (!passage.success) continue;
    merged.push(passage.data);
    characters += selectedCharacters.length;
  }
  return merged;
};

export const searchStudySources = (
  context: AuthorizedContext,
  input: unknown,
): SourcePassage[] | null => {
  const parsed = searchStudySourcesInputSchema.safeParse(input);
  if (
    !parsed.success ||
    !context.userId.trim() ||
    context.signal.aborted ||
    !context.isCurrent()
  )
    return null;
  const ftsQuery = normalizeContextSearchQuery(parsed.data.query);
  if (!ftsQuery) return [];
  try {
    const session = db
      .select({ courseId: StudySessionTable.courseId })
      .from(StudySessionTable)
      .where(
        and(
          eq(StudySessionTable.userId, context.userId),
          eq(StudySessionTable.id, parsed.data.sessionId),
          isNull(StudySessionTable.deletedAt),
        ),
      )
      .get();
    if (!session) return null;
    const course = db
      .select({
        id: CourseTable.id,
        connectionId: CourseTable.connectionId,
      })
      .from(CourseTable)
      .where(
        and(
          eq(CourseTable.userId, context.userId),
          eq(CourseTable.id, session.courseId),
        ),
      )
      .get();
    if (!course) return null;
    const selected = validSelectedIds(
      context.userId,
      parsed.data.sessionId,
      course.id,
      parsed.data.selectedIds,
    );
    if (!selected) return null;
    const limit = parsed.data.limit ?? 20;
    const maxCharacters = parsed.data.maxCharacters ?? 24_000;
    const selectedContextIds = selected.contextIds
      ? new Set(
          [...selected.contextIds].filter((id) =>
            parsed.data.selectedIds.includes(id),
          ),
        )
      : null;
    const contextCandidates = searchContextCandidates({
      userId: context.userId,
      sessionId: parsed.data.sessionId,
      courseId: course.id,
      ftsQuery,
      limit,
      selectedIds: selectedContextIds,
    }).slice(0, limit);
    let materialCandidates: MaterialCandidate[] = [];
    const shouldSearchMaterials =
      course.connectionId !== null &&
      (!parsed.data.selectedIds.length || selected.materialIds?.size);
    if (shouldSearchMaterials && course.connectionId) {
      const connection = db
        .select({ id: AcademicConnectionTable.id })
        .from(AcademicConnectionTable)
        .where(
          and(
            eq(AcademicConnectionTable.userId, context.userId),
            eq(AcademicConnectionTable.id, course.connectionId),
            eq(AcademicConnectionTable.isCourseResource, true),
          ),
        )
        .get();
      if (connection) {
        const results = searchMaterialCandidates({
          userId: context.userId,
          courseId: course.id,
          connectionId: connection.id,
          query: parsed.data.query,
          selectedIds: selected.materialIds?.size ? selected.materialIds : null,
          limit,
          maxCharacters,
        });
        if (!results) return null;
        materialCandidates = results;
      }
    }
    return mergeWithinBudget(
      contextCandidates,
      materialCandidates,
      limit,
      maxCharacters,
    );
  } catch {
    return null;
  }
};
