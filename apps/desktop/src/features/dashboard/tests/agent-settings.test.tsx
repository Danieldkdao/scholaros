// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AgentSettings } from '../agent-settings';
import type { SettingsUpdateSchema } from '../../onboarding/schemas';

const mountSettings = async (
  accountId: string,
  onSave: (changes: SettingsUpdateSchema) => Promise<void>,
  persisted = { decisionTimeSeconds: 1, blockedWords: [] as string[] },
) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(AgentSettings, {
        accountId,
        decisionTimeSeconds: persisted.decisionTimeSeconds,
        blockedWords: persisted.blockedWords,
        onSave,
      }),
    ),
  );
  return { container, root };
};

const changeDecisionTime = async (container: HTMLElement, value: string) =>
  act(async () => {
    const input = container.querySelector('input')!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const changeBlockedWords = async (container: HTMLElement, value: string) =>
  act(async () => {
    const input = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

it('serializes pending saves across settings remounts', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: Array<{
    changes: SettingsUpdateSchema;
    release: () => void;
    reject: (error: Error) => void;
  }> = [];
  const save = vi.fn(
    (changes: SettingsUpdateSchema) =>
      new Promise<void>((resolve, reject) => {
        pending.push({
          changes,
          release: resolve,
          reject: (error) => reject(error),
        });
      }),
  );
  const firstContainer = document.createElement('div');
  const firstRoot = createRoot(firstContainer);
  const mount = (root: ReturnType<typeof createRoot>) =>
    root.render(
      createElement(AgentSettings, {
        accountId: 'student-a',
        decisionTimeSeconds: 1,
        blockedWords: [],
        onSave: save,
      }),
    );
  await act(async () => mount(firstRoot));
  const change = async (container: HTMLElement, value: string) =>
    act(async () => {
      const input = container.querySelector('input')!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

  await change(firstContainer, '0');
  expect(save).not.toHaveBeenCalled();
  expect(firstContainer.textContent).toContain('0.5 to 5 seconds');
  await change(firstContainer, '0.4');
  expect(save).not.toHaveBeenCalled();
  await change(firstContainer, '5.1');
  expect(save).not.toHaveBeenCalled();
  await change(firstContainer, '0.5');
  await change(firstContainer, '2');
  expect(save).toHaveBeenCalledTimes(1);

  await act(async () => firstRoot.unmount());
  const secondContainer = document.createElement('div');
  const secondRoot = createRoot(secondContainer);
  await act(async () => mount(secondRoot));
  await change(secondContainer, '3');
  expect(save).toHaveBeenCalledTimes(1);

  await act(async () => pending[0]!.reject(new Error('Temporary failure')));
  expect(save).toHaveBeenCalledTimes(2);
  expect(pending[1]!.changes).toEqual({ decisionTimeSeconds: 2 });
  expect(secondContainer.textContent).toContain('Saving settings');
  await act(async () => pending[1]!.release());
  expect(save).toHaveBeenCalledTimes(3);
  expect(pending[2]!.changes).toEqual({ decisionTimeSeconds: 3 });
  expect(secondContainer.textContent).toContain('Saving settings');
  await act(async () => pending[2]!.release());
  expect(secondContainer.textContent).toContain('Settings saved');
  expect(pending.map(({ changes }) => changes)).toEqual([
    { decisionTimeSeconds: 0.5 },
    { decisionTimeSeconds: 2 },
    { decisionTimeSeconds: 3 },
  ]);
  await act(async () => secondRoot.unmount());
});

it('labels navigation delay and enforces the supported range', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const save = vi.fn(async () => undefined);
  const { container, root } = await mountSettings('student-delay-range', save);
  const input = container.querySelector('input')!;

  expect(container.textContent).toContain('Navigation delay in seconds');
  expect(input.min).toBe('0.5');
  expect(input.max).toBe('5');
  expect(input.step).toBe('0.1');
  await changeDecisionTime(container, '0.4');
  expect(save).not.toHaveBeenCalled();
  expect(container.textContent).toContain('0.5 to 5 seconds');
  await changeDecisionTime(container, '5.1');
  expect(save).not.toHaveBeenCalled();
  await changeDecisionTime(container, '0.5');
  expect(save).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
});

it('keeps queued settings writes bound to their account', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: Array<{
    accountId: string;
    changes: SettingsUpdateSchema;
    release: () => void;
  }> = [];
  const save = vi.fn(
    (accountId: string, changes: SettingsUpdateSchema) =>
      new Promise<void>((resolve) => {
        pending.push({ accountId, changes, release: resolve });
      }),
  );
  const mount = async (accountId: string) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(AgentSettings, {
          accountId,
          decisionTimeSeconds: 1,
          blockedWords: [],
          onSave: (changes) => save(accountId, changes),
        }),
      ),
    );
    return { container, root };
  };
  const change = async (container: HTMLElement, value: string) =>
    act(async () => {
      const input = container.querySelector('input')!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

  const first = await mount('student-a');
  await change(first.container, '0.5');
  await change(first.container, '2');
  await act(async () => first.root.unmount());

  const second = await mount('student-b');
  await change(second.container, '3');
  expect(
    pending.map(({ accountId, changes }) => ({ accountId, changes })),
  ).toEqual([
    { accountId: 'student-a', changes: { decisionTimeSeconds: 0.5 } },
    { accountId: 'student-b', changes: { decisionTimeSeconds: 3 } },
  ]);

  await act(async () => pending[0]!.release());
  expect(pending[2]).toMatchObject({
    accountId: 'student-a',
    changes: { decisionTimeSeconds: 2 },
  });
  await act(async () => {
    pending[1]!.release();
    pending[2]!.release();
    await second.root.unmount();
  });
});

it('restores pending save status when Settings reopens without another edit', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let release!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = await mountSettings('student-pending', save);
  await changeDecisionTime(first.container, '2');
  expect(first.container.textContent).toContain('Saving settings');
  await act(async () => first.root.unmount());

  const reopened = await mountSettings('student-pending', save);
  expect(reopened.container.querySelector('input')?.value).toBe('2');
  expect(reopened.container.textContent).toContain('Saving settings');
  await act(async () => release());
  expect(reopened.container.querySelector('input')?.value).toBe('2');
  expect(reopened.container.textContent).toContain('Settings saved');
  await act(async () => reopened.root.unmount());
});

it('restores a failed save and its error when Settings reopens without another edit', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let reject!: (error: Error) => void;
  const save = vi.fn(
    () =>
      new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  const first = await mountSettings('student-failed', save);
  await changeDecisionTime(first.container, '2');
  await act(async () => first.root.unmount());
  await act(async () =>
    reject(new Error('The settings service is unavailable.')),
  );

  const reopened = await mountSettings('student-failed', save);
  expect(reopened.container.querySelector('input')?.value).toBe('2');
  expect(reopened.container.textContent).toContain('Could not save settings');
  expect(reopened.container.textContent).toContain(
    'The settings service is unavailable.',
  );
  await act(async () => reopened.root.unmount());
});

it('does not let an older save overwrite a newer reopened edit', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: Array<{
    changes: SettingsUpdateSchema;
    release: () => void;
  }> = [];
  const save = vi.fn(
    (changes: SettingsUpdateSchema) =>
      new Promise<void>((resolve) =>
        pending.push({ changes, release: resolve }),
      ),
  );
  const first = await mountSettings('student-overlap', save);
  await changeDecisionTime(first.container, '2');
  await act(async () => first.root.unmount());

  const reopened = await mountSettings('student-overlap', save);
  expect(reopened.container.querySelector('input')?.value).toBe('2');
  await changeDecisionTime(reopened.container, '3');
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  expect(pending[0]?.changes).toEqual({ decisionTimeSeconds: 2 });

  await act(async () => pending[0]!.release());
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[1]?.changes).toEqual({ decisionTimeSeconds: 3 });
  expect(reopened.container.querySelector('input')?.value).toBe('3');
  expect(reopened.container.textContent).toContain('Saving settings');

  await act(async () => pending[1]!.release());
  expect(reopened.container.querySelector('input')?.value).toBe('3');
  expect(reopened.container.textContent).toContain('Settings saved');
  await act(async () => reopened.root.unmount());
});

