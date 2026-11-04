import { randomUUID, createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseMaterialVersionTable,
  CourseTable,
  StudySourceReferenceTable,
} from '../../../db/schema';
import {
  courseCollectionScanSchema,
  hostCourseCollectionCoverageEvidenceSchema,
} from '../../courses/schemas';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import { saveCourseMaterialInputSchema } from '../schemas';
import type { SaveCourseMaterialInputSchema } from '../schemas';
import type { CourseMaterialSelectData } from '../../../db/schema';

type MaterialSaveResult = {
  outcome: 'saved' | 'preserved-current';
  material: CourseMaterialSelectData;
  changed: boolean;
  passagesWritten: number;
};

const deleteCourseMaterialInputSchema = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  connectionId: z.string().trim().min(1).max(200),
  courseId: z.string().trim().min(1).max(200),
  materialId: z.string().trim().min(1).max(200),
});
export type DeleteCourseMaterialInputSchema = z.infer<
  typeof deleteCourseMaterialInputSchema
>;
export type DeleteCourseMaterialInput = z.infer<
  typeof deleteCourseMaterialInputSchema
>;

const materialCollectionReconciliationContextSchema = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  connectionId: z.string().trim().min(1).max(200),
  courseId: z.string().trim().min(1).max(200),
});
export type MaterialCollectionReconciliationContextSchema = z.infer<
  typeof materialCollectionReconciliationContextSchema
>;
const materialCollectionReconciliationInputSchema = z.strictObject({
  coverage: hostCourseCollectionCoverageEvidenceSchema,
  seenIds: z
    .array(z.string().trim().min(1).max(200))
    .max(10_000)
    .refine((ids) => new Set(ids).size === ids.length),
});
export type MaterialCollectionReconciliationInputSchema = z.infer<
  typeof materialCollectionReconciliationInputSchema
>;
export type MaterialCollectionReconciliationContext = z.infer<
  typeof materialCollectionReconciliationContextSchema
>;
export type MaterialCollectionReconciliationInput = z.infer<
  typeof materialCollectionReconciliationInputSchema
