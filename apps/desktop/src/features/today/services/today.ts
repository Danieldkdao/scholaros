import { count, and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AssignmentKind } from '@scholaros/services/ai/resources/assignment';
import { assignmentStates } from '@scholaros/services/ai/resources/shared';
import {
  sourceReferenceSchema,
  type SourceReference,
} from '@scholaros/services/learning/context-contracts';
import { observedGradeSchema } from '@scholaros/services/learning/grade-contracts';
import {
  learningProgressSchema,
  memorySchema,
  observationSummarySchema,
  type LearningProgress,
  type MemoryDTO,
} from '@scholaros/services/learning/memory-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import {
  todayOverviewSchema,
  type AnnouncementSummary,
  type AttentionItem,
  type FreshnessItem,
  type Recommendation,
  type TodayCourseSummary,
  type TodayOverview,
} from '@scholaros/services/learning/today-contracts';
import type { StudySessionDTO } from '@scholaros/services/learning/study-contracts';
import { db } from '../../../db';
import {
  ConceptTable,
  ContextItemTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseMaterialTable,
  CourseTable,
  GradeEvidenceTable,
  LearningObservationTable,
  MemoryTable,
  SettingTable,
  StudySessionTable,
  WatchTargetTable,
} from '../../../db/schema';
import { academicDateFor } from '../../courses/lib/dates';
import { formatTodayAnnouncementContent } from '../lib/formatters';
import {
  sortAnnouncements,
  sortAssignments,
} from '../../courses/lib/formatters';
import type {
  CourseSummary,
  CourseSourceStatus,
  SavedCourseChild,
} from '../../courses/types';
import { getCoursesAction } from '../../courses/services/read-actions';
import { getOnboardingState } from '../../onboarding/services/store';
import type { OnboardingState } from '../../onboarding/types';
import {
  buildStudyRecommendations,
  createTodayInputsRevision,
} from './recommendations';
import type {
  RecommendationAssignment,
  RecommendationConcept,
  RecommendationGradeEvidence,
  RecommendationObservation,
} from './recommendations';

const overviewInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(20).optional(),
});
export type OverviewInputSchema = z.infer<typeof overviewInputSchema>;
export type OverviewInput = z.infer<typeof overviewInputSchema>;

const recommendationsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(5).optional(),
});
export type RecommendationsInputSchema = z.infer<
  typeof recommendationsInputSchema
>;
export type RecommendationsInput = z.infer<typeof recommendationsInputSchema>;

const maxSourceRows = 500;
const maxRecentSessions = 10;
const maxOverviewLimit = 20;

export type TodayCourseChild = SavedCourseChild & { courseId: string };

type TodayChildFields = Pick<
  SavedCourseChild,
  'title' | 'body' | 'dateValue' | 'dateText'
>;

export const applyTodayChildOverrides = (
  fields: TodayChildFields,
  overrides: Partial<TodayChildFields>,
): TodayChildFields => ({
  title: Object.hasOwn(overrides, 'title')
    ? (overrides.title ?? fields.title)
    : fields.title,
  body: Object.hasOwn(overrides, 'body')
    ? (overrides.body ?? null)
    : fields.body,
  dateValue: Object.hasOwn(overrides, 'dateValue')
    ? (overrides.dateValue ?? null)
    : fields.dateValue,
  dateText: Object.hasOwn(overrides, 'dateText')
    ? (overrides.dateText ?? null)
    : fields.dateText,
});

export const summarizeCourseMaterialProcessing = (
  materials: Pick<
    typeof CourseMaterialTable.$inferSelect,
    'extractionStatus'
  >[],
) =>
  materials.reduce(
    (counts, { extractionStatus }) => {
      if (extractionStatus === 'pending') counts.pendingCount += 1;
      if (['partial', 'unreadable', 'failed'].includes(extractionStatus))
        counts.needsAttentionCount += 1;
      return counts;
    },
    { pendingCount: 0, needsAttentionCount: 0 },
  );

export const isCurrentGradeEvidenceForCourse = ({
  evidence,
  course,
  connection,
  workspaceVerifiedAt,
  academicConsent,
}: {
  evidence: Pick<
    typeof GradeEvidenceTable.$inferSelect,
    'connectionId' | 'observedAt'
  >;
  course: Pick<CourseSummary, 'connectionId' | 'sourceState'> | undefined;
  connection:
    | Pick<
        OnboardingState['connections'][number],
        'isCourseResource' | 'status' | 'verifiedAt'
      >
    | undefined;
  workspaceVerifiedAt: string | null;
  academicConsent: boolean;
}) => {
  const observedAt = Date.parse(evidence.observedAt);
  const connectionVerifiedAt = Date.parse(connection?.verifiedAt ?? '');
  const workspaceVerified = Date.parse(workspaceVerifiedAt ?? '');
  return Boolean(
    academicConsent &&
    course?.sourceState === 'connected' &&
    course.connectionId === evidence.connectionId &&
    connection?.isCourseResource &&
    connection.status === 'verified' &&
    Number.isFinite(observedAt) &&
    Number.isFinite(connectionVerifiedAt) &&
    Number.isFinite(workspaceVerified) &&
    observedAt >= connectionVerifiedAt &&
    observedAt >= workspaceVerified,
  );
};

