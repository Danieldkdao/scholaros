// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DictationControl } from '../components/dictation-control';
import type { ScholarBridge } from '../../onboarding/types';
import type { DictationEvent } from '../lib/transcript-state';

const roots: Array<ReturnType<typeof createRoot>> = [];
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  delete (window as Partial<Window>).scholar;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type ControlProps = {
  sessionId?: string;
  composerRevision?: number;
  selection?: { start: number; end: number };
  onProvisional?: (text: string | null) => void;
  onFinal?: (result: {
    text: string;
    composerRevision: number;
    selection: { start: number; end: number };
  }) => void;
  onCancel?: () => void;
};

const mountControl = async (props: ControlProps = {}) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onProvisional = props.onProvisional ?? vi.fn();
  const onFinal = props.onFinal ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  const render = (
    composerRevision = props.composerRevision ?? 2,
    sessionId = props.sessionId ?? 'session-a',
  ) =>
    root.render(
      createElement(DictationControl, {
        sessionId,
        composerRevision,
        selection: props.selection ?? { start: 0, end: 0 },
        onProvisional,
        onFinal,
        onCancel,
      }),
    );
  await act(async () => render());
  return { container, root, render, onProvisional, onFinal, onCancel };
};

const clickButton = async (name: string) =>
  act(async () => {
    const button = Array.from(document.body.querySelectorAll('button')).find(
      (candidate) =>
        candidate.getAttribute('aria-label') === name ||
        candidate.textContent?.trim() === name,
    );
    if (!button) throw new Error(`Could not find button ${name}.`);
    button.click();
  });

type WorkletCommand = { kind: 'credit' | 'stop' | 'cancel'; count?: number };
type WorkletReply =
  | { kind: 'stopped' }
  | { kind: 'chunk'; buffer: ArrayBuffer }
  | { kind: 'error'; code: 'unsupported' | 'limit-exceeded' };

class FakeAudioWorkletNode {
  static instance: FakeAudioWorkletNode | null = null;
  port = {
    onmessage: null as ((event: MessageEvent<WorkletReply>) => void) | null,
    close: vi.fn(),
    postMessage: (message: WorkletCommand) => {
      if (message.kind === 'stop' || message.kind === 'cancel')
        queueMicrotask(() =>
          this.port.onmessage?.({
            data: { kind: 'stopped' },
          } as MessageEvent<WorkletReply>),
        );
    },
  };
  connect = vi.fn();
  disconnect = vi.fn();

  constructor() {
    FakeAudioWorkletNode.instance = this;
  }
}

const installFakeMicrophone = () => {
  const trackListeners = new Map<string, Set<() => void>>();
  const track = {
    readyState: 'live',
    getSettings: () => ({ sampleRate: 48_000, channelCount: 1 }),
    stop: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      const listeners = trackListeners.get(type) ?? new Set<() => void>();
      listeners.add(listener);
      trackListeners.set(type, listeners);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      trackListeners.get(type)?.delete(listener);
    }),
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  class FakeAudioContext {
    sampleRate = 48_000;
    state: 'running' | 'closed' = 'running';
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => undefined) };
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => {
      this.state = 'closed';
    });
    createMediaStreamSource = vi.fn(() => source);
    createGain = vi.fn(() => gain);
  }
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', {
    onLine: true,
    mediaDevices: { getUserMedia },
  });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('crypto', { randomUUID: () => 'request-a' });
  return {
    track,
    stream,
    source,
    gain,
    getUserMedia,
    FakeAudioContext,
    emitTrackEvent: (type: string) => {
      for (const listener of trackListeners.get(type) ?? []) listener();
    },
  };
};

