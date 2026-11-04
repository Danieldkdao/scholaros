import { describe, expect, it } from 'vitest';
import type { AcademicDateSchema } from '@scholaros/services/ai/resources/shared';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import {
  buildStudyRecommendations,
  createTodayInputsRevision,
} from '../services/recommendations';

const assignmentReference = (
  sourceId: string,
  courseId = 'biology',
): SourceReference => ({
  sourceKind: 'assignment',
  sourceId,
  versionId: null,
  courseId,
  locator: null,
  title: 'Biology assessment',
  provenance: 'connected-source',
  observedAt: '2026-11-03T12:00:00Z',
  state: 'current',
});

const assignment = ({
  id,
  date,
  kind = 'assignment',
  courseId = 'biology',
}: {
  id: string;
  date: AcademicDateSchema | null;
  kind?: 'assignment' | 'exam' | 'quiz' | 'discussion' | 'unknown';
  courseId?: string;
}) => ({
  courseName: courseId === 'physics' ? 'Physics' : 'Biology',
  kind,
  state: 'active-unsubmitted' as const,
  item: {
    resourceId: id,
    courseId,
    title: id,
    date,
    sourceReference: assignmentReference(id, courseId),
  },
});

const createRecommendations = (
  overrides: Partial<Parameters<typeof buildStudyRecommendations>[0]> = {},
) =>
  buildStudyRecommendations({
    assignments: [],
    concepts: [],
    observations: [],
    gradeEvidence: [],
    gradeSettings: { enabled: false, revision: 0 },
    preferences: [],
    inputsRevision: 9,
    now: '2026-11-03T12:00:00Z',
    limit: 5,
    ...overrides,
  });

