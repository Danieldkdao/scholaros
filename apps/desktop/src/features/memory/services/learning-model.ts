import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  ArtifactTable,
  ArtifactVersionTable,
  ConceptLinkTable,
  ConceptTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseMaterialTable,
  CourseMaterialVersionTable,
  CourseTable,
  GradeEvidenceTable,
  LearningObservationTable,
  MemoryTable,
  PracticeAnswerTable,
  PracticeAttemptTable,
  StudySessionTable,
  StudyTurnTable,
} from '../../../db/schema';
import type {
  ConceptLinkSelectData,
  ConceptSelectData,
  LearningObservationInsertData,
  LearningObservationSelectData,
  MemoryInsertData,
  MemorySelectData,
  PracticeAnswerSelectData,
} from '../../../db/schema';
import {
  conceptRelationshipKinds,
  learningProgressSchema,
  memorySchema,
  observationOutcomes,
  observationSummarySchema,
  preferenceContentSchema,
} from '@scholaros/services/learning/memory-contracts';
import type {
  ConceptRelationshipKind,
  LearningProgress,
  MemoryDTO,
  ObservationOutcome,
} from '@scholaros/services/learning/memory-contracts';
import {
  idSchema,
  instantSchema,
  revisionSchema,
} from '@scholaros/services/learning/product-contracts';
import type {
  AuthorizedContext,
  Revision,
} from '@scholaros/services/learning/product-contracts';
import {
  practiceEvaluationSchema,
  practiceQuestionSchema,
} from '@scholaros/services/learning/practice-contracts';
import type { PracticeEvaluationDTO } from '@scholaros/services/learning/practice-contracts';
import { sourceReferenceSchema } from '@scholaros/services/learning/context-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import {
  MemoryServiceError,
  getMemoryRevision,
  nextMemoryRevision,
  publishMemoryChange,
} from './memory-store';

type MemoryWriter = Omit<typeof db, '$client'>;
const proposeLearningObservationInputSchema = z.strictObject({
  attemptId: idSchema,
  confidence: z.number().min(0).max(1).optional(),
});
export type ProposeLearningObservationInputSchema = z.infer<
  typeof proposeLearningObservationInputSchema
>;
const proposePreferenceInferenceInputSchema = z.strictObject({
  preference: preferenceContentSchema.extend({
    value: z.string().trim().min(1).max(300),
  }),
  evidenceIds: z.array(idSchema).min(1).max(50),
  confidence: z.number().min(0).max(1),
  courseId: idSchema.optional(),
});
export type ProposePreferenceInferenceInputSchema = z.infer<
  typeof proposePreferenceInferenceInputSchema
>;
const detachLearningEvidenceInputSchema = z.strictObject({
  sessionId: idSchema,
});
export type DetachLearningEvidenceInputSchema = z.infer<
  typeof detachLearningEvidenceInputSchema
>;
const learningProgressInputSchema = z.strictObject({
  courseId: idSchema.optional(),
});
export type LearningProgressInputSchema = z.infer<
  typeof learningProgressInputSchema
>;
const practiceQuestionsSchema = z.array(practiceQuestionSchema).max(20);
export type PracticeQuestionsSchema = z.infer<typeof practiceQuestionsSchema>;
const evidenceSummarySchema = z.strictObject({
  attemptId: idSchema,
  questionId: idSchema.nullable(),
  answerRevision: revisionSchema.nullable(),
  objectiveId: idSchema.nullable(),
  sourceReferences: z.array(sourceReferenceSchema).max(20),
  assisted: z.boolean(),
  outcome: z.enum(observationOutcomes),
  confidence: z.number().min(0).max(1).nullable(),
});
export type EvidenceSummarySchema = z.infer<typeof evidenceSummarySchema>;
const conceptProposalSchema = z.strictObject({
  courseId: idSchema,
  concepts: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(1000),
        uncertainty: z.string().trim().min(1).max(500),
        sourceReferences: z.array(sourceReferenceSchema).min(1).max(20),
      }),
    )
    .max(50),
  links: z
    .array(
      z.strictObject({
        fromLabel: z.string().trim().min(1).max(160),
        toLabel: z.string().trim().min(1).max(160),
        relationship: z.enum(conceptRelationshipKinds),
        uncertainty: z.string().trim().min(1).max(500),
        sourceReferences: z.array(sourceReferenceSchema).min(1).max(20),
      }),
    )
    .max(100),
});
export type ConceptProposalSchema = z.infer<typeof conceptProposalSchema>;
const courseConceptGraphInputSchema = z.strictObject({
  courseId: idSchema,
  conceptId: idSchema.optional(),
  maxDepth: z.number().int().min(1).max(6).optional(),
  maxNodes: z.number().int().min(1).max(100).optional(),
});
export type CourseConceptGraphInputSchema = z.infer<
  typeof courseConceptGraphInputSchema
>;

export type CourseConceptNode = {
  id: string;
  label: string;
  description: string;
  uncertainty: string;
  sourceReferences: SourceReference[];
  prerequisiteIds: string[];
  relatedIds: string[];
};
export type CourseConceptLink = {
  id: string;
  fromConceptId: string;
  toConceptId: string;
  relationship: ConceptRelationshipKind;
  uncertainty: string;
  sourceReferences: SourceReference[];
};
export type CourseConceptGraph = {
  courseId: string;
  revision: Revision;
  concepts: CourseConceptNode[];
  links: CourseConceptLink[];
  truncated: boolean;
};

const assertCurrentContext = (context: AuthorizedContext) => {
  if (context.signal.aborted) throw new MemoryServiceError('cancelled');
  if (!context.isCurrent()) throw new MemoryServiceError('session-changed');
};

type ResolvedConceptSource = {
  reference: SourceReference;
  partial: boolean;
};

const normalizeConceptLabel = (label: string) =>
  label
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');

const mergeSourceReferences = (
  previous: SourceReference[],
  added: SourceReference[],
) => {
  const references = new Map<string, SourceReference>();
  for (const reference of [...previous, ...added]) {
    const key = [
      reference.sourceKind,
      reference.sourceId,
      reference.versionId ?? '',
      JSON.stringify(reference.locator),
    ].join(':');
    references.set(key, reference);
  }
  return [...references.values()].slice(0, 20);
};

const mergeUncertainty = (previous: string, added: string) =>
  [...new Set([previous, added].map((value) => value.trim()).filter(Boolean))]
    .join(' ')
    .slice(0, 500);