export const isGradeEvidenceCurrentForAssignment = ({
  observedAt,
  lastSeenAt,
  contentChangedAt,
}: {
  observedAt: string | null;
  lastSeenAt: string;
  contentChangedAt: string | null;
}) => {
  const observedTime = Date.parse(observedAt ?? '');
  const sourceTimes = [lastSeenAt, contentChangedAt].filter(
    (value): value is string => value !== null,
  );
  return (
    Number.isFinite(observedTime) &&
    sourceTimes.every((value) => {
      const sourceTime = Date.parse(value);
      return Number.isFinite(sourceTime) && observedTime >= sourceTime;
    })
  );
};

export type TodayProjectedAssignment = {
  courseId: string;
  courseName: string;
  kind: AssignmentKind;
  state: (typeof assignmentStates)[number];
  item: TodayCourseChild;
  sourceReference: SourceReference;
};

export type TodayProjectedAnnouncement = {
  courseId: string;
  courseName?: string;
  item: TodayCourseChild;
  sourceReference: SourceReference;
};

export type TodayProjectionInput = {
  attention: AttentionItem[];
  freshness: FreshnessItem[];
  assignments: TodayProjectedAssignment[];
  announcements: TodayProjectedAnnouncement[];
  recentCourses: TodayCourseSummary[];
  recentMaterials: SourceReference[];
  recentSessions: StudySessionDTO[];
  progress: LearningProgress;
  recommendations: Recommendation[];
  revision: number;
};

export type TodayProjectionReader = (
  context: AuthorizedContext,
  now: string,
) => TodayProjectionInput | null;

const childItem = (
  row:
    | typeof CourseAssignmentTable.$inferSelect
    | typeof CourseAnnouncementTable.$inferSelect,
): TodayCourseChild => {
  const overrides = row.localOverrides ?? {};
  const { title, body, dateValue, dateText } = applyTodayChildOverrides(
    row,
    overrides,
  );
  return {
    courseId: row.courseId,
    id: row.id,
    active: row.active,
    lastSeenAt: row.lastSeenAt,
    title,
    body,
    dateValue,
    dateText,
    url: row.url,
    content: row.content,
    contentChangedAt: row.contentChangedAt,
  };
};

const referenceForChild = ({
  id,
  courseId,
  title,
  lastSeenAt,
  sourceKey,
}: {
  id: string;
  courseId: string;
  title: string;
  lastSeenAt: string;
  sourceKey: string;
}): SourceReference =>
  sourceReferenceSchema.parse({
    sourceKind: 'assignment',
    sourceId: id,
    versionId: null,
    courseId,
    locator: null,
    title,
    provenance: sourceKey.startsWith('manual:')
      ? 'user-authored'
      : 'connected-source',
    observedAt: lastSeenAt,
    state: 'current',
  });

const referenceForAnnouncement = ({
  id,
  courseId,
  title,
  lastSeenAt,
  sourceKey,
}: {
  id: string;
  courseId: string;
  title: string;
  lastSeenAt: string;
  sourceKey: string;
}): SourceReference =>
  sourceReferenceSchema.parse({
    sourceKind: 'announcement',
    sourceId: id,
    versionId: null,
    courseId,
    locator: null,
    title,
    provenance: sourceKey.startsWith('manual:')
      ? 'user-authored'
      : 'connected-source',
    observedAt: lastSeenAt,
    state: 'current',
  });

const courseSummaryForToday = (course: CourseSummary): TodayCourseSummary => ({
  id: course.id,
  name: course.name,
  code: course.code,
  term: course.term,
  connectionId: course.connectionId,
  active: course.active,
  sourceName: course.sourceName,
  sourceHost: course.sourceHost,
  lastSeenAt: course.lastSeenAt,
  assignmentCount: course.assignmentCount,
  announcementCount: course.announcementCount,
});

const readRecentSessions = (userId: string): StudySessionDTO[] =>
  db
    .select()
    .from(StudySessionTable)
    .where(
      and(
        eq(StudySessionTable.userId, userId),
        isNull(StudySessionTable.deletedAt),
      ),
    )
    .orderBy(
      desc(StudySessionTable.lastOpenedAt),
      desc(StudySessionTable.updatedAt),
      desc(StudySessionTable.id),
    )
    .limit(maxRecentSessions)
    .all()
    .map((row) => ({
      id: row.id,
      courseId: row.courseId,
      title: row.title,
      activity: row.activity,
      targetAssignmentId: row.targetAssignmentId,
      topic: row.topic,
      status: row.status,
      revision: row.revision,
      generationEpoch: row.generationEpoch,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastOpenedAt: row.lastOpenedAt,
      draft: { text: row.draftText, revision: row.draftRevision },
      timer: {
        deadlineAt: row.deadlineAt,
        revision: row.timerRevision,
        expiredRevision: row.expiredRevision,
        resolvedExpiredRevision: row.resolvedExpiredRevision,
        finishedAt: row.finishedAt,
      },
    }));

const toSourceReferences = (value: SourceReference[] | null | undefined) => {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((reference) => {
      const parsed = sourceReferenceSchema.safeParse(reference);
      return parsed.success && parsed.data.state === 'current'
        ? [parsed.data]
        : [];
    })
    .slice(0, 20);
};

