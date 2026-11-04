import { createHash } from 'node:crypto';
import type { AssignmentKind } from '@scholaros/services/ai/resources/assignment';
import type { AssignmentState } from '@scholaros/services/ai/resources/shared';
import type {
  MemoryDTO,
  PreferenceContent,
} from '@scholaros/services/learning/memory-contracts';
import type {
  EvidenceTriState,
  ObservedGrade,
} from '@scholaros/services/learning/grade-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import type {
  Recommendation,
  UpcomingItem,
} from '@scholaros/services/learning/today-contracts';
import { sortAssignments } from '../../courses/lib/formatters';
import { dateValueFrom } from '../../courses/lib/dates';

export type RecommendationAssignment = {
  courseName: string;
  kind: AssignmentKind;
  state: AssignmentState;
  item: UpcomingItem;
};

export type RecommendationConcept = {
  id: string;
  courseId: string;
  label: string;
  sourceReferences: SourceReference[];
};

export type RecommendationObservation = {
  id: string;
  courseId: string;
  conceptId: string | null;
  outcome:
    | 'independent-success'
    | 'assisted-success'
    | 'difficulty'
    | 'uncertain';
  assisted: boolean;
  independentEvidence: boolean;
  summary: string;
  createdAt: string;
  sourceReferences: SourceReference[];
};

export type RecommendationGradeEvidence = {
  courseId: string;
  assignmentId: string;
  completed: EvidenceTriState;
  grade: ObservedGrade | null;
  remainingOpportunity: EvidenceTriState;
  conflicts: unknown;
  observedAt: string | null;
  consentRevision: number;
  sourceReferences: SourceReference[];
};

export type StudyRecommendationInput = {
  assignments: RecommendationAssignment[];
  concepts: RecommendationConcept[];
  observations: RecommendationObservation[];
  gradeEvidence: RecommendationGradeEvidence[];
  gradeSettings: { enabled: boolean; revision: number };
  preferences: MemoryDTO[];
  inputsRevision: number;
  now: string;
  limit: number;
};

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const createTodayInputsRevision = (inputs: unknown) =>
  Number.parseInt(
    createHash('sha256')
      .update(canonicalize(inputs))
      .digest('hex')
      .slice(0, 12),
    16,
  );

const sourceReferenceKey = (reference: SourceReference) =>
  `${reference.sourceKind}:${reference.sourceId}:${reference.versionId ?? ''}`;

