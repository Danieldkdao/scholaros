import { and, eq } from 'drizzle-orm';
import { extractedAnnouncementSchema } from '@scholaros/services/ai/resources/announcement';
import { extractedAssignmentSchema } from '@scholaros/services/ai/resources/assignment';
import {
  resourceIdentityKeys,
  type ResourceIdentityRecord,
  type ResourceIdentityScope,
} from '@scholaros/services/ai/resources/identity';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseTable,
} from '../../../db/schema';
import {
  createNavigationContext,
  type NavigationContextPackage,
} from '../lib/navigation-context';
import {
  courseMaterialPassageReadInputSchema,
  courseMaterialReadPassageSchema,
  courseMaterialSearchInputSchema,
  courseMaterialSearchPassageSchema,
  courseMaterialSearchResultSchema,
  existingResourceIdentityInputSchema,
  navigationContextQuerySchema,
} from '../schemas';
import type {
  CourseMaterialPassageReadInputSchema,
  CourseMaterialSearchInputSchema,
  CourseMaterialReadPassageSchema,
  CourseMaterialSearchResultSchema,
  ExistingResourceIdentityInputSchema,
} from '../schemas';
import type { NavigationPurpose } from '../types';
import { getNavigationLocations } from './navigation-store';
import { isReadNavigation } from '../../onboarding/lib/browser-policy';

const maxFtsTerms = 12;
const maxFtsScannedPassages = 40;

const materialReadHosts = (userId: string) =>
  db
    .select({ host: AcademicConnectionTable.host })
    .from(AcademicConnectionTable)
    .where(
      and(
        eq(AcademicConnectionTable.userId, userId),
        eq(AcademicConnectionTable.isCourseResource, true),
      ),
    )
    .all()
    .map(({ host }) => host);

type ExistingResourceIdentity = ResourceIdentityRecord & {
  id: string;
  aliases: string[];
  active: boolean;
};

type CourseMaterialSearchPassage =
  CourseMaterialSearchResultSchema['passages'][number];

const ftsQueryFromText = (value: string) => {
  const tokens = [
    ...new Set(
      (value.normalize('NFKC').match(/[\p{L}\p{N}]{1,64}/gu) ?? []).slice(
        0,
        maxFtsTerms,
      ),
    ),
  ];
  return tokens
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' AND ');
};

const normalizedText = (value: string) =>
  value.replace(/\s+/g, ' ').trim().toLowerCase();

const isRedundantPassage = (
  candidate: CourseMaterialSearchPassage,
  selected: CourseMaterialSearchPassage[],
) => {
  const text = normalizedText(candidate.text);
  return selected.some((passage) => {
    if (
      passage.materialId !== candidate.materialId ||
      passage.version !== candidate.version
    )
      return false;
    const existing = normalizedText(passage.text);
    return (
      existing === text || existing.includes(text) || text.includes(existing)
    );
  });
};

export const getNavigationContextForTask = (input: {
  userId: string;
  connectionId: string;
  courseId: string | null;
  purpose: NavigationPurpose;
}): NavigationContextPackage | null => {
  const parsed = navigationContextQuerySchema.safeParse(input);
  if (!parsed.success) return null;
  const locations = getNavigationLocations(parsed.data);
  if (!locations) return null;
  return createNavigationContext(locations, parsed.data);
};

