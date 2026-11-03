import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  sourceReferenceSchema,
  type SourceReference,
} from '@scholaros/services/learning/context-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import { db } from '../../../db';
import {
  ArtifactTable,
  ArtifactVersionTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseworkProtectionTable,
  GradeEvidenceTable,
  StudySessionTable,
} from '../../../db/schema';
import {
  isCurrentVerifiedEvidence,
  readCurrentGradeConsent,
} from './assistance-store';

const previewInputSchema = z.strictObject({
  sessionId: z.string().min(1).max(300),
  reference: sourceReferenceSchema,
  text: z.string().min(1).max(50_000),
});
const normalize = (text: string) =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim();
const containsExactSourceText = (
  source: string | null | undefined,
  excerpt: string,
) => Boolean(source && normalize(source).includes(normalize(excerpt)));

const assignmentSource = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) => {
  const assignment = db
    .select()
    .from(CourseAssignmentTable)
    .where(
      and(
        eq(CourseAssignmentTable.userId, context.userId),
        eq(CourseAssignmentTable.courseId, session.courseId),
      ),
    )
    .all()
    .find(
      (record) =>
        record.id === reference.sourceId ||
        record.sourceKey === reference.sourceId,
    );
  return Boolean(
    assignment &&
    assignment.active &&
    assignment.suppressedAt === null &&
    (reference.versionId === null ||
      reference.versionId === assignment.contentChangedAt ||
      reference.versionId === assignment.lastSeenAt),
  );
};

const announcementSource = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) => {
  const announcement = db
    .select()
    .from(CourseAnnouncementTable)
    .where(
      and(
        eq(CourseAnnouncementTable.userId, context.userId),
        eq(CourseAnnouncementTable.courseId, session.courseId),
      ),
    )
    .all()
    .find(
      (record) =>
        record.id === reference.sourceId ||
        record.sourceKey === reference.sourceId,
    );
  return Boolean(
    announcement &&
    announcement.active &&
    announcement.suppressedAt === null &&
    (reference.versionId === null ||
      reference.versionId === announcement.contentChangedAt ||
      reference.versionId === announcement.lastSeenAt),
  );
};

const materialSource = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) => {
  if (!reference.versionId) return false;
  const material = db
    .select()
    .from(CourseMaterialTable)
    .where(
      and(
        eq(CourseMaterialTable.userId, context.userId),
        eq(CourseMaterialTable.courseId, session.courseId),
        eq(CourseMaterialTable.id, reference.sourceId),
        eq(CourseMaterialTable.active, true),
        isNull(CourseMaterialTable.suppressedAt),
      ),
    )
    .get();
  return Boolean(
    material &&
    (material.currentUsableVersion === reference.versionId ||
      material.contentHash === reference.versionId),
  );
};

const contextVersionSource = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) => {
  if (!reference.versionId) return false;
  const item = db
    .select()
    .from(ContextItemTable)
    .where(
      and(
        eq(ContextItemTable.userId, context.userId),
        eq(ContextItemTable.id, reference.sourceId),
        isNull(ContextItemTable.removedAt),
      ),
    )
    .get();
  const version = db
    .select()
    .from(ContextVersionTable)
    .where(
      and(
        eq(ContextVersionTable.userId, context.userId),
        eq(ContextVersionTable.itemId, reference.sourceId),
        eq(ContextVersionTable.id, reference.versionId),
      ),
    )
    .get();
  if (
    !item ||
    !version ||
    item.currentVersionId !== version.id ||
    !['complete', 'partial'].includes(version.extractionStatus)
  )
    return false;
  const links = db
    .select()
    .from(ContextLinkTable)
    .where(
      and(
        eq(ContextLinkTable.userId, context.userId),
        eq(ContextLinkTable.itemId, item.id),
      ),
    )
    .all();
  return links.some(
    (link) =>
      link.courseId === session.courseId ||
      link.sessionId === session.id ||
      (link.courseId === null &&
        link.sessionId === null &&
        link.retainedInLibrary),
  );
};

const activitySource = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) => {
  if (!reference.versionId) return false;
  const artifact = db
    .select()
    .from(ArtifactTable)
    .where(
      and(
        eq(ArtifactTable.userId, context.userId),
        eq(ArtifactTable.id, reference.sourceId),
        isNull(ArtifactTable.removedAt),
      ),
    )
    .get();
  const version = db
    .select()
    .from(ArtifactVersionTable)
    .where(
      and(
        eq(ArtifactVersionTable.userId, context.userId),
        eq(ArtifactVersionTable.artifactId, reference.sourceId),
        eq(ArtifactVersionTable.id, reference.versionId),
      ),
    )
    .get();
  return Boolean(
    artifact &&
    version &&
    artifact.currentVersionId === version.id &&
    (artifact.courseId === null || artifact.courseId === session.courseId) &&
    (artifact.retained || artifact.originatingSessionId === session.id),
  );
};