>;

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
  const requestedUsable =
    source.extractionStatus === 'complete' ||
    source.extractionStatus === 'partial';
  const hasUsableContent =
    content.normalizedText.trim().length > 0 && content.passages.length > 0;
  if (source.extractionStatus === 'complete' && !hasUsableContent) return null;
  if (!requestedUsable && hasUsableContent) return null;
  const attemptStatus =
    source.extractionStatus === 'partial' && !hasUsableContent
      ? 'unreadable'
      : source.extractionStatus;
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
            eq(AcademicConnectionTable.status, 'verified'),
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
            eq(CourseTable.active, true),
            isNull(CourseTable.suppressionId),
            isNull(CourseTable.suppressedAt),
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
            eq(AcademicConnectionTable.status, 'verified'),
          ),
        )
        .all()
        .map(({ host }) => host);
      const sourceIdentity = safeMaterialUrl(source.url, allowedHosts);
      if (!sourceIdentity) return null;
      const summaryEvidence = requestedUsable
        ? source.summaryEvidence.map((evidence) => ({
            ...evidence,
            sourceUrl: safeMaterialUrl(evidence.sourceUrl, allowedHosts),
          }))
        : [];
      if (
        summaryEvidence.some((evidence) => !evidence.sourceUrl) ||
        (requestedUsable &&
          content.passages.some(
            (passage) => !content.normalizedText.includes(passage.text),
          )) ||
        (requestedUsable &&
          content.passages.some(
            (passage) =>
              safeMaterialUrl(passage.sourceUrl, allowedHosts) !==
              sourceIdentity,
          ))
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
      if (
        existingCourseMaterial?.suppressionId ||
        existingCourseMaterial?.suppressedAt
      )
        return null;
      const materialId = existingCourseMaterial?.id ?? randomUUID();
      const currentCandidateHash =
        existingCourseMaterial?.currentUsableVersion ??
        existingCourseMaterial?.contentHash ??
        null;
      const existingCurrentVersion = currentCandidateHash
        ? tx
            .select()
            .from(CourseMaterialVersionTable)
            .where(
              and(
                eq(CourseMaterialVersionTable.materialId, materialId),
                eq(
                  CourseMaterialVersionTable.contentHash,
                  currentCandidateHash,
                ),
              ),
            )
            .get()
        : undefined;
      const currentVersionIsUsable =
        existingCurrentVersion?.extractionStatus === 'complete' ||
        existingCurrentVersion?.extractionStatus === 'partial';
      const currentVersionHash = currentVersionIsUsable
        ? existingCurrentVersion.contentHash
        : null;
      const now = source.retrievedAt;
      if (!requestedUsable || !hasUsableContent) {
        const attemptValues = {
          extractionStatus: attemptStatus,
          completeness:
            attemptStatus === 'unreadable' ? 0 : source.completeness,
          lastAttemptAt: now,
        };
        if (existingCourseMaterial) {
          tx.update(CourseMaterialTable)
            .set(
              currentVersionHash
                ? attemptValues
                : {
                    ...attemptValues,
                    url: sourceIdentity,
                    title: source.title,
                    sourceType: source.sourceType,
                  },
            )
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
              url: sourceIdentity,
              title: source.title,
              sourceType: source.sourceType,
              contentHash: null,
              currentUsableVersion: null,
              extractionStatus: attemptStatus,
              completeness:
                attemptStatus === 'unreadable' ? 0 : source.completeness,
              summary: null,
              summaryEvidence: [],
              retrievedAt: null,
              verifiedAt: null,
              contentChangedAt: null,
              lastAttemptAt: now,
              active: true,
              suppressionId: null,
              suppressedAt: null,
            })
            .run();
        }
        const material = tx
          .select()
          .from(CourseMaterialTable)
          .where(eq(CourseMaterialTable.id, materialId))
          .get();
        if (!material) return null;
        return {
          outcome: currentVersionHash ? 'preserved-current' : 'saved',
          material,
          changed: false,
          passagesWritten: 0,
        };
      }

      const existingContentVersion = tx
        .select()
        .from(CourseMaterialVersionTable)
        .where(
          and(
            eq(CourseMaterialVersionTable.materialId, materialId),
            eq(CourseMaterialVersionTable.contentHash, content.hash),
          ),
        )
        .get();
      const changed = currentVersionHash !== content.hash;
      const versionMetadata = {
        title: source.title,
        sourceUrl: sourceIdentity,
        sourceType: source.sourceType,
        extractionStatus: source.extractionStatus,
        completeness: source.completeness,
        summary: source.summary,
        summaryEvidence: summaryEvidence.map((evidence) => ({
          ...evidence,
          sourceUrl: evidence.sourceUrl!,
        })),
        retrievedAt: source.retrievedAt,
        verifiedAt:
          source.extractionStatus === 'complete' ? source.verifiedAt : null,
        contentChangedAt: changed
          ? now
          : (existingCourseMaterial?.contentChangedAt ?? null),
      };
      if (!existingContentVersion) {
        tx.insert(CourseMaterialVersionTable)
          .values({
            materialId,
            contentHash: content.hash,
            ...versionMetadata,
          })
          .run();
      } else if (
        source.extractionStatus === 'complete' &&
        existingContentVersion.extractionStatus !== 'complete'
      ) {
        tx.update(CourseMaterialVersionTable)
          .set({
            extractionStatus: 'complete',
            completeness: source.completeness,
            verifiedAt: source.verifiedAt,
          })
          .where(
            and(
              eq(CourseMaterialVersionTable.materialId, materialId),
              eq(CourseMaterialVersionTable.contentHash, content.hash),
            ),
          )
          .run();
      }
      const existingVersionPassages = tx
        .select({ id: CourseMaterialChunkTable.id })
        .from(CourseMaterialChunkTable)
        .where(
          and(
            eq(CourseMaterialChunkTable.materialId, materialId),
            eq(CourseMaterialChunkTable.version, content.hash),
          ),
        )
        .all();
      let passagesWritten = 0;
      if (!existingVersionPassages.length) {
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
        passagesWritten = content.passages.length;
      }
      const values = {
        url: sourceIdentity,
        title: source.title,
        sourceType: source.sourceType,
        contentHash: content.hash,
        currentUsableVersion: content.hash,
        extractionStatus: source.extractionStatus,
        completeness: source.completeness,
        summary: source.summary,
        summaryEvidence: summaryEvidence.map((evidence) => ({
          ...evidence,
          sourceUrl: evidence.sourceUrl!,
        })),
        retrievedAt: source.retrievedAt,
        verifiedAt:
          source.extractionStatus === 'complete'
            ? source.verifiedAt
            : (existingCourseMaterial?.verifiedAt ?? null),
        contentChangedAt: changed
          ? now
          : (existingCourseMaterial?.contentChangedAt ?? null),
        lastAttemptAt: now,
        active: true,
      };
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
            suppressionId: null,
            suppressedAt: null,
            ...values,
          })
          .run();
      }
      const material = tx
        .select()
        .from(CourseMaterialTable)
        .where(eq(CourseMaterialTable.id, materialId))
        .get();
      if (!material) return null;
      return {
        outcome: 'saved',
        material,
        changed,
        passagesWritten,
      };
    });
  } catch {
    return null;
  }
};