export const getExistingResourceIdentities = (
  input: ExistingResourceIdentityInputSchema,
): ExistingResourceIdentity[] | null => {
  const parsed = existingResourceIdentityInputSchema.safeParse(input);
  if (!parsed.success) return null;
  try {
    const connection = db
      .select({ host: AcademicConnectionTable.host })
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, parsed.data.userId),
          eq(AcademicConnectionTable.id, parsed.data.connectionId),
          eq(AcademicConnectionTable.isCourseResource, true),
        ),
      )
      .get();
    const course = db
      .select({ id: CourseTable.id })
      .from(CourseTable)
      .where(
        and(
          eq(CourseTable.userId, parsed.data.userId),
          eq(CourseTable.connectionId, parsed.data.connectionId),
          eq(CourseTable.id, parsed.data.courseId),
        ),
      )
      .get();
    if (!connection || !course) return null;
    const scope: ResourceIdentityScope = {
      accountId: parsed.data.userId,
      connectionId: parsed.data.connectionId,
      courseId: parsed.data.courseId,
      kind: parsed.data.kind,
    };
    const rows =
      parsed.data.kind === 'assignments'
        ? db
            .select()
            .from(CourseAssignmentTable)
            .where(
              and(
                eq(CourseAssignmentTable.userId, parsed.data.userId),
                eq(CourseAssignmentTable.courseId, parsed.data.courseId),
              ),
            )
            .all()
            .map((row) => {
              const content = extractedAssignmentSchema.safeParse(row.content);
              const resource: ResourceIdentityRecord = {
                title: content.success ? content.data.title : row.title,
                sourceId: content.success ? content.data.sourceId : null,
                url: (content.success ? content.data.url : null) ?? row.url,
                evidence: content.success
                  ? content.data.evidence
                  : {
                      sourceUrl: row.url,
                      excerpts: [row.title],
                      targetIds: [],
                    },
                ...(content.success
                  ? { state: content.data.state }
                  : { state: 'unknown' }),
              };
              return {
                id: row.id,
                active: row.active,
                ...resource,
                aliases: resourceIdentityKeys(scope, resource).aliases,
              };
            })
        : db
            .select()
            .from(CourseAnnouncementTable)
            .where(
              and(
                eq(CourseAnnouncementTable.userId, parsed.data.userId),
                eq(CourseAnnouncementTable.courseId, parsed.data.courseId),
              ),
            )
            .all()
            .map((row) => {
              const content = extractedAnnouncementSchema.safeParse(
                row.content,
              );
              const resource: ResourceIdentityRecord = {
                title: content.success ? content.data.title : row.title,
                sourceId: content.success ? content.data.sourceId : null,
                url: (content.success ? content.data.url : null) ?? row.url,
                evidence: content.success
                  ? content.data.evidence
                  : {
                      sourceUrl: row.url,
                      excerpts: [row.title],
                      targetIds: [],
                    },
              };
              return {
                id: row.id,
                active: row.active,
                ...resource,
                aliases: resourceIdentityKeys(scope, resource).aliases,
              };
            });
    return rows.filter((row) => {
      const urls = [row.url, row.evidence.sourceUrl].filter(
        (url): url is string => !!url,
      );
      return urls.every((url) => isReadNavigation(url, [connection.host]));
    });
  } catch {
    return null;
  }
};

