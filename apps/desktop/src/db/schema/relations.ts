import { relations } from 'drizzle-orm';
import { AcademicConnectionTable } from './academic-connection';
import { ArtifactStateTable } from './artifact-state';
import { ArtifactTable } from './artifact';
import { ArtifactVersionTable } from './artifact-version';
import { AssistanceLedgerTable } from './assistance-ledger';
import { ConceptLinkTable } from './concept-link';
import { ConceptTable } from './concept';
import { ContextChunkTable } from './context-chunk';
import { ContextItemTable } from './context-item';
import { ContextLinkTable } from './context-link';
import { ContextVersionTable } from './context-version';
import { CourseAnnouncementTable } from './course-announcement';
import { CourseAssignmentTable } from './course-assignment';
import { CourseMaterialChunkTable } from './course-material-chunk';
import { CourseMaterialTable } from './course-material';
import { CourseMaterialVersionTable } from './course-material-version';
import { CourseTable } from './course';
import { CourseworkProtectionTable } from './coursework-protection';
import { GradeEvidenceTable } from './grade-evidence';
import { LearningObservationTable } from './learning-observation';
import { MemoryTable } from './memory';
import { PracticeAnswerTable } from './practice-answer';
import { PracticeAttemptTable } from './practice-attempt';
import { StudyMessageTable } from './study-message';
import { StudySessionTable } from './study-session';
import { StudySourceReferenceTable } from './study-source-reference';
import { StudyTurnTable } from './study-turn';
import { WatchTargetTable } from './watch-target';

export const AcademicConnectionRelations = relations(
  AcademicConnectionTable,
  ({ many }) => ({
    courses: many(CourseTable),
    courseMaterials: many(CourseMaterialTable),
    gradeEvidence: many(GradeEvidenceTable),
    watchTargets: many(WatchTargetTable),
  }),
);

export const CourseRelations = relations(CourseTable, ({ one, many }) => ({
  connection: one(AcademicConnectionTable, {
    fields: [CourseTable.connectionId],
    references: [AcademicConnectionTable.id],
  }),
  assignments: many(CourseAssignmentTable),
  announcements: many(CourseAnnouncementTable),
  materials: many(CourseMaterialTable),
  watchTargets: many(WatchTargetTable),
  contextLinks: many(ContextLinkTable),
  studySessions: many(StudySessionTable),
  artifacts: many(ArtifactTable),
  practiceAttempts: many(PracticeAttemptTable),
  memories: many(MemoryTable),
  concepts: many(ConceptTable),
  conceptLinks: many(ConceptLinkTable),
  observations: many(LearningObservationTable),
  gradeEvidence: many(GradeEvidenceTable),
  courseworkProtections: many(CourseworkProtectionTable),
  assistanceLedger: many(AssistanceLedgerTable),
}));

export const CourseAssignmentRelations = relations(
  CourseAssignmentTable,
  ({ one, many }) => ({
    course: one(CourseTable, {
      fields: [CourseAssignmentTable.courseId],
      references: [CourseTable.id],
    }),
    studySessions: many(StudySessionTable),
  }),
);

export const CourseAnnouncementRelations = relations(
  CourseAnnouncementTable,
  ({ one }) => ({
    course: one(CourseTable, {
      fields: [CourseAnnouncementTable.courseId],
      references: [CourseTable.id],
    }),
  }),
);

export const CourseMaterialRelations = relations(
  CourseMaterialTable,
  ({ one, many }) => ({
    connection: one(AcademicConnectionTable, {
      fields: [CourseMaterialTable.connectionId],
      references: [AcademicConnectionTable.id],
    }),
    course: one(CourseTable, {
      fields: [CourseMaterialTable.courseId],
      references: [CourseTable.id],
    }),
    versions: many(CourseMaterialVersionTable, {
      relationName: 'materialVersions',
    }),
    currentUsableVersionData: one(CourseMaterialVersionTable, {
      fields: [
        CourseMaterialTable.id,
        CourseMaterialTable.currentUsableVersion,
      ],
      references: [
        CourseMaterialVersionTable.materialId,
        CourseMaterialVersionTable.contentHash,
      ],
      relationName: 'currentMaterialVersion',
    }),
    chunks: many(CourseMaterialChunkTable),
  }),
);

