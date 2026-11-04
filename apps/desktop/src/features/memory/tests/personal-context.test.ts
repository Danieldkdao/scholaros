import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-personal-context-'));
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
  ConceptLinkTable,
  ConceptTable,
  CourseTable,
  LearningObservationTable,
  MemoryTable,
} = await import('../../../db/schema');
const {
  correctMemory,
  deleteMemory,
  purgeMemoryData,
  upsertExplicitPreference,
} = await import('../services/memory-store');
const { detachLearningEvidenceFromSession } =
  await import('../services/learning-model');
const { preparePersonalContext } = await import('../services/personal-context');

const userId = 'personal-context-student';
const courseA = 'personal-course-a';
const courseB = 'personal-course-b';
const now = '2026-11-03T12:00:00.000Z';
const preferenceRequestId = '00000000-0000-4000-8000-000000000201';

const makeContext = (ownerId = userId): AuthorizedContext => ({
  userId: ownerId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const insertCourse = (id: string, ownerId = userId) =>
  db
    .insert(CourseTable)
    .values({
      id,
      userId: ownerId,
      sourceKey: `manual:${id}`,
      sourceName: 'Local',
      sourceHost: 'local.invalid',
      url: `https://local.invalid/${id}`,
      name: id,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();

const insertLearningObservation = (input: {
  id: string;
  ownerId?: string;
  courseId: string;
  sourceSessionId: string | null;
}) => {
  const ownerId = input.ownerId ?? userId;
  db.insert(LearningObservationTable)
    .values({
      id: input.id,
      userId: ownerId,
      courseId: input.courseId,
      conceptId: null,
      attemptId: `attempt-${input.id}`,
      sourceSessionId: input.sourceSessionId,
      kind: 'tutor-interaction',
      responseOutcome: 'independent-success',
      assisted: false,
      independentEvidence: true,
      confidence: null,
      evidenceSummary: {
        attemptId: `attempt-${input.id}`,
        questionId: null,
        answerRevision: null,
        objectiveId: null,
        sourceReferences: [],
        assisted: false,
        outcome: 'independent-success',
        confidence: null,
      },
      createdAt: now,
      revokedAt: null,
    })
    .run();
  db.insert(MemoryTable)
    .values({
      id: input.id,
      userId: ownerId,
      courseId: input.courseId,
      type: 'learning-observation',
      content: {
        conceptId: null,
        outcome: 'independent-success',
        summary: 'An independent practice response was correct.',
      },
      provenance: 'practice-evidence',
      evidenceIds: [input.id],
      confidence: null,
      revision: 1,
      supersedesId: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
};

beforeEach(() => {
  db.delete(ConceptLinkTable).run();
  db.delete(ConceptTable).run();
  db.delete(LearningObservationTable).run();
  db.delete(MemoryTable).run();
  db.delete(CourseTable).run();
});

describe('personal context', () => {
  it('prefers explicit memory and includes observations only for the selected course', () => {
    insertCourse(courseA);
    insertCourse(courseB);
    const context = makeContext();
    const explicitPreference = upsertExplicitPreference(context, {
      requestId: preferenceRequestId,
      preference: { field: 'explanation-length', value: 'concise' },
    });
    db.insert(MemoryTable)
      .values({
        id: 'inferred-course-a',
        userId,
        courseId: courseA,
        type: 'provisional-preference',
        content: { field: 'explanation-length', value: 'detailed' },
        provenance: 'meta-inferred',
        evidenceIds: ['turn-evidence'],
        confidence: 0.95,
        revision: 2,
        supersedesId: null,
        deletedAt: null,
        createdAt: '2026-10-01T12:01:00.000Z',
        updatedAt: '2026-10-01T12:01:00.000Z',
      })
      .run();
    insertLearningObservation({
      id: 'observation-course-a',
      courseId: courseA,
      sourceSessionId: null,
    });
    insertLearningObservation({
      id: 'observation-course-b',
      courseId: courseB,
      sourceSessionId: null,
    });
    insertCourse('other-account-course', 'other-student');
    insertLearningObservation({
      id: 'observation-other-account',
      ownerId: 'other-student',
      courseId: 'other-account-course',
      sourceSessionId: null,
    });

    const contextA = preparePersonalContext(context, { courseId: courseA });
    const contextB = preparePersonalContext(context, { courseId: courseB });
    const accountContext = preparePersonalContext(context, { courseId: null });

    expect(contextA?.preferences).toEqual([explicitPreference]);
    expect(contextA?.observations.map(({ id }) => id)).toEqual([
      'observation-course-a',
    ]);
    expect(contextB?.preferences).toEqual([explicitPreference]);
    expect(contextB?.observations.map(({ id }) => id)).toEqual([
      'observation-course-b',
    ]);
    expect(accountContext?.preferences).toEqual([explicitPreference]);
    expect(accountContext?.observations).toEqual([]);

    deleteMemory(context, {
      memoryId: explicitPreference.id,
      expectedRevision: explicitPreference.revision,
    });
    expect(
      preparePersonalContext(context, { courseId: courseA })?.preferences,
    ).toEqual([]);
  });

  it('detaches retained learning evidence, applies a correction and stops using a deleted preference', () => {
    insertCourse(courseA);
    const context = makeContext();
    const preference = upsertExplicitPreference(context, {
      requestId: preferenceRequestId,
      preference: { field: 'explanation-length', value: 'concise' },
    });
    insertLearningObservation({
      id: 'retained-observation',
      courseId: courseA,
      sourceSessionId: 'deleted-session',
    });

    expect(
      detachLearningEvidenceFromSession(context, {
        sessionId: 'deleted-session',
      }),
    ).toBe(1);
    expect(
      db.select().from(LearningObservationTable).all()[0]?.sourceSessionId,
    ).toBeNull();
    expect(
      JSON.stringify(db.select().from(MemoryTable).all()).includes(
        'deleted transcript',
      ),
    ).toBe(false);
    expect(
      preparePersonalContext(context, { courseId: courseA })?.preferences[0]
        ?.content,
    ).toEqual({ field: 'explanation-length', value: 'concise' });

    const correctedPreference = correctMemory(context, {
      memoryId: preference.id,
      expectedRevision: preference.revision,
      preference: { field: 'explanation-length', value: 'balanced' },
    });
    expect(
      preparePersonalContext(context, { courseId: courseA })?.preferences[0]
        ?.content,
    ).toEqual({ field: 'explanation-length', value: 'balanced' });
    deleteMemory(context, {
      memoryId: correctedPreference.id,
      expectedRevision: correctedPreference.revision,
    });
    expect(
      preparePersonalContext(context, { courseId: courseA })?.preferences,
    ).toEqual([]);
    expect(
      preparePersonalContext(context, { courseId: courseA })?.observations,
    ).toHaveLength(1);

    upsertExplicitPreference(makeContext('other-student'), {
      requestId: '00000000-0000-4000-8000-000000000202',
      preference: { field: 'vocabulary', value: 'plain language' },
    });
    const otherCourseId = 'other-account-course';
    insertCourse(otherCourseId, 'other-student');
    insertLearningObservation({
      id: 'other-user-observation',
      ownerId: 'other-student',
      courseId: otherCourseId,
      sourceSessionId: null,
    });
    db.insert(ConceptTable)
      .values([
        {
          id: 'owned-concept-a',
          userId,
          courseId: courseA,
          label: 'Owned concept A',
          normalizedLabel: 'owned concept a',
          description: 'Test concept.',
          sourceReferences: [],
          uncertainty: 'Test-only evidence.',
          revision: 4,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'owned-concept-b',
          userId,
          courseId: courseA,
          label: 'Owned concept B',
          normalizedLabel: 'owned concept b',
          description: 'Test concept.',
          sourceReferences: [],
          uncertainty: 'Test-only evidence.',
          revision: 4,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'other-user-concept',
          userId: 'other-student',
          courseId: otherCourseId,
          label: 'Other concept',
          normalizedLabel: 'other concept',
          description: 'Test concept.',
          sourceReferences: [],
          uncertainty: 'Test-only evidence.',
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(ConceptLinkTable)
      .values([
        {
          id: 'owned-concept-link',
          userId,
          courseId: courseA,
          fromConceptId: 'owned-concept-a',
          toConceptId: 'owned-concept-b',
          relationship: 'related',
          sourceReferences: [],
          uncertainty: 'Test-only relation.',
          createdAt: now,
        },
        {
          id: 'other-user-concept-link',
          userId: 'other-student',
          courseId: otherCourseId,
          fromConceptId: 'other-user-concept',
          toConceptId: 'other-user-concept',
          relationship: 'related',
          sourceReferences: [],
          uncertainty: 'Test-only relation.',
          createdAt: now,
        },
      ])
      .run();
    purgeMemoryData(context);
    expect(
      db
        .select()
        .from(ConceptTable)
        .all()
        .map(({ id }) => id),
    ).toEqual(['other-user-concept']);
    expect(
      db
        .select()
        .from(ConceptLinkTable)
        .all()
        .map(({ id }) => id),
    ).toEqual(['other-user-concept-link']);
    expect(
      db
        .select()
        .from(MemoryTable)
        .all()
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      ['00000000-0000-4000-8000-000000000202', 'other-user-observation'].sort(),
    );
    expect(
      db
        .select()
        .from(LearningObservationTable)
        .all()
        .map(({ id }) => id),
    ).toEqual(['other-user-observation']);
  });
});