const gradeEvidenceSource = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) => {
  if (!reference.versionId) return false;
  const evidence = db
    .select()
    .from(GradeEvidenceTable)
    .where(
      and(
        eq(GradeEvidenceTable.userId, context.userId),
        eq(GradeEvidenceTable.courseId, session.courseId),
        eq(GradeEvidenceTable.id, reference.sourceId),
        isNull(GradeEvidenceTable.revokedAt),
      ),
    )
    .get();
  if (!evidence || evidence.sourceVersion !== reference.versionId) return false;
  const protections = db
    .select()
    .from(CourseworkProtectionTable)
    .where(
      and(
        eq(CourseworkProtectionTable.userId, context.userId),
        eq(CourseworkProtectionTable.courseId, session.courseId),
        eq(CourseworkProtectionTable.sourceEvidenceId, evidence.id),
      ),
    )
    .all();
  if (protections.length !== 1) return false;
  const protection = protections[0]!;
  const changedAt =
    db
      .select({ contentChangedAt: CourseAssignmentTable.contentChangedAt })
      .from(CourseAssignmentTable)
      .where(
        and(
          eq(CourseAssignmentTable.userId, context.userId),
          eq(CourseAssignmentTable.courseId, session.courseId),
          inArray(CourseAssignmentTable.sourceKey, protection.aliases),
        ),
      )
      .all()
      .map((assignment) => assignment.contentChangedAt)
      .filter((timestamp): timestamp is string => timestamp !== null)
      .sort()
      .at(-1) ?? null;
  const hasCurrentEvidenceSource = evidence.sourceReferences.some(
    (source) =>
      source.sourceKind === 'assignment' &&
      source.provenance === 'connected-source' &&
      protection.aliases.includes(source.sourceId) &&
      source.state === 'current' &&
      source.courseId === session.courseId &&
      isCurrentSourceReference(context, session, source),
  );
  return (
    hasCurrentEvidenceSource &&
    isCurrentVerifiedEvidence({
      consent: readCurrentGradeConsent(context.userId),
      protection,
      evidence,
      sourceChangedAt: changedAt,
    })
  );
};

export const isCurrentSourceReference = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) => {
  if (
    context.signal.aborted ||
    !context.isCurrent() ||
    reference.state !== 'current' ||
    (reference.courseId !== null && reference.courseId !== session.courseId)
  )
    return false;

  switch (reference.sourceKind) {
    case 'assignment':
      return assignmentSource(context, session, reference);
    case 'announcement':
      return announcementSource(context, session, reference);
    case 'course-material':
      return materialSource(context, session, reference);
    case 'context-version':
      return contextVersionSource(context, session, reference);
    case 'saved-activity':
      return activitySource(context, session, reference);
    case 'grade-evidence':
      return gradeEvidenceSource(context, session, reference);
    default:
      return false;
  }
};

const readAssignmentText = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) =>
  db
    .select()
    .from(CourseAssignmentTable)
    .where(
      and(
        eq(CourseAssignmentTable.userId, context.userId),
        eq(CourseAssignmentTable.courseId, session.courseId),
      ),
    )
    .all()
    .find(
      (record) =>
        record.id === reference.sourceId ||
        record.sourceKey === reference.sourceId,
    )?.body;

const readAnnouncementText = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
) =>
  db
    .select()
    .from(CourseAnnouncementTable)
    .where(
      and(
        eq(CourseAnnouncementTable.userId, context.userId),
        eq(CourseAnnouncementTable.courseId, session.courseId),
      ),
    )
    .all()
    .find(
      (record) =>
        record.id === reference.sourceId ||
        record.sourceKey === reference.sourceId,
    )?.body;

const previewExistsInSource = (
  context: AuthorizedContext,
  session: typeof StudySessionTable.$inferSelect,
  reference: SourceReference,
  text: string,
) => {
  switch (reference.sourceKind) {
    case 'assignment':
      return containsExactSourceText(
        readAssignmentText(context, session, reference),
        text,
      );
    case 'announcement':
      return containsExactSourceText(
        readAnnouncementText(context, session, reference),
        text,
      );
    case 'course-material':
      return db
        .select({ text: CourseMaterialChunkTable.text })
        .from(CourseMaterialChunkTable)
        .where(
          and(
            eq(CourseMaterialChunkTable.materialId, reference.sourceId),
            eq(CourseMaterialChunkTable.version, reference.versionId ?? ''),
          ),
        )
        .all()
        .some((chunk) => containsExactSourceText(chunk.text, text));
    case 'context-version': {
      const version = db
        .select({ extractedText: ContextVersionTable.extractedText })
        .from(ContextVersionTable)
        .where(
          and(
            eq(ContextVersionTable.userId, context.userId),
            eq(ContextVersionTable.itemId, reference.sourceId),
            eq(ContextVersionTable.id, reference.versionId ?? ''),
          ),
        )
        .get();
      return containsExactSourceText(version?.extractedText, text);
    }
    case 'saved-activity': {
      const artifact = db
        .select({ objective: ArtifactTable.objective })
        .from(ArtifactTable)
        .where(
          and(
            eq(ArtifactTable.userId, context.userId),
            eq(ArtifactTable.id, reference.sourceId),
          ),
        )
        .get();
      return containsExactSourceText(artifact?.objective, text);
    }
    case 'grade-evidence':
      // The persisted evidence row contains provenance, not verified feedback text.
      return false;
    default:
      return false;
  }
};

export const filterSourcePreview = (
  context: AuthorizedContext,
  input: unknown,
): string | null => {
  const parsed = previewInputSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.text.length > 2_000 ||
    context.signal.aborted ||
    !context.isCurrent()
  )
    return null;
  const session = db
    .select()
    .from(StudySessionTable)
    .where(
      and(
        eq(StudySessionTable.userId, context.userId),
        eq(StudySessionTable.id, parsed.data.sessionId),
        isNull(StudySessionTable.deletedAt),
      ),
    )
    .get();
  if (
    !session ||
    !isCurrentSourceReference(context, session, parsed.data.reference) ||
    !previewExistsInSource(
      context,
      session,
      parsed.data.reference,
      parsed.data.text,
    ) ||
    !context.isCurrent()
  )
    return null;
  return parsed.data.text.trim();
};