export const CourseMaterialVersionRelations = relations(
  CourseMaterialVersionTable,
  ({ one, many }) => ({
    material: one(CourseMaterialTable, {
      fields: [CourseMaterialVersionTable.materialId],
      references: [CourseMaterialTable.id],
      relationName: 'materialVersions',
    }),
    currentForMaterials: many(CourseMaterialTable, {
      relationName: 'currentMaterialVersion',
    }),
    chunks: many(CourseMaterialChunkTable, {
      relationName: 'materialVersionChunks',
    }),
  }),
);

export const CourseMaterialChunkRelations = relations(
  CourseMaterialChunkTable,
  ({ one }) => ({
    material: one(CourseMaterialTable, {
      fields: [CourseMaterialChunkTable.materialId],
      references: [CourseMaterialTable.id],
    }),
    versionData: one(CourseMaterialVersionTable, {
      fields: [
        CourseMaterialChunkTable.materialId,
        CourseMaterialChunkTable.version,
      ],
      references: [
        CourseMaterialVersionTable.materialId,
        CourseMaterialVersionTable.contentHash,
      ],
      relationName: 'materialVersionChunks',
    }),
  }),
);

export const WatchTargetRelations = relations(WatchTargetTable, ({ one }) => ({
  connection: one(AcademicConnectionTable, {
    fields: [WatchTargetTable.connectionId],
    references: [AcademicConnectionTable.id],
  }),
  course: one(CourseTable, {
    fields: [WatchTargetTable.courseId],
    references: [CourseTable.id],
  }),
}));

export const ContextItemRelations = relations(
  ContextItemTable,
  ({ one, many }) => ({
    versions: many(ContextVersionTable, {
      relationName: 'contextItemVersions',
    }),
    currentVersion: one(ContextVersionTable, {
      fields: [ContextItemTable.id, ContextItemTable.currentVersionId],
      references: [ContextVersionTable.itemId, ContextVersionTable.id],
      relationName: 'contextCurrentVersion',
    }),
    originatingSession: one(StudySessionTable, {
      fields: [ContextItemTable.originatingSessionId],
      references: [StudySessionTable.id],
      relationName: 'contextOriginatingSession',
    }),
    links: many(ContextLinkTable),
    chunks: many(ContextChunkTable),
  }),
);

export const ContextVersionRelations = relations(
  ContextVersionTable,
  ({ one, many }) => ({
    item: one(ContextItemTable, {
      fields: [ContextVersionTable.itemId],
      references: [ContextItemTable.id],
      relationName: 'contextItemVersions',
    }),
    currentForItems: many(ContextItemTable, {
      relationName: 'contextCurrentVersion',
    }),
    chunks: many(ContextChunkTable),
  }),
);

export const ContextLinkRelations = relations(ContextLinkTable, ({ one }) => ({
  item: one(ContextItemTable, {
    fields: [ContextLinkTable.itemId],
    references: [ContextItemTable.id],
  }),
  course: one(CourseTable, {
    fields: [ContextLinkTable.courseId],
    references: [CourseTable.id],
  }),
  session: one(StudySessionTable, {
    fields: [ContextLinkTable.sessionId],
    references: [StudySessionTable.id],
  }),
}));

export const ContextChunkRelations = relations(
  ContextChunkTable,
  ({ one }) => ({
    item: one(ContextItemTable, {
      fields: [ContextChunkTable.itemId],
      references: [ContextItemTable.id],
    }),
    version: one(ContextVersionTable, {
      fields: [ContextChunkTable.itemId, ContextChunkTable.versionId],
      references: [ContextVersionTable.itemId, ContextVersionTable.id],
    }),
  }),
);

export const StudySessionRelations = relations(
  StudySessionTable,
  ({ one, many }) => ({
    course: one(CourseTable, {
      fields: [StudySessionTable.courseId],
      references: [CourseTable.id],
    }),
    targetAssignment: one(CourseAssignmentTable, {
      fields: [StudySessionTable.targetAssignmentId],
      references: [CourseAssignmentTable.id],
    }),
    messages: many(StudyMessageTable),
    turns: many(StudyTurnTable),
    sourceReferences: many(StudySourceReferenceTable),
    contextLinks: many(ContextLinkTable),
    originatedContextItems: many(ContextItemTable, {
      relationName: 'contextOriginatingSession',
    }),
    artifacts: many(ArtifactTable),
    practiceAttempts: many(PracticeAttemptTable),
    observations: many(LearningObservationTable),
  }),
);