it('preserves pending blocked-word edits when Settings reopens with stale props', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: Array<() => void> = [];
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  );
  const first = await mountSettings('student-words', save);
  await changeBlockedWords(first.container, 'quiz\nexam');
  await act(async () => first.root.unmount());

  const reopened = await mountSettings('student-words', save);
  expect(reopened.container.querySelector('textarea')?.value).toBe(
    'quiz\nexam',
  );
  await changeDecisionTime(reopened.container, '2');
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await act(async () => reopened.root.unmount());

  const reopenedAgain = await mountSettings('student-words', save);
  expect(reopenedAgain.container.querySelector('input')?.value).toBe('2');
  expect(reopenedAgain.container.querySelector('textarea')?.value).toBe(
    'quiz\nexam',
  );
  await act(async () => pending[0]!());
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => pending[1]!());
  expect(reopenedAgain.container.querySelector('textarea')?.value).toBe(
    'quiz\nexam',
  );
  await act(async () => reopenedAgain.root.unmount());
});

it('keeps draft values isolated to their account', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: Array<() => void> = [];
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  );
  const first = await mountSettings('student-draft-a', save);
  await changeDecisionTime(first.container, '2');
  await changeBlockedWords(first.container, 'quiz');
  await act(async () => first.root.unmount());

  const second = await mountSettings('student-draft-b', save);
  expect(second.container.querySelector('input')?.value).toBe('1');
  expect(second.container.querySelector('textarea')?.value).toBe('');
  await act(async () => pending[0]!());
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => {
    pending[1]!();
    await second.root.unmount();
  });
});

