// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionNotesEditor } from '../components/connection-notes-editor';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

const editor = (save: (id: string, notes: string) => Promise<void>) => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      createElement(ConnectionNotesEditor, {
        id: 'a',
        notes: '',
        save,
      }),
    ),
  );
  const input = container.querySelector('textarea')!;
  return {
    container,
    // React reads the value through the prototype setter, so typing must too.
    type: (value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value',
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }),
    blur: () =>
      act(async () => {
        // React maps onBlur to the native focusout event, not blur.
        input.dispatchEvent(new Event('focusout', { bubbles: true }));
      }),
  };
};

// Saves queue behind any in-flight save, so a call lands a few microtasks after
// the event that asked for it.
const drain = async () => {
  for (let hop = 0; hop < 4; hop += 1) await Promise.resolve();
};

it('autosaves a site note after editing', async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => undefined);
  const { type } = editor(save);
  await type('Biology');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(save).toHaveBeenCalledWith('a', 'Biology');
});

it('saves a reversion made while an earlier save is in flight', async () => {
  vi.useFakeTimers();
  let release = () => {};
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const { type } = editor(save);
  await type('first');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  await type('');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
    release();
    await Promise.resolve();
  });
  expect(save).toHaveBeenLastCalledWith('a', '');
});

it('returns to saved when an edit is reverted before the debounce', async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => undefined);
  const { container, type } = editor(save);
  await type('x');
  await type('');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(container.textContent).toContain('Saved');
  expect(save).not.toHaveBeenCalled();
});

it('saves on blur without waiting out the pause', async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => undefined);
  const { type, blur } = editor(save);
  await type('Lab notebook');
  expect(save).not.toHaveBeenCalled();
  await blur();
  await drain();
  expect(save).toHaveBeenCalledWith('a', 'Lab notebook');
  // A timer that is still running must not save the same text a second time.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(save).toHaveBeenCalledOnce();
});

it('saves a pending note when the editor unmounts', async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => undefined);
  const { type } = editor(save);
  await type('Written just before leaving');
  expect(save).not.toHaveBeenCalled();
  act(() => root?.unmount());
  root = undefined;
  await drain();
  expect(save).toHaveBeenCalledWith('a', 'Written just before leaving');
});

it('retries a failed autosave when the field loses focus', async () => {
  vi.useFakeTimers();
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValue(undefined);
  const { container, type, blur } = editor(save);
  await type('Biology');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(container.textContent).toContain('Could not save');
  await blur();
  await act(drain);
  expect(save).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('Saved');
});