const buildLearningProgress = ({
  concepts,
  observations,
  revision,
}: {
  concepts: (typeof ConceptTable.$inferSelect)[];
  observations: (typeof LearningObservationTable.$inferSelect)[];
  revision: number;
}): LearningProgress => {
  const observationsByConcept = new Map<
    string,
    (typeof observations)[number][]
  >();
  for (const observation of observations) {
    if (!observation.conceptId) continue;
    const current = observationsByConcept.get(observation.conceptId) ?? [];
    current.push(observation);
    observationsByConcept.set(observation.conceptId, current);
  }
  const strengths: LearningProgress['strengths'] = [];
  const practiceTopics: LearningProgress['practiceTopics'] = [];
  const recentChanges: LearningProgress['recentChanges'] = [];
  let unknownCount = 0;
  for (const concept of concepts) {
    const related = (observationsByConcept.get(concept.id) ?? [])
      .filter((observation) => observation.courseId === concept.courseId)
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
    const sourceReferences = toSourceReferences(concept.sourceReferences);
    const independent = related.filter(
      (observation) =>
        observation.independentEvidence &&
        !observation.assisted &&
        observation.responseOutcome === 'independent-success',
    );
    const difficulties = related.filter(
      (observation) => observation.responseOutcome === 'difficulty',
    );
    if (independent.length)
      strengths.push({
        conceptId: concept.id,
        label: concept.label,
        summary: 'Independent practice evidence is recorded for this topic.',
        evidenceIds: independent.slice(0, 50).map(({ id }) => id),
        assisted: false,
        sourceReferences,
      });
    if (difficulties.length)
      practiceTopics.push({
        conceptId: concept.id,
        label: concept.label,
        summary: 'A practice response recorded difficulty with this topic.',
        evidenceIds: difficulties.slice(0, 50).map(({ id }) => id),
        assisted: difficulties.every(({ assisted }) => assisted),
        sourceReferences,
      });
    const recent = related[0];
    if (!recent) {
      unknownCount += 1;
      continue;
    }
    const summaryEvidence = observationSummarySchema.safeParse(
      recent.evidenceSummary,
    );
    const summary =
      summaryEvidence.success &&
      summaryEvidence.data.conceptId === concept.id &&
      summaryEvidence.data.outcome === recent.responseOutcome
        ? summaryEvidence.data.summary
        : (() => {
            switch (recent.responseOutcome) {
              case 'independent-success':
                return 'An independent response was recorded.';
              case 'assisted-success':
                return 'A response following assistance was recorded.';
              case 'difficulty':
                return 'A practice difficulty was recorded.';
              case 'uncertain':
                return 'The learning evidence is uncertain.';
            }
          })();
    recentChanges.push({
      conceptId: concept.id,
      label: concept.label,
      summary,
      evidenceIds: [recent.id],
      assisted: recent.assisted,
      sourceReferences,
    });
  }
  return learningProgressSchema.parse({
    courseId: null,
    strengths: strengths.slice(0, 10),
    practiceTopics: practiceTopics.slice(0, 10),
    recentChanges: recentChanges.slice(0, 10),
    unknownCount,
    revision,
  });
};

const attentionForState = ({
  state,
  refreshing,
  indexing,
  contextNeedsAttention,
  hasPartialSources,
  pendingWatchCount,
}: {
  state: OnboardingState;
  refreshing: boolean;
  indexing: number;
  contextNeedsAttention: number;
  hasPartialSources: boolean;
  pendingWatchCount: number;
}): AttentionItem[] => {
  const attention: AttentionItem[] = [];
  if (!state.workspace?.ready)
    attention.push({
      kind: 'device',
      code: 'device-not-ready',
      label: state.workspace
        ? 'Finish setting up this computer to sync your classes.'
        : 'Set up the academic browser to connect a class.',
      route: { kind: 'settings', section: 'device' },
    });
  if (!state.settings.consent)
    attention.push({
      kind: 'permission',
      code: 'academic-access-not-enabled',
      label: 'Review course access settings before syncing classes.',
      route: { kind: 'settings', section: 'connections' },
    });
  const courseConnections = state.connections.filter(
    (connection) => connection.isCourseResource,
  );
  if (!courseConnections.length)
    attention.push({
      kind: 'connection',
      code: 'no-course-connection',
      label: 'Connect a class source to see course deadlines and materials.',
      route: { kind: 'settings', section: 'connections' },
    });
  for (const connection of courseConnections) {
    if (connection.status !== 'needs-sign-in') continue;
    attention.push({
      kind: 'connection',
      code: `needs-sign-in-${connection.id}`,
      label: `${connection.name} needs sign-in before it can sync again.`,
      route: { kind: 'settings', section: 'connections' },
    });
  }
  if (refreshing)
    attention.push({
      kind: 'sync',
      code: 'sync-running',
      label: 'Class information is still syncing.',
      route: { kind: 'settings', section: 'background' },
    });
  if (hasPartialSources)
    attention.push({
      kind: 'sync',
      code: 'sync-partial',
      label:
        'Some course lists were only partly updated; saved information is still available.',
      route: { kind: 'settings', section: 'background' },
    });
  if (pendingWatchCount > 0)
    attention.push({
      kind: 'sync',
      code: 'watch-pending',
      label: `${pendingWatchCount} watched course change${pendingWatchCount === 1 ? ' is' : 's are'} waiting to sync.`,
      route: { kind: 'settings', section: 'background' },
    });
  if (indexing > 0)
    attention.push({
      kind: 'context',
      code: 'context-indexing',
      label: `${indexing} saved item${indexing === 1 ? ' is' : 's are'} queued or still processing.`,
      route: { kind: 'context', itemId: null },
    });
  if (contextNeedsAttention > 0)
    attention.push({
      kind: 'context',
      code: 'context-needs-attention',
      label: `${contextNeedsAttention} saved item${contextNeedsAttention === 1 ? ' needs' : 's need'} another look.`,
      route: { kind: 'context', itemId: null },
    });
  return attention.slice(0, 10);
};