const resolveCurrentConceptSource = (
  writer: MemoryWriter,
  userId: string,
  courseId: string,
  candidate: unknown,
): ResolvedConceptSource | null => {
  const parsedReference = sourceReferenceSchema.safeParse(candidate);
  if (!parsedReference.success) throw new MemoryServiceError('invalid-input');
  const reference = parsedReference.data;
  if (reference.courseId && reference.courseId !== courseId)
    throw new MemoryServiceError('scope-denied');

  if (reference.sourceKind === 'course-material' && reference.versionId) {
    const material = writer
      .select()
      .from(CourseMaterialTable)
      .where(
        and(
          eq(CourseMaterialTable.userId, userId),
          eq(CourseMaterialTable.courseId, courseId),
          eq(CourseMaterialTable.id, reference.sourceId),
        ),
      )
      .get();
    if (!material?.active || material.suppressedAt) return null;
    const connection = writer
      .select({
        id: AcademicConnectionTable.id,
        isCourseResource: AcademicConnectionTable.isCourseResource,
      })
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.id, material.connectionId),
          eq(AcademicConnectionTable.isCourseResource, true),
        ),
      )
      .get();
    if (!connection || material.currentUsableVersion !== reference.versionId)
      return null;
    const version = writer
      .select()
      .from(CourseMaterialVersionTable)
      .where(
        and(
          eq(CourseMaterialVersionTable.materialId, material.id),
          eq(CourseMaterialVersionTable.contentHash, reference.versionId),
        ),
      )
      .get();
    if (
      !version ||
      (version.extractionStatus !== 'complete' &&
        version.extractionStatus !== 'partial')
    )
      return null;
    return {
      reference: {
        sourceKind: 'course-material',
        sourceId: material.id,
        versionId: version.contentHash,
        courseId,
        locator: reference.locator,
        title: material.title,
        provenance: 'connected-source',
        observedAt: version.verifiedAt ?? version.retrievedAt,
        state: 'current',
      },
      partial: version.extractionStatus === 'partial',
    };
  }

  if (reference.sourceKind === 'context-version' && reference.versionId) {
    const item = writer
      .select()
      .from(ContextItemTable)
      .where(
        and(
          eq(ContextItemTable.userId, userId),
          eq(ContextItemTable.id, reference.sourceId),
        ),
      )
      .get();
    if (
      !item ||
      item.removedAt ||
      item.currentVersionId !== reference.versionId
    )
      return null;
    const courseLink = writer
      .select({ id: ContextLinkTable.id })
      .from(ContextLinkTable)
      .where(
        and(
          eq(ContextLinkTable.userId, userId),
          eq(ContextLinkTable.itemId, item.id),
          eq(ContextLinkTable.courseId, courseId),
        ),
      )
      .get();
    if (!courseLink) return null;
    const version = writer
      .select()
      .from(ContextVersionTable)
      .where(
        and(
          eq(ContextVersionTable.userId, userId),
          eq(ContextVersionTable.itemId, item.id),
          eq(ContextVersionTable.id, reference.versionId),
        ),
      )
      .get();
    if (
      !version ||
      (version.extractionStatus !== 'complete' &&
        version.extractionStatus !== 'partial') ||
      !version.extractedText
    )
      return null;
    return {
      reference: {
        sourceKind: 'context-version',
        sourceId: item.id,
        versionId: version.id,
        courseId,
        locator: reference.locator,
        title: item.title,
        provenance: item.provenance,
        observedAt: version.createdAt,
        state: 'current',
      },
      partial: version.extractionStatus === 'partial',
    };
  }
  return null;
};

const resolveStoredConceptSource = (
  writer: MemoryWriter,
  userId: string,
  courseId: string,
  reference: SourceReference,
): SourceReference => {
  const current = resolveCurrentConceptSource(
    writer,
    userId,
    courseId,
    reference,
  );
  if (current) return current.reference;
  if (reference.sourceKind === 'course-material') {
    const material = writer
      .select()
      .from(CourseMaterialTable)
      .where(
        and(
          eq(CourseMaterialTable.userId, userId),
          eq(CourseMaterialTable.courseId, courseId),
          eq(CourseMaterialTable.id, reference.sourceId),
        ),
      )
      .get();
    if (!material?.active || material.suppressedAt)
      return { ...reference, courseId, state: 'removed' };
    const connection = writer
      .select({ isCourseResource: AcademicConnectionTable.isCourseResource })
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.id, material.connectionId),
        ),
      )
      .get();
    if (!connection?.isCourseResource)
      return { ...reference, courseId, state: 'removed' };
    const version = reference.versionId
      ? writer
          .select({ contentHash: CourseMaterialVersionTable.contentHash })
          .from(CourseMaterialVersionTable)
          .where(
            and(
              eq(CourseMaterialVersionTable.materialId, material.id),
              eq(CourseMaterialVersionTable.contentHash, reference.versionId),
            ),
          )
          .get()
      : undefined;
    if (!version) return { ...reference, courseId, state: 'unavailable' };
    return {
      ...reference,
      courseId,
      state:
        material.currentUsableVersion === version.contentHash
          ? 'unavailable'
          : 'historical',
    };
  }
  if (reference.sourceKind === 'context-version') {
    const item = writer
      .select()
      .from(ContextItemTable)
      .where(
        and(
          eq(ContextItemTable.userId, userId),
          eq(ContextItemTable.id, reference.sourceId),
        ),
      )
      .get();
    if (!item || item.removedAt)
      return { ...reference, courseId, state: 'removed' };
    const courseLink = writer
      .select({ id: ContextLinkTable.id })
      .from(ContextLinkTable)
      .where(
        and(
          eq(ContextLinkTable.userId, userId),
          eq(ContextLinkTable.itemId, item.id),
          eq(ContextLinkTable.courseId, courseId),
        ),
      )
      .get();
    if (!courseLink) return { ...reference, courseId, state: 'removed' };
    const version = reference.versionId
      ? writer
          .select({ id: ContextVersionTable.id })
          .from(ContextVersionTable)
          .where(
            and(
              eq(ContextVersionTable.userId, userId),
              eq(ContextVersionTable.itemId, item.id),
              eq(ContextVersionTable.id, reference.versionId),
            ),
          )
          .get()
      : undefined;
    if (!version) return { ...reference, courseId, state: 'unavailable' };
    return {
      ...reference,
      courseId,
      state:
        item.currentVersionId === version.id ? 'unavailable' : 'historical',
    };
  }
  return { ...reference, courseId, state: 'unavailable' };
};

const resolveStoredSourceReferences = (
  writer: MemoryWriter,
  userId: string,
  courseId: string,
  sourceReferences: unknown,
) => {
  const parsedReferences = z
    .array(sourceReferenceSchema)
    .max(20)
    .safeParse(sourceReferences);
  if (!parsedReferences.success) throw new MemoryServiceError('storage-failed');
  return parsedReferences.data.map((reference) =>
    resolveStoredConceptSource(writer, userId, courseId, reference),
  );
};

