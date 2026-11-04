// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StudyComposer,
  type StudyComposerProps,
  type StudyDictationControlProps,
} from '../components/study-composer';
import type { StudyAttachment } from '../components/study-composer';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

const defaultProps = (
  overrides: Partial<StudyComposerProps> = {},
): StudyComposerProps => ({
  sessionId: 'session-1',
  initialDraft: { text: '', revision: 0 },
  offline: false,
  activeTurn: null,
  failedTurnId: null,
  onSaveDraft: vi.fn(async (_text, expectedDraftRevision) => ({
    draftRevision: expectedDraftRevision + 1,
  })),
  onSend: vi.fn(async () => ({ turnId: 'turn-1', draftRevision: 2 })),
  onStop: vi.fn(async () => undefined),
  onRetry: vi.fn(async () => undefined),
  onAddAttachments: vi.fn(async () => []),
  onRefreshAttachment: vi.fn(async (attachment) => attachment),
  ...overrides,
});

const mount = async (props: StudyComposerProps) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(StudyComposer, props)));
  return container;
};

const changeText = async (input: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const click = async (button: HTMLButtonElement) =>
  act(async () => button.click());

const drain = async () => {
  for (let hop = 0; hop < 8; hop += 1) await Promise.resolve();
};

const readyAttachment: StudyAttachment = {
  itemId: 'item-ready',
  title: 'Lecture notes',
  status: 'complete',
  provenance: 'user-uploaded',
  versionId: 'version-1',
  sourceRemoved: false,
};

const unavailableAttachment: StudyAttachment = {
  itemId: 'item-unreadable',
  title: 'Unreadable scan',
  status: 'unreadable',
  provenance: 'user-uploaded',
  versionId: null,
  sourceRemoved: false,
};

describe('StudyComposer', () => {
  it('shows an explicit unavailable state when no dictation runtime is provided', async () => {
    const node = await mount(defaultProps());

    expect(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Dictation unavailable"]',
      )?.disabled,
    ).toBe(true);
  });

  it('allows sending again after the session returns online', async () => {
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('offline'), { code: 'offline' }),
      )
      .mockResolvedValue({ turnId: 'turn-1', draftRevision: 2 });
    const props = defaultProps({ onSend });
    const node = await mount(props);
    const input = node.querySelector('textarea')!;
    await changeText(input, 'Try again when connected');
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]',
      )!,
    );
    await act(drain);

    await act(async () => {
      root?.render(createElement(StudyComposer, { ...props, offline: true }));
    });
    await act(async () => {
      root?.render(createElement(StudyComposer, { ...props, offline: false }));
    });

    const sendButton = node.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]',
    )!;
    expect(sendButton.disabled).toBe(false);
    await click(sendButton);
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('clears the sent text and attachments but keeps files added during sending', async () => {
    let resolveSend:
      | ((result: { turnId: string; draftRevision: number }) => void)
      | undefined;
    const onSend = vi.fn(
      () =>
        new Promise<{ turnId: string; draftRevision: number }>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const onAddAttachments = vi
      .fn()
      .mockResolvedValueOnce([readyAttachment])
      .mockResolvedValueOnce([
        { ...readyAttachment, itemId: 'item-next', title: 'Next notes' },
      ]);
    const node = await mount(defaultProps({ onAddAttachments, onSend }));
    const addButton = node.querySelector<HTMLButtonElement>(
      'button[aria-label="Add attachment"]',
    )!;
    await click(addButton);
    await act(drain);
    const input = node.querySelector<HTMLTextAreaElement>('textarea')!;
    await changeText(input, 'Explain these notes');
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]',
      )!,
    );
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await click(addButton);
    await act(drain);
    await act(async () => {
      resolveSend?.({ turnId: 'turn-1', draftRevision: 2 });
      await drain();
    });

    expect(input.value).toBe('');
    expect(node.textContent).not.toContain('Lecture notes');
    expect(node.textContent).toContain('Next notes');
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIds: ['item-ready'] }),
    );
  });

  it('sends on Enter and keeps Shift+Enter available for a newline', async () => {
    const props = defaultProps();
    const node = await mount(props);
    const input = node.querySelector('textarea')!;
    await changeText(input, 'Explain mitosis');

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(enter));
    await act(drain);

    expect(enter.defaultPrevented).toBe(true);
    expect(props.onSend).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Explain mitosis', attachmentIds: [] }),
    );

    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(shiftEnter));
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(props.onSend).toHaveBeenCalledOnce();
  });

  it('never sends while an IME composition is committing Enter', async () => {
    const props = defaultProps();
    const node = await mount(props);
    const input = node.querySelector('textarea')!;
    await changeText(input, '日本語');

    const composingEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    await act(async () => input.dispatchEvent(composingEnter));

    expect(composingEnter.defaultPrevented).toBe(false);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('prevents duplicate sends while the first logical request is pending', async () => {
    let releaseSend: () => void = () => {};
    const onSend = vi.fn(
      () =>
        new Promise<{ turnId: string; draftRevision: number }>((resolve) => {
          releaseSend = () => resolve({ turnId: 'turn-1', draftRevision: 2 });
        }),
    );
    const node = await mount(defaultProps({ onSend }));
    const input = node.querySelector('textarea')!;
    await changeText(input, 'One request only');
    const send = node.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]',
    )!;

    await act(async () => {
      send.click();
      send.click();
      await Promise.resolve();
    });
    await act(drain);

    expect(onSend).toHaveBeenCalledOnce();
    await act(async () => releaseSend());
    await act(drain);
  });

  it('sends one stop command while a response is active', async () => {
    let releaseStop: () => void = () => {};
    const onStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    );
    const node = await mount(
      defaultProps({
        activeTurn: {
          id: 'turn-1',
          sessionId: 'session-1',
          status: 'generating',
          attemptNumber: 1,
          errorCode: null,
          startedAt: '2026-11-03T12:00:00.000Z',
          settledAt: null,
        },
        onStop,
      }),
    );
    const stopButton = node.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop response"]',
    )!;

    await act(async () => {
      stopButton.click();
      stopButton.click();
      await Promise.resolve();
    });

    expect(onStop).toHaveBeenCalledOnce();
    await act(async () => releaseStop());
    await act(drain);
  });

  it('preserves newer text typed while an accepted send is pending', async () => {
    let releaseSend: () => void = () => {};
    const onSend = vi.fn(
      () =>
        new Promise<{ turnId: string; draftRevision: number }>((resolve) => {
          releaseSend = () => resolve({ turnId: 'turn-1', draftRevision: 3 });
        }),
    );
    const node = await mount(defaultProps({ onSend }));
    const input = node.querySelector('textarea')!;
    await changeText(input, 'Submitted text');

    await act(async () => {
      node
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!
        .click();
      await Promise.resolve();
    });
    await changeText(input, 'Newer draft');
    await act(async () => releaseSend());
    await act(drain);

    expect(input.value).toBe('Newer draft');
  });

  it('keeps the draft after send failure and disables sending when offline', async () => {
    const onSend = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'offline' });
    });
    const node = await mount(defaultProps({ onSend }));
    const input = node.querySelector('textarea')!;
    await changeText(input, 'Please explain the diagram');
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]',
      )!,
    );
    await act(drain);

    expect(input.value).toBe('Please explain the diagram');
    expect(node.textContent).toContain('offline');

    act(() => root?.unmount());
    root = undefined;
    const offlineNode = await mount(defaultProps({ offline: true }));
    expect(
      offlineNode.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]',
      )?.disabled,
    ).toBe(true);
    expect(offlineNode.textContent).toContain('Connect to send');
  });

  it('shows attachment status and provenance, and sends only ready selections', async () => {
    const onAddAttachments = vi.fn(async () => [
      readyAttachment,
      unavailableAttachment,
    ]);
    const onSend = vi.fn(async () => ({ turnId: 'turn-1', draftRevision: 2 }));
    const node = await mount(defaultProps({ onAddAttachments, onSend }));
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Add attachment"]',
      )!,
    );

    expect(node.textContent).toContain('Lecture notes');
    expect(node.textContent).toContain('Unreadable');
    expect(node.textContent).toContain('Uploaded');

    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Remove Unreadable scan from message"]',
      )!,
    );
    await changeText(node.querySelector('textarea')!, 'Use the notes');
    await click(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]',
      )!,
    );
    await act(drain);

    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Use the notes',
        attachmentIds: ['item-ready'],
      }),
    );
  });

  it('inserts a final transcript at its captured selection without sending', async () => {
    let dictationProps: StudyDictationControlProps | undefined;
    const renderDictation = (props: StudyDictationControlProps) => {
      dictationProps = props;
      return createElement('button', { type: 'button' }, 'Dictation');
    };
    const onSend = vi.fn(async () => ({ turnId: 'turn-1', draftRevision: 2 }));
    const node = await mount(defaultProps({ renderDictation, onSend }));
    const input = node.querySelector('textarea')!;
    await changeText(input, 'start end');
    await act(async () => {
      input.setSelectionRange(6, 9);
      input.dispatchEvent(new Event('select', { bubbles: true }));
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const captured = dictationProps!;
    await act(async () =>
      captured.onFinal({
        text: 'middle',
        composerRevision: captured.composerRevision,
        selection: captured.selection,
      }),
    );

    expect(input.value).toBe('start middle');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('ignores late dictation events after the composer unmounts', async () => {
    vi.useFakeTimers();
    let dictationProps: StudyDictationControlProps | undefined;
    const onSaveDraft = vi.fn(async (_text: string, revision: number) => ({
      draftRevision: revision + 1,
    }));
    await mount(
      defaultProps({
        onSaveDraft,
        renderDictation: (props) => {
          dictationProps = props;
          return createElement('button', { type: 'button' }, 'Dictation');
        },
      }),
    );
    const captured = dictationProps!;
    await act(async () => {
      root?.unmount();
      root = undefined;
    });
    await act(async () => {
      captured.onFinal({
        text: 'late transcript',
        composerRevision: captured.composerRevision,
        selection: { start: 0, end: 0 },
      });
      await vi.advanceTimersByTimeAsync(500);
      await drain();
    });

    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it('offers an explicit recovery when the draft changed during dictation', async () => {
    let dictationProps: StudyDictationControlProps | undefined;
    const renderDictation = (props: StudyDictationControlProps) => {
      dictationProps = props;
      return createElement('button', { type: 'button' }, 'Dictation');
    };
    const props = defaultProps({ renderDictation });
    const node = await mount(props);
    const input = node.querySelector('textarea')!;
    await changeText(input, 'Typed before dictation');
    const captured = dictationProps!;
    await changeText(input, 'Edited while dictating');
    await act(async () =>
      captured.onFinal({
        text: 'spoken words',
        composerRevision: captured.composerRevision,
        selection: captured.selection,
      }),
    );

    expect(input.value).toBe('Edited while dictating');
    expect(node.textContent).toContain('Insert dictated text');
    expect(node.textContent).toContain('spoken words');
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('flushes a pending autosave when the composer leaves the session', async () => {
    vi.useFakeTimers();
    const props = defaultProps();
    const node = await mount(props);
    await changeText(node.querySelector('textarea')!, 'Keep this draft');
    expect(props.onSaveDraft).not.toHaveBeenCalled();

    act(() => root?.unmount());
    root = undefined;
    await act(drain);

    expect(props.onSaveDraft).toHaveBeenCalledWith('Keep this draft', 0);
  });

  it('keeps the saved draft readable while host read-only mode blocks composer writes', async () => {
    vi.useFakeTimers();
    const onSaveDraft = vi.fn(async (_text: string, revision: number) => ({
      draftRevision: revision + 1,
    }));
    const onSend = vi.fn(async () => ({ turnId: 'turn-1', draftRevision: 2 }));
    const onAddAttachments = vi.fn(async () => [readyAttachment]);
    const onRetry = vi.fn(async () => undefined);
    const renderDictation = vi.fn(() => createElement('button', null, 'Mic'));
    const props = defaultProps({
      initialDraft: { text: 'Saved study question', revision: 4 },
      readOnly: true,
      failedTurnId: 'turn-1',
      onSaveDraft,
      onSend,
      onAddAttachments,
      onRetry,
      renderDictation,
    });
    const node = await mount(props);
    const input = node.querySelector<HTMLTextAreaElement>('textarea')!;
    const send = node.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"]',
    )!;
    const attach = node.querySelector<HTMLButtonElement>(
      'button[aria-label="Add attachment"]',
    )!;
    const retry = [...node.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Retry response'),
    )!;

    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('Saved study question');
    expect(send.disabled).toBe(true);
    expect(attach.disabled).toBe(true);
    expect(retry.disabled).toBe(true);
    expect(renderDictation).not.toHaveBeenCalled();

    await changeText(input, 'Attempted offline edit');
    await click(send);
    await click(attach);
    await click(retry);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(input.value).toBe('Saved study question');
    expect(onSaveDraft).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onAddAttachments).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('keeps an in-flight draft save pending across a read-only transition', async () => {
    vi.useFakeTimers();
    let resolveSave!: (value: { draftRevision: number }) => void;
    const onSaveDraft = vi.fn(
      () =>
        new Promise<{ draftRevision: number }>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const props = defaultProps({ onSaveDraft });
    const node = await mount(props);
    await changeText(node.querySelector('textarea')!, 'Pending draft');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(onSaveDraft).toHaveBeenCalledOnce();

    await act(async () =>
      root?.render(createElement(StudyComposer, { ...props, readOnly: true })),
    );
    expect(node.querySelector('[role="status"]')?.textContent).toContain(
      'Saving draft',
    );

    await act(async () => resolveSave({ draftRevision: 1 }));
    await vi.waitFor(() => {
      expect(
        node.querySelector('#study-composer-status .sr-only')?.textContent,
      ).toBe('Draft saved');
    });
    expect(onSaveDraft).toHaveBeenCalledOnce();
  });

  it('saves a preserved draft after reconnecting from host read-only mode', async () => {
    vi.useFakeTimers();
    const onSaveDraft = vi.fn(async (_text: string, revision: number) => ({
      draftRevision: revision + 1,
    }));
    const props = defaultProps({
      initialDraft: { text: 'Saved draft', revision: 2 },
      onSaveDraft,
    });
    const node = await mount(props);
    await changeText(node.querySelector('textarea')!, 'Pending offline draft');

    await act(async () =>
      root?.render(createElement(StudyComposer, { ...props, readOnly: true })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onSaveDraft).not.toHaveBeenCalled();
    expect(node.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'Pending offline draft',
    );

    await act(async () => root?.render(createElement(StudyComposer, props)));
    await act(async () => vi.advanceTimersByTimeAsync(500));

    expect(onSaveDraft).toHaveBeenCalledOnce();
    expect(onSaveDraft).toHaveBeenCalledWith('Pending offline draft', 2);
  });
});

it('keeps the idle composer plain without redundant help or saved indicators', async () => {
  const node = await mount(defaultProps());
  expect(node.textContent).not.toContain(
    'Enter a message or attach a readable file.',
  );
  expect(
    node.querySelector('#study-composer-status .sr-only')?.textContent,
  ).toBe('Draft saved');
  expect(node.querySelector('textarea')?.className).toContain('resize-none');
  expect(node.querySelector('[data-slot="input-group"]')?.className).toContain(
    'border-0',
  );
  expect(
    node.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
      ?.disabled,
  ).toBe(true);
});

it('shows an accessible quiet save icon inside the composer toolbar', async () => {
  const node = await mount(defaultProps());
  const status = node.querySelector('#study-composer-status')!;
  expect(status.closest('[data-slot="input-group-addon"]')).not.toBeNull();
  expect(status.querySelector('svg')).not.toBeNull();
  expect(status.querySelector('.sr-only')?.textContent).toBe('Draft saved');
});

it('disables hosted dictation while the session is offline even with browser connectivity', async () => {
  let captured: StudyDictationControlProps | undefined;
  await mount(
    defaultProps({
      offline: true,
      renderDictation: (props) => {
        captured = props;
        return null;
      },
    }),
  );
  expect(captured?.disabled).toBe(true);
});
