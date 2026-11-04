// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  PracticeEvaluationDTO,
  PracticeQuestionDTO,
  PracticeSnapshot,
} from '@scholaros/services/learning/practice-contracts';
import { PracticeView } from '../components/practice-view';
import {
  usePracticeAttempt,
  type UsePracticeAttemptResult,
} from '../hooks/use-practice-attempt';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const question: PracticeQuestionDTO = {
  id: 'question-1',
  kind: 'multiple-choice',
  prompt: 'Which value is equivalent to one half?',
  options: [
    { id: 'choice-a', text: '0.5' },
    { id: 'choice-b', text: '0.25' },
  ],
  unit: null,
  objectiveIds: ['objective-1'],
  sourceReferences: [],
};
const numericQuestion: PracticeQuestionDTO = {
  id: 'numeric-question',
  kind: 'numeric',
  prompt: 'What is one plus one?',
  options: null,
  unit: null,
  objectiveIds: ['objective-1'],
  sourceReferences: [],
};
const answer = {
  questionId: question.id,
  revision: 1,
  value: 'choice-a',
  savedAt: '2026-11-03T12:00:00Z',
};
const evaluation: PracticeEvaluationDTO = {
  questionId: question.id,
  outcome: 'correct',
  explanation: 'One half is equal to 0.5.',
  acceptedAlternatives: ['1/2'],
  sourceReferences: [],
  rubricVersion: 'rubric-1',
  assisted: false,
};
const attempt = (
  overrides: Partial<PracticeSnapshot> = {},
): PracticeSnapshot => ({
  id: 'attempt-1',
  courseId: 'course-1',
  sessionId: 'session-1',
  mode: 'quiz',
  feedbackMode: 'end',
  status: 'in-progress',
  revision: 0,
  assisted: false,
  priorAttemptId: null,
  questions: [question],
  answers: [],
  feedback: [],
  ...overrides,
});

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
let bridge: {
  getPracticeAttempt: ReturnType<typeof vi.fn>;
  savePracticeAnswer: ReturnType<typeof vi.fn>;
  submitPracticeAttempt: ReturnType<typeof vi.fn>;
  switchPracticeToGuided: ReturnType<typeof vi.fn>;
  retryPracticeAttempt: ReturnType<typeof vi.fn>;
};