const resolveStoredLearningSourceReference = (
  writer: MemoryWriter,
  userId: string,
  courseId: string,
  reference: SourceReference,
): SourceReference => {
  if (
    reference.sourceKind === 'course-material' ||
    reference.sourceKind === 'context-version'
  )
    return resolveStoredConceptSource(writer, userId, courseId, reference);
  if (reference.sourceKind === 'grade-evidence') {
    const evidence = writer
      .select()
      .from(GradeEvidenceTable)
      .where(
        and(
          eq(GradeEvidenceTable.userId, userId),
          eq(GradeEvidenceTable.courseId, courseId),
          eq(GradeEvidenceTable.id, reference.sourceId),
        ),
      )
      .get();
    if (!evidence || evidence.revokedAt)
      return { ...reference, courseId, state: 'removed' };
    return {
      ...reference,
      versionId: evidence.sourceVersion,
      courseId,
      observedAt: evidence.observedAt,
      state:
        reference.versionId && reference.versionId !== evidence.sourceVersion
          ? 'historical'
          : 'current',
    };
  }
  if (reference.sourceKind === 'assignment') {
    const assignment = writer
      .select()
      .from(CourseAssignmentTable)
      .where(
        and(
          eq(CourseAssignmentTable.userId, userId),
          eq(CourseAssignmentTable.courseId, courseId),
          eq(CourseAssignmentTable.id, reference.sourceId),
        ),
      )
      .get();
    if (!assignment?.active || assignment.suppressedAt)
      return { ...reference, courseId, state: 'removed' };
    return {
      ...reference,
      courseId,
      title: assignment.title,
      observedAt: assignment.lastSeenAt,
      state:
        reference.versionId &&
        reference.versionId !== assignment.contentChangedAt
          ? 'historical'
          : 'current',
    };
  }
  if (reference.sourceKind === 'announcement') {
    const announcement = writer
      .select()
      .from(CourseAnnouncementTable)
      .where(
        and(
          eq(CourseAnnouncementTable.userId, userId),
          eq(CourseAnnouncementTable.courseId, courseId),
          eq(CourseAnnouncementTable.id, reference.sourceId),
        ),
      )
      .get();
    if (!announcement?.active || announcement.suppressedAt)
      return { ...reference, courseId, state: 'removed' };
    return {
      ...reference,
      courseId,
      title: announcement.title,
      observedAt: announcement.lastSeenAt,
      state:
        reference.versionId &&
        reference.versionId !== announcement.contentChangedAt
          ? 'historical'
          : 'current',
    };
  }
  if (reference.sourceKind === 'saved-activity') {
    const artifact = writer
      .select()
      .from(ArtifactTable)
      .where(
        and(
          eq(ArtifactTable.userId, userId),
          eq(ArtifactTable.courseId, courseId),
          eq(ArtifactTable.id, reference.sourceId),
        ),
      )
      .get();
    if (!artifact?.retained || artifact.removedAt)
      return { ...reference, courseId, state: 'removed' };
    const version = reference.versionId
      ? writer
          .select()
          .from(ArtifactVersionTable)
          .where(
            and(
              eq(ArtifactVersionTable.userId, userId),
              eq(ArtifactVersionTable.artifactId, artifact.id),
              eq(ArtifactVersionTable.id, reference.versionId),
            ),
          )
          .get()
      : undefined;
    if (!version) return { ...reference, courseId, state: 'unavailable' };
    return {
      ...reference,
      courseId,
      title: artifact.title,
      observedAt: version.createdAt,
      state:
        artifact.currentVersionId === version.id ? 'current' : 'historical',
    };
  }
  return { ...reference, courseId, state: 'unavailable' };
};

const resolveStoredLearningSourceReferences = (
  writer: MemoryWriter,
  userId: string,
  courseId: string,
  sourceReferences: unknown,
) => {
  const parsedReferences = z
    .array(sourceReferenceSchema)
    .max(20)
    .safeParse(sourceReferences);
  if (!parsedReferences.success) throw new MemoryServiceError('storage-failed');
  return parsedReferences.data
    .filter((reference) => reference.courseId === courseId)
    .map((reference) =>
      resolveStoredLearningSourceReference(writer, userId, courseId, reference),
    );
};