const sourceFreshness = ({
  course,
  source,
  courseRow,
  connectionNeedsSignIn,
  pendingCount,
}: {
  course: CourseSummary;
  source: CourseSourceStatus | undefined;
  courseRow: typeof CourseTable.$inferSelect | undefined;
  connectionNeedsSignIn: boolean;
  pendingCount: number;
}): FreshnessItem => {
  const lastSuccessfulAt = source?.lastSuccessfulAt ?? null;
  const statuses = [
    course.assignmentsStatus,
    course.announcementsStatus,
    courseRow?.materialsStatus ?? 'pending',
  ];
  const partial =
    statuses.some((status) =>
      ['partial', 'blocked', 'cancelled'].includes(status),
    ) ||
    ['partial', 'blocked', 'cancelled'].includes(source?.outcome ?? 'pending');
  const attemptedAfterSuccess = Boolean(
    source?.lastAttemptedAt &&
    lastSuccessfulAt &&
    Date.parse(source.lastAttemptedAt) > Date.parse(lastSuccessfulAt),
  );
  let status: FreshnessItem['status'];
  if (connectionNeedsSignIn)
    status = lastSuccessfulAt ? 'stale' : 'unavailable';
  else if (partial) status = 'partial';
  else if (pendingCount > 0 || attemptedAfterSuccess) status = 'stale';
  else if (
    lastSuccessfulAt &&
    source?.outcome === 'complete' &&
    statuses.every((value) => value === 'complete')
  )
    status = 'current';
  else if (!lastSuccessfulAt) status = 'unavailable';
  else status = 'stale';
  return { courseId: course.id, status, lastSuccessfulAt, pendingCount };
};

const currentReference = (reference: SourceReference) =>
  sourceReferenceSchema.parse(reference);