export const reconcileMaterialCollection = (
  context: MaterialCollectionReconciliationContext,
  input: MaterialCollectionReconciliationInput,
): { retiredMaterialIds: string[] } | null => {
  const parsedContext =
    materialCollectionReconciliationContextSchema.safeParse(context);
  const parsed = materialCollectionReconciliationInputSchema.safeParse(input);
  if (!parsedContext.success || !parsed.success) return null;
  const { userId, connectionId, courseId } = parsedContext.data;
  const { coverage, seenIds } = parsed.data;
  const scan = courseCollectionScanSchema.safeParse({
    status: 'complete',
    interruption: null,
    hostCoverage: coverage,
    items: seenIds.map((id) => ({ id })),
  });
  if (
    !scan.success ||
    coverage.ownerId !== userId ||
    coverage.connectionId !== connectionId ||
    coverage.courseId !== courseId ||
    coverage.collectionKind !== 'materials'
  )
    return null;
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
            eq(AcademicConnectionTable.status, 'verified'),
          ),
        )
        .get();
      const course = tx
        .select({ id: CourseTable.id })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.connectionId, connectionId),
            eq(CourseTable.id, courseId),
            eq(CourseTable.active, true),
            isNull(CourseTable.suppressionId),
            isNull(CourseTable.suppressedAt),
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
            eq(AcademicConnectionTable.status, 'verified'),
          ),
        )
        .all()
        .map(({ host }) => host);
      const coverageUrls = [
        ...coverage.collectionUrls,
        ...coverage.pagination.visitedPageUrls,
        ...(coverage.pagination.state === 'pending'
          ? [coverage.pagination.nextPageUrl]
          : []),
      ];
      if (coverageUrls.some((url) => !safeMaterialUrl(url, allowedHosts)))
        return null;
      const currentMaterials = tx
        .select({ id: CourseMaterialTable.id })
        .from(CourseMaterialTable)
        .where(
          and(
            eq(CourseMaterialTable.userId, userId),
            eq(CourseMaterialTable.connectionId, connectionId),
            eq(CourseMaterialTable.courseId, courseId),
            eq(CourseMaterialTable.active, true),
            isNull(CourseMaterialTable.suppressionId),
            isNull(CourseMaterialTable.suppressedAt),
          ),
        )
        .all();
      const seenRows = seenIds.length
        ? tx
            .select({ id: CourseMaterialTable.id })
            .from(CourseMaterialTable)
            .where(
              and(
                eq(CourseMaterialTable.userId, userId),
                eq(CourseMaterialTable.connectionId, connectionId),
                eq(CourseMaterialTable.courseId, courseId),
                inArray(CourseMaterialTable.id, seenIds),
                eq(CourseMaterialTable.active, true),
                isNull(CourseMaterialTable.suppressionId),
                isNull(CourseMaterialTable.suppressedAt),
              ),
            )
            .all()
        : [];
      if (seenRows.length !== seenIds.length) return null;
      const seenSet = new Set(seenIds);
      const retiredMaterialIds = currentMaterials
        .map(({ id }) => id)
        .filter((id) => !seenSet.has(id));
      if (retiredMaterialIds.length)
        tx.update(CourseMaterialTable)
          .set({ active: false })
          .where(
            and(
              eq(CourseMaterialTable.userId, userId),
              eq(CourseMaterialTable.connectionId, connectionId),
              eq(CourseMaterialTable.courseId, courseId),
              inArray(CourseMaterialTable.id, retiredMaterialIds),
              isNull(CourseMaterialTable.suppressionId),
              isNull(CourseMaterialTable.suppressedAt),
            ),
          )
          .run();
      return { retiredMaterialIds };
    });
  } catch {
    return null;
  }
};

export const deleteCourseMaterial = (
  input: DeleteCourseMaterialInput,
): { deleted: boolean } | null => {
  const parsed = deleteCourseMaterialInputSchema.safeParse(input);
  if (!parsed.success) return null;
  const { userId, connectionId, courseId, materialId } = parsed.data;
  try {
    return db.transaction((tx) => {
      const material = tx
        .select({ id: CourseMaterialTable.id })
        .from(CourseMaterialTable)
        .where(
          and(
            eq(CourseMaterialTable.userId, userId),
            eq(CourseMaterialTable.connectionId, connectionId),
            eq(CourseMaterialTable.courseId, courseId),
            eq(CourseMaterialTable.id, materialId),
          ),
        )
        .get();
      if (!material) return { deleted: false };
      tx.delete(StudySourceReferenceTable)
        .where(
          and(
            eq(StudySourceReferenceTable.userId, userId),
            eq(StudySourceReferenceTable.sourceKind, 'course-material'),
            eq(StudySourceReferenceTable.sourceId, materialId),
          ),
        )
        .run();
      tx.delete(CourseMaterialChunkTable)
        .where(eq(CourseMaterialChunkTable.materialId, materialId))
        .run();
      tx.delete(CourseMaterialVersionTable)
        .where(eq(CourseMaterialVersionTable.materialId, materialId))
        .run();
      tx.delete(CourseMaterialTable)
        .where(
          and(
            eq(CourseMaterialTable.userId, userId),
            eq(CourseMaterialTable.connectionId, connectionId),
            eq(CourseMaterialTable.courseId, courseId),
            eq(CourseMaterialTable.id, materialId),
          ),
        )
        .run();
      return { deleted: true };
    });
  } catch {
    return null;
  }
};