it('keeps a decision-time draft that reverts while an earlier save is pending', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: Array<{
    changes: SettingsUpdateSchema;
    release: () => void;
  }> = [];
  const save = vi.fn(
    (changes: SettingsUpdateSchema) =>
      new Promise<void>((resolve) =>
        pending.push({ changes, release: resolve }),
      ),
  );
  const first = await mountSettings('student-revert-time', save);
  await changeDecisionTime(first.container, '2');
  await changeDecisionTime(first.container, '1');
  expect(first.container.querySelector('input')?.value).toBe('1');
  expect(first.container.textContent).toContain('Saving settings');
  await act(async () => first.root.unmount());

  await act(async () => pending[0]!.release());
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(pending.map(({ changes }) => changes)).toEqual([
    { decisionTimeSeconds: 2 },
    { decisionTimeSeconds: 1 },
  ]);

  const reopened = await mountSettings('student-revert-time', save, {
    decisionTimeSeconds: 2,
    blockedWords: [],
  });
  expect(reopened.container.querySelector('input')?.value).toBe('1');
  expect(reopened.container.textContent).toContain('Saving settings');
  await act(async () => pending[1]!.release());
  expect(reopened.container.querySelector('input')?.value).toBe('1');
  expect(reopened.container.textContent).toContain('Settings saved');
  await act(async () => reopened.root.unmount());
});

it('keeps reverted blocked words while the first words save is pending', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const pending: Array<{
    changes: SettingsUpdateSchema;
    release: () => void;
  }> = [];
  const save = vi.fn(
    (changes: SettingsUpdateSchema) =>
      new Promise<void>((resolve) =>
        pending.push({ changes, release: resolve }),
      ),
  );
  const first = await mountSettings('student-revert-words', save);
  await changeBlockedWords(first.container, 'quiz');
  await changeBlockedWords(first.container, '');
  expect(first.container.querySelector('textarea')?.value).toBe('');
  expect(first.container.textContent).toContain('Saving settings');
  await act(async () => first.root.unmount());

  await act(async () => pending[0]!.release());
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(pending.map(({ changes }) => changes)).toEqual([
    { blockedWords: ['quiz'] },
    { blockedWords: [] },
  ]);

  const reopened = await mountSettings('student-revert-words', save, {
    decisionTimeSeconds: 1,
    blockedWords: ['quiz'],
  });
  expect(reopened.container.querySelector('textarea')?.value).toBe('');
  expect(reopened.container.textContent).toContain('Saving settings');
  await act(async () => pending[1]!.release());
  expect(reopened.container.querySelector('textarea')?.value).toBe('');
  expect(reopened.container.textContent).toContain('Settings saved');
  await act(async () => reopened.root.unmount());
});