const readTodayProjection = (
  context: AuthorizedContext,
  now: string,
): TodayProjectionInput | null => {
  const coursesSnapshot = getCoursesAction(context.userId);
  if (!coursesSnapshot || !context.isCurrent() || context.signal.aborted)
    return null;
  const onboardingState = getOnboardingState(context.userId);
  if (!context.isCurrent() || context.signal.aborted) return null;
  const settings = db
    .select()
    .from(SettingTable)
    .where(eq(SettingTable.userId, context.userId))
    .get();
  const courses = coursesSnapshot.courses.filter(
    (course) =>
      course.active &&
      (course.sourceState === 'connected' || course.sourceState === 'manual'),
  );
  const visibleCourses = courses.slice(0, maxSourceRows);
  const visibleCourseIds = visibleCourses.map(({ id }) => id);
  const visibleCourseIdSet = new Set(visibleCourseIds);
  const courseRows = visibleCourseIds.length
    ? db
        .select()
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, context.userId),
            inArray(CourseTable.id, visibleCourseIds),
          ),
        )
        .limit(maxSourceRows + 1)
        .all()
    : [];
  const assignmentRows = visibleCourseIds.length
    ? db
        .select()
        .from(CourseAssignmentTable)
        .where(
          and(
            eq(CourseAssignmentTable.userId, context.userId),
            eq(CourseAssignmentTable.active, true),
            inArray(CourseAssignmentTable.courseId, visibleCourseIds),
          ),
        )
        .orderBy(
          desc(CourseAssignmentTable.lastSeenAt),
          desc(CourseAssignmentTable.id),
        )
        .limit(maxSourceRows + 1)
        .all()
    : [];
  const announcementRows = visibleCourseIds.length
    ? db
        .select()
        .from(CourseAnnouncementTable)
        .where(
          and(
            eq(CourseAnnouncementTable.userId, context.userId),
            eq(CourseAnnouncementTable.active, true),
            inArray(CourseAnnouncementTable.courseId, visibleCourseIds),
          ),
        )
        .orderBy(
          desc(CourseAnnouncementTable.lastSeenAt),
          desc(CourseAnnouncementTable.id),
        )
        .limit(maxSourceRows + 1)
        .all()
    : [];
  const contextRows = db
    .select()
    .from(ContextItemTable)
    .where(
      and(
        eq(ContextItemTable.userId, context.userId),
        isNull(ContextItemTable.removedAt),
      ),
    )
    .orderBy(desc(ContextItemTable.updatedAt), desc(ContextItemTable.id))
    .limit(maxSourceRows + 1)
    .all();
  const materials = visibleCourseIds.length
    ? db
        .select()
        .from(CourseMaterialTable)
        .where(
          and(
            eq(CourseMaterialTable.userId, context.userId),
            eq(CourseMaterialTable.active, true),
            inArray(CourseMaterialTable.courseId, visibleCourseIds),
          ),
        )
        .orderBy(
          desc(CourseMaterialTable.retrievedAt),
          desc(CourseMaterialTable.id),
        )
        .limit(maxSourceRows + 1)
        .all()
    : [];
  const materialProcessing = summarizeCourseMaterialProcessing(materials);
  const pendingWatchCounts = visibleCourseIds.length
    ? db
        .select({ courseId: WatchTargetTable.courseId, count: count() })
        .from(WatchTargetTable)
        .where(
          and(
            eq(WatchTargetTable.userId, context.userId),
            eq(WatchTargetTable.pendingChange, true),
            inArray(WatchTargetTable.courseId, visibleCourseIds),
          ),
        )
        .groupBy(WatchTargetTable.courseId)
        .all()
    : [];
  const pendingWatchByCourse = new Map(
    pendingWatchCounts.map(({ courseId, count: pendingCount }) => [
      courseId,
      Number(pendingCount),
    ]),
  );
  const courseRowById = new Map(courseRows.map((row) => [row.id, row]));
  const sourceByConnection = new Map(
    coursesSnapshot.sources.map((source) => [source.connectionId, source]),
  );
  const connectionById = new Map(
    onboardingState.connections.map((connection) => [
      connection.id,
      connection,
    ]),
  );
  const courseById = new Map(
    visibleCourses.map((course) => [course.id, course]),
  );
  const watchPendingCount = pendingWatchCounts.reduce(
    (total, item) => total + Number(item.count),
    0,
  );
  const assignments: TodayProjectedAssignment[] = assignmentRows
    .slice(0, maxSourceRows)
    .flatMap((row) => {
      const course = courseById.get(row.courseId);
      if (!course) return [];
      const item = childItem(row);
      const sourceReference = referenceForChild({
        id: row.id,
        courseId: row.courseId,
        title: item.title,
        lastSeenAt: row.lastSeenAt,
        sourceKey: row.sourceKey,
      });
      return [
        {
          courseId: row.courseId,
          courseName: course.name,
          kind: row.content?.kind ?? 'unknown',
          state: row.content?.state ?? 'unknown',
          item,
          sourceReference,
        },
      ];
    });
  const announcements: TodayProjectedAnnouncement[] = announcementRows
    .slice(0, maxSourceRows)
    .flatMap((row) => {
      if (!courseById.has(row.courseId)) return [];
      const item = childItem(row);
      const sourceReference = referenceForAnnouncement({
        id: row.id,
        courseId: row.courseId,
        title: item.title,
        lastSeenAt: row.lastSeenAt,
        sourceKey: row.sourceKey,
      });
      return [
        {
          courseId: row.courseId,
          courseName: courseById.get(row.courseId)!.name,
          item,
          sourceReference,
        },
      ];
    });
  const recentCourses = visibleCourses.map(courseSummaryForToday);
  const courseFreshness = visibleCourses
    .filter((course) => course.sourceState === 'connected')
    .map((course) => {
      const connection = course.connectionId
        ? connectionById.get(course.connectionId)
        : null;
      return sourceFreshness({
        course,
        source: course.connectionId
          ? sourceByConnection.get(course.connectionId)
          : undefined,
        courseRow: courseRowById.get(course.id),
        connectionNeedsSignIn: connection?.status === 'needs-sign-in',
        pendingCount: pendingWatchByCourse.get(course.id) ?? 0,
      });
    });
  const contextPending =
    contextRows.filter(
      (row) => row.status === 'queued' || row.status === 'processing',
    ).length + materialProcessing.pendingCount;
  const contextNeedsAttention =
    contextRows.filter((row) =>
      ['partial', 'unreadable', 'unsupported', 'failed'].includes(row.status),
    ).length + materialProcessing.needsAttentionCount;
  const sourcePartial = coursesSnapshot.sources.some((source) =>
    ['partial', 'blocked', 'cancelled'].includes(source.outcome),
  );
  const learningConceptRows = visibleCourseIds.length
    ? db
        .select()
        .from(ConceptTable)
        .where(
          and(
            eq(ConceptTable.userId, context.userId),
            inArray(ConceptTable.courseId, visibleCourseIds),
          ),
        )
        .orderBy(desc(ConceptTable.updatedAt), desc(ConceptTable.id))
        .limit(maxSourceRows + 1)
        .all()
    : [];
  const learningConcepts = learningConceptRows.slice(0, maxSourceRows);
  const observationRows = visibleCourseIds.length
    ? db
        .select()
        .from(LearningObservationTable)
        .where(
          and(
            eq(LearningObservationTable.userId, context.userId),
            isNull(LearningObservationTable.revokedAt),
            inArray(LearningObservationTable.courseId, visibleCourseIds),
          ),
        )
        .orderBy(
          desc(LearningObservationTable.createdAt),
          desc(LearningObservationTable.id),
        )
        .limit(maxSourceRows + 1)
        .all()
    : [];
  const observations = observationRows.slice(0, maxSourceRows);
  const memoryRows = db
    .select()
    .from(MemoryTable)
    .where(
      and(
        eq(MemoryTable.userId, context.userId),
        isNull(MemoryTable.deletedAt),
        visibleCourseIds.length
          ? or(
              isNull(MemoryTable.courseId),
              inArray(MemoryTable.courseId, visibleCourseIds),
            )
          : isNull(MemoryTable.courseId),
      ),
    )
    .orderBy(desc(MemoryTable.updatedAt), desc(MemoryTable.id))
    .limit(maxSourceRows + 1)
    .all();
  const memories = memoryRows.slice(0, maxSourceRows);
  const supersededMemoryIds = new Set(
    memories.flatMap((memory) =>
      memory.supersedesId ? [memory.supersedesId] : [],
    ),
  );
  const personalMemories = memories
    .filter((memory) => !supersededMemoryIds.has(memory.id))
    .flatMap((memory) => {
      const parsed = memorySchema.safeParse({
        id: memory.id,
        courseId: memory.courseId,
        type: memory.type,
        content: memory.content,
        provenance: memory.provenance,
        evidenceIds: memory.evidenceIds,
        confidence: memory.confidence,
        revision: memory.revision,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      });
      return parsed.success ? [parsed.data] : [];
    });
  const gradeSettings = settings?.productPreferences.grades ?? {
    enabled: false,
    notes: '',
    revision: 0,
  };
  const assignmentRowsById = new Map(
    assignmentRows.map((row) => [row.id, row]),
  );
  const assignmentByIdentity = new Map<string, TodayProjectedAssignment>();
  for (const candidate of assignments) {
    const row = assignmentRowsById.get(candidate.item.id);
    if (!row) continue;
    assignmentByIdentity.set(row.id, candidate);
    assignmentByIdentity.set(row.sourceKey, candidate);
  }
  const rawGradeEvidence =
    gradeSettings.enabled && visibleCourseIds.length
      ? db
          .select()
          .from(GradeEvidenceTable)
          .where(
            and(
              eq(GradeEvidenceTable.userId, context.userId),
              inArray(GradeEvidenceTable.courseId, visibleCourseIds),
            ),
          )
          .orderBy(
            desc(GradeEvidenceTable.observedAt),
            desc(GradeEvidenceTable.id),
          )
          .limit(maxSourceRows + 1)
          .all()
      : [];
  const boundedRead =
    coursesSnapshot.courses.length > maxSourceRows ||
    courseRows.length > maxSourceRows ||
    assignmentRows.length > maxSourceRows ||
    announcementRows.length > maxSourceRows ||
    contextRows.length > maxSourceRows ||
    materials.length > maxSourceRows ||
    learningConceptRows.length > maxSourceRows ||
    observationRows.length > maxSourceRows ||
    memoryRows.length > maxSourceRows ||
    rawGradeEvidence.length > maxSourceRows;
  const gradeEvidence: RecommendationGradeEvidence[] = rawGradeEvidence.flatMap(
    (row) => {
      const course = courseById.get(row.courseId);
      const connection = connectionById.get(row.connectionId);
      if (
        row.revokedAt ||
        row.consentRevision !== gradeSettings.revision ||
        !visibleCourseIdSet.has(row.courseId) ||
        !isCurrentGradeEvidenceForCourse({
          evidence: row,
          course,
          connection,
          workspaceVerifiedAt: onboardingState.workspace?.verifiedAt ?? null,
          academicConsent: onboardingState.settings.consent,
        })
      )
        return [];
      const assignment = assignmentByIdentity.get(row.assignmentIdentity);
      if (
        !assignment ||
        !isGradeEvidenceCurrentForAssignment({
          observedAt: row.observedAt,
          lastSeenAt: assignment.item.lastSeenAt,
          contentChangedAt: assignment.item.contentChangedAt ?? null,
        })
      )
        return [];
      const grade = observedGradeSchema.safeParse(row.grade);
      if (!grade.success) return [];
      const references = sourceReferenceSchema
        .array()
        .safeParse(row.sourceReferences);
      if (!references.success) return [];
      return [
        {
          courseId: row.courseId,
          assignmentId: assignment.item.id,
          completed: row.completed,
          grade: grade.data,
          remainingOpportunity: row.remainingOpportunity,
          conflicts: row.conflicts,
          observedAt: row.observedAt,
          consentRevision: row.consentRevision,
          sourceReferences: [assignment.sourceReference, ...references.data],
        },
      ];
    },
  );
  const recommendationAssignments: RecommendationAssignment[] = assignments.map(
    ({ courseName, kind, state, item, sourceReference }) => ({
      courseName,
      kind,
      state,
      item: {
        resourceId: item.id,
        courseId: item.courseId,
        title: item.title,
        date: academicDateFor(item),
        sourceReference,
      },
    }),
  );
  const recommendationConcepts: RecommendationConcept[] = learningConcepts.map(
    (concept) => ({
      id: concept.id,
      courseId: concept.courseId,
      label: concept.label,
      sourceReferences: toSourceReferences(concept.sourceReferences),
    }),
  );
  const recommendationObservations: RecommendationObservation[] =
    observations.flatMap((observation) => {
      const concept = recommendationConcepts.find(
        ({ id }) => id === observation.conceptId,
      );
      if (!concept) return [];
      const summary =
        typeof observation.evidenceSummary === 'string'
          ? observation.evidenceSummary
          : observation.responseOutcome === 'difficulty'
            ? 'Practice difficulty recorded.'
            : 'Learning observation recorded.';
      return [
        {
          id: observation.id,
          courseId: observation.courseId,
          conceptId: observation.conceptId,
          outcome: observation.responseOutcome,
          assisted: observation.assisted,
          independentEvidence: observation.independentEvidence,
          summary,
          createdAt: observation.createdAt,
          sourceReferences: concept.sourceReferences,
        },
      ];
    });
  const recentSessions = readRecentSessions(context.userId);
  const revision = createTodayInputsRevision({
    settings: {
      consent: onboardingState.settings.consent,
      gradeEnabled: gradeSettings.enabled,
      gradeRevision: gradeSettings.revision,
      learningRevision: settings?.productPreferences.learning.revision ?? 0,
    },
    connections: onboardingState.connections
      .filter((connection) => connection.isCourseResource)
      .map(({ id, status, verifiedAt, isCourseResource }) => ({
        id,
        status,
        verifiedAt,
        isCourseResource,
      })),
    workspace: onboardingState.workspace
      ? {
          ready: onboardingState.workspace.ready,
          verifiedAt: onboardingState.workspace.verifiedAt,
        }
      : null,
    courses: visibleCourses.map((course) => ({
      id: course.id,
      active: course.active,
      sourceState: course.sourceState,
      connectionId: course.connectionId,
      lastSeenAt: course.lastSeenAt,
      contentChangedAt: course.contentChangedAt,
      overviewSyncedAt: course.overviewSyncedAt,
      assignmentsStatus: course.assignmentsStatus,
      announcementsStatus: course.announcementsStatus,
    })),
    courseSources: coursesSnapshot.sources.map((source) => ({
      connectionId: source.connectionId,
      outcome: source.outcome,
      lastAttemptedAt: source.lastAttemptedAt,
      lastSuccessfulAt: source.lastSuccessfulAt,
    })),
    assignments: assignmentRows.map((row) => ({
      id: row.id,
      sourceKey: row.sourceKey,
      lastSeenAt: row.lastSeenAt,
      contentChangedAt: row.contentChangedAt,
      localEditedAt: row.localEditedAt,
      active: row.active,
      state: row.content?.state ?? 'unknown',
    })),
    announcements: announcementRows.map((row) => ({
      id: row.id,
      lastSeenAt: row.lastSeenAt,
      contentChangedAt: row.contentChangedAt,
      localEditedAt: row.localEditedAt,
      active: row.active,
    })),
    materials: materials.map((material) => ({
      id: material.id,
      version: material.currentUsableVersion,
      status: material.extractionStatus,
      retrievedAt: material.retrievedAt,
      verifiedAt: material.verifiedAt,
      contentChangedAt: material.contentChangedAt,
    })),
    sessions: recentSessions.map((session) => ({
      id: session.id,
      revision: session.revision,
      updatedAt: session.updatedAt,
      lastOpenedAt: session.lastOpenedAt,
      status: session.status,
    })),
    context: contextRows.map((row) => ({
      id: row.id,
      revision: row.revision,
      currentVersionId: row.currentVersionId,
      status: row.status,
      updatedAt: row.updatedAt,
    })),
    concepts: learningConcepts.map(({ id, revision, updatedAt }) => ({
      id,
      revision,
      updatedAt,
    })),
    observations: observations.map(
      ({
        id,
        attemptId,
        responseOutcome,
        assisted,
        independentEvidence,
        createdAt,
        revokedAt,
      }) => ({
        id,
        attemptId,
        responseOutcome,
        assisted,
        independentEvidence,
        createdAt,
        revokedAt,
      }),
    ),
    memories: personalMemories.map(
      ({ id, revision, updatedAt, type, courseId }) => ({
        id,
        revision,
        updatedAt,
        type,
        courseId,
      }),
    ),
    grades: rawGradeEvidence.map(
      ({
        id,
        sourceVersion,
        observedAt,
        consentRevision,
        completed,
        grade,
        remainingOpportunity,
        revokedAt,
      }) => ({
        id,
        sourceVersion,
        observedAt,
        consentRevision,
        completed,
        grade,
        remainingOpportunity,
        revokedAt,
      }),
    ),
    watch: pendingWatchCounts,
    coverage: {
      courseLimitReached: coursesSnapshot.courses.length > maxSourceRows,
      assignmentLimitReached: assignmentRows.length > maxSourceRows,
      announcementLimitReached: announcementRows.length > maxSourceRows,
      contextLimitReached: contextRows.length > maxSourceRows,
      materialLimitReached: materials.length > maxSourceRows,
      conceptLimitReached: learningConceptRows.length > maxSourceRows,
      observationLimitReached: observationRows.length > maxSourceRows,
      memoryLimitReached: memoryRows.length > maxSourceRows,
      gradeLimitReached: rawGradeEvidence.length > maxSourceRows,
    },
  });
  const progress = buildLearningProgress({
    concepts: learningConcepts,
    observations,
    revision: createTodayInputsRevision({
      concepts: learningConcepts.map(({ id, revision, updatedAt }) => ({
        id,
        revision,
        updatedAt,
      })),
      observations: observations.map(
        ({
          id,
          responseOutcome,
          assisted,
          independentEvidence,
          createdAt,
        }) => ({
          id,
          responseOutcome,
          assisted,
          independentEvidence,
          createdAt,
        }),
      ),
    }),
  });
  const recommendationMemory: MemoryDTO[] = personalMemories.filter(
    (memory) =>
      memory.type === 'explicit-preference' &&
      memory.provenance === 'student-explicit',
  );
  const recommendations = buildStudyRecommendations({
    assignments: recommendationAssignments,
    concepts: recommendationConcepts,
    observations: recommendationObservations,
    gradeEvidence,
    gradeSettings,
    preferences: recommendationMemory,
    inputsRevision: revision,
    now,
    limit: 5,
  });
  const recentMaterials = materials
    .filter((material) => material.currentUsableVersion !== null)
    .flatMap((material) => {
      const course = courseById.get(material.courseId);
      if (!course || course.sourceState !== 'connected') return [];
      return [
        currentReference({
          sourceKind: 'course-material',
          sourceId: material.id,
          versionId: material.currentUsableVersion,
          courseId: material.courseId,
          locator: null,
          title: material.title,
          provenance: 'connected-source',
          observedAt: material.retrievedAt ?? material.verifiedAt,
          state: 'current',
        }),
      ];
    });
  const currentAttention = attentionForState({
    state: onboardingState,
    refreshing: Boolean(coursesSnapshot.refreshing),
    indexing: contextPending,
    contextNeedsAttention,
    hasPartialSources: sourcePartial,
    pendingWatchCount: watchPendingCount,
  });
  const attention = boundedRead
    ? [
        ...currentAttention.slice(0, 9),
        {
          kind: 'sync' as const,
          code: 'overview-bounded',
          label:
            'Today is showing a bounded selection of saved class and learning records.',
          route: { kind: 'today' as const },
        },
      ]
    : currentAttention;
  return {
    attention,
    freshness: courseFreshness,
    assignments,
    announcements,
    recentCourses,
    recentMaterials,
    recentSessions,
    progress,
    recommendations,
    revision,
  };
};

