import { randomUUID, createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseTable,
} from '../../../db/schema';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import { saveCourseMaterialInputSchema } from '../schemas';
import type { SaveCourseMaterialInputSchema } from '../schemas';
import type { CourseMaterialSelectData } from '../../../db/schema';

type MaterialSaveResult = {
  material: CourseMaterialSelectData;
  changed: boolean;
  passagesWritten: number;
};

const safeMaterialUrl = (url: string, allowedHosts: string[]) => {
  if (url.length > 2048 || !isReadNavigation(url, allowedHosts)) return null;
  return academicPageIdentity(url);
};

export const saveCourseMaterial = (
  input: SaveCourseMaterialInputSchema,
): MaterialSaveResult | null => {
  const parsed = saveCourseMaterialInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const { userId, connectionId, courseId, source, content } = parsed.data;
  const contentHash = createHash('sha256')
    .update(content.normalizedText)
    .digest('hex');
  if (contentHash !== content.hash) return null;
  try {
    return db.transaction((tx) => {
      const connection = tx
        .select()
        .from(AcademicConnectionTable)
        .where(
          and(
            eq(AcademicConnectionTable.userId, userId),
            eq(AcademicConnectionTable.id, connectionId),
            eq(AcademicConnectionTable.isCourseResource, true),
          ),
        )
        .get();
      const course = tx
        .select()
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.connectionId, connectionId),
            eq(CourseTable.id, courseId),
          ),
        )
        .get();
      if (!connection || !course) return null;
      const allowedHosts = tx
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
      const sourceIdentity = safeMaterialUrl(source.url, allowedHosts);
      const summaryEvidence = source.summaryEvidence.map((evidence) => ({
        ...evidence,
        sourceUrl: safeMaterialUrl(evidence.sourceUrl, allowedHosts),
      }));
      if (
        !sourceIdentity ||
        summaryEvidence.some((evidence) => !evidence.sourceUrl) ||
        content.passages.some(
          (passage) => !content.normalizedText.includes(passage.text),
        ) ||
        content.passages.some(
          (passage) =>
            safeMaterialUrl(passage.sourceUrl, allowedHosts) !== sourceIdentity,
        )
      )
        return null;
      const existingCourseMaterial = tx
        .select()
        .from(CourseMaterialTable)
        .where(
          and(
            eq(CourseMaterialTable.userId, userId),
            eq(CourseMaterialTable.connectionId, connectionId),
            eq(CourseMaterialTable.courseId, courseId),
            eq(CourseMaterialTable.sourceIdentity, sourceIdentity),
          ),
        )
        .get();
      // An incomplete retry cannot replace the last fully read source version.
      if (
        existingCourseMaterial?.extractionStatus === 'complete' &&
        source.extractionStatus !== 'complete'
      )
        return null;
      const now = source.retrievedAt;
      const changed =
        !existingCourseMaterial ||
        existingCourseMaterial.contentHash !== content.hash;
      const values = {
        url: sourceIdentity,
        title: source.title,
        sourceType: source.sourceType,
        contentHash: content.hash,
        extractionStatus: source.extractionStatus,
        completeness: source.completeness,
        summary: source.summary,
        summaryEvidence: summaryEvidence.map((evidence) => ({
          ...evidence,
          sourceUrl: evidence.sourceUrl!,
        })),
        retrievedAt: source.retrievedAt,
        verifiedAt: source.verifiedAt,
        contentChangedAt: changed
          ? now
          : (existingCourseMaterial?.contentChangedAt ?? null),
        active: true,
      };
      let materialId = existingCourseMaterial?.id ?? randomUUID();
      if (existingCourseMaterial) {
        tx.update(CourseMaterialTable)
          .set(values)
          .where(eq(CourseMaterialTable.id, existingCourseMaterial.id))
          .run();
      } else {
        tx.insert(CourseMaterialTable)
          .values({
            id: materialId,
            userId,
            connectionId,
            courseId,
            sourceIdentity,
            ...values,
          })
          .run();
      }
      if (changed) {
        if (existingCourseMaterial)
          tx.delete(CourseMaterialChunkTable)
            .where(
              eq(
                CourseMaterialChunkTable.materialId,
                existingCourseMaterial.id,
              ),
            )
            .run();
        if (content.passages.length)
          tx.insert(CourseMaterialChunkTable)
            .values(
              content.passages.map((passage) => ({
                id: randomUUID(),
                materialId,
                version: content.hash,
                ordinal: passage.ordinal,
                heading: passage.heading,
                locator: passage.locator,
                text: passage.text,
                sourceUrl: sourceIdentity,
              })),
            )
            .run();
      }
      const material = tx
        .select()
        .from(CourseMaterialTable)
        .where(eq(CourseMaterialTable.id, materialId))
        .get();
      if (!material) return null;
      return {
        material,
        changed,
        passagesWritten: changed ? content.passages.length : 0,
      };
    });
  } catch {
    return null;
  }
};
