// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { PracticeQuestionDTO } from '@scholaros/services/learning/practice-contracts';
import { PracticeQuestion } from '../components/practice-question';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

const mountQuestion = (
  question: PracticeQuestionDTO,
  options: { value?: string; error?: string } = {},
) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const onChange = vi.fn();
  act(() => {
    root?.render(
      createElement(PracticeQuestion, {
        question,
        questionNumber: 1,
        value: options.value ?? '',
        onChange,
        onRetrySave: vi.fn(),
        answerState: 'saved',
        error: options.error ?? null,
        disabled: false,
        feedback: null,
      }),
    );
  });
  return { onChange };
};

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

it('renders named multiple-choice controls that support arrow-key selection', async () => {
  const { onChange } = mountQuestion({
    id: 'question-1',
    kind: 'multiple-choice',
    prompt: 'Which value is one half?',
    options: [
      { id: 'choice-a', text: '0.5' },
      { id: 'choice-b', text: '0.25' },
    ],
    unit: null,
    objectiveIds: [],
    sourceReferences: [],
  });
  const group = container.querySelector('[role="radiogroup"]');
  const radios = container.querySelectorAll('[role="radio"]');
  const legend = container.querySelector('[data-slot="field-legend"]');
  expect(group?.getAttribute('aria-labelledby')).toBe(legend?.id);
  expect(legend?.textContent).toContain('Your answer');
  expect(radios).toHaveLength(2);
  expect(container.textContent).toContain('Which value is one half?');

  await act(async () => {
    (radios[0] as HTMLElement).focus();
    radios[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(onChange).toHaveBeenCalledWith('choice-b');
});

it('renders an accessible numeric answer field and associates save errors', () => {
  mountQuestion(
    {
      id: 'question-2',
      kind: 'numeric',
      prompt: 'How many grams are in one kilogram?',
      options: null,
      unit: 'g',
      objectiveIds: [],
      sourceReferences: [],
    },
    { value: '1000', error: 'Could not save this answer.' },
  );
  const input = container.querySelector('input');
  expect(input?.getAttribute('inputmode')).toBe('decimal');
  expect(input?.getAttribute('aria-label')).toContain('Answer');
  expect(input?.getAttribute('aria-invalid')).toBe('true');
  expect(input?.getAttribute('aria-describedby')).toBeTruthy();
  expect((input as HTMLInputElement).value).toBe('1000');
  expect(container.textContent).toContain('Could not save this answer.');
});

it('updates the labeled explanation field with the student text', async () => {
  const { onChange } = mountQuestion(
    {
      id: 'question-3',
      kind: 'short-explanation',
      prompt: 'Explain why water expands when it freezes.',
      options: null,
      unit: null,
      objectiveIds: [],
      sourceReferences: [],
    },
    { value: 'Ice forms a lattice.' },
  );
  const textarea = container.querySelector('textarea');
  expect(textarea?.getAttribute('aria-label')).toContain('Answer');
  expect((textarea as HTMLTextAreaElement).value).toBe('Ice forms a lattice.');
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(
      textarea,
      'Ice forms a lattice because of its crystal structure.',
    );
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith(
    'Ice forms a lattice because of its crystal structure.',
  );
});
