import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModel } from 'ai';
import type { PracticeQuestionDTO } from '@scholaros/services/learning/practice-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import { generateText } from 'ai';
import type { PracticeAnswerEvaluationInput } from '../practice-evaluation';
import { evaluatePracticeAnswer } from '../practice-evaluation';

vi.mock('ai', () => ({
  Output: { object: (options: unknown) => options },
  generateText: vi.fn(),
}));

const sourceReference: SourceReference = {
  sourceKind: 'course-material',
  sourceId: 'material-1',
  versionId: 'version-1',
  courseId: 'course-1',
  locator: { kind: 'page', page: 2 },
  title: 'Cell division',
  provenance: 'connected-source',
  observedAt: '2026-11-02T12:00:00.000Z',
  state: 'current',
};

const question: PracticeQuestionDTO = {
  id: 'question-1',
  kind: 'multiple-choice',
  prompt: 'What do spindle fibers do?',
  options: [
    { id: 'option-1', text: 'They dissolve chromosomes.' },
    { id: 'option-2', text: 'They move chromosomes apart.' },
  ],
  unit: null,
  objectiveIds: ['objective-1'],
  sourceReferences: [sourceReference],
};

const input: PracticeAnswerEvaluationInput = {
  question,
  answer: 'option-2',
  answerKey: {
    questionId: question.id,
    kind: 'multiple-choice',
    correctOptionId: 'option-2',
    acceptedAlternatives: [],
    explanation: 'Spindle fibers move chromosomes apart.',
  },
  rubricVersion: 'rubric-1',
  assisted: false,
};

const signal = new AbortController().signal;
const model = {} as LanguageModel;

