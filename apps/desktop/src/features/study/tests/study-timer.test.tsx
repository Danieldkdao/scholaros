// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  StudyTimer,
  StudyTimerResolution,
  type StudyTimerActions,
} from '../components/study-timer';
import type { StudyTimerDTO } from '@scholaros/services/learning/study-contracts';

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

const makeTimer = (overrides: Partial<StudyTimerDTO> = {}): StudyTimerDTO => ({
  deadlineAt: '2026-11-03T12:15:00.000Z',
  revision: 2,
  expiredRevision: null,
  resolvedExpiredRevision: null,
  finishedAt: null,
  ...overrides,
});

const mount = async (node: ReactNode) => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement('div', null, node)));
  return container;
};

const changeNumber = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const actions = (
  overrides: Partial<StudyTimerActions> = {},
): StudyTimerActions => ({
  reconcile: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
  extend: vi.fn(async (_durationMinutes: number) => undefined),
  continueUntimed: vi.fn(async () => undefined),
  ...overrides,
});

it('derives the countdown from the absolute deadline as wall-clock time passes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T12:00:00.000Z'));
  const node = await mount(
    createElement(StudyTimer, {
      sessionId: 'session-1',
      timer: makeTimer(),
      actions: actions(),
    }),
  );
  expect(node.textContent).toContain('15 min left');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });

  expect(node.textContent).toContain('14 min left');
});

it('reconciles an elapsed deadline once for the same timer revision', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T12:14:59.000Z'));
  const timerActions = actions();
  const node = await mount(
    createElement(StudyTimer, {
      sessionId: 'session-1',
      timer: makeTimer(),
      actions: timerActions,
    }),
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });

  expect(node.textContent).toContain('Time is up');
  expect(timerActions.reconcile).toHaveBeenCalledOnce();
});

it('shows one persisted expiry summary with Finish, custom Extend, and untimed actions', async () => {
  const timerActions = actions();
  const node = await mount(
    createElement(StudyTimerResolution, {
      timer: makeTimer({ expiredRevision: 2 }),
      summary: 'Your planned study time has ended.',
      actions: timerActions,
    }),
  );

  expect(
    node.querySelectorAll('[data-slot="study-timer-expiry-summary"]'),
  ).toHaveLength(1);
  expect(node.textContent).toContain('Your planned study time has ended.');
  expect(node.textContent).toContain('Finish session');
  expect(node.textContent).toContain('Extend session');
  expect(node.textContent).toContain('Continue without timer');

  await changeNumber(
    node.querySelector<HTMLInputElement>(
      'input[aria-label="Extension in minutes"]',
    )!,
    '30',
  );
  await act(async () =>
    node
      .querySelector<HTMLButtonElement>('button[aria-label="Extend session"]')!
      .click(),
  );

  expect(timerActions.extend).toHaveBeenCalledWith(30);
});

it('does not repeat resolution controls for a persisted resolved timer revision', async () => {
  const node = await mount(
    createElement(StudyTimerResolution, {
      timer: makeTimer({ expiredRevision: 2, resolvedExpiredRevision: 2 }),
      summary: 'Your planned study time has ended.',
      actions: actions(),
    }),
  );

  expect(
    node.querySelector('[data-slot="study-timer-expiry-summary"]'),
  ).toBeNull();
});

it('keeps the expiry summary and actions available after a command fails', async () => {
  const timerActions = actions({
    continueUntimed: vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'offline' });
    }),
  });
  const node = await mount(
    createElement(StudyTimerResolution, {
      timer: makeTimer({ expiredRevision: 2 }),
      summary: 'Your planned study time has ended.',
      actions: timerActions,
    }),
  );

  await act(async () =>
    node
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Continue without timer"]',
      )!
      .click(),
  );
  await act(async () => {
    for (let hop = 0; hop < 4; hop += 1) await Promise.resolve();
  });

  expect(
    node.querySelector('[data-slot="study-timer-expiry-summary"]'),
  ).not.toBeNull();
  expect(node.textContent).toContain('Reconnect and retry');
  expect(node.textContent).toContain('Your planned study time has ended.');
});

it('keeps timer status visible without reconciling persisted time while host read-only', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T12:20:00.000Z'));
  const timerActions = actions();
  const node = await mount(
    createElement(StudyTimer, {
      sessionId: 'session-1',
      timer: makeTimer(),
      actions: timerActions,
      readOnly: true,
    }),
  );

  expect(node.textContent).toContain('Time is up');
  expect(timerActions.reconcile).not.toHaveBeenCalled();
});

it('shows the expiry summary but blocks every timer mutation in host read-only mode', async () => {
  const timerActions = actions();
  const node = await mount(
    createElement(StudyTimerResolution, {
      timer: makeTimer({ expiredRevision: 2 }),
      summary: 'Your planned study time has ended.',
      actions: timerActions,
      readOnly: true,
    }),
  );
  const extension = node.querySelector<HTMLInputElement>(
    'input[aria-label="Extension in minutes"]',
  )!;
  const finish = [...node.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.includes('Finish session'),
  )!;
  const extend = node.querySelector<HTMLButtonElement>(
    'button[aria-label="Extend session"]',
  )!;
  const untimed = node.querySelector<HTMLButtonElement>(
    'button[aria-label="Continue without timer"]',
  )!;

  expect(node.textContent).toContain('Your planned study time has ended.');
  expect(extension.disabled).toBe(true);
  expect(finish.disabled).toBe(true);
  expect(extend.disabled).toBe(true);
  expect(untimed.disabled).toBe(true);

  await act(async () => {
    finish.click();
    extend.click();
    untimed.click();
  });
  expect(timerActions.finish).not.toHaveBeenCalled();
  expect(timerActions.extend).not.toHaveBeenCalled();
  expect(timerActions.continueUntimed).not.toHaveBeenCalled();
});

it('uses a compact transparent resolution with an inline extension and one primary continuation', async () => {
  const node = await mount(
    createElement(StudyTimerResolution, {
      timer: makeTimer({ expiredRevision: 2 }),
      summary: 'Keep learning when you are ready.',
      actions: actions(),
    }),
  );
  const panel = node.querySelector('[data-slot="study-timer-expiry-summary"]')!;
  expect(panel.querySelector('[data-slot="card"]')).toBeNull();
  expect(panel.className).not.toContain('bg-');
  expect(panel.className).not.toContain('border');
  const extension = panel.querySelector('[data-slot="study-timer-extension"]')!;
  expect(extension.className).toContain('items-center');
  expect(extension.querySelector('input')?.className).toContain('w-20');
  expect(
    extension.querySelector('button[aria-label="Extend session"]'),
  ).not.toBeNull();
  const primary = panel.querySelector(
    'button[aria-label="Continue without timer"]',
  )!;
  expect(primary.className).toContain('bg-primary');
  const finish = [...panel.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Finish session'),
  )!;
  expect(finish.className).toContain('bg-secondary');
});
