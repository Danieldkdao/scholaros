// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GradeSettings as GradeSettingsValue } from '@scholaros/services/learning/grade-contracts';
import { GradeSettings } from '../components/grade-settings';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const settings: GradeSettingsValue = {
  enabled: false,
  notes: '',
  revision: 0,
  collectedCount: 3,
  updatedAt: '2026-11-03T12:00:00.000Z',
};

const mount = async (onSave = vi.fn(async () => settings)) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(GradeSettings, {
        accountId: 'student-a',
        settings,
        onSave,
      }),
    );
  });
  return { container, root, onSave };
};

const click = (element: Element) =>
  act(async () =>
    element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );

const changeTextarea = (element: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });

it('starts with grade access off and auto-saves a user toggle', async () => {
  const onSave = vi.fn(async () => settings);
  const { container, root } = await mount(onSave);
  const toggle = container.querySelector('[role="switch"]')!;

  expect(toggle.getAttribute('aria-checked')).toBe('false');
  await click(toggle);
  await vi.waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({ enabled: true, notes: '' }),
  );
  await act(async () => root.unmount());
});

it('shows optional notes only when enabled and saves a valid edit', async () => {
  const onSave = vi.fn(async () => settings);
  const { container, root } = await mount(onSave);
  await click(container.querySelector('[role="switch"]')!);
  const notes = container.querySelector('textarea')!;
  expect(notes).not.toBeNull();

  await changeTextarea(notes, 'Use only the Biology course');
  await vi.waitFor(() =>
    expect(onSave).toHaveBeenLastCalledWith({
      enabled: true,
      notes: 'Use only the Biology course',
    }),
  );
  await act(async () => root.unmount());
});

it('refreshes the collected grade count when settings change for the same account', async () => {
  const { container, root, onSave } = await mount();
  await act(async () =>
    root.render(
      createElement(GradeSettings, {
        accountId: 'student-a',
        settings: { ...settings, collectedCount: 0, revision: 1 },
        onSave,
      }),
    ),
  );

  expect(container.textContent).toContain('Collected grade records: 0');
  await act(async () => root.unmount());
});

it('requires explicit confirmation before deleting collected grade data', async () => {
  const onSave = vi.fn(async () => settings);
  const { container, root } = await mount(onSave);
  await click(
    container.querySelector('[aria-label="Delete collected grade data"]')!,
  );

  expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(onSave).not.toHaveBeenCalled();
  await click(document.body.querySelector('[data-confirm-grade-deletion]')!);
  await vi.waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({
      enabled: false,
      notes: '',
      deleteCollected: true,
    }),
  );
  await act(async () => root.unmount());
});