describe('practice answer evaluation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('compares multiple-choice answers by stable option ID', async () => {
    const result = await evaluatePracticeAnswer(input, signal, model);

    expect(result).toMatchObject({
      questionId: 'question-1',
      outcome: 'correct',
      rubricVersion: 'rubric-1',
      assisted: false,
      sourceReferences: [sourceReference],
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('accepts rationally equivalent numeric answers with matching units', async () => {
    const numericQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-2',
      kind: 'numeric',
      prompt: 'Express the result in meters.',
      options: null,
      unit: 'm',
    };
    const numericInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: numericQuestion,
      answer: { value: '100/300', unit: 'm' },
      answerKey: {
        questionId: 'question-2',
        kind: 'numeric',
        acceptedValues: [{ value: 1 / 3, tolerance: 0.00001, unit: 'm' }],
        acceptedAlternatives: ['1/3 m'],
        explanation: 'The equivalent rational value is one third.',
      },
    };

    const result = await evaluatePracticeAnswer(numericInput, signal, model);

    expect(result.outcome).toBe('correct');
    expect(result.acceptedAlternatives).toEqual(['1/3 m']);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('returns uncertain rather than incorrect when units cannot be compared safely', async () => {
    const numericQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-3',
      kind: 'numeric',
      prompt: 'Enter the measured value.',
      options: null,
      unit: 'furlong',
    };
    const numericInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: numericQuestion,
      answer: { value: 1, unit: 'league' },
      answerKey: {
        questionId: 'question-3',
        kind: 'numeric',
        acceptedValues: [{ value: 1, tolerance: 0.00001, unit: 'furlong' }],
        acceptedAlternatives: [],
        explanation: 'The answer should use the requested unit.',
      },
    };

    const result = await evaluatePracticeAnswer(numericInput, signal, model);

    expect(result.outcome).toBe('uncertain');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('converts supported length units before applying numeric tolerance', async () => {
    const numericQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-8',
      kind: 'numeric',
      prompt: 'Enter the result in meters.',
      options: null,
      unit: 'm',
    };
    const numericInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: numericQuestion,
      answer: { value: 100, unit: 'cm' },
      answerKey: {
        questionId: 'question-8',
        kind: 'numeric',
        acceptedValues: [{ value: 1, tolerance: 0.001, unit: 'm' }],
        acceptedAlternatives: ['100 cm'],
        explanation: 'One hundred centimeters equal one meter.',
      },
    };

    const result = await evaluatePracticeAnswer(numericInput, signal, model);

    expect(result.outcome).toBe('correct');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('marks a clearly incompatible known unit as incorrect', async () => {
    const numericQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-9',
      kind: 'numeric',
      prompt: 'Enter the result in meters.',
      options: null,
      unit: 'm',
    };
    const numericInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: numericQuestion,
      answer: { value: 1, unit: 'kg' },
      answerKey: {
        questionId: 'question-9',
        kind: 'numeric',
        acceptedValues: [{ value: 1, tolerance: 0.001, unit: 'm' }],
        acceptedAlternatives: [],
        explanation: 'The answer should be a length in meters.',
      },
    };

    const result = await evaluatePracticeAnswer(numericInput, signal, model);

    expect(result.outcome).toBe('incorrect');
  });

  it('treats a blank numeric submission as incorrect rather than uncertain', async () => {
    const numericQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-10',
      kind: 'numeric',
      prompt: 'Enter the result in meters.',
      options: null,
      unit: 'm',
    };
    const numericInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: numericQuestion,
      answer: '',
      answerKey: {
        questionId: 'question-10',
        kind: 'numeric',
        acceptedValues: [{ value: 1, tolerance: 0.001, unit: 'm' }],
        acceptedAlternatives: [],
        explanation: 'The answer is one meter.',
      },
    };

    const result = await evaluatePracticeAnswer(numericInput, signal, model);

    expect(result.outcome).toBe('incorrect');
    expect(result.explanation).toContain('No numeric answer');
  });

  it('rejects a numeric rubric tolerance broad enough to accept arbitrary answers', async () => {
    const numericQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-11',
      kind: 'numeric',
      prompt: 'Enter the result.',
      options: null,
      unit: null,
    };
    const numericInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: numericQuestion,
      answer: 99,
      answerKey: {
        questionId: 'question-11',
        kind: 'numeric',
        acceptedValues: [{ value: 1, tolerance: 100, unit: null }],
        acceptedAlternatives: [],
        explanation: 'The answer is one.',
      },
    };

    await expect(
      evaluatePracticeAnswer(numericInput, signal, model),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('uses the bounded Meta rubric and preserves uncertainty for explanations', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: {
        outcome: 'uncertain',
        explanation:
          'The response may describe the same idea with different wording.',
      },
    } as never);
    const explanationQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-4',
      kind: 'short-explanation',
      prompt: 'Explain how spindle fibers separate chromosomes.',
      options: null,
      unit: null,
    };
    const explanationInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: explanationQuestion,
      answer: 'They pull each chromosome toward a different side of the cell.',
      answerKey: {
        questionId: 'question-4',
        kind: 'short-explanation',
        rubricCriteria: ['Explains movement toward opposite poles.'],
        acceptedAlternatives: ['The chromosomes move to opposite sides.'],
        explanation:
          'Spindle fibers separate chromosomes toward opposite poles.',
      },
    };

    const result = await evaluatePracticeAnswer(
      explanationInput,
      signal,
      model,
    );

    expect(result).toMatchObject({
      outcome: 'uncertain',
      acceptedAlternatives: ['The chromosomes move to opposite sides.'],
      sourceReferences: [sourceReference],
    });
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('preserves a reasonable alternative without sending it to inference', async () => {
    const explanationQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-5',
      kind: 'short-explanation',
      prompt: 'Explain the role of spindle fibers.',
      options: null,
      unit: null,
    };
    const explanationInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: explanationQuestion,
      answer: 'Spindle fibers move the chromosomes to opposite sides.',
      answerKey: {
        questionId: 'question-5',
        kind: 'short-explanation',
        rubricCriteria: ['Identifies chromosome separation.'],
        acceptedAlternatives: [
          'Spindle fibers move the chromosomes to opposite sides.',
        ],
        explanation: 'The fibers move the chromosomes apart.',
      },
    };

    const result = await evaluatePracticeAnswer(
      explanationInput,
      signal,
      model,
    );

    expect(result.outcome).toBe('correct');
    expect(generateText).not.toHaveBeenCalled();
  });

  it('does not turn provider failure into an incorrect grade', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('provider detail'));
    const explanationQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-6',
      kind: 'short-explanation',
      prompt: 'Explain chromosome separation.',
      options: null,
      unit: null,
    };
    const explanationInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: explanationQuestion,
      answer: 'The chromosomes are moved apart.',
      answerKey: {
        questionId: 'question-6',
        kind: 'short-explanation',
        rubricCriteria: ['Explains separation.'],
        acceptedAlternatives: [],
        explanation: 'Chromosomes are separated during mitosis.',
      },
    };

    await expect(
      evaluatePracticeAnswer(explanationInput, signal, model),
    ).rejects.toMatchObject({ code: 'provider-failed' });
  });

  it('never evaluates student code as JavaScript', async () => {
    const explanationQuestion: PracticeQuestionDTO = {
      ...question,
      id: 'question-7',
      kind: 'short-explanation',
      prompt: 'Explain chromosome separation.',
      options: null,
      unit: null,
    };
    const explanationInput: PracticeAnswerEvaluationInput = {
      ...input,
      question: explanationQuestion,
      answer: 'process.exit()',
      answerKey: {
        questionId: 'question-7',
        kind: 'short-explanation',
        rubricCriteria: ['Explains separation.'],
        acceptedAlternatives: [],
        explanation: 'Chromosomes are separated during mitosis.',
      },
    };
    vi.mocked(generateText).mockResolvedValue({
      output: {
        outcome: 'incorrect',
        explanation: 'This does not explain separation.',
      },
    } as never);

    const result = await evaluatePracticeAnswer(
      explanationInput,
      signal,
      model,
    );

    expect(result.outcome).toBe('incorrect');
    expect(generateText).toHaveBeenCalledOnce();
  });
});