export const StudyMessageRelations = relations(
  StudyMessageTable,
  ({ one, many }) => ({
    session: one(StudySessionTable, {
      fields: [StudyMessageTable.sessionId],
      references: [StudySessionTable.id],
    }),
    turn: one(StudyTurnTable, {
      fields: [StudyMessageTable.turnId],
      references: [StudyTurnTable.id],
    }),
    sourceReferences: many(StudySourceReferenceTable),
  }),
);

export const StudyTurnRelations = relations(
  StudyTurnTable,
  ({ one, many }) => ({
    session: one(StudySessionTable, {
      fields: [StudyTurnTable.sessionId],
      references: [StudySessionTable.id],
    }),
    messages: many(StudyMessageTable),
    assistanceLedger: many(AssistanceLedgerTable),
  }),
);

export const StudySourceReferenceRelations = relations(
  StudySourceReferenceTable,
  ({ one }) => ({
    session: one(StudySessionTable, {
      fields: [StudySourceReferenceTable.sessionId],
      references: [StudySessionTable.id],
    }),
    message: one(StudyMessageTable, {
      fields: [StudySourceReferenceTable.messageId],
      references: [StudyMessageTable.id],
    }),
  }),
);

export const ArtifactRelations = relations(ArtifactTable, ({ one, many }) => ({
  course: one(CourseTable, {
    fields: [ArtifactTable.courseId],
    references: [CourseTable.id],
  }),
  originatingSession: one(StudySessionTable, {
    fields: [ArtifactTable.originatingSessionId],
    references: [StudySessionTable.id],
  }),
  versions: many(ArtifactVersionTable, { relationName: 'artifactVersions' }),
  currentVersion: one(ArtifactVersionTable, {
    fields: [ArtifactTable.id, ArtifactTable.currentVersionId],
    references: [ArtifactVersionTable.artifactId, ArtifactVersionTable.id],
    relationName: 'artifactCurrentVersion',
  }),
  states: many(ArtifactStateTable),
  practiceAttempts: many(PracticeAttemptTable),
}));

export const ArtifactVersionRelations = relations(
  ArtifactVersionTable,
  ({ one, many }) => ({
    artifact: one(ArtifactTable, {
      fields: [ArtifactVersionTable.artifactId],
      references: [ArtifactTable.id],
      relationName: 'artifactVersions',
    }),
    currentForArtifacts: many(ArtifactTable, {
      relationName: 'artifactCurrentVersion',
    }),
    states: many(ArtifactStateTable),
    practiceAttempts: many(PracticeAttemptTable, {
      relationName: 'practiceArtifactVersion',
    }),
  }),
);

export const ArtifactStateRelations = relations(
  ArtifactStateTable,
  ({ one }) => ({
    artifact: one(ArtifactTable, {
      fields: [ArtifactStateTable.artifactId],
      references: [ArtifactTable.id],
    }),
    version: one(ArtifactVersionTable, {
      fields: [ArtifactStateTable.artifactId, ArtifactStateTable.versionId],
      references: [ArtifactVersionTable.artifactId, ArtifactVersionTable.id],
    }),
  }),
);

export const PracticeAttemptRelations = relations(
  PracticeAttemptTable,
  ({ one, many }) => ({
    course: one(CourseTable, {
      fields: [PracticeAttemptTable.courseId],
      references: [CourseTable.id],
    }),
    session: one(StudySessionTable, {
      fields: [PracticeAttemptTable.sessionId],
      references: [StudySessionTable.id],
    }),
    artifact: one(ArtifactTable, {
      fields: [PracticeAttemptTable.artifactId],
      references: [ArtifactTable.id],
    }),
    version: one(ArtifactVersionTable, {
      fields: [PracticeAttemptTable.artifactId, PracticeAttemptTable.versionId],
      references: [ArtifactVersionTable.artifactId, ArtifactVersionTable.id],
      relationName: 'practiceArtifactVersion',
    }),
    answers: many(PracticeAnswerTable),
    observations: many(LearningObservationTable),
  }),
);

