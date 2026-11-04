import { describe, expect, it } from 'vitest';
import {
  practiceGenerationInputSchema,
  validatePracticeCandidate,
} from '../practice-generation';

const sourceReference = {
  sourceKind: 'course-material',
  sourceId: 'material-1',
  versionId: 'version-1',
  courseId: 'course-1',
  locator: { kind: 'page', page: 2 },
  title: 'Cell division',
  provenance: 'connected-source',
  observedAt: '2026-11-02T12:00:00.000Z',
  state: 'current',
} as const;

const input = {
  topic: 'Explain how chromosomes are separated during mitosis.',
  difficulty: 'developing',
  questionCount: 1,
  objectives: [
    { id: 'objective-1', description: 'Describe chromosome separation.' },
  ],
  sources: [
    {
      reference: sourceReference,
      excerpt: 'Spindle fibers attach to chromosomes and move them apart.',
    },
  ],
};

const candidate = {
  questions: [
    {
      kind: 'multiple-choice',
      difficulty: 'developing',
      answerability: 'answerable',
      prompt: 'What do spindle fibers do during chromosome separation?',
      options: [
        { text: 'They dissolve the chromosomes.' },
        { text: 'They move chromosomes toward opposite poles.' },
      ],
      objectiveIndexes: [0],
      sourceIndexes: [0],
      answer: {
        correctOptionIndex: 1,
        explanation: 'Spindle fibers move chromosomes apart.',
        acceptedAlternatives: [],
      },
    },
  ],
};

describe('practice generation candidates', () => {
  it('keeps the private answer key out of the student-facing question DTO', () => {
    const result = validatePracticeCandidate(input, candidate);

    expect(result).not.toBeNull();
    expect(result?.questions).toHaveLength(1);
    expect(result?.questions[0]).toMatchObject({
      kind: 'multiple-choice',
      objectiveIds: ['objective-1'],
      sourceReferences: [sourceReference],
      options: [
        { text: 'They dissolve the chromosomes.' },
        { text: 'They move chromosomes toward opposite poles.' },
      ],
    });
    expect(result?.questions[0]).not.toHaveProperty('answer');
    expect(result?.hostAnswerKey).toHaveLength(1);
    expect(result?.hostAnswerKey[0]).toMatchObject({
      questionId: result?.questions[0]?.id,
      kind: 'multiple-choice',
      correctOptionId: result?.questions[0]?.options?.[1]?.id,
    });
  });

  it('rejects candidate references and objectives that were not offered', () => {
    const invalidObjective = structuredClone(candidate);
    invalidObjective.questions[0]!.objectiveIndexes = [1];
    const invalidSource = structuredClone(candidate);
    invalidSource.questions[0]!.sourceIndexes = [1];

    expect(validatePracticeCandidate(input, invalidObjective)).toBeNull();
    expect(validatePracticeCandidate(input, invalidSource)).toBeNull();
  });

  it('rejects an unanswerable multiple-choice key', () => {
    const invalid = structuredClone(candidate);
    invalid.questions[0]!.answer.correctOptionIndex = 4;

    expect(validatePracticeCandidate(input, invalid)).toBeNull();
  });

  it('requires an explicit answerable question at the requested difficulty', () => {
    const wrongDifficulty = JSON.parse(JSON.stringify(candidate)) as {
      questions: Array<Record<string, unknown>>;
    };
    wrongDifficulty.questions[0]!.difficulty = 'introductory';
    const uncertain = JSON.parse(JSON.stringify(candidate)) as {
      questions: Array<Record<string, unknown>>;
    };
    uncertain.questions[0]!.answerability = 'uncertain';

    expect(validatePracticeCandidate(input, wrongDifficulty)).toBeNull();
    expect(validatePracticeCandidate(input, uncertain)).toBeNull();
  });

  it('validates bounded input and total source text before generation', () => {
    expect(
      practiceGenerationInputSchema.safeParse({
        ...input,
        sources: Array.from({ length: 20 }, (_, index) => ({
          reference: { ...sourceReference, sourceId: `material-${index}` },
          excerpt: 'x'.repeat(2000),
        })),
      }).success,
    ).toBe(false);
  });

  it('requires at least one current source to ground generated questions', () => {
    expect(
      practiceGenerationInputSchema.safeParse({ ...input, sources: [] })
        .success,
    ).toBe(false);
  });

  it('rejects stale source references before generating practice', () => {
    expect(
      practiceGenerationInputSchema.safeParse({
        ...input,
        sources: [
          {
            reference: { ...sourceReference, state: 'removed' },
            excerpt: 'Previously available course content.',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('preserves distinct immutable source versions and locators for one material', () => {
    const secondReference = {
      ...sourceReference,
      versionId: 'version-2',
      locator: { kind: 'page', page: 3 },
    } as const;
    const sourceInput = {
      ...input,
      sources: [
        {
          reference: sourceReference,
          excerpt: 'Spindle fibers attach to chromosomes.',
        },
        {
          reference: secondReference,
          excerpt: 'Spindle fibers move chromosomes apart.',
        },
      ],
    };
    const sourceCandidate = structuredClone(candidate);
    sourceCandidate.questions[0]!.sourceIndexes = [0, 1];

    const result = validatePracticeCandidate(sourceInput, sourceCandidate);

    expect(result?.questions[0]?.sourceReferences).toEqual([
      sourceReference,
      secondReference,
    ]);
  });
});
