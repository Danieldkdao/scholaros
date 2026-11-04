import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import type { PracticeQuestionDTO } from '@scholaros/services/learning/practice-contracts';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-learning-model-'));
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
    },
  };
});

const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  ArtifactStateTable,
  ConceptTable,
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
} = await import('../../../db/schema');
const {
  deleteMemory,
  listMemories,
  subscribeMemoryChanges,
  upsertExplicitPreference,
} = await import('../services/memory-store');
const {
  buildCourseConcepts,
  getCourseConceptGraph,
  getLearningProgress,
  proposeLearningObservation,
  proposePreferenceInference,
} = await import('../services/learning-model');

const userId = 'learning-student';
const courseId = 'learning-course';
const conceptId = 'concept-cell-energy';
const attemptId = '00000000-0000-4000-8000-000000000101';
const questionId = '00000000-0000-4000-8000-000000000102';
const now = '2026-11-03T12:00:00.000Z';

const makeContext = (): AuthorizedContext => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const insertCourse = () =>
  db
    .insert(CourseTable)
    .values({
      id: courseId,
      userId,
      sourceKey: `manual:${courseId}`,
      sourceName: 'Local',
      sourceHost: 'local.invalid',
      url: 'https://local.invalid/course',
      name: 'Biology',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();

const insertSourceCourse = (id: string) => {
  const connectionId = `${id}-connection`;
  const materialId = `${id}-material`;
  const versionId = `${id}-version`;
  db.insert(AcademicConnectionTable)
    .values({
      id: connectionId,
      userId,
      name: 'Schoology',
      url: 'https://schoology.com/',
      host: 'schoology.com',
      kind: 'resource',
      status: 'verified',
      verifiedAt: now,
      isCourseResource: true,
    })
    .run();
  db.insert(CourseTable)
    .values({
      id,
      userId,
      connectionId,
      sourceKey: `schoology:${id}`,
      sourceName: 'Schoology',
      sourceHost: 'schoology.com',
      externalId: id,
      name: 'Biology',
      url: `https://schoology.com/course/${id}`,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();
  db.insert(CourseMaterialTable)
    .values({
      id: materialId,
      userId,
      connectionId,
      courseId: id,
      sourceIdentity: `https://schoology.com/course/${id}/materials/1`,
      url: `https://schoology.com/course/${id}/materials/1`,
      title: 'Cell biology notes',
      sourceType: 'lecture',
      contentHash: versionId,
      currentUsableVersion: versionId,
      extractionStatus: 'complete',
      completeness: 100,
      summary: null,
      summaryEvidence: [],
      retrievedAt: now,
      verifiedAt: now,
      contentChangedAt: now,
      lastAttemptAt: now,
      active: true,
      suppressionId: null,
      suppressedAt: null,
    })
    .run();
  db.insert(CourseMaterialVersionTable)
    .values({
      materialId,
      contentHash: versionId,
      title: 'Cell biology notes',
      sourceUrl: `https://schoology.com/course/${id}/materials/1`,
      sourceType: 'lecture',
      extractionStatus: 'complete',
      completeness: 100,
      summary: null,
      summaryEvidence: [],
      retrievedAt: now,
      verifiedAt: now,
      contentChangedAt: now,
    })
    .run();
  return { courseId: id, materialId, versionId };
};

const sourceReferenceFor = (source: {
  courseId: string;
  materialId: string;
  versionId: string;
}) => ({
  sourceKind: 'course-material' as const,
  sourceId: source.materialId,
  versionId: source.versionId,
  courseId: source.courseId,
  locator: { kind: 'page' as const, page: 1 },
  title: 'Cell biology notes',
  provenance: 'connected-source' as const,
  observedAt: now,
  state: 'current' as const,
});

const insertConcept = (id: string, label: string) =>
  db
    .insert(ConceptTable)
    .values({
      id,
      userId,
      courseId,
      label,
      normalizedLabel: label.toLocaleLowerCase('en-US'),
      description: `${label} in this course.`,
      sourceReferences: [],
      uncertainty: 'Concept identity is unverified.',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

const question: PracticeQuestionDTO = {
  id: questionId,
  kind: 'short-explanation',
  prompt: 'Explain the role of mitochondria.',
  options: null,
  unit: null,
  objectiveIds: [conceptId],
  sourceReferences: [],
};

const insertAttempt = (input: {
  assisted: boolean;
  outcome: 'correct' | 'incorrect' | 'uncertain';
  answerAssisted?: boolean;
  sourceReferences?: SourceReference[];
}) => {
  db.insert(PracticeAttemptTable)
    .values({
      id: attemptId,
      userId,
      courseId,
      sessionId: null,
      artifactId: null,
      versionId: 'practice-version',
      objectiveIds: [conceptId],
      mode: input.assisted ? 'guided' : 'quiz',
      feedbackMode: 'end',
      status: 'evaluated',
      assisted: input.assisted,
      priorAttemptId: null,
      rubricVersion: 'rubric-v1',
      questionSet: [question],
      hostAnswerKey: { storedByHost: true },
      revision: 1,
      startedAt: now,
      submittedAt: now,
    })
    .run();
  db.insert(PracticeAnswerTable)
    .values({
      id: 'practice-answer',
      userId,
      attemptId,
      questionId,
      revision: 1,
      answer: 'Student answer text must not be copied into memory.',
      assisted: input.answerAssisted ?? input.assisted,
      evaluation: {
        questionId,
        outcome: input.outcome,
        explanation: 'Host-validated evaluation summary.',
        acceptedAlternatives: [],
        sourceReferences: input.sourceReferences ?? [],
        rubricVersion: 'rubric-v1',
        assisted: input.assisted || (input.answerAssisted ?? false),
      },
      createdAt: now,
    })
    .run();
};

const insertStudyEvidence = () => {
  const sessionId = 'preference-inference-session';
  const turnId = 'preference-inference-turn';
  const startedAt = '2026-10-01T10:00:00.000Z';
  db.insert(StudySessionTable)
    .values({
      id: sessionId,
      userId,
      courseId,
      title: 'Biology review',
      activity: 'understand-topic',
      status: 'finished',
      revision: 1,
      generationEpoch: 1,
      draftText: '',
      draftRevision: 0,
      deadlineAt: null,
      timerRevision: 0,
      expiredRevision: null,
      resolvedExpiredRevision: null,
      finishedAt: '2026-10-01T10:05:00.000Z',
      deletedAt: null,
      createdAt: startedAt,
      updatedAt: '2026-10-01T10:05:00.000Z',
      lastOpenedAt: '2026-10-01T10:05:00.000Z',
    })
    .run();
  db.insert(StudyTurnTable)
    .values({
      id: turnId,
      userId,
      sessionId,
      requestId: 'preference-inference-request',
      payloadHash: 'test-payload-hash',
      generationEpoch: 1,
      status: 'complete',
      attemptNumber: 1,
      policyRevision: 1,
      contextRevision: 1,
      errorCode: null,
      startedAt,
      settledAt: '2026-10-01T10:01:00.000Z',
    })
    .run();
  return turnId;
};

beforeEach(() => {
  db.delete(StudyTurnTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseMaterialVersionTable).run();
  db.delete(CourseMaterialTable).run();
  db.delete(AcademicConnectionTable).run();
  db.delete(MemoryTable).run();
  db.delete(LearningObservationTable).run();
  db.delete(PracticeAnswerTable).run();
  db.delete(PracticeAttemptTable).run();
  db.delete(ConceptTable).run();
  db.delete(GradeEvidenceTable).run();
  db.delete(ArtifactStateTable).run();
  db.delete(CourseTable).run();
});

describe('learning model', () => {
  it('keeps confidence-bearing preference inference provisional and fences old evidence after explicit deletion', () => {
    insertCourse();
    const context = makeContext();
    const evidenceId = insertStudyEvidence();
    const input = {
      preference: { field: 'example-style' as const, value: 'worked examples' },
      evidenceIds: [evidenceId],
      confidence: 0.72,
    };

    const changes: number[] = [];
    const unsubscribe = subscribeMemoryChanges(({ revision }) =>
      changes.push(revision),
    );
    let inferredPreference: ReturnType<typeof proposePreferenceInference>;
    try {
      inferredPreference = proposePreferenceInference(context, input);
      expect(proposePreferenceInference(context, input)).toEqual(
        inferredPreference,
      );
      expect(changes).toEqual([1]);
    } finally {
      unsubscribe();
    }
    expect(inferredPreference).toMatchObject({
      type: 'provisional-preference',
      provenance: 'meta-inferred',
      content: input.preference,
      evidenceIds: [evidenceId],
      confidence: 0.72,
      revision: 1,
    });

    const explicitPreference = upsertExplicitPreference(context, {
      requestId: '00000000-0000-4000-8000-000000000111',
      preference: { field: 'example-style', value: 'short analogies' },
    });
    expect(
      proposePreferenceInference(context, {
        ...input,
        preference: { field: 'example-style', value: 'long examples' },
      }),
    ).toBeNull();
    deleteMemory(context, {
      memoryId: explicitPreference.id,
      expectedRevision: explicitPreference.revision,
    });

    expect(proposePreferenceInference(context, input)).toBeNull();
    expect(listMemories(context, { limit: 10 })?.items).toEqual([]);
  });

  it('uses account revisions to break equal-timestamp evidence ties', () => {
    insertCourse();
    insertConcept(conceptId, 'Cellular energy');
    const observations = [
      {
        id: 'z-older-observation',
        outcome: 'independent-success' as const,
        revision: 1,
        independentEvidence: true,
      },
      {
        id: 'a-newer-observation',
        outcome: 'difficulty' as const,
        revision: 2,
        independentEvidence: false,
      },
    ];
    for (const observation of observations) {
      const evidence = {
        attemptId: `attempt-${observation.id}`,
        questionId: `question-${observation.id}`,
        answerRevision: 1,
        objectiveId: conceptId,
        sourceReferences: [],
        assisted: false,
        outcome: observation.outcome,
        confidence: null,
      };
      db.insert(LearningObservationTable)
        .values({
          id: observation.id,
          userId,
          courseId,
          conceptId,
          attemptId: evidence.attemptId,
          sourceSessionId: null,
          kind: 'practice-response',
          responseOutcome: observation.outcome,
          assisted: false,
          independentEvidence: observation.independentEvidence,
          confidence: null,
          evidenceSummary: evidence,
          createdAt: now,
          revokedAt: null,
        })
        .run();
      db.insert(MemoryTable)
        .values({
          id: observation.id,
          userId,
          courseId,
          type: 'learning-observation',
          content: {
            conceptId,
            outcome: observation.outcome,
            summary: 'Evidence-backed practice observation.',
          },
          provenance: 'practice-evidence',
          evidenceIds: [observation.id],
          confidence: null,
          revision: observation.revision,
          supersedesId: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const progress = getLearningProgress(makeContext(), { courseId });

    expect(progress).toMatchObject({
      strengths: [],
      practiceTopics: [
        expect.objectContaining({ evidenceIds: ['a-newer-observation'] }),
      ],
      unknownCount: 0,
    });
  });

  it('keeps assisted success and student confidence as separate non-mastery evidence', () => {
    insertCourse();
    insertConcept(conceptId, 'Cellular energy');
    insertAttempt({ assisted: true, outcome: 'correct' });

    const context = makeContext();
    const firstObservations = proposeLearningObservation(context, {
      attemptId,
      confidence: 0.9,
    });
    const retriedObservations = proposeLearningObservation(context, {
      attemptId,
      confidence: 0.9,
    });

    expect(retriedObservations).toEqual(firstObservations);
    expect(firstObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'learning-observation',
          content: expect.objectContaining({ outcome: 'assisted-success' }),
          provenance: 'practice-evidence',
        }),
        expect.objectContaining({
          type: 'learning-observation',
          content: expect.objectContaining({ outcome: 'uncertain' }),
          confidence: 0.9,
          provenance: 'practice-evidence',
        }),
      ]),
    );
    expect(db.select().from(LearningObservationTable).all()).toMatchObject([
      expect.objectContaining({
        attemptId,
        kind: 'practice-response',
        responseOutcome: 'assisted-success',
        assisted: true,
        independentEvidence: false,
        confidence: null,
      }),
      expect.objectContaining({
        attemptId,
        kind: 'confidence-check',
        responseOutcome: 'uncertain',
        assisted: false,
        independentEvidence: false,
        confidence: 0.9,
      }),
    ]);
    expect(db.select().from(LearningObservationTable).all()).toHaveLength(2);
    expect(
      db
        .select()
        .from(LearningObservationTable)
        .all()
        .some(({ evidenceSummary }) =>
          JSON.stringify(evidenceSummary).includes('Student answer text'),
        ),
    ).toBe(false);

    const progress = getLearningProgress(context, { courseId });
    expect(progress).toMatchObject({
      courseId,
      strengths: [],
      practiceTopics: [],
      unknownCount: 0,
    });
    expect(progress?.recentChanges).toEqual([
      expect.objectContaining({
        conceptId,
        label: 'Cellular energy',
        assisted: true,
        evidenceIds: expect.any(Array),
      }),
    ]);
  });

  it('keeps source concepts course-scoped and downgrades cyclic prerequisites', () => {
    const source = insertSourceCourse(courseId);
    const sourceReference = sourceReferenceFor(source);
    const context = makeContext();
    const concepts = [
      {
        label: 'Photosynthesis',
        description: 'How plants convert light into chemical energy.',
        uncertainty: 'Concept connection is provisional.',
        sourceReferences: [sourceReference],
      },
      {
        label: 'Chlorophyll',
        description: 'A light-absorbing pigment.',
        uncertainty: 'Concept identity is provisional.',
        sourceReferences: [sourceReference],
      },
    ];
    const sourceLinks = [
      {
        fromLabel: 'Chlorophyll',
        toLabel: 'Photosynthesis',
        relationship: 'prerequisite' as const,
        uncertainty: 'Possible prerequisite relation.',
        sourceReferences: [sourceReference],
      },
      {
        fromLabel: 'Photosynthesis',
        toLabel: 'Chlorophyll',
        relationship: 'prerequisite' as const,
        uncertainty: 'Possible reverse prerequisite relation.',
        sourceReferences: [sourceReference],
      },
      {
        fromLabel: 'Photosynthesis',
        toLabel: 'Photosynthesis',
        relationship: 'prerequisite' as const,
        uncertainty: 'Self relation should be rejected.',
        sourceReferences: [sourceReference],
      },
    ];

    const courseGraph = (() => {
      const graphEvents: number[] = [];
      const unsubscribeGraphChanges = subscribeMemoryChanges(({ revision }) =>
        graphEvents.push(revision),
      );
      try {
        const graph = buildCourseConcepts(context, {
          courseId,
          concepts,
          links: sourceLinks,
        });
        buildCourseConcepts(context, {
          courseId,
          concepts,
          links: sourceLinks,
        });
        expect(graphEvents).toEqual([graph.revision]);
        return graph;
      } finally {
        unsubscribeGraphChanges();
      }
    })();

    expect(courseGraph.concepts.map(({ label }) => label).sort()).toEqual([
      'Chlorophyll',
      'Photosynthesis',
    ]);
    expect(courseGraph.links).toHaveLength(2);
    expect(courseGraph.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relationship: 'prerequisite',
          uncertainty: 'Possible prerequisite relation.',
        }),
        expect.objectContaining({
          relationship: 'related',
          uncertainty: expect.stringContaining('cycle'),
        }),
      ]),
    );
    expect(
      getCourseConceptGraph(context, {
        courseId,
        conceptId: courseGraph.concepts[0]!.id,
        maxDepth: 5,
        maxNodes: 1,
      }),
    ).toMatchObject({ concepts: [expect.any(Object)], truncated: true });

    const otherSource = insertSourceCourse('other-course');
    const otherReference = sourceReferenceFor(otherSource);
    const otherGraph = buildCourseConcepts(context, {
      courseId: otherSource.courseId,
      concepts: [{ ...concepts[0]!, sourceReferences: [otherReference] }],
      links: [],
    });
    expect(otherGraph.concepts[0]?.id).not.toBe(
      courseGraph.concepts.find(({ label }) => label === 'Photosynthesis')?.id,
    );
    expect(() =>
      buildCourseConcepts(context, {
        courseId: otherSource.courseId,
        concepts: [concepts[0]!],
        links: [],
      }),
    ).toThrow('scope-denied');

    db.update(CourseMaterialTable)
      .set({ active: false })
      .where(eq(CourseMaterialTable.id, source.materialId))
      .run();
    const historicalGraph = getCourseConceptGraph(context, {
      courseId,
      conceptId: courseGraph.concepts[0]!.id,
    });
    expect(historicalGraph?.concepts[0]?.sourceReferences[0]?.state).toBe(
      'removed',
    );
  });

  it('does not resurrect a deleted practice observation on retry', () => {
    insertCourse();
    insertConcept(conceptId, 'Cellular energy');
    insertAttempt({ assisted: true, outcome: 'correct' });
    const context = makeContext();
    const savedObservations = proposeLearningObservation(context, {
      attemptId,
      confidence: 0.9,
    });
    const responseMemory = savedObservations.find(
      (memory) =>
        'outcome' in memory.content &&
        memory.content.outcome === 'assisted-success',
    );
    expect(responseMemory).toBeDefined();

    deleteMemory(context, {
      memoryId: responseMemory!.id,
      expectedRevision: responseMemory!.revision,
    });
    const retriedObservations = proposeLearningObservation(context, {
      attemptId,
      confidence: 0.9,
    });

    expect(retriedObservations).toHaveLength(1);
    expect(db.select().from(LearningObservationTable).all()).toMatchObject([
      expect.objectContaining({
        kind: 'practice-response',
        revokedAt: expect.any(String),
        evidenceSummary: { deleted: true },
      }),
      expect.objectContaining({ kind: 'confidence-check', revokedAt: null }),
    ]);
    expect(
      db
        .select()
        .from(MemoryTable)
        .all()
        .filter((memory) => !memory.deletedAt),
    ).toHaveLength(1);
    expect(getLearningProgress(context, { courseId })?.unknownCount).toBe(1);
  });

  it('distinguishes a demonstrated difficulty from an unknown topic and ignores grade or artifact scores', () => {
    insertCourse();
    insertConcept(conceptId, 'Cellular energy');
    insertConcept('concept-cell-structure', 'Cell structure');
    const gradeReference: SourceReference = {
      sourceKind: 'grade-evidence',
      sourceId: 'grade-evidence',
      versionId: 'grade-v1',
      courseId,
      locator: null,
      title: 'Reviewed exam feedback',
      provenance: 'connected-source',
      observedAt: now,
      state: 'current',
    };
    insertAttempt({
      assisted: false,
      outcome: 'incorrect',
      sourceReferences: [gradeReference],
    });
    db.insert(GradeEvidenceTable)
      .values({
        id: 'grade-evidence',
        userId,
        connectionId: 'connection',
        courseId,
        assignmentIdentity: 'exam',
        sourceVersion: 'grade-v1',
        observedAt: now,
        consentRevision: 1,
        completed: 'yes',
        grade: { scale: 'percentage', earned: 100 },
        remainingOpportunity: 'no',
        conflicts: [],
        sourceReferences: [],
        revokedAt: null,
      })
      .run();
    db.insert(ArtifactStateTable)
      .values({
        id: 'artifact-state',
        userId,
        artifactId: 'artifact',
        versionId: 'artifact-version',
        attemptId: 'artifact-attempt',
        stateRevision: 1,
        state: { score: 100 },
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const context = makeContext();
    proposeLearningObservation(context, { attemptId, confidence: 1 });

    const progress = getLearningProgress(context, { courseId });
    expect(progress).toMatchObject({
      courseId,
      strengths: [],
      practiceTopics: [expect.objectContaining({ conceptId })],
      unknownCount: 1,
    });
    expect(progress?.practiceTopics[0]?.evidenceIds).toHaveLength(1);
    expect(progress?.practiceTopics[0]?.sourceReferences).toEqual([
      gradeReference,
    ]);
    expect(progress?.recentChanges[0]?.assisted).toBe(false);

    db.update(GradeEvidenceTable)
      .set({ revokedAt: now })
      .where(eq(GradeEvidenceTable.id, 'grade-evidence'))
      .run();
    const revokedProgress = getLearningProgress(context, { courseId });
    expect(revokedProgress).toMatchObject({
      strengths: [],
      practiceTopics: [
        expect.objectContaining({
          sourceReferences: [expect.objectContaining({ state: 'removed' })],
        }),
      ],
      unknownCount: 1,
    });
  });
});