const renderPractice = async (
  initialAttempt = attempt(),
  onAttemptChange?: (attemptId: string) => void,
  readOnly = false,
) => {
  bridge = {
    getPracticeAttempt: vi.fn(async () => initialAttempt),
    savePracticeAnswer: vi.fn(async () => initialAttempt),
    submitPracticeAttempt: vi.fn(async () => initialAttempt),
    switchPracticeToGuided: vi.fn(async () => initialAttempt),
    retryPracticeAttempt: vi.fn(async () => initialAttempt),
  };
  window.scholar = bridge as unknown as typeof window.scholar;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(PracticeView, {
        accountId: 'account-1',
        sessionId: 'session-1',
        attemptId: initialAttempt.id,
        onAttemptChange,
        readOnly,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
};

const rerenderPractice = async (
  initialAttempt: PracticeSnapshot,
  readOnly: boolean,
  onAttemptChange?: (attemptId: string) => void,
) => {
  await act(async () =>
    root?.render(
      createElement(PracticeView, {
        accountId: 'account-1',
        sessionId: 'session-1',
        attemptId: initialAttempt.id,
        onAttemptChange,
        readOnly,
      }),
    ),
  );
};

const buttonWithText = (text: string) =>
  [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text),
  );

const clickButton = async (text: string) => {
  const button = buttonWithText(text);
  expect(button).toBeTruthy();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const selectOption = async (view: HTMLElement, optionText: string) => {
  const radio = [...view.querySelectorAll('[role="radio"]')].find((item) =>
    item.closest('label')?.textContent?.includes(optionText),
  );
  expect(radio).toBeTruthy();
  await act(async () => {
    radio?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const typeInto = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  document.body.replaceChildren();
});

it('keeps ordinary quiz feedback hidden until the end review is submitted', async () => {
  const view = await renderPractice(attempt());
  bridge.savePracticeAnswer.mockResolvedValue(
    attempt({ revision: 1, answers: [answer] }),
  );
  expect(view.textContent).not.toContain(evaluation.explanation);
  await selectOption(view, '0.5');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(bridge.savePracticeAnswer).toHaveBeenCalledOnce();
  expect(view.textContent).not.toContain(evaluation.explanation);

  bridge.submitPracticeAttempt.mockResolvedValue(
    attempt({
      status: 'evaluated',
      revision: 2,
      answers: [answer],
      feedback: [evaluation],
    }),
  );
  await clickButton('Submit answers');
  expect(bridge.submitPracticeAttempt).toHaveBeenCalledWith(
    expect.objectContaining({ attemptId: 'attempt-1', expectedRevision: 1 }),
  );
  expect(view.textContent).toContain(evaluation.explanation);
});

it('saves the latest edit before submitting without waiting for the autosave delay', async () => {
  const view = await renderPractice(attempt());
  bridge.savePracticeAnswer.mockResolvedValue(
    attempt({ revision: 1, answers: [answer] }),
  );
  bridge.submitPracticeAttempt.mockResolvedValue(
    attempt({
      status: 'evaluated',
      revision: 2,
      answers: [answer],
      feedback: [evaluation],
    }),
  );
  await selectOption(view, '0.5');
  expect(bridge.savePracticeAnswer).not.toHaveBeenCalled();

  await clickButton('Submit answers');

  expect(bridge.savePracticeAnswer).toHaveBeenCalledOnce();
  expect(bridge.submitPracticeAttempt).toHaveBeenCalledOnce();
  expect(bridge.savePracticeAnswer.mock.invocationCallOrder[0]).toBeLessThan(
    bridge.submitPracticeAttempt.mock.invocationCallOrder[0]!,
  );
  expect(bridge.submitPracticeAttempt).toHaveBeenCalledWith(
    expect.objectContaining({ expectedRevision: 1 }),
  );
});

it('shows per-answer feedback only when that mode is present in the saved attempt', async () => {
  const view = await renderPractice(
    attempt({
      feedbackMode: 'per-answer',
      answers: [answer],
      feedback: [evaluation],
    }),
  );
  expect(view.textContent).toContain(evaluation.explanation);
  expect(view.textContent).toContain('Answer-by-answer feedback');
});

it('does not expose exam feedback before submission, even if an unexpected payload includes it', async () => {
  const examAttempt = {
    ...attempt({ mode: 'exam', feedback: [evaluation] }),
    hostAnswerKey: 'PRIVATE-ANSWER-KEY',
  } as unknown as PracticeSnapshot;
  const view = await renderPractice(examAttempt);
  expect(view.textContent).not.toContain(evaluation.explanation);
  expect(view.textContent).not.toContain('1/2');
  expect(view.textContent).not.toContain('PRIVATE-ANSWER-KEY');

  bridge.submitPracticeAttempt.mockResolvedValue(
    attempt({
      mode: 'exam',
      status: 'evaluated',
      revision: 1,
      feedback: [evaluation],
    }),
  );
  await clickButton('Submit answers');
  expect(view.textContent).toContain(evaluation.explanation);
});

it('marks an exam attempt assisted before switching it to guided practice', async () => {
  const view = await renderPractice(attempt({ mode: 'exam' }));
  bridge.switchPracticeToGuided.mockResolvedValue(
    attempt({ mode: 'guided', assisted: true, revision: 1 }),
  );
  await clickButton('Switch to guided practice');
  expect(bridge.switchPracticeToGuided).toHaveBeenCalledWith(
    expect.objectContaining({ attemptId: 'attempt-1', expectedRevision: 0 }),
  );
  expect(view.textContent).toContain('Assisted practice');
  expect(view.textContent).toContain('Guided practice is on');
});

it('restores the latest saved answer when an incomplete attempt is reopened', async () => {
  const view = await renderPractice(
    attempt({ answers: [answer], revision: 1 }),
  );
  expect(
    [...view.querySelectorAll('[role="radio"]')].some(
      (radio) => radio.getAttribute('aria-checked') === 'true',
    ),
  ).toBe(true);
});

it('preserves a locally edited answer and offers an idempotent retry after save failure', async () => {
  const numericAnswer = {
    questionId: numericQuestion.id,
    revision: 1,
    value: '2',
    savedAt: '2026-11-03T12:00:00Z',
  };
  const view = await renderPractice(attempt({ questions: [numericQuestion] }));
  bridge.savePracticeAnswer
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(
      attempt({
        questions: [numericQuestion],
        answers: [numericAnswer],
        revision: 1,
      }),
    );
  const answerField =
    view.querySelector<HTMLInputElement>('input[type="text"]')!;
  await typeInto(answerField, '2');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(
    (view.querySelector('input[type="text"]') as HTMLInputElement).value,
  ).toBe('2');
  expect(view.textContent).toContain('Could not save this answer');

  await clickButton('Retry save');
  expect(bridge.savePracticeAnswer).toHaveBeenCalledTimes(2);
  expect(bridge.savePracticeAnswer.mock.calls[1]?.[0].requestId).toBe(
    bridge.savePracticeAnswer.mock.calls[0]?.[0].requestId,
  );
  expect(
    (view.querySelector('input[type="text"]') as HTMLInputElement).value,
  ).toBe('2');
});

it('keeps saved answers visible when evaluation is interrupted by a provider failure', async () => {
  const view = await renderPractice(
    attempt({ status: 'interrupted', answers: [answer], revision: 1 }),
  );
  expect(
    [...view.querySelectorAll('[role="radio"]')].some(
      (radio) => radio.getAttribute('aria-checked') === 'true',
    ),
  ).toBe(true);
  expect(view.textContent).toContain('Your saved answers are still here');
  expect(view.textContent).toContain('Try again');
});

it('keeps the latest cleared value after an earlier save finishes in flight', async () => {
  const view = await renderPractice(attempt({ questions: [numericQuestion] }));
  const answerField =
    view.querySelector<HTMLInputElement>('input[type="text"]')!;
  let finishFirstSave!: (snapshot: PracticeSnapshot) => void;
  bridge.savePracticeAnswer
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstSave = resolve;
        }),
    )
    .mockResolvedValueOnce(
      attempt({
        questions: [numericQuestion],
        answers: [
          {
            questionId: numericQuestion.id,
            revision: 2,
            value: '',
            savedAt: '2026-11-03T12:02:00Z',
          },
        ],
        revision: 2,
      }),
    );

  await typeInto(answerField, '1');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(bridge.savePracticeAnswer).toHaveBeenCalledOnce();
  await typeInto(answerField, '');
  await act(async () => {
    finishFirstSave(
      attempt({
        questions: [numericQuestion],
        answers: [
          {
            questionId: numericQuestion.id,
            revision: 1,
            value: '1',
            savedAt: '2026-11-03T12:01:00Z',
          },
        ],
        revision: 1,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });

  expect(bridge.savePracticeAnswer).toHaveBeenCalledTimes(2);
  expect(bridge.savePracticeAnswer.mock.calls[1]?.[0].value).toBe('');
  expect(
    (view.querySelector('input[type="text"]') as HTMLInputElement).value,
  ).toBe('');
});

it('ignores a late submit response after the displayed account and attempt change', async () => {
  const oldFeedback: PracticeEvaluationDTO = {
    ...evaluation,
    explanation: 'Private feedback from the previous account.',
  };
  const secondQuestion: PracticeQuestionDTO = {
    ...question,
    id: 'question-account-2',
    prompt: 'Question for the next account.',
  };
  const view = await renderPractice(attempt());
  let finishOldSubmit!: (snapshot: PracticeSnapshot) => void;
  bridge.submitPracticeAttempt.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOldSubmit = resolve;
      }),
  );
  await act(async () => {
    buttonWithText('Submit answers')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  const nextAttempt = attempt({
    id: 'attempt-account-2',
    sessionId: 'session-account-2',
    questions: [secondQuestion],
  });
  bridge.getPracticeAttempt.mockResolvedValue(nextAttempt);
  await act(async () => {
    root?.render(
      createElement(PracticeView, {
        accountId: 'account-2',
        sessionId: 'session-account-2',
        attemptId: nextAttempt.id,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(view.textContent).toContain('Question for the next account.');

  await act(async () => {
    finishOldSubmit(attempt({ status: 'evaluated', feedback: [oldFeedback] }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(view.textContent).toContain('Question for the next account.');
  expect(view.textContent).not.toContain(
    'Private feedback from the previous account.',
  );
});

it('rebases a conflicting answer save without replacing the local draft', async () => {
  const latestAnswer = {
    questionId: numericQuestion.id,
    revision: 1,
    value: '1',
    savedAt: '2026-11-03T12:01:00Z',
  };
  const view = await renderPractice(attempt({ questions: [numericQuestion] }));
  bridge.getPracticeAttempt.mockResolvedValueOnce(
    attempt({
      questions: [numericQuestion],
      answers: [latestAnswer],
      revision: 1,
    }),
  );
  bridge.savePracticeAnswer
    .mockRejectedValueOnce(
      Object.assign(new Error('Conflict'), { code: 'revision-conflict' }),
    )
    .mockResolvedValue(
      attempt({
        questions: [numericQuestion],
        answers: [{ ...latestAnswer, revision: 2, value: '2' }],
        revision: 2,
      }),
    );
  const answerField =
    view.querySelector<HTMLInputElement>('input[type="text"]')!;
  await typeInto(answerField, '2');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(answerField.value).toBe('2');
  expect(view.textContent).toContain('changed elsewhere');

  await clickButton('Retry save');
  expect(bridge.savePracticeAnswer).toHaveBeenCalledTimes(2);
  expect(bridge.savePracticeAnswer.mock.calls[1]?.[0].expectedRevision).toBe(1);
  expect(bridge.savePracticeAnswer.mock.calls[1]?.[0].requestId).not.toBe(
    bridge.savePracticeAnswer.mock.calls[0]?.[0].requestId,
  );
  expect(
    (view.querySelector('input[type="text"]') as HTMLInputElement).value,
  ).toBe('2');
});

it('keeps saved answers when the provider rejects submission', async () => {
  const view = await renderPractice(
    attempt({ answers: [answer], revision: 1 }),
  );
  bridge.submitPracticeAttempt.mockRejectedValueOnce(
    new Error('provider-failed'),
  );

  await clickButton('Submit answers');

  expect(
    [...view.querySelectorAll('[role="radio"]')].some(
      (radio) => radio.getAttribute('aria-checked') === 'true',
    ),
  ).toBe(true);
  expect(view.textContent).toContain('Could not submit your answers');
  expect(buttonWithText('Submit answers')).toBeTruthy();
});

it('refreshes submitted attempts until real evaluation feedback is available', async () => {
  const view = await renderPractice(
    attempt({ status: 'submitted', answers: [answer], revision: 1 }),
  );
  bridge.getPracticeAttempt.mockResolvedValueOnce(
    attempt({
      status: 'evaluated',
      answers: [answer],
      revision: 2,
      feedback: [evaluation],
    }),
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  expect(view.textContent).toContain(evaluation.explanation);
});

it('shows uncertain feedback, accepted alternatives, and available source location honestly', async () => {
  const view = await renderPractice(
    attempt({
      status: 'evaluated',
      feedback: [
        {
          ...evaluation,
          outcome: 'uncertain',
          explanation: 'The response could not be assessed confidently.',
          acceptedAlternatives: ['½', '1/2'],
          sourceReferences: [
            {
              sourceKind: 'course-material',
              sourceId: 'material-1',
              versionId: 'version-1',
              courseId: 'course-1',
              locator: { kind: 'page', page: 2 },
              title: 'Fractions notes',
              provenance: 'connected-source',
              observedAt: '2026-11-03T12:00:00Z',
              state: 'current',
            },
          ],
        },
      ],
    }),
  );
  expect(view.textContent).toContain('Could not assess confidently');
  expect(view.textContent).toContain('Also accepted');
  expect(view.textContent).toContain('½');
  expect(view.textContent).toContain('Fractions notes');
  expect(view.textContent).toContain('Page 2');
  expect(view.textContent).not.toContain('Official grade');
});

it('keeps an earlier attempt and notifies the conversation when retry creates a new attempt', async () => {
  const onAttemptChange = vi.fn();
  const view = await renderPractice(
    attempt({ status: 'evaluated', answers: [answer], revision: 1 }),
    onAttemptChange,
  );
  bridge.retryPracticeAttempt.mockResolvedValue(
    attempt({ id: 'attempt-2', priorAttemptId: 'attempt-1', revision: 0 }),
  );

  await clickButton('Try again');

  expect(bridge.retryPracticeAttempt).toHaveBeenCalledWith(
    expect.objectContaining({ attemptId: 'attempt-1' }),
  );
  expect(onAttemptChange).toHaveBeenCalledWith('attempt-2');
  expect(view.textContent).toContain('Repeated practice');
});

it('keeps cached practice visible while host read-only mode blocks in-progress actions', async () => {
  const cachedAnswer = {
    questionId: numericQuestion.id,
    revision: 1,
    value: '2',
    savedAt: '2026-11-03T12:00:00Z',
  };
  const cachedAttempt = attempt({
    questions: [numericQuestion],
    answers: [cachedAnswer],
    revision: 1,
  });
  const view = await renderPractice(cachedAttempt, undefined, true);
  await vi.waitFor(() =>
    expect(view.textContent).toContain('What is one plus one?'),
  );

  const answerInput = view.querySelector<HTMLInputElement>(
    'input[aria-label="Answer for question 1"]',
  );
  expect(answerInput?.value).toBe('2');
  expect(answerInput?.disabled).toBe(true);
  expect(view.textContent).toContain(
    'Reconnect online to save pending answers',
  );
  expect(buttonWithText('Submit answers')?.disabled).toBe(true);
  expect(buttonWithText('Switch to guided practice')?.disabled).toBe(true);

  await act(async () =>
    view
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  await clickButton('Switch to guided practice');

  expect(bridge.getPracticeAttempt).toHaveBeenCalledOnce();
  expect(bridge.savePracticeAnswer).not.toHaveBeenCalled();
  expect(bridge.submitPracticeAttempt).not.toHaveBeenCalled();
  expect(bridge.switchPracticeToGuided).not.toHaveBeenCalled();
  expect(bridge.retryPracticeAttempt).not.toHaveBeenCalled();
});

it('ignores a stale offline practice snapshot after reconnecting to a fresh attempt', async () => {
  const initialAttempt = attempt({
    questions: [{ ...numericQuestion, prompt: 'Original practice prompt' }],
  });
  const offlineAttempt = attempt({
    questions: [{ ...numericQuestion, prompt: 'Stale offline prompt' }],
    revision: 1,
  });
  const onlineAttempt = attempt({
    questions: [{ ...numericQuestion, prompt: 'Fresh online prompt' }],
    revision: 2,
  });
  const view = await renderPractice(initialAttempt);
  let resolveOffline!: (value: PracticeSnapshot) => void;
  bridge.getPracticeAttempt
    .mockImplementationOnce(
      () =>
        new Promise<PracticeSnapshot>((resolve) => {
          resolveOffline = resolve;
        }),
    )
    .mockResolvedValueOnce(onlineAttempt);

  await rerenderPractice(initialAttempt, true);
  expect(view.textContent).toContain('Original practice prompt');
  await rerenderPractice(initialAttempt, false);
  await vi.waitFor(() =>
    expect(view.textContent).toContain('Fresh online prompt'),
  );

  await act(async () => resolveOffline(offlineAttempt));
  expect(view.textContent).toContain('Fresh online prompt');
  expect(view.textContent).not.toContain('Stale offline prompt');
});

it('cancels answer autosave while read-only and resumes it after reconnect', async () => {
  const initialAttempt = attempt({ questions: [numericQuestion] });
  const view = await renderPractice(initialAttempt);
  const offlineSnapshot = attempt({
    questions: [numericQuestion],
    answers: [
      {
        questionId: numericQuestion.id,
        revision: 1,
        value: '1',
        savedAt: '2026-11-03T12:00:00Z',
      },
    ],
    revision: 1,
  });
  const onlineSnapshot = attempt({
    questions: [numericQuestion],
    answers: [
      {
        questionId: numericQuestion.id,
        revision: 2,
        value: '1',
        savedAt: '2026-11-03T12:01:00Z',
      },
    ],
    revision: 2,
  });
  bridge.getPracticeAttempt
    .mockResolvedValueOnce(offlineSnapshot)
    .mockResolvedValueOnce(onlineSnapshot);
  const answerInput = view.querySelector<HTMLInputElement>(
    'input[aria-label="Answer for question 1"]',
  )!;
  await typeInto(answerInput, '2');
  await rerenderPractice(initialAttempt, true);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));

  expect(bridge.savePracticeAnswer).not.toHaveBeenCalled();
  expect(answerInput.value).toBe('2');
  expect(answerInput.disabled).toBe(true);

  const savedAttempt = attempt({
    questions: [numericQuestion],
    answers: [
      {
        questionId: numericQuestion.id,
        revision: 3,
        value: '2',
        savedAt: '2026-11-03T12:02:00Z',
      },
    ],
    revision: 3,
  });
  bridge.savePracticeAnswer.mockResolvedValue(savedAttempt);
  await rerenderPractice(initialAttempt, false);
  await act(async () => vi.advanceTimersByTimeAsync(500));

  expect(bridge.savePracticeAnswer).toHaveBeenCalledOnce();
  expect(bridge.getPracticeAttempt).toHaveBeenCalledTimes(3);
  expect(bridge.savePracticeAnswer).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedRevision: 2,
      questionId: numericQuestion.id,
      value: '2',
    }),
  );
  expect(answerInput.disabled).toBe(false);
});

it('does not flush queued answer writes after a read-only transition', async () => {
  const initialAttempt = attempt({ questions: [numericQuestion] });
  const firstSavedAttempt = attempt({
    questions: [numericQuestion],
    answers: [
      {
        questionId: numericQuestion.id,
        revision: 1,
        value: '1',
        savedAt: '2026-11-03T12:00:00Z',
      },
    ],
    revision: 1,
  });
  const secondSavedAttempt = attempt({
    questions: [numericQuestion],
    answers: [
      {
        questionId: numericQuestion.id,
        revision: 2,
        value: '2',
        savedAt: '2026-11-03T12:01:00Z',
      },
    ],
    revision: 2,
  });
  const view = await renderPractice(initialAttempt);
  let resolveFirstSave!: (value: PracticeSnapshot) => void;
  bridge.savePracticeAnswer
    .mockImplementationOnce(
      () =>
        new Promise<PracticeSnapshot>((resolve) => {
          resolveFirstSave = resolve;
        }),
    )
    .mockResolvedValueOnce(secondSavedAttempt);
  const answerInput = view.querySelector<HTMLInputElement>(
    'input[aria-label="Answer for question 1"]',
  )!;
  await typeInto(answerInput, '1');
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(bridge.savePracticeAnswer).toHaveBeenCalledOnce();

  await typeInto(answerInput, '2');
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(bridge.savePracticeAnswer).toHaveBeenCalledOnce();
  await rerenderPractice(initialAttempt, true);

  await act(async () => {
    resolveFirstSave(firstSavedAttempt);
    for (let hop = 0; hop < 8; hop += 1) await Promise.resolve();
  });
  expect(bridge.savePracticeAnswer).toHaveBeenCalledOnce();
  expect(answerInput.value).toBe('2');

  await rerenderPractice(initialAttempt, false);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(bridge.savePracticeAnswer).toHaveBeenCalledTimes(2);
  expect(bridge.savePracticeAnswer).toHaveBeenLastCalledWith(
    expect.objectContaining({ value: '2' }),
  );
});

it('guards practice answer, submit, and guided callbacks in host read-only mode', async () => {
  const cachedAttempt = attempt({
    questions: [numericQuestion],
    answers: [
      {
        questionId: numericQuestion.id,
        revision: 1,
        value: '2',
        savedAt: '2026-11-03T12:00:00Z',
      },
    ],
    revision: 1,
  });
  bridge = {
    getPracticeAttempt: vi.fn(async () => cachedAttempt),
    savePracticeAnswer: vi.fn(async () => cachedAttempt),
    submitPracticeAttempt: vi.fn(async () => cachedAttempt),
    switchPracticeToGuided: vi.fn(async () => cachedAttempt),
    retryPracticeAttempt: vi.fn(async () => cachedAttempt),
  };
  window.scholar = bridge as unknown as typeof window.scholar;
  let practice: UsePracticeAttemptResult | null = null;
  const Probe = () => {
    practice = usePracticeAttempt({
      accountId: 'account-1',
      sessionId: 'session-1',
      attemptId: cachedAttempt.id,
      readOnly: true,
    });
    return createElement('div', null, practice.snapshot?.id ?? 'Loading');
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Probe)));
  await vi.waitFor(() => expect(container.textContent).toBe(cachedAttempt.id));

  await act(async () => {
    practice!.changeAnswer(numericQuestion.id, '3');
    practice!.retryAnswerSave(numericQuestion.id);
    await practice!.submit();
    await practice!.switchToGuided();
  });

  expect(practice!.answerDrafts[numericQuestion.id]).toBe('2');
  expect(bridge.savePracticeAnswer).not.toHaveBeenCalled();
  expect(bridge.submitPracticeAttempt).not.toHaveBeenCalled();
  expect(bridge.switchPracticeToGuided).not.toHaveBeenCalled();
});

it('blocks retry callbacks while host read-only even when an attempt is complete', async () => {
  const completedAttempt = attempt({
    status: 'evaluated',
    answers: [answer],
    revision: 1,
  });
  bridge = {
    getPracticeAttempt: vi.fn(async () => completedAttempt),
    savePracticeAnswer: vi.fn(async () => completedAttempt),
    submitPracticeAttempt: vi.fn(async () => completedAttempt),
    switchPracticeToGuided: vi.fn(async () => completedAttempt),
    retryPracticeAttempt: vi.fn(async () => completedAttempt),
  };
  window.scholar = bridge as unknown as typeof window.scholar;
  const onAttemptChange = vi.fn();
  let practice: UsePracticeAttemptResult | null = null;
  const Probe = () => {
    practice = usePracticeAttempt({
      accountId: 'account-1',
      sessionId: 'session-1',
      attemptId: completedAttempt.id,
      onAttemptChange,
      readOnly: true,
    });
    return createElement('div', null, practice.snapshot?.id ?? 'Loading');
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Probe)));
  await vi.waitFor(() =>
    expect(container.textContent).toBe(completedAttempt.id),
  );

  await act(async () => practice!.retry());

  expect(bridge.retryPracticeAttempt).not.toHaveBeenCalled();
  expect(onAttemptChange).not.toHaveBeenCalled();
});

it('keeps evaluated practice feedback readable while read-only blocks retry', async () => {
  const completedAttempt = attempt({
    status: 'evaluated',
    answers: [answer],
    feedback: [evaluation],
    revision: 2,
  });
  const view = await renderPractice(completedAttempt, undefined, true);

  expect(view.textContent).toContain(evaluation.explanation);
  expect(buttonWithText('Try again')?.disabled).toBe(true);
  await clickButton('Try again');
  expect(bridge.retryPracticeAttempt).not.toHaveBeenCalled();
});

it('defers practice attempt-link changes until the host is writable again', async () => {
  const completedAttempt = attempt({
    status: 'evaluated',
    answers: [answer],
    revision: 1,
  });
  const nextAttempt = attempt({
    id: 'attempt-2',
    priorAttemptId: 'attempt-1',
    revision: 0,
  });
  let resolveRetry!: (value: PracticeSnapshot) => void;
  bridge = {
    getPracticeAttempt: vi.fn(async () => completedAttempt),
    savePracticeAnswer: vi.fn(async () => completedAttempt),
    submitPracticeAttempt: vi.fn(async () => completedAttempt),
    switchPracticeToGuided: vi.fn(async () => completedAttempt),
    retryPracticeAttempt: vi.fn(
      () =>
        new Promise<PracticeSnapshot>((resolve) => {
          resolveRetry = resolve;
        }),
    ),
  };
  window.scholar = bridge as unknown as typeof window.scholar;
  const onAttemptChange = vi.fn();
  let practice: UsePracticeAttemptResult | null = null;
  const Probe = ({ readOnly }: { readOnly: boolean }) => {
    practice = usePracticeAttempt({
      accountId: 'account-1',
      sessionId: 'session-1',
      attemptId: completedAttempt.id,
      onAttemptChange,
      readOnly,
    });
    return createElement('div', null, practice.snapshot?.id ?? 'Loading');
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(createElement(Probe, { readOnly: false })),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toBe(completedAttempt.id),
  );

  let retryPromise!: Promise<void>;
  await act(async () => {
    retryPromise = practice!.retry();
    await Promise.resolve();
  });
  await act(async () => root?.render(createElement(Probe, { readOnly: true })));
  await act(async () => {
    resolveRetry(nextAttempt);
    await retryPromise;
  });

  expect(onAttemptChange).not.toHaveBeenCalled();
  await act(async () =>
    root?.render(createElement(Probe, { readOnly: false })),
  );
  expect(onAttemptChange).toHaveBeenCalledOnce();
  expect(onAttemptChange).toHaveBeenCalledWith('attempt-2');
});