export const projectTodayOverview = (
  input: TodayProjectionInput,
  limit: number,
): TodayOverview => {
  const visibleLimit = Math.max(
    1,
    Math.min(maxOverviewLimit, Math.floor(limit)),
  );
  const assignmentReferences = new Map(
    input.assignments.map(({ item, sourceReference }) => [
      item.id,
      sourceReference,
    ]),
  );
  const assignmentItems = sortAssignments(
    input.assignments
      .filter(({ state }) => state === 'active-unsubmitted')
      .map(({ item }) => item),
  );
  const upcoming = assignmentItems.slice(0, visibleLimit).map((item) => ({
    resourceId: item.id,
    courseId: item.courseId,
    title: item.title,
    date: academicDateFor(item),
    sourceReference: assignmentReferences.get(item.id)!,
  }));
  const announcementReferences = new Map(
    input.announcements.map(({ item, sourceReference }) => [
      item.id,
      sourceReference,
    ]),
  );
  const announcementItems = sortAnnouncements(
    input.announcements.map(({ item }) => item),
  );
  const courseNames = new Map(
    input.recentCourses.map((course) => [course.id, course.name]),
  );
  for (const announcement of input.announcements)
    if (announcement.courseName)
      courseNames.set(announcement.courseId, announcement.courseName);
  const announcements: AnnouncementSummary[] = announcementItems
    .flatMap((item) => {
      const content = formatTodayAnnouncementContent(item.title, item.body);
      if (!content) return [];
      const date = academicDateFor(item);
      return [
        {
          id: item.id,
          courseId: item.courseId,
          courseName: courseNames.get(item.courseId),
          ...content,
          publishedAt: date?.kind === 'instant' ? date.instant : null,
          sourceReference: announcementReferences.get(item.id)!,
        },
      ];
    })
    .slice(0, Math.min(visibleLimit, 10));
  return todayOverviewSchema.parse({
    attention: input.attention.slice(0, 10),
    freshness: input.freshness.slice(0, maxOverviewLimit).map((item) => {
      const courseName = courseNames.get(item.courseId) ?? item.courseName;
      return courseName ? { ...item, courseName } : item;
    }),
    upcoming,
    announcements,
    recentCourses: [...input.recentCourses]
      .sort((first, second) =>
        second.lastSeenAt.localeCompare(first.lastSeenAt),
      )
      .slice(0, Math.min(visibleLimit, 10)),
    recentMaterials: input.recentMaterials.slice(0, Math.min(visibleLimit, 10)),
    recentSessions: [...input.recentSessions]
      .sort((first, second) =>
        second.lastOpenedAt.localeCompare(first.lastOpenedAt),
      )
      .slice(0, Math.min(visibleLimit, maxRecentSessions)),
    progress: input.progress,
    recommendations: input.recommendations.slice(0, 5),
    revision: input.revision,
  });
};

const readTodayOverview = (
  reader: TodayProjectionReader,
  context: AuthorizedContext,
  input: unknown,
): TodayOverview | null => {
  try {
    const parsedInput = overviewInputSchema.safeParse(input);
    if (!parsedInput.success || !context.isCurrent() || context.signal.aborted)
      return null;
    const now = new Date().toISOString();
    const projection = reader(context, now);
    if (!projection || !context.isCurrent() || context.signal.aborted)
      return null;
    return projectTodayOverview(projection, parsedInput.data.limit ?? 10);
  } catch {
    return null;
  }
};

export const createTodayOverviewReader =
  (reader: TodayProjectionReader) =>
  (context: AuthorizedContext, input: unknown): TodayOverview | null =>
    readTodayOverview(reader, context, input);

export const getTodayOverview = createTodayOverviewReader(readTodayProjection);

export const getStudyRecommendations = (
  context: AuthorizedContext,
  input: unknown,
): Recommendation[] | null => {
  const parsedInput = recommendationsInputSchema.safeParse(input);
  if (!parsedInput.success) return null;
  const overview = getTodayOverview(context, { limit: 20 });
  if (!overview) return null;
  return overview.recommendations.slice(0, parsedInput.data.limit ?? 5);
};