describe('buildStudyRecommendations', () => {
  it('does not infer a weak topic without an actual learning observation', () => {
    expect(
      createRecommendations({
        concepts: [
          {
            id: 'concept-1',
            courseId: 'biology',
            label: 'Cell division',
            sourceReferences: [],
          },
        ],
      }),
    ).toEqual([]);
  });

  it('orders recommendations by the existing rich academic date precision', () => {
    const recommendations = createRecommendations({
      assignments: [
        assignment({
          id: 'timed-later',
          date: {
            kind: 'instant',
            instant: '2026-11-08T15:00:00Z',
            timezone: 'UTC',
            original: 'November 8 at 3 PM UTC',
          },
        }),
        assignment({
          id: 'date-only',
          date: {
            kind: 'date',
            date: '2026-11-08',
            original: 'November 8',
          },
        }),
        assignment({
          id: 'timed-sooner',
          date: {
            kind: 'instant',
            instant: '2026-11-05T15:00:00Z',
            timezone: 'UTC',
            original: 'November 5 at 3 PM UTC',
          },
        }),
      ],
    });

    expect(
      recommendations.map(({ targetAssignmentId }) => targetAssignmentId),
    ).toEqual(['timed-sooner', 'date-only', 'timed-later']);
  });

  it('keeps unresolved and local dates explicit without inventing timed urgency', () => {
    const recommendations = createRecommendations({
      assignments: [
        assignment({
          id: 'unresolved',
          date: {
            kind: 'unresolved',
            original: 'after the next lecture',
            reason: 'The source does not establish a calendar date.',
          },
        }),
        assignment({
          id: 'local',
          date: {
            kind: 'local',
            date: '2026-11-04',
            time: '09:00',
            original: 'November 4 at 9 AM',
          },
        }),
      ],
    });

    expect(recommendations).toHaveLength(2);
    expect(recommendations[0]?.reason).toContain('timezone');
    expect(recommendations[1]?.reason).toContain('not established');
    expect(
      recommendations.every(
        ({ reason }) => !/overdue|due in|tomorrow/i.test(reason),
      ),
    ).toBe(true);
  });

  it('uses actual assignment kind and carries the matching source reference', () => {
    const [recommendation] = createRecommendations({
      assignments: [
        assignment({
          id: 'biology-exam',
          kind: 'exam',
          date: {
            kind: 'date',
            date: '2026-11-08',
            original: 'November 8',
          },
        }),
      ],
    });

    expect(recommendation).toMatchObject({
      activity: 'prepare-exam',
      courseId: 'biology',
      targetAssignmentId: 'biology-exam',
      sourceReferences: [assignmentReference('biology-exam')],
      inputsRevision: 9,
    });
  });

  it('uses stored graded evidence only while current grade consent is enabled', () => {
    const gradeEvidence = {
      courseId: 'biology',
      assignmentId: 'graded-assignment',
      completed: 'yes' as const,
      grade: { scale: 'points' as const, earned: 7, possible: 10 },
      remainingOpportunity: 'no' as const,
      conflicts: [],
      observedAt: '2026-11-03T11:55:00Z',
      consentRevision: 2,
      sourceReferences: [
        {
          ...assignmentReference('graded-assignment'),
          sourceKind: 'grade-evidence' as const,
          title: 'Recorded grade',
        },
      ],
    };

    expect(
      createRecommendations({
        gradeEvidence: [gradeEvidence],
        gradeSettings: { enabled: false, revision: 2 },
      }),
    ).toEqual([]);

    expect(
      createRecommendations({
        gradeEvidence: [gradeEvidence],
        gradeSettings: { enabled: true, revision: 2 },
      })[0],
    ).toMatchObject({
      activity: 'review-graded-mistakes',
      targetAssignmentId: 'graded-assignment',
      sourceReferences: gradeEvidence.sourceReferences,
    });

    expect(
      createRecommendations({
        gradeEvidence: [gradeEvidence],
        gradeSettings: { enabled: true, revision: 3 },
      }),
    ).toEqual([]);
    expect(
      createRecommendations({
        gradeEvidence: [{ ...gradeEvidence, remainingOpportunity: 'yes' }],
        gradeSettings: { enabled: true, revision: 2 },
      }),
    ).toEqual([]);
  });

  it('uses saved preferences, stays deterministic, and returns at most five items', () => {
    const input = {
      assignments: Array.from({ length: 7 }, (_, index) =>
        assignment({
          id: `assignment-${index}`,
          date: {
            kind: 'date' as const,
            date: `2026-11-${String(5 + index).padStart(2, '0')}`,
            original: `November ${5 + index}`,
          },
        }),
      ),
      preferences: [
        {
          id: 'preference-1',
          courseId: null,
          type: 'explicit-preference' as const,
          content: {
            field: 'example-style' as const,
            value: 'worked examples',
          },
          provenance: 'student-explicit' as const,
          evidenceIds: [],
          confidence: null,
          revision: 2,
          createdAt: '2026-11-01T12:00:00Z',
          updatedAt: '2026-11-03T11:00:00Z',
        },
      ],
    };

    const first = createRecommendations(input);
    const second = createRecommendations(input);

    expect(first).toHaveLength(5);
    expect(first).toEqual(second);
    expect(
      first.every(({ reason }) => reason.includes('worked examples')),
    ).toBe(true);
  });

  it('keeps course-specific preferences scoped to their course', () => {
    const recommendations = createRecommendations({
      assignments: [
        assignment({
          id: 'biology-assignment',
          courseId: 'biology',
          date: { kind: 'date', date: '2026-11-05', original: 'November 5' },
        }),
        assignment({
          id: 'physics-assignment',
          courseId: 'physics',
          date: { kind: 'date', date: '2026-11-06', original: 'November 6' },
        }),
      ],
      preferences: [
        {
          id: 'physics-preference',
          courseId: 'physics',
          type: 'explicit-preference',
          content: { field: 'example-style', value: 'worked examples' },
          provenance: 'student-explicit',
          evidenceIds: [],
          confidence: null,
          revision: 1,
          createdAt: '2026-11-01T12:00:00Z',
          updatedAt: '2026-11-03T11:00:00Z',
        },
      ],
    });
    const biology = recommendations.find(
      ({ courseId }) => courseId === 'biology',
    );
    const physics = recommendations.find(
      ({ courseId }) => courseId === 'physics',
    );

    expect(biology?.reason).not.toContain('worked examples');
    expect(physics?.reason).toContain('worked examples');
  });

  it('changes the input revision after permission, memory, practice, or sync changes', () => {
    const base = {
      sync: { assignmentsRevision: 2 },
      memory: { id: 'memory-1', revision: 0 },
      practice: { id: 'attempt-1', revision: 1 },
      grades: { enabled: true, revision: 4 },
      connections: [
        {
          id: 'connection-1',
          status: 'verified',
          verifiedAt: '2026-11-03T10:00:00Z',
        },
      ],
      workspace: { ready: true, verifiedAt: '2026-11-03T09:00:00Z' },
    };

    expect(createTodayInputsRevision(base)).toBe(
      createTodayInputsRevision(base),
    );
    expect(createTodayInputsRevision(base)).not.toBe(
      createTodayInputsRevision({
        ...base,
        grades: { enabled: false, revision: 5 },
      }),
    );
    expect(createTodayInputsRevision(base)).not.toBe(
      createTodayInputsRevision({
        ...base,
        memory: { id: 'memory-1', revision: 1 },
      }),
    );
    expect(createTodayInputsRevision(base)).not.toBe(
      createTodayInputsRevision({
        ...base,
        practice: { id: 'attempt-1', revision: 2 },
      }),
    );
    expect(createTodayInputsRevision(base)).not.toBe(
      createTodayInputsRevision({
        ...base,
        sync: { assignmentsRevision: 3 },
      }),
    );
    expect(createTodayInputsRevision(base)).not.toBe(
      createTodayInputsRevision({
        ...base,
        connections: [{ ...base.connections[0], status: 'needs-sign-in' }],
      }),
    );
    expect(createTodayInputsRevision(base)).not.toBe(
      createTodayInputsRevision({
        ...base,
        workspace: { ...base.workspace, verifiedAt: '2026-11-03T12:00:00Z' },
      }),
    );
  });
});