const currentReferences = (references: SourceReference[]) => {
  const seen = new Set<string>();
  return references.filter((reference) => {
    if (reference.state !== 'current' || reference.courseId === null)
      return false;
    const key = sourceReferenceKey(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const preferenceContentOf = (memory: MemoryDTO): PreferenceContent | null =>
  memory.type === 'explicit-preference' &&
  memory.provenance === 'student-explicit' &&
  'field' in memory.content
    ? memory.content
    : null;

const preferenceSuffix = (preferences: MemoryDTO[], courseId: string) => {
  const hasPreference = (memory: MemoryDTO) =>
    Boolean(preferenceContentOf(memory));
  const preference =
    preferences.find(
      (memory) => memory.courseId === courseId && hasPreference(memory),
    ) ??
    preferences.find(
      (memory) => memory.courseId === null && hasPreference(memory),
    );
  const content = preference ? preferenceContentOf(preference) : null;
  const value = content?.value.trim().slice(0, 140);
  return value
    ? ` Your saved preference for ${value} will guide this session.`
    : '';
};

const gradeShowsReviewOpportunity = (grade: ObservedGrade | null) => {
  if (!grade) return false;
  switch (grade.scale) {
    case 'points':
      return grade.possible !== null && grade.earned < grade.possible;
    case 'percentage':
      return grade.earned < 100;
    case 'pass-fail':
      return grade.value === 'fail';
    case 'letter':
    case 'other':
      return false;
  }
};

const assignmentDatePhrase = (
  assignment: RecommendationAssignment,
  now: string,
) => {
  const date = assignment.item.date;
  if (!date) return 'No date was established for this course item.';
  switch (date.kind) {
    case 'instant':
      return Date.parse(date.instant) < Date.parse(now)
        ? `Its exact due time passed on ${date.original}.`
        : `It is due ${date.original}.`;
    case 'date':
      return `The source lists ${date.original} as a date only.`;
    case 'local':
      return `The source lists ${date.original}, but its timezone is not established.`;
    case 'unresolved':
      return `The source date is not established: ${date.original}.`;
  }
};

const recommendationId = (
  inputsRevision: number,
  courseId: string,
  activity: Recommendation['activity'],
  target: string,
) =>
  `today-${createHash('sha256')
    .update(`${inputsRevision}:${courseId}:${activity}:${target}`)
    .digest('hex')
    .slice(0, 24)}`;

const makeRecommendation = ({
  courseId,
  activity,
  targetAssignmentId,
  topic,
  reason,
  sourceReferences,
  inputsRevision,
}: Omit<Recommendation, 'id'>): Recommendation | null => {
  const references = currentReferences(sourceReferences);
  if (!references.length) return null;
  const target = targetAssignmentId ?? topic ?? references[0]!.sourceId;
  return {
    id: recommendationId(inputsRevision, courseId, activity, target),
    courseId,
    activity,
    targetAssignmentId,
    topic,
    reason: reason.slice(0, 500),
    sourceReferences: references.slice(0, 20),
    inputsRevision,
  };
};

export const buildStudyRecommendations = ({
  assignments,
  concepts,
  observations,
  gradeEvidence,
  gradeSettings,
  preferences,
  inputsRevision,
  now,
  limit,
}: StudyRecommendationInput): Recommendation[] => {
  const assignmentById = new Map(
    assignments.map((candidate) => [candidate.item.resourceId, candidate]),
  );
  const orderedAssignmentIds = sortAssignments(
    assignments
      .filter(
        ({ kind, state }) =>
          state === 'active-unsubmitted' &&
          (kind === 'exam' || kind === 'assignment' || kind === 'discussion'),
      )
      .map(({ item }) => ({
        id: item.resourceId,
        title: item.title,
        body: null,
        dateValue: dateValueFrom(item.date),
        dateText: item.date?.original ?? null,
        url: '',
        content: null,
      })),
  );
  const recommendations: Recommendation[] = [];
  const seen = new Set<string>();

  const add = (recommendation: Recommendation | null) => {
    if (!recommendation) return;
    const key = `${recommendation.courseId}:${recommendation.activity}:${recommendation.targetAssignmentId ?? recommendation.topic ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    recommendations.push(recommendation);
  };

  for (const ordered of orderedAssignmentIds) {
    const candidate = assignmentById.get(ordered.id);
    if (!candidate) continue;
    const { item, courseName, kind } = candidate;
    const activity = kind === 'exam' ? 'prepare-exam' : 'assignment-start';
    const reason = `${courseName}: ${item.title}. ${assignmentDatePhrase(candidate, now)}${preferenceSuffix(preferences, item.courseId)}`;
    add(
      makeRecommendation({
        courseId: item.courseId,
        activity,
        targetAssignmentId: item.resourceId,
        topic: null,
        reason,
        sourceReferences: [item.sourceReference],
        inputsRevision,
      }),
    );
  }

  if (gradeSettings.enabled) {
    const orderedGrades = [...gradeEvidence].sort((first, second) =>
      (second.observedAt ?? '').localeCompare(first.observedAt ?? ''),
    );
    for (const evidence of orderedGrades) {
      const observedAt = evidence.observedAt
        ? Date.parse(evidence.observedAt)
        : NaN;
      if (
        evidence.completed !== 'yes' ||
        !gradeShowsReviewOpportunity(evidence.grade) ||
        evidence.remainingOpportunity !== 'no' ||
        evidence.consentRevision !== gradeSettings.revision ||
        !Array.isArray(evidence.conflicts) ||
        evidence.conflicts.length > 0 ||
        !Number.isFinite(observedAt) ||
        observedAt > Date.parse(now) ||
        Date.parse(now) - observedAt > 15 * 60 * 1000
      )
        continue;
      add(
        makeRecommendation({
          courseId: evidence.courseId,
          activity: 'review-graded-mistakes',
          targetAssignmentId: evidence.assignmentId,
          topic: null,
          reason: `Your completed assessment has a grade below its recorded maximum; a review session may help.${preferenceSuffix(preferences, evidence.courseId)}`,
          sourceReferences: evidence.sourceReferences,
          inputsRevision,
        }),
      );
    }
  }

  const conceptsById = new Map(
    concepts.map((concept) => [concept.id, concept]),
  );
  const recentDifficulties = [...observations]
    .filter((observation) => observation.outcome === 'difficulty')
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  for (const observation of recentDifficulties) {
    if (!observation.conceptId) continue;
    const concept = conceptsById.get(observation.conceptId);
    if (!concept || concept.courseId !== observation.courseId) continue;
    add(
      makeRecommendation({
        courseId: concept.courseId,
        activity: 'understand-topic',
        targetAssignmentId: null,
        topic: concept.label,
        reason: `A recent practice response showed difficulty with ${concept.label}.${preferenceSuffix(preferences, concept.courseId)}`,
        sourceReferences: [
          ...observation.sourceReferences,
          ...concept.sourceReferences,
        ],
        inputsRevision,
      }),
    );
  }

  return recommendations.slice(0, Math.max(0, Math.min(5, limit)));
};
