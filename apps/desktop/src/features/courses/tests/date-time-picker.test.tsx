// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DateTimePicker } from '../components/date-time-picker';

it('keeps a date-only value without inventing a time and provides a time control', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      createElement(DateTimePicker, {
        id: 'due',
        value: '2026-11-10',
        onChange,
      }),
    ),
  );
  expect(node.querySelector('button')?.textContent).toContain('November');
  expect(
    node.querySelector<HTMLInputElement>('input[type="time"]')?.value,
  ).toBe('');
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  node.remove();
});

it('displays a structured source date without changing its original wording', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      createElement(DateTimePicker, {
        id: 'due',
        value: 'Tomorrow at noon',
        sourceDate: {
          kind: 'instant',
          instant: '2026-11-10T12:00-06:00',
          timezone: null,
          original: 'Tomorrow at noon',
        },
        onChange,
      }),
    ),
  );
  expect(node.querySelector('button')?.textContent).toContain('November');
  expect(
    node.querySelector<HTMLInputElement>('input[type="time"]')?.value,
  ).toBe('12:00');
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  node.remove();
});