export const searchCourseMaterialPassages = (
  input: CourseMaterialSearchInputSchema,
): CourseMaterialSearchResultSchema | null => {
  const startedAt = performance.now();
  const parsed = courseMaterialSearchInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const query = ftsQueryFromText(parsed.data.query);
  if (!query)
    return {
      passages: [],
      characters: 0,
      truncated: false,
      retrievalMs: Math.max(0, performance.now() - startedAt),
    };
  const limit = parsed.data.limit ?? 8;
  const characterLimit = parsed.data.maxCharacters ?? 16_000;
  try {
    const allowedHosts = materialReadHosts(parsed.data.userId);
    const rows = db.$client
      .prepare(
        `SELECT
          chunks.id AS id,
          chunks.material_id AS materialId,
          chunks.version AS version,
          chunks.ordinal AS ordinal,
          chunks.heading AS heading,
          chunks.locator AS locator,
          chunks.text AS text,
          chunks.source_url AS sourceUrl,
          materials.title AS title,
          materials.source_type AS sourceType,
          materials.extraction_status AS extractionStatus,
          materials.retrieved_at AS retrievedAt,
          materials.verified_at AS verifiedAt,
          materials.content_changed_at AS contentChangedAt,
          connections.host AS connectionHost,
          bm25(course_material_chunks_fts, 0, 0, 0, 3.0, 1.0) AS score
        FROM course_material_chunks_fts
        JOIN course_material_chunks AS chunks
          ON chunks.rowid = course_material_chunks_fts.rowid
        JOIN course_materials AS materials
          ON materials.id = chunks.material_id
        JOIN courses
          ON courses.id = materials.course_id
        JOIN academic_connections AS connections
          ON connections.id = materials.connection_id
        WHERE course_material_chunks_fts MATCH ?
          AND materials.user_id = ?
          AND materials.connection_id = ?
          AND materials.course_id = ?
          AND materials.active = 1
          AND materials.content_hash = chunks.version
          AND materials.extraction_status IN ('complete', 'partial')
          AND courses.user_id = ?
          AND courses.connection_id = ?
          AND courses.active = 1
          AND connections.user_id = ?
          AND connections.is_course_resource = 1
        ORDER BY score ASC, chunks.ordinal ASC
        LIMIT ?`,
      )
      .all(
        query,
        parsed.data.userId,
        parsed.data.connectionId,
        parsed.data.courseId,
        parsed.data.userId,
        parsed.data.connectionId,
        parsed.data.userId,
        maxFtsScannedPassages,
      ) as Array<Record<string, unknown>>;
    const passages: CourseMaterialSearchPassage[] = [];
    let characters = 0;
    let truncated = rows.length === maxFtsScannedPassages;
    for (const row of rows) {
      if (passages.length >= limit) {
        truncated = true;
        break;
      }
      const pageUrl = row.sourceUrl;
      if (!isReadNavigation(String(pageUrl), allowedHosts)) {
        truncated = true;
        continue;
      }
      const remaining = characterLimit - characters;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const candidate = {
        id: row.id,
        materialId: row.materialId,
        version: row.version,
        ordinal: row.ordinal,
        heading: row.heading,
        locator: row.locator,
        text: String(row.text).slice(0, remaining),
        sourceUrl: row.sourceUrl,
        title: row.title,
        sourceType: row.sourceType,
        extractionStatus: row.extractionStatus,
        retrievedAt: row.retrievedAt,
        verifiedAt: row.verifiedAt,
        contentChangedAt: row.contentChangedAt,
        score: row.score,
      };
      const passage = courseMaterialSearchPassageSchema.safeParse(candidate);
      if (!passage.success) {
        truncated = true;
        continue;
      }
      if (passage.data.text.length < String(row.text).length) truncated = true;
      if (isRedundantPassage(passage.data, passages)) continue;
      passages.push(passage.data);
      characters += passage.data.text.length;
    }
    const result = courseMaterialSearchResultSchema.safeParse({
      passages,
      characters,
      truncated,
      retrievalMs: Math.max(0, performance.now() - startedAt),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

export const readCourseMaterialPassages = (
  input: CourseMaterialPassageReadInputSchema,
): CourseMaterialReadPassageSchema[] | null => {
  const parsed = courseMaterialPassageReadInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const selections = [
    ...new Map(parsed.data.selections.map((item) => [item.id, item])).values(),
  ];
  const placeholders = selections.map(() => '?').join(', ');
  try {
    const allowedHosts = materialReadHosts(parsed.data.userId);
    const rows = db.$client
      .prepare(
        `SELECT
          chunks.id AS id,
          chunks.material_id AS materialId,
          chunks.version AS version,
          chunks.ordinal AS ordinal,
          chunks.heading AS heading,
          chunks.locator AS locator,
          chunks.text AS text,
          chunks.source_url AS sourceUrl,
          materials.title AS title,
          materials.source_type AS sourceType,
          materials.extraction_status AS extractionStatus,
          materials.retrieved_at AS retrievedAt,
          materials.verified_at AS verifiedAt,
          materials.content_changed_at AS contentChangedAt,
          connections.host AS connectionHost
        FROM course_material_chunks AS chunks
        JOIN course_materials AS materials
          ON materials.id = chunks.material_id
        JOIN courses
          ON courses.id = materials.course_id
        JOIN academic_connections AS connections
          ON connections.id = materials.connection_id
        WHERE chunks.id IN (${placeholders})
          AND chunks.version = materials.content_hash
          AND materials.user_id = ?
          AND materials.connection_id = ?
          AND materials.course_id = ?
          AND materials.active = 1
          AND courses.user_id = ?
          AND courses.connection_id = ?
          AND courses.active = 1
          AND connections.user_id = ?
          AND connections.is_course_resource = 1`,
      )
      .all(
        ...selections.map(({ id }) => id),
        parsed.data.userId,
        parsed.data.connectionId,
        parsed.data.courseId,
        parsed.data.userId,
        parsed.data.connectionId,
        parsed.data.userId,
      ) as Array<Record<string, unknown>>;
    const currentSelections = new Map(
      selections.map((selection) => [selection.id, selection.version]),
    );
    const readPassages: CourseMaterialReadPassageSchema[] = [];
    for (const row of rows) {
      if (currentSelections.get(String(row.id)) !== row.version) continue;
      if (!isReadNavigation(String(row.sourceUrl), allowedHosts)) continue;
      const candidate = { ...row };
      delete candidate.connectionHost;
      const passage = courseMaterialReadPassageSchema.safeParse(candidate);
      if (passage.success) readPassages.push(passage.data);
    }
    return readPassages;
  } catch {
    return null;
  }
};
