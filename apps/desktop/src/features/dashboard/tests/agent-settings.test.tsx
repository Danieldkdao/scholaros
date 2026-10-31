// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AgentSettings } from '../agent-settings';

it('auto-saves valid edits in order and keeps pending saves after closing settings', async () => {
  const save = vi.fn(async (): Promise<void> => undefined);
  let release!: () => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(AgentSettings, {
        decisionTimeSeconds: 1,
        blockedWords: [],
        onSave: save,
      }),
    ),
  );
  const input = container.querySelector('input')!;
  const change = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await change('0');
  expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain('greater than zero');
  await change('5.1');
  expect(save).not.toHaveBeenCalled();
  await change('0.5');
  expect(save).toHaveBeenCalledWith({ decisionTimeSeconds: 0.5 });
  await change('2');
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  await act(async () => release());
  expect(save).toHaveBeenLastCalledWith({ decisionTimeSeconds: 2 });
});
