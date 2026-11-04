import { describe, expect, it } from 'vitest';
import type { PracticeQuestionDTO } from '@scholaros/services/learning/practice-contracts';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';
import { validatePracticeEvaluation } from '../services/practice-evaluation';

const question: PracticeQuestionDTO = {
  id: 'question-1',
  kind: 'multiple-choice',
  prompt: 'Which option describes chromosome separation?',
  options: [{ id: 'option-1', text: 'Chromosomes move apart.' }],
  unit: null,
  objectiveIds: ['objective-1'],
  sourceReferences: [],
};
const answerKey: JsonValue = [
  {
    questionId: 'question-1',
    kind: 'multiple-choice',
    correctOptionId: 'option-1',
    acceptedAlternatives: ['moving chromosomes apart'],
    explanation: 'Spindle fibers separate chromosomes.',
  },
];
const evaluation = {
  questionId: 'question-1',
  outcome: 'correct',
  explanation: 'Your answer identifies chromosome separation.',
  acceptedAlternatives: ['moving chromosomes apart'],
  sourceReferences: [],
  rubricVersion: 'rubric-1',
  assisted: false,
};

describe('host practice evaluation validation', () => {
  it('accepts only the current question rubric and assistance state', () => {
    expect(
      validatePracticeEvaluation(
        { question, answerKey, rubricVersion: 'rubric-1', assisted: false },
        evaluation,
      ),
    ).toEqual(evaluation);
  });

  it('rejects invented citations, alternatives, revisions, and assistance state', () => {
    const inventedCitation = {
      ...evaluation,
      sourceReferences: [
        {
          sourceKind: 'course-material',
          sourceId: 'forged-source',
          versionId: 'forged-version',
          courseId: 'course-1',
          locator: null,
          title: 'Forged source',
          provenance: 'connected-source',
          observedAt: null,
          state: 'current',
        },
      ],
    };
    const inventedAlternative = {
      ...evaluation,
      acceptedAlternatives: ['a new unreviewed answer'],
    };

    expect(
      validatePracticeEvaluation(
        { question, answerKey, rubricVersion: 'rubric-1', assisted: false },
        { ...evaluation, rubricVersion: 'old-rubric' },
      ),
    ).toBeNull();
    expect(
      validatePracticeEvaluation(
        { question, answerKey, rubricVersion: 'rubric-1', assisted: true },
        evaluation,
      ),
    ).toBeNull();
    expect(
      validatePracticeEvaluation(
        { question, answerKey, rubricVersion: 'rubric-1', assisted: false },
        inventedCitation,
      ),
    ).toBeNull();
    expect(
      validatePracticeEvaluation(
        { question, answerKey, rubricVersion: 'rubric-1', assisted: false },
        inventedAlternative,
      ),
    ).toBeNull();
  });
});