const installDictationBridge = (
  permission: 'granted' | 'denied' | 'unsupported' = 'granted',
) => {
  let listener: ((event: DictationEvent) => void) | null = null;
  const requestMicrophonePermission = vi.fn(async () => ({
    state: permission,
  }));
  const startDictation = vi.fn(async () => ({ operationId: 'operation-a' }));
  const appendDictationAudio = vi.fn(
    async ({ sequence }: { sequence: number }) => ({
      acceptedSequence: sequence,
    }),
  );
  const stopDictation = vi.fn(async () => {
    listener?.({
      version: 1,
      operationId: 'operation-a',
      sessionId: 'session-a',
      composerRevision: 2,
      sequence: 3,
      kind: 'final',
      text: 'Please explain this concept.',
    });
    listener?.({
      version: 1,
      operationId: 'operation-a',
      sessionId: 'session-a',
      composerRevision: 2,
      sequence: 4,
      kind: 'final',
      text: 'Please explain this concept.',
    });
  });
  const cancelDictation = vi.fn(async () => undefined);
  const onDictationEvent = vi.fn(
    (nextListener: (event: DictationEvent) => void) => {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
  );
  const bridge = {
    openMicrophoneSettings: vi.fn(async () => undefined),
    requestMicrophonePermission,
    startDictation,
    appendDictationAudio,
    stopDictation,
    cancelDictation,
    onDictationEvent,
    sendStudyTurn: vi.fn(),
  };
  window.scholar = bridge as unknown as ScholarBridge;
  return {
    bridge,
    emit: (event: DictationEvent) => listener?.(event),
    getListener: () => listener,
  };
};

it('explains transmission before requesting microphone permission', async () => {
  const { bridge } = installDictationBridge('denied');
  const { container } = await mountControl();

  expect(bridge.requestMicrophonePermission).not.toHaveBeenCalled();
  await clickButton('Start dictation');
  expect(document.body.textContent).toContain('sent to Meta');
  expect(bridge.requestMicrophonePermission).not.toHaveBeenCalled();

  await clickButton('Start recording');
  expect(bridge.requestMicrophonePermission).toHaveBeenCalledOnce();
  expect(bridge.requestMicrophonePermission).toHaveBeenCalledWith({
    sessionId: 'session-a',
  });
  expect(container.textContent).toContain('Privacy & Security → Microphone');
  await clickButton('Open microphone settings');
  expect(bridge.openMicrophoneSettings).toHaveBeenCalledOnce();
  expect(bridge.requestMicrophonePermission).toHaveBeenCalledOnce();
});

it('shows a useful settings failure without requesting capture again', async () => {
  const { bridge } = installDictationBridge('denied');
  const { container } = await mountControl();
  await clickButton('Start dictation');
  await clickButton('Start recording');
  bridge.openMicrophoneSettings.mockRejectedValueOnce(
    new Error('private detail'),
  );
  await clickButton('Open microphone settings');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Open System Settings',
  );
  expect(container.textContent).not.toContain('private detail');
  expect(bridge.requestMicrophonePermission).toHaveBeenCalledOnce();
});

it('disables dictation while offline without requesting microphone access', async () => {
  const { bridge } = installDictationBridge();
  const getUserMedia = vi.fn();
  vi.stubGlobal('navigator', { onLine: false, mediaDevices: { getUserMedia } });
  const { container } = await mountControl();
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Start dictation"]',
  )!;
  expect(button.disabled).toBe(true);
  await clickButton('Start dictation');
  expect(document.body.textContent).not.toContain(
    'Dictation sends audio to Meta',
  );
  expect(bridge.requestMicrophonePermission).not.toHaveBeenCalled();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('Dictation is ready.');
});

it('shows one enabled microphone without a ready badge or tooltip when idle', async () => {
  installDictationBridge();
  const { container } = await mountControl();
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Start dictation"]',
  )!;
  expect(button.disabled).toBe(false);
  expect(button.getAttribute('data-slot')).toBe('button');
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.textContent).not.toContain('Dictation is ready.');
});

it('stops capture if the connection drops while listening', async () => {
  const microphone = installFakeMicrophone();
  const { bridge } = installDictationBridge();
  const { container } = await mountControl();

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  await act(async () => window.dispatchEvent(new Event('offline')));
  await vi.waitFor(() => expect(bridge.cancelDictation).toHaveBeenCalledOnce());

  expect(microphone.track.stop).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Reconnect to transcribe speech');
});

it('stops capture when microphone permission is revoked', async () => {
  const microphone = installFakeMicrophone();
  const { bridge } = installDictationBridge();
  const { container } = await mountControl();

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  await act(async () => microphone.emitTrackEvent('mute'));
  await vi.waitFor(() => expect(bridge.cancelDictation).toHaveBeenCalledOnce());

  expect(microphone.track.stop).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Privacy & Security → Microphone');
});

