// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GradeSettingsSection } from '../components/grade-settings-section';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it('loads implemented grade settings and persists a toggle through the real bridge contract', async () => {
  const settings = {
    enabled: false,
    notes: '',
    revision: 4,
    collectedCount: 0,
    updatedAt: '2026-11-04T12:00:00.000Z',
  };
  const bridge = {
    getCurrentUser: vi.fn(async () => ({ id: 'student-a' })),
    getGradeSettings: vi.fn(async () => settings),
    saveGradeSettings: vi.fn(
      async (input: {
        enabled: boolean;
        notes: string;
        expectedRevision: number;
      }) => ({
        ...settings,
        enabled: input.enabled,
        notes: input.notes,
        revision: 5,
      }),
    ),
  };
  Object.defineProperty(window, 'scholar', {
    configurable: true,
    value: bridge,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(GradeSettingsSection, { accountId: 'student-a' }),
    );
  });
  expect(container.textContent).toContain('School grades');
  expect(container.textContent).not.toContain(
    'unavailable in the current build',
  );
  await act(async () => {
    container
      .querySelector('[role="switch"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(bridge.saveGradeSettings).toHaveBeenCalledWith({
    enabled: true,
    notes: '',
    expectedRevision: 4,
  });
  await act(async () => root.unmount());
  container.remove();
});

it('does not expose another account’s grade settings after an account change during loading', async () => {
  let resolve!: (value: unknown) => void;
  const bridge = {
    getCurrentUser: vi.fn(async () => ({ id: 'student-a' })),
    getGradeSettings: vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  };
  Object.defineProperty(window, 'scholar', {
    configurable: true,
    value: bridge,
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(GradeSettingsSection, { accountId: 'student-a' }),
    );
  });
  bridge.getCurrentUser.mockResolvedValue({ id: 'student-b' });
  await act(async () => {
    resolve({
      enabled: true,
      notes: 'Private old-account notes',
      revision: 4,
      collectedCount: 0,
      updatedAt: '2026-11-04T12:00:00.000Z',
    });
  });
  expect(container.textContent).not.toContain('Private old-account notes');
  expect(container.querySelector('[role="switch"]')).toBeNull();
  await act(async () => root.unmount());
});