const prerequisitePathState = (
  links: ConceptLinkSelectData[],
  startId: string,
  targetId: string,
): 'cycle' | 'bounded' | 'clear' => {
  const prerequisiteAdjacency = new Map<string, string[]>();
  for (const link of links) {
    if (link.relationship !== 'prerequisite') continue;
    const neighbors = prerequisiteAdjacency.get(link.fromConceptId) ?? [];
    neighbors.push(link.toConceptId);
    prerequisiteAdjacency.set(link.fromConceptId, neighbors);
  }
  const queue = [startId];
  const visited = new Set<string>();
  while (queue.length) {
    const currentId = queue.shift()!;
    if (currentId === targetId) return 'cycle';
    if (visited.has(currentId)) continue;
    if (visited.size >= 1000) return 'bounded';
    visited.add(currentId);
    queue.push(...(prerequisiteAdjacency.get(currentId) ?? []));
  }
  return 'clear';
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

const toObservationOutcome = (
  evaluation: PracticeEvaluationDTO,
  assisted: boolean,
): ObservationOutcome => {
  if (evaluation.outcome === 'uncertain') return 'uncertain';
  if (evaluation.outcome === 'incorrect') return 'difficulty';
  return assisted ? 'assisted-success' : 'independent-success';
};

const summaryForOutcome = (outcome: ObservationOutcome) => {
  switch (outcome) {
    case 'independent-success':
      return 'An independent practice response was correct.';
    case 'assisted-success':
      return 'A guided practice response was correct; independent evidence was not established.';
    case 'difficulty':
      return 'A practice response showed this topic may need another example.';
    case 'uncertain':
      return 'The host evaluation could not determine this response.';
  }
};

const existingObservationMemory = (
  writer: MemoryWriter,
  userId: string,
  observation: LearningObservationSelectData,
) => {
  if (observation.revokedAt) return null;
  const memory = writer
    .select()
    .from(MemoryTable)
    .where(
      and(
        eq(MemoryTable.userId, userId),
        eq(MemoryTable.id, observation.id),
        isNull(MemoryTable.deletedAt),
      ),
    )
    .get();
  return memory ? toMemoryDTO(memory) : null;
};

const appendLearningObservation = (
  writer: MemoryWriter,
  context: AuthorizedContext,
  input: {
    courseId: string;
    conceptId: string | null;
    attemptId: string;
    sourceSessionId: string | null;
    kind: LearningObservationInsertData['kind'];
    outcome: ObservationOutcome;
    assisted: boolean;
    independentEvidence: boolean;
    confidence: number | null;
    summary: string;
    questionId: string | null;
    answerRevision: Revision | null;
    objectiveId: string | null;
    sourceReferences: SourceReference[];
  },
): MemoryDTO => {
  assertCurrentContext(context);
  const now = new Date().toISOString();
  const id = randomUUID();
  const revision = nextMemoryRevision(writer, context.userId);
  const evidenceSummary = evidenceSummarySchema.parse({
    attemptId: input.attemptId,
    questionId: input.questionId,
    answerRevision: input.answerRevision,
    objectiveId: input.objectiveId,
    sourceReferences: input.sourceReferences,
    assisted: input.assisted,
    outcome: input.outcome,
    confidence: input.confidence,
  });
  const insertedObservation: LearningObservationInsertData = {
    id,
    userId: context.userId,
    courseId: input.courseId,
    conceptId: input.conceptId,
    attemptId: input.attemptId,
    sourceSessionId: input.sourceSessionId,
    kind: input.kind,
    responseOutcome: input.outcome,
    assisted: input.assisted,
    independentEvidence: input.independentEvidence,
    confidence: input.confidence,
    evidenceSummary,
    createdAt: now,
    revokedAt: null,
  };
  writer.insert(LearningObservationTable).values(insertedObservation).run();
  const insertedMemory: MemoryInsertData = {
    id,
    userId: context.userId,
    courseId: input.courseId,
    type: 'learning-observation',
    content: {
      conceptId: input.conceptId,
      outcome: input.outcome,
      summary: input.summary,
    },
    provenance: 'practice-evidence',
    evidenceIds: [id],
    confidence: input.kind === 'confidence-check' ? input.confidence : null,
    revision,
    supersedesId: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  writer.insert(MemoryTable).values(insertedMemory).run();
  const savedMemory = writer
    .select()
    .from(MemoryTable)
    .where(and(eq(MemoryTable.userId, context.userId), eq(MemoryTable.id, id)))
    .get();
  if (!savedMemory) throw new MemoryServiceError('storage-failed');
  return toMemoryDTO(savedMemory);
};

export const proposeLearningObservation = (
  context: AuthorizedContext,
  input: z.infer<typeof proposeLearningObservationInputSchema>,
): MemoryDTO[] => {
  assertCurrentContext(context);
  const parsedInput = proposeLearningObservationInputSchema.safeParse(input);
  if (!parsedInput.success) throw new MemoryServiceError('invalid-input');
  const { attemptId, confidence } = parsedInput.data;
  let lastRevision: Revision | null = null;
  let changedCourseId: string | null = null;

  try {
    const proposed = db.transaction((tx) => {
      assertCurrentContext(context);
      const attempt = tx
        .select()
        .from(PracticeAttemptTable)
        .where(
          and(
            eq(PracticeAttemptTable.userId, context.userId),
            eq(PracticeAttemptTable.id, attemptId),
          ),
        )
        .get();
      if (!attempt) throw new MemoryServiceError('not-found');
      if (attempt.status !== 'evaluated')
        throw new MemoryServiceError('invalid-input');
      const questions = practiceQuestionsSchema.safeParse(attempt.questionSet);
      if (!questions.success) throw new MemoryServiceError('storage-failed');
      const answers = tx
        .select()
        .from(PracticeAnswerTable)
        .where(
          and(
            eq(PracticeAnswerTable.userId, context.userId),
            eq(PracticeAnswerTable.attemptId, attempt.id),
          ),
        )
        .all();
      const latestAnswers = new Map<string, PracticeAnswerSelectData>();
      for (const answer of answers) {
        const previousAnswer = latestAnswers.get(answer.questionId);
        if (!previousAnswer || answer.revision > previousAnswer.revision)
          latestAnswers.set(answer.questionId, answer);
      }
      const concepts = tx
        .select()
        .from(ConceptTable)
        .where(
          and(
            eq(ConceptTable.userId, context.userId),
            eq(ConceptTable.courseId, attempt.courseId),
          ),
        )
        .all();
      const conceptsById = new Map(
        concepts.map((concept) => [concept.id, concept]),
      );
      const priorObservations = tx
        .select()
        .from(LearningObservationTable)
        .where(
          and(
            eq(LearningObservationTable.userId, context.userId),
            eq(LearningObservationTable.attemptId, attempt.id),
          ),
        )
        .all();
      const hasDeletedPracticeEvidence = priorObservations.some(
        (observation) =>
          observation.kind === 'practice-response' &&
          observation.revokedAt !== null,
      );
      const proposedMemories: MemoryDTO[] = [];

      for (const question of questions.data) {
        if (hasDeletedPracticeEvidence) continue;
        const answer = latestAnswers.get(question.id);
        if (!answer?.evaluation) continue;
        const evaluation = practiceEvaluationSchema.safeParse(
          answer.evaluation,
        );
        if (!evaluation.success || evaluation.data.questionId !== question.id)
          throw new MemoryServiceError('storage-failed');
        const assisted = attempt.assisted || answer.assisted;
        if (evaluation.data.assisted !== assisted)
          throw new MemoryServiceError('storage-failed');
        const outcome = toObservationOutcome(evaluation.data, assisted);
        const matchingConceptId = question.objectiveIds.find((objectiveId) =>
          conceptsById.has(objectiveId),
        );
        const conceptId = matchingConceptId ?? null;
        const existingObservation = priorObservations.find((observation) => {
          if (observation.kind !== 'practice-response') return false;
          const evidence = evidenceSummarySchema.safeParse(
            observation.evidenceSummary,
          );
          return evidence.success && evidence.data.questionId === question.id;
        });
        if (existingObservation) {
          const existingMemory = existingObservationMemory(
            tx,
            context.userId,
            existingObservation,
          );
          if (existingMemory) proposedMemories.push(existingMemory);
          continue;
        }
        const sourceReferences = evaluation.data.sourceReferences.filter(
          (reference) => reference.courseId === attempt.courseId,
        );
        const proposedMemory = appendLearningObservation(tx, context, {
          courseId: attempt.courseId,
          conceptId,
          attemptId: attempt.id,
          sourceSessionId: attempt.sessionId,
          kind: 'practice-response',
          outcome,
          assisted,
          independentEvidence: outcome === 'independent-success' && !assisted,
          confidence: null,
          summary: summaryForOutcome(outcome),
          questionId: question.id,
          answerRevision: answer.revision,
          objectiveId: matchingConceptId ?? question.objectiveIds[0] ?? null,
          sourceReferences,
        });
        proposedMemories.push(proposedMemory);
        lastRevision = proposedMemory.revision;
        changedCourseId = attempt.courseId;
      }

      if (confidence !== undefined) {
        const existingConfidence = priorObservations.find(
          (observation) => observation.kind === 'confidence-check',
        );
        if (existingConfidence) {
          const existingMemory = existingObservationMemory(
            tx,
            context.userId,
            existingConfidence,
          );
          if (existingMemory) proposedMemories.push(existingMemory);
        } else {
          const proposedMemory = appendLearningObservation(tx, context, {
            courseId: attempt.courseId,
            conceptId: null,
            attemptId: attempt.id,
            sourceSessionId: attempt.sessionId,
            kind: 'confidence-check',
            outcome: 'uncertain',
            assisted: false,
            independentEvidence: false,
            confidence,
            summary:
              'Student confidence was recorded separately from response correctness.',
            questionId: null,
            answerRevision: null,
            objectiveId: null,
            sourceReferences: [],
          });
          proposedMemories.push(proposedMemory);
          lastRevision = proposedMemory.revision;
          changedCourseId = attempt.courseId;
        }
      }
      return proposedMemories;
    });
    if (lastRevision !== null && changedCourseId !== null)
      publishMemoryChange({
        userId: context.userId,
        courseId: changedCourseId,
        revision: lastRevision,
      });
    return proposed;
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError('storage-failed');
  }
};

const preferenceEvidenceTimes = (
  writer: MemoryWriter,
  userId: string,
  courseId: string | null,
  evidenceIds: string[],
) => {
  const observedAt: string[] = [];
  for (const evidenceId of evidenceIds) {
    const turn = writer
      .select()
      .from(StudyTurnTable)
      .where(
        and(
          eq(StudyTurnTable.userId, userId),
          eq(StudyTurnTable.id, evidenceId),
        ),
      )
      .get();
    if (turn) {
      if (turn.status !== 'complete' || !turn.settledAt)
        throw new MemoryServiceError('invalid-input');
      const session = writer
        .select()
        .from(StudySessionTable)
        .where(
          and(
            eq(StudySessionTable.userId, userId),
            eq(StudySessionTable.id, turn.sessionId),
            isNull(StudySessionTable.deletedAt),
          ),
        )
        .get();
      if (!session || (courseId && session.courseId !== courseId))
        throw new MemoryServiceError('invalid-input');
      observedAt.push(instantSchema.parse(turn.startedAt));
      continue;
    }

    const observation = writer
      .select()
      .from(LearningObservationTable)
      .where(
        and(
          eq(LearningObservationTable.userId, userId),
          eq(LearningObservationTable.id, evidenceId),
          isNull(LearningObservationTable.revokedAt),
        ),
      )
      .get();
    if (!observation || !courseId || observation.courseId !== courseId)
      throw new MemoryServiceError('invalid-input');
    observedAt.push(instantSchema.parse(observation.createdAt));
  }
  return observedAt;
};

const latestEvidenceTime = (evidenceTimes: string[]) =>
  evidenceTimes.reduce((latest, time) =>
    Date.parse(time) > Date.parse(latest) ? time : latest,
  );

// Inference is persisted only from completed host-owned evidence; this does not call a model.
export const proposePreferenceInference = (
  context: AuthorizedContext,
  input: z.infer<typeof proposePreferenceInferenceInputSchema>,
): MemoryDTO | null => {
  assertCurrentContext(context);
  const parsedInput = proposePreferenceInferenceInputSchema.safeParse(input);
  if (!parsedInput.success) throw new MemoryServiceError('invalid-input');
  const { preference, confidence } = parsedInput.data;
  const courseId = parsedInput.data.courseId ?? null;
  const evidenceIds = [...new Set(parsedInput.data.evidenceIds)].sort();
  const now = new Date().toISOString();
  let changed = false;

  try {
    const result = db.transaction((tx) => {
      assertCurrentContext(context);
      if (courseId) {
        const course = tx
          .select({ id: CourseTable.id })
          .from(CourseTable)
          .where(
            and(
              eq(CourseTable.userId, context.userId),
              eq(CourseTable.id, courseId),
            ),
          )
          .get();
        if (!course) throw new MemoryServiceError('scope-denied');
      }
      const observedAt = latestEvidenceTime(
        preferenceEvidenceTimes(tx, context.userId, courseId, evidenceIds),
      );
      const preferences = tx
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            inArray(MemoryTable.type, [
              'explicit-preference',
              'provisional-preference',
            ]),
          ),
        )
        .orderBy(desc(MemoryTable.revision), desc(MemoryTable.updatedAt))
        .limit(10_001)
        .all();
      if (preferences.length > 10_000)
        throw new MemoryServiceError('storage-failed');
      const matchingPreferences = preferences.filter((memory) => {
        const existingPreference = preferenceContentSchema.safeParse(
          memory.content,
        );
        if (!existingPreference.success)
          throw new MemoryServiceError('storage-failed');
        const scopeMatches =
          memory.courseId === courseId ||
          (courseId !== null && memory.courseId === null);
        return (
          scopeMatches && existingPreference.data.field === preference.field
        );
      });
      if (
        matchingPreferences.some(
          (memory) =>
            memory.type === 'explicit-preference' && !memory.deletedAt,
        )
      )
        return null;
      if (
        matchingPreferences.some(
          (memory) =>
            memory.deletedAt &&
            Date.parse(memory.updatedAt) >= Date.parse(observedAt),
        )
      )
        return null;

      const activeInference = matchingPreferences.find(
        (memory) =>
          memory.type === 'provisional-preference' &&
          memory.courseId === courseId &&
          !memory.deletedAt,
      );
      if (activeInference) {
        const sameEvidence =
          activeInference.evidenceIds.length === evidenceIds.length &&
          activeInference.evidenceIds.every(
            (id, index) => id === evidenceIds[index],
          );
        if (sameEvidence) return toMemoryDTO(activeInference);
        let priorEvidenceAt: string;
        try {
          priorEvidenceAt = latestEvidenceTime(
            preferenceEvidenceTimes(
              tx,
              context.userId,
              courseId,
              activeInference.evidenceIds,
            ),
          );
        } catch {
          return toMemoryDTO(activeInference);
        }
        if (Date.parse(priorEvidenceAt) >= Date.parse(observedAt))
          return toMemoryDTO(activeInference);
      }

      assertCurrentContext(context);
      const revision = nextMemoryRevision(tx, context.userId);
      if (activeInference)
        tx.update(MemoryTable)
          .set({ deletedAt: now, revision, updatedAt: now })
          .where(
            and(
              eq(MemoryTable.userId, context.userId),
              eq(MemoryTable.id, activeInference.id),
              isNull(MemoryTable.deletedAt),
            ),
          )
          .run();
      const insertedMemory: MemoryInsertData = {
        id: randomUUID(),
        userId: context.userId,
        courseId,
        type: 'provisional-preference',
        content: preference,
        provenance: 'meta-inferred',
        evidenceIds,
        confidence,
        revision,
        supersedesId: activeInference?.id ?? null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(MemoryTable).values(insertedMemory).run();
      changed = true;
      const savedMemory = tx
        .select()
        .from(MemoryTable)
        .where(
          and(
            eq(MemoryTable.userId, context.userId),
            eq(MemoryTable.id, insertedMemory.id),
          ),
        )
        .get();
      if (!savedMemory) throw new MemoryServiceError('storage-failed');
      return toMemoryDTO(savedMemory);
    });
    if (result && changed)
      publishMemoryChange({
        userId: context.userId,
        courseId,
        revision: result.revision,
      });
    return result;
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError('storage-failed');
  }
};

export const detachLearningEvidenceFromSession = (
  context: AuthorizedContext,
  input: z.infer<typeof detachLearningEvidenceInputSchema>,
): number => {
  assertCurrentContext(context);
  const parsedInput = detachLearningEvidenceInputSchema.safeParse(input);
  if (!parsedInput.success) throw new MemoryServiceError('invalid-input');
  try {
    return db.transaction((tx) => {
      assertCurrentContext(context);
      return tx
        .update(LearningObservationTable)
        .set({ sourceSessionId: null })
        .where(
          and(
            eq(LearningObservationTable.userId, context.userId),
            eq(
              LearningObservationTable.sourceSessionId,
              parsedInput.data.sessionId,
            ),
            isNull(LearningObservationTable.revokedAt),
          ),
        )
        .run().changes;
    });
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError('storage-failed');
  }
};

const progressItemForObservation = (
  writer: MemoryWriter,
  userId: string,
  concept: ConceptSelectData,
  observation: LearningObservationSelectData,
): LearningProgress['recentChanges'][number] => {
  const evidence = evidenceSummarySchema.safeParse(observation.evidenceSummary);
  if (!evidence.success) throw new MemoryServiceError('storage-failed');
  const summary = observationSummarySchema.safeParse({
    conceptId: concept.id,
    outcome: observation.responseOutcome,
    summary: summaryForOutcome(observation.responseOutcome),
  });
  if (!summary.success) throw new MemoryServiceError('storage-failed');
  return {
    conceptId: concept.id,
    label: concept.label,
    summary: summary.data.summary,
    evidenceIds: [observation.id],
    assisted: observation.assisted,
    sourceReferences: resolveStoredLearningSourceReferences(
      writer,
      userId,
      concept.courseId,
      evidence.data.sourceReferences,
    ),
  };
};

export const getLearningProgress = (
  context: AuthorizedContext,
  input: z.infer<typeof learningProgressInputSchema>,
): LearningProgress | null => {
  if (context.signal.aborted || !context.isCurrent()) return null;
  const parsedInput = learningProgressInputSchema.safeParse(input);
  if (!parsedInput.success) return null;
  try {
    const { courseId } = parsedInput.data;
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
    const conceptConditions = [eq(ConceptTable.userId, context.userId)];
    if (courseId) conceptConditions.push(eq(ConceptTable.courseId, courseId));
    const concepts = db
      .select()
      .from(ConceptTable)
      .where(and(...conceptConditions))
      .orderBy(ConceptTable.updatedAt, ConceptTable.id)
      .limit(1001)
      .all();
    if (concepts.length > 1000) return null;
    const observationConditions = [
      eq(LearningObservationTable.userId, context.userId),
      isNull(LearningObservationTable.revokedAt),
    ];
    if (courseId)
      observationConditions.push(
        eq(LearningObservationTable.courseId, courseId),
      );
    const observationRows = db
      .select({ observation: LearningObservationTable })
      .from(LearningObservationTable)
      .innerJoin(
        MemoryTable,
        and(
          eq(MemoryTable.userId, LearningObservationTable.userId),
          eq(MemoryTable.id, LearningObservationTable.id),
          eq(MemoryTable.type, 'learning-observation'),
          isNull(MemoryTable.deletedAt),
        ),
      )
      .where(and(...observationConditions))
      .orderBy(
        desc(MemoryTable.revision),
        desc(LearningObservationTable.createdAt),
        desc(LearningObservationTable.id),
      )
      .limit(10_001)
      .all();
    if (observationRows.length > 10_000) return null;
    const observations = observationRows.map(({ observation }) => observation);
    const latestObservationsByConcept = new Map<
      string,
      LearningObservationSelectData
    >();
    for (const observation of observations) {
      if (observation.kind === 'confidence-check' || !observation.conceptId)
        continue;
      const key = JSON.stringify([observation.courseId, observation.conceptId]);
      if (!latestObservationsByConcept.has(key))
        latestObservationsByConcept.set(key, observation);
    }
    const strengths: LearningProgress['strengths'] = [];
    const practiceTopics: LearningProgress['practiceTopics'] = [];
    const recentChanges: LearningProgress['recentChanges'] = [];
    let unknownCount = 0;

    for (const concept of concepts) {
      const latestObservation = latestObservationsByConcept.get(
        JSON.stringify([concept.courseId, concept.id]),
      );
      if (!latestObservation) {
        unknownCount += 1;
        continue;
      }
      const progressItem = progressItemForObservation(
        db,
        context.userId,
        concept,
        latestObservation,
      );
      recentChanges.push(progressItem);
      if (
        latestObservation.responseOutcome === 'independent-success' &&
        latestObservation.independentEvidence &&
        !latestObservation.assisted
      )
        strengths.push(progressItem);
      if (latestObservation.responseOutcome === 'difficulty')
        practiceTopics.push(progressItem);
    }

    const observationRank = new Map(
      observations.map((observation, index) => [observation.id, index]),
    );
    const ordered = (items: typeof recentChanges) =>
      items
        .sort(
          (first, second) =>
            (observationRank.get(first.evidenceIds[0]!) ??
              Number.MAX_SAFE_INTEGER) -
            (observationRank.get(second.evidenceIds[0]!) ??
              Number.MAX_SAFE_INTEGER),
        )
        .slice(0, 10);
    return learningProgressSchema.parse({
      courseId: courseId ?? null,
      strengths: ordered(strengths),
      practiceTopics: ordered(practiceTopics),
      recentChanges: ordered(recentChanges),
      unknownCount,
      revision: getMemoryRevision(db, context.userId),
    });
  } catch {
    return null;
  }
};

export const buildCourseConcepts = (
  context: AuthorizedContext,
  input: z.infer<typeof conceptProposalSchema>,
): CourseConceptGraph => {
  assertCurrentContext(context);
  const parsedInput = conceptProposalSchema.safeParse(input);
  if (!parsedInput.success) throw new MemoryServiceError('invalid-input');
  const {
    courseId,
    concepts: proposedConcepts,
    links: proposedLinks,
  } = parsedInput.data;
  const now = new Date().toISOString();
  let lastRevision: Revision | null = null;

  try {
    db.transaction((tx) => {
      assertCurrentContext(context);
      const ownedCourse = tx
        .select({ id: CourseTable.id })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, context.userId),
            eq(CourseTable.id, courseId),
          ),
        )
        .get();
      if (!ownedCourse) throw new MemoryServiceError('scope-denied');
      const courseConcepts = tx
        .select()
        .from(ConceptTable)
        .where(
          and(
            eq(ConceptTable.userId, context.userId),
            eq(ConceptTable.courseId, courseId),
          ),
        )
        .limit(1001)
        .all();
      if (courseConcepts.length > 1000)
        throw new MemoryServiceError('storage-failed');
      const conceptsByLabel = new Map(
        courseConcepts.map((concept) => [
          normalizeConceptLabel(concept.label),
          concept,
        ]),
      );

      for (const candidate of proposedConcepts) {
        const resolvedSources = candidate.sourceReferences
          .map((reference) =>
            resolveCurrentConceptSource(
              tx,
              context.userId,
              courseId,
              reference,
            ),
          )
          .filter((source): source is ResolvedConceptSource => source !== null);
        if (!resolvedSources.length) continue;
        const sourceReferences = resolvedSources.map(
          ({ reference }) => reference,
        );
        const partial = resolvedSources.some((source) => source.partial);
        const uncertainty = mergeUncertainty(
          candidate.uncertainty,
          partial
            ? 'A supporting source was partially extracted; this concept remains uncertain.'
            : '',
        );
        const label = candidate.label.trim();
        const normalizedLabel = normalizeConceptLabel(label);
        const existingConcept = conceptsByLabel.get(normalizedLabel);
        if (existingConcept) {
          const mergedReferences = mergeSourceReferences(
            existingConcept.sourceReferences,
            sourceReferences,
          );
          const mergedConceptUncertainty = mergeUncertainty(
            existingConcept.uncertainty,
            uncertainty,
          );
          if (
            JSON.stringify(existingConcept.sourceReferences) ===
              JSON.stringify(mergedReferences) &&
            existingConcept.uncertainty === mergedConceptUncertainty
          )
            continue;
          assertCurrentContext(context);
          const revision = nextMemoryRevision(tx, context.userId);
          lastRevision = revision;
          tx.update(ConceptTable)
            .set({
              sourceReferences: mergedReferences,
              uncertainty: mergedConceptUncertainty,
              revision,
              updatedAt: now,
            })
            .where(
              and(
                eq(ConceptTable.userId, context.userId),
                eq(ConceptTable.courseId, courseId),
                eq(ConceptTable.id, existingConcept.id),
              ),
            )
            .run();
          const updatedConcept = tx
            .select()
            .from(ConceptTable)
            .where(eq(ConceptTable.id, existingConcept.id))
            .get();
          if (!updatedConcept) throw new MemoryServiceError('storage-failed');
          conceptsByLabel.set(normalizedLabel, updatedConcept);
          continue;
        }

        assertCurrentContext(context);
        const revision = nextMemoryRevision(tx, context.userId);
        lastRevision = revision;
        const insertedConcept = {
          id: randomUUID(),
          userId: context.userId,
          courseId,
          label,
          normalizedLabel,
          description: candidate.description.trim(),
          sourceReferences,
          uncertainty,
          revision,
          createdAt: now,
          updatedAt: now,
        };
        tx.insert(ConceptTable).values(insertedConcept).run();
        const savedConcept = tx
          .select()
          .from(ConceptTable)
          .where(eq(ConceptTable.id, insertedConcept.id))
          .get();
        if (!savedConcept) throw new MemoryServiceError('storage-failed');
        conceptsByLabel.set(normalizedLabel, savedConcept);
      }

      const savedLinks = tx
        .select()
        .from(ConceptLinkTable)
        .where(
          and(
            eq(ConceptLinkTable.userId, context.userId),
            eq(ConceptLinkTable.courseId, courseId),
          ),
        )
        .limit(2001)
        .all();
      const linkGraphLimited = savedLinks.length > 2000;
      const courseLinks = savedLinks.slice(0, 2000);
      for (const candidate of proposedLinks) {
        const fromConcept = conceptsByLabel.get(
          normalizeConceptLabel(candidate.fromLabel),
        );
        const toConcept = conceptsByLabel.get(
          normalizeConceptLabel(candidate.toLabel),
        );
        if (!fromConcept || !toConcept || fromConcept.id === toConcept.id)
          continue;
        const resolvedSources = candidate.sourceReferences
          .map((reference) =>
            resolveCurrentConceptSource(
              tx,
              context.userId,
              courseId,
              reference,
            ),
          )
          .filter((source): source is ResolvedConceptSource => source !== null);
        if (!resolvedSources.length) continue;
        const sourceReferences = resolvedSources.map(
          ({ reference }) => reference,
        );
        const sourceIsPartial = resolvedSources.some(
          (source) => source.partial,
        );
        let relationship = candidate.relationship;
        let uncertainty = mergeUncertainty(
          candidate.uncertainty,
          sourceIsPartial
            ? 'A supporting source was partially extracted; this relation remains uncertain.'
            : '',
        );
        if (relationship === 'prerequisite') {
          const pathState = linkGraphLimited
            ? 'bounded'
            : prerequisitePathState(courseLinks, toConcept.id, fromConcept.id);
          if (pathState !== 'clear') {
            relationship = 'related';
            uncertainty = mergeUncertainty(
              uncertainty,
              pathState === 'cycle'
                ? 'The proposed prerequisite direction was downgraded to a related concept because it would create a cycle.'
                : 'The prerequisite graph exceeded its safe traversal bound; this relation is retained as uncertain related context.',
            );
          }
        }
        const existingLink = courseLinks.find(
          (link) =>
            link.fromConceptId === fromConcept.id &&
            link.toConceptId === toConcept.id &&
            link.relationship === relationship,
        );
        if (existingLink) {
          const mergedReferences = mergeSourceReferences(
            existingLink.sourceReferences,
            sourceReferences,
          );
          const mergedLinkUncertainty = mergeUncertainty(
            existingLink.uncertainty,
            uncertainty,
          );
          if (
            JSON.stringify(existingLink.sourceReferences) ===
              JSON.stringify(mergedReferences) &&
            existingLink.uncertainty === mergedLinkUncertainty
          )
            continue;
          assertCurrentContext(context);
          const revision = nextMemoryRevision(tx, context.userId);
          lastRevision = revision;
          tx.update(ConceptLinkTable)
            .set({
              sourceReferences: mergedReferences,
              uncertainty: mergedLinkUncertainty,
            })
            .where(
              and(
                eq(ConceptLinkTable.userId, context.userId),
                eq(ConceptLinkTable.courseId, courseId),
                eq(ConceptLinkTable.id, existingLink.id),
              ),
            )
            .run();
          tx.update(ConceptTable)
            .set({ revision, updatedAt: now })
            .where(
              and(
                eq(ConceptTable.userId, context.userId),
                eq(ConceptTable.courseId, courseId),
                or(
                  eq(ConceptTable.id, fromConcept.id),
                  eq(ConceptTable.id, toConcept.id),
                ),
              ),
            )
            .run();
          Object.assign(existingLink, {
            sourceReferences: mergedReferences,
            uncertainty: mergedLinkUncertainty,
          });
          continue;
        }

        assertCurrentContext(context);
        const revision = nextMemoryRevision(tx, context.userId);
        lastRevision = revision;
        const insertedLink: ConceptLinkSelectData = {
          id: randomUUID(),
          userId: context.userId,
          courseId,
          fromConceptId: fromConcept.id,
          toConceptId: toConcept.id,
          relationship,
          sourceReferences,
          uncertainty,
          createdAt: now,
        };
        tx.insert(ConceptLinkTable).values(insertedLink).run();
        tx.update(ConceptTable)
          .set({ revision, updatedAt: now })
          .where(
            and(
              eq(ConceptTable.userId, context.userId),
              eq(ConceptTable.courseId, courseId),
              or(
                eq(ConceptTable.id, fromConcept.id),
                eq(ConceptTable.id, toConcept.id),
              ),
            ),
          )
          .run();
        courseLinks.push(insertedLink);
      }
    });
    if (lastRevision !== null)
      publishMemoryChange({
        userId: context.userId,
        courseId,
        revision: lastRevision,
      });
    const graph = getCourseConceptGraph(context, { courseId });
    if (!graph) throw new MemoryServiceError('storage-failed');
    return graph;
  } catch (error) {
    if (error instanceof MemoryServiceError) throw error;
    throw new MemoryServiceError('storage-failed');
  }
};