it('preserves the draft when no microphone device is available', async () => {
  const microphone = installFakeMicrophone();
  microphone.getUserMedia.mockRejectedValue(
    new DOMException('No microphone found.', 'NotFoundError'),
  );
  const { bridge } = installDictationBridge();
  const { container } = await mountControl();

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('A microphone is unavailable'),
  );

  expect(bridge.requestMicrophonePermission).toHaveBeenCalledOnce();
  expect(bridge.startDictation).not.toHaveBeenCalled();
  expect(container.textContent).toContain('A microphone is unavailable');
});

it('keeps the captured selection and revision and exposes one editable final', async () => {
  const microphone = installFakeMicrophone();
  microphone.source.disconnect.mockImplementation(() => {
    throw new Error('Source already disconnected.');
  });
  const { bridge, emit } = installDictationBridge();
  const composer = document.createElement('textarea');
  composer.value = 'typed before capture';
  document.body.append(composer);
  composer.focus();
  composer.setSelectionRange(3, 7);
  const onFinal = vi.fn();
  const onProvisional = vi.fn();
  const { render } = await mountControl({
    selection: { start: 3, end: 7 },
    onFinal,
    onProvisional,
  });

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  await act(async () => {
    emit({
      version: 1,
      operationId: 'operation-a',
      sessionId: 'session-a',
      composerRevision: 2,
      sequence: 1,
      kind: 'partial',
      text: 'Please explain',
    });
    emit({
      version: 1,
      operationId: 'operation-a',
      sessionId: 'session-a',
      composerRevision: 2,
      sequence: 2,
      kind: 'partial',
      text: 'Please explain this concept',
    });
  });
  await act(async () => render());
  bridge.stopDictation.mockImplementation(async () => undefined);
  await clickButton('Stop dictation');
  await vi.waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledOnce());
  expect(microphone.track.stop).toHaveBeenCalledOnce();
  await act(async () =>
    emit({
      version: 1,
      operationId: 'operation-a',
      sessionId: 'session-a',
      composerRevision: 2,
      sequence: 3,
      kind: 'final',
      text: 'Please explain this concept.',
    }),
  );
  await vi.waitFor(() => expect(onFinal).toHaveBeenCalledOnce());

  expect(onProvisional.mock.calls.map(([text]) => text)).toEqual([
    'Please explain',
    'Please explain this concept',
    null,
  ]);
  expect(onFinal).toHaveBeenCalledWith({
    text: 'Please explain this concept.',
    composerRevision: 2,
    selection: { start: 3, end: 7 },
  });
  expect(bridge.sendStudyTurn).not.toHaveBeenCalled();
  expect(composer.value).toBe('typed before capture');
  expect(microphone.track.stop).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(FakeAudioWorkletNode.instance?.port.close).toHaveBeenCalledOnce(),
  );
});

it('cancels capture and discards a late final when the composer revision changes', async () => {
  const microphone = installFakeMicrophone();
  const { bridge, getListener } = installDictationBridge();
  const onFinal = vi.fn();
  const onProvisional = vi.fn();
  const { render } = await mountControl({ onFinal, onProvisional });

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  const lateEvent = getListener();
  await act(async () => render(3));
  await vi.waitFor(() => expect(bridge.cancelDictation).toHaveBeenCalledOnce());
  lateEvent?.({
    version: 1,
    operationId: 'operation-a',
    sessionId: 'session-a',
    composerRevision: 2,
    sequence: 1,
    kind: 'final',
    text: 'must not replace the edited draft',
  });

  expect(microphone.track.stop).toHaveBeenCalledOnce();
  expect(onProvisional).toHaveBeenLastCalledWith(null);
  expect(onFinal).not.toHaveBeenCalled();
  expect(bridge.sendStudyTurn).not.toHaveBeenCalled();
});

it('stops capture if the relay finalizes before the user presses Stop', async () => {
  const microphone = installFakeMicrophone();
  const { bridge, emit } = installDictationBridge();
  const onFinal = vi.fn();
  await mountControl({ onFinal });

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  await act(async () =>
    emit({
      version: 1,
      operationId: 'operation-a',
      sessionId: 'session-a',
      composerRevision: 2,
      sequence: 1,
      kind: 'final',
      text: 'Please explain this concept.',
    }),
  );
  await vi.waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(microphone.track.stop).toHaveBeenCalledOnce());

  expect(onFinal).toHaveBeenCalledOnce();
  expect(bridge.cancelDictation).not.toHaveBeenCalled();
});