export const PracticeAnswerRelations = relations(
  PracticeAnswerTable,
  ({ one }) => ({
    attempt: one(PracticeAttemptTable, {
      fields: [PracticeAnswerTable.attemptId],
      references: [PracticeAttemptTable.id],
    }),
  }),
);

export const MemoryRelations = relations(MemoryTable, ({ one, many }) => ({
  course: one(CourseTable, {
    fields: [MemoryTable.courseId],
    references: [CourseTable.id],
  }),
  supersedes: one(MemoryTable, {
    fields: [MemoryTable.supersedesId],
    references: [MemoryTable.id],
    relationName: 'memorySupersession',
  }),
  supersededBy: many(MemoryTable, { relationName: 'memorySupersession' }),
}));

export const ConceptRelations = relations(ConceptTable, ({ one, many }) => ({
  course: one(CourseTable, {
    fields: [ConceptTable.courseId],
    references: [CourseTable.id],
  }),
  outgoingLinks: many(ConceptLinkTable, { relationName: 'conceptLinkFrom' }),
  incomingLinks: many(ConceptLinkTable, { relationName: 'conceptLinkTo' }),
  observations: many(LearningObservationTable),
}));

export const ConceptLinkRelations = relations(ConceptLinkTable, ({ one }) => ({
  course: one(CourseTable, {
    fields: [ConceptLinkTable.courseId],
    references: [CourseTable.id],
  }),
  fromConcept: one(ConceptTable, {
    fields: [ConceptLinkTable.fromConceptId],
    references: [ConceptTable.id],
    relationName: 'conceptLinkFrom',
  }),
  toConcept: one(ConceptTable, {
    fields: [ConceptLinkTable.toConceptId],
    references: [ConceptTable.id],
    relationName: 'conceptLinkTo',
  }),
}));

export const LearningObservationRelations = relations(
  LearningObservationTable,
  ({ one }) => ({
    course: one(CourseTable, {
      fields: [LearningObservationTable.courseId],
      references: [CourseTable.id],
    }),
    concept: one(ConceptTable, {
      fields: [LearningObservationTable.conceptId],
      references: [ConceptTable.id],
    }),
    attempt: one(PracticeAttemptTable, {
      fields: [LearningObservationTable.attemptId],
      references: [PracticeAttemptTable.id],
    }),
    session: one(StudySessionTable, {
      fields: [LearningObservationTable.sourceSessionId],
      references: [StudySessionTable.id],
    }),
  }),
);

export const GradeEvidenceRelations = relations(
  GradeEvidenceTable,
  ({ one, many }) => ({
    connection: one(AcademicConnectionTable, {
      fields: [GradeEvidenceTable.connectionId],
      references: [AcademicConnectionTable.id],
    }),
    course: one(CourseTable, {
      fields: [GradeEvidenceTable.courseId],
      references: [CourseTable.id],
    }),
    protections: many(CourseworkProtectionTable, {
      relationName: 'protectionEvidence',
    }),
  }),
);

export const CourseworkProtectionRelations = relations(
  CourseworkProtectionTable,
  ({ one, many }) => ({
    course: one(CourseTable, {
      fields: [CourseworkProtectionTable.courseId],
      references: [CourseTable.id],
    }),
    connection: one(AcademicConnectionTable, {
      fields: [CourseworkProtectionTable.connectionId],
      references: [AcademicConnectionTable.id],
    }),
    sourceEvidence: one(GradeEvidenceTable, {
      fields: [CourseworkProtectionTable.sourceEvidenceId],
      references: [GradeEvidenceTable.id],
      relationName: 'protectionEvidence',
    }),
    assistanceLedger: many(AssistanceLedgerTable),
  }),
);

export const AssistanceLedgerRelations = relations(
  AssistanceLedgerTable,
  ({ one }) => ({
    course: one(CourseTable, {
      fields: [AssistanceLedgerTable.courseId],
      references: [CourseTable.id],
    }),
    protection: one(CourseworkProtectionTable, {
      fields: [AssistanceLedgerTable.protectionId],
      references: [CourseworkProtectionTable.id],
    }),
    turn: one(StudyTurnTable, {
      fields: [AssistanceLedgerTable.turnId],
      references: [StudyTurnTable.id],
    }),
  }),
);