export const getCourseConceptGraph = (
  context: AuthorizedContext,
  input: z.infer<typeof courseConceptGraphInputSchema>,
): CourseConceptGraph | null => {
  if (context.signal.aborted || !context.isCurrent()) return null;
  const parsedInput = courseConceptGraphInputSchema.safeParse(input);
  if (!parsedInput.success) return null;
  const {
    courseId,
    conceptId,
    maxDepth = 4,
    maxNodes = 100,
  } = parsedInput.data;

  try {
    const ownedCourse = db
      .select({ id: CourseTable.id })
      .from(CourseTable)
      .where(
        and(
          eq(CourseTable.userId, context.userId),
          eq(CourseTable.id, courseId),
        ),
      )
      .get();
    if (!ownedCourse) return null;
    const allConcepts = db
      .select()
      .from(ConceptTable)
      .where(
        and(
          eq(ConceptTable.userId, context.userId),
          eq(ConceptTable.courseId, courseId),
        ),
      )
      .orderBy(asc(ConceptTable.label), asc(ConceptTable.id))
      .limit(1001)
      .all();
    const conceptRows = allConcepts.slice(0, 1000);
    const allLinks = db
      .select()
      .from(ConceptLinkTable)
      .where(
        and(
          eq(ConceptLinkTable.userId, context.userId),
          eq(ConceptLinkTable.courseId, courseId),
        ),
      )
      .limit(2001)
      .all();
    const linkRows = allLinks.slice(0, 2000);
    const conceptById = new Map(
      conceptRows.map((concept) => [concept.id, concept]),
    );
    const startConcept = conceptId ? conceptById.get(conceptId) : undefined;
    if (conceptId && !startConcept) return null;
    const includedIds = new Set<string>();
    let truncated = allConcepts.length > 1000 || allLinks.length > 2000;

    if (startConcept) {
      const queue: { id: string; depth: number }[] = [
        { id: startConcept.id, depth: 0 },
      ];
      while (queue.length) {
        const current = queue.shift()!;
        if (includedIds.has(current.id)) continue;
        if (includedIds.size >= maxNodes) {
          truncated = true;
          continue;
        }
        includedIds.add(current.id);
        for (const link of linkRows) {
          if (
            link.fromConceptId !== current.id &&
            link.toConceptId !== current.id
          )
            continue;
          const nextId =
            link.fromConceptId === current.id
              ? link.toConceptId
              : link.fromConceptId;
          if (includedIds.has(nextId)) continue;
          if (current.depth >= maxDepth) {
            truncated = true;
            continue;
          }
          if (!conceptById.has(nextId)) {
            truncated = true;
            continue;
          }
          queue.push({ id: nextId, depth: current.depth + 1 });
        }
      }
    } else {
      for (const concept of conceptRows.slice(0, maxNodes))
        includedIds.add(concept.id);
      if (conceptRows.length > maxNodes) truncated = true;
    }

    const visibleConceptRows = conceptRows.filter((concept) =>
      includedIds.has(concept.id),
    );
    const visibleLinkRows = linkRows.filter(
      (link) =>
        includedIds.has(link.fromConceptId) &&
        includedIds.has(link.toConceptId),
    );
    const visibleLinks: CourseConceptLink[] = visibleLinkRows.map((link) => {
      const sourceReferences = resolveStoredSourceReferences(
        db,
        context.userId,
        courseId,
        link.sourceReferences,
      );
      const hasCurrentSource = sourceReferences.some(
        (reference) => reference.state === 'current',
      );
      return {
        id: link.id,
        fromConceptId: link.fromConceptId,
        toConceptId: link.toConceptId,
        relationship: link.relationship,
        uncertainty: hasCurrentSource
          ? link.uncertainty
          : mergeUncertainty(
              link.uncertainty,
              'Supporting sources are no longer current; treat this relation as historical.',
            ),
        sourceReferences,
      };
    });
    const visibleConcepts: CourseConceptNode[] = visibleConceptRows.map(
      (concept) => {
        const sourceReferences = resolveStoredSourceReferences(
          db,
          context.userId,
          courseId,
          concept.sourceReferences,
        );
        const hasCurrentSource = sourceReferences.some(
          (reference) => reference.state === 'current',
        );
        const prerequisiteIds = visibleLinks
          .filter(
            (link) =>
              link.relationship === 'prerequisite' &&
              link.toConceptId === concept.id,
          )
          .map((link) => link.fromConceptId);
        const relatedIds = visibleLinks
          .filter(
            (link) =>
              link.relationship === 'related' &&
              (link.fromConceptId === concept.id ||
                link.toConceptId === concept.id),
          )
          .map((link) =>
            link.fromConceptId === concept.id
              ? link.toConceptId
              : link.fromConceptId,
          );
        return {
          id: concept.id,
          label: concept.label,
          description: concept.description,
          uncertainty: hasCurrentSource
            ? concept.uncertainty
            : mergeUncertainty(
                concept.uncertainty,
                'Supporting sources are no longer current; treat this concept as historical.',
              ),
          sourceReferences,
          prerequisiteIds: [...new Set(prerequisiteIds)],
          relatedIds: [...new Set(relatedIds)],
        };
      },
    );
    const revision =
      db
        .select({
          revision: sql<number>`coalesce(max(${ConceptTable.revision}), 0)`,
        })
        .from(ConceptTable)
        .where(
          and(
            eq(ConceptTable.userId, context.userId),
            eq(ConceptTable.courseId, courseId),
          ),
        )
        .get()?.revision ?? 0;
    return {
      courseId,
      revision,
      concepts: visibleConcepts,
      links: visibleLinks,
      truncated,
    };
  } catch {
    return null;
  }
};