it('keeps the draft unchanged when the relay returns an empty final', async () => {
  const microphone = installFakeMicrophone();
  const { bridge, emit } = installDictationBridge();
  const onFinal = vi.fn();
  const { container } = await mountControl({ onFinal });

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  bridge.stopDictation.mockImplementation(async () => undefined);
  await clickButton('Stop dictation');
  await vi.waitFor(() => expect(bridge.stopDictation).toHaveBeenCalledOnce());
  await act(async () =>
    emit({
      version: 1,
      operationId: 'operation-a',
      sessionId: 'session-a',
      composerRevision: 2,
      sequence: 1,
      kind: 'final',
      text: '  ',
    }),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain('No speech was recognized'),
  );

  expect(microphone.track.stop).toHaveBeenCalledOnce();
  expect(onFinal).not.toHaveBeenCalled();
  expect(bridge.cancelDictation).not.toHaveBeenCalled();
});

it('cancels capture when a PCM message exceeds the chunk bound', async () => {
  const microphone = installFakeMicrophone();
  const { bridge } = installDictationBridge();
  const { container } = await mountControl();

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  const worklet = FakeAudioWorkletNode.instance;
  expect(worklet).not.toBeNull();
  await act(async () =>
    worklet?.port.onmessage?.({
      data: { kind: 'chunk', buffer: new ArrayBuffer(16 * 1024 + 2) },
    } as MessageEvent<WorkletReply>),
  );
  await vi.waitFor(() => expect(bridge.cancelDictation).toHaveBeenCalledOnce());

  expect(bridge.appendDictationAudio).not.toHaveBeenCalled();
  expect(microphone.track.stop).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Dictation failed');
});

it('cancels audio and ignores a late final after explicit cancel', async () => {
  const microphone = installFakeMicrophone();
  const { bridge, getListener } = installDictationBridge();
  const onFinal = vi.fn();
  const onCancel = vi.fn();
  await mountControl({ onFinal, onCancel });

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  const lateEvent = getListener();
  await clickButton('Cancel dictation');
  await vi.waitFor(() => expect(bridge.cancelDictation).toHaveBeenCalledOnce());
  lateEvent?.({
    version: 1,
    operationId: 'operation-a',
    sessionId: 'session-a',
    composerRevision: 2,
    sequence: 1,
    kind: 'final',
    text: 'must not be inserted',
  });

  expect(microphone.track.stop).toHaveBeenCalledOnce();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onFinal).not.toHaveBeenCalled();
});

it('cancels relay and capture when the study session changes', async () => {
  const microphone = installFakeMicrophone();
  const { bridge } = installDictationBridge();
  const onFinal = vi.fn();
  const { render } = await mountControl({ onFinal });

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  await act(async () => render(2, 'session-b'));
  await vi.waitFor(() => expect(bridge.cancelDictation).toHaveBeenCalledOnce());

  expect(microphone.track.stop).toHaveBeenCalledOnce();
  expect(onFinal).not.toHaveBeenCalled();
});

it('cancels relay and capture on leave and ignores late finals', async () => {
  const microphone = installFakeMicrophone();
  const { bridge, getListener } = installDictationBridge();
  const onFinal = vi.fn();
  const onCancel = vi.fn();
  const { root } = await mountControl({ onFinal, onCancel });

  await clickButton('Start dictation');
  await clickButton('Start recording');
  await vi.waitFor(() => expect(bridge.startDictation).toHaveBeenCalledOnce());
  const lateEvent = getListener();
  await act(async () => root.render(null));
  await vi.waitFor(() => expect(bridge.cancelDictation).toHaveBeenCalledOnce());
  lateEvent?.({
    version: 1,
    operationId: 'operation-a',
    sessionId: 'session-a',
    composerRevision: 2,
    sequence: 1,
    kind: 'final',
    text: 'must not be inserted',
  });

  expect(microphone.track.stop).toHaveBeenCalledOnce();
  expect(onFinal).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});
