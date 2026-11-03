import { useEffect, useRef, useState } from 'react';
import pcmWorkletUrl from '../lib/pcm-worklet.ts?worker&url';
import {
  applyDictationEvent,
  cancelTranscript,
  createTranscriptState,
} from '../lib/transcript-state';
import type {
  AcceptedTranscript,
  DictationEvent,
  DraftSelection,
  TranscriptCapture,
  TranscriptState,
} from '../lib/transcript-state';
import { maxAudioChunkBytes, pcmWorkletName } from '../lib/pcm-worklet';
import type { DictationStatus } from '../lib/formatters';

type MicrophonePermission = {
  state: 'granted' | 'denied' | 'unsupported';
};

type DictationBridge = {
  requestMicrophonePermission: (input: {
    sessionId: string;
  }) => Promise<MicrophonePermission>;
  startDictation: (input: {
    sessionId: string;
    requestId: string;
    composerRevision: number;
  }) => Promise<{ operationId: string }>;
  appendDictationAudio: (input: {
    operationId: string;
    sequence: number;
    bytes: Uint8Array;
  }) => Promise<{ acceptedSequence: number }>;
  stopDictation: (input: { operationId: string }) => Promise<void>;
  cancelDictation: (input: { operationId: string }) => Promise<void>;
  onDictationEvent: (listener: (event: DictationEvent) => void) => () => void;
};

type CaptureAttempt = {
  token: symbol;
  capture: TranscriptCapture;
  bridge: DictationBridge;
  cancelled: boolean;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  processor?: AudioWorkletNode;
  mutedOutput?: GainNode;
  operationId?: string;
  unsubscribe?: () => void;
  lifecycleCleanup?: () => void;
  captureStopped?: boolean;
  stoppedPromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
};

type ActiveDictation = CaptureAttempt & {
  operationId: string;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: AudioWorkletNode;
  mutedOutput: GainNode;
  transcript: TranscriptState;
  captureStopped: boolean;
  stopping: boolean;
  settled: boolean;
  pendingBytes: number;
  nextAudioSequence: number;
  audioBuffers: Set<Uint8Array>;
  uploadTail: Promise<void>;
  uploadFailure: unknown | null;
  stoppedPromise: Promise<void>;
  resolveStopped: () => void;
  finalPromise: Promise<AcceptedTranscript | null>;
  resolveFinal: (result: AcceptedTranscript | null) => void;
  trackEnded: () => void;
  trackMuted: () => void;
  wentOffline: () => void;
};

let activeCaptureToken: symbol | null = null;
const maxPendingAudioBytes = 24_000 * 2;
const finalDrainTimeoutMs = 15_000;
const stopFlushTimeoutMs = 15_000;
const contextCloseTimeoutMs = 1_000;

const getDictationBridge = (): DictationBridge => {
  if (typeof window === 'undefined' || !window.scholar)
    throw Object.assign(new Error('Dictation bridge is unavailable.'), {
      code: 'unsupported',
    });
  const bridge = window.scholar as typeof window.scholar &
    Partial<DictationBridge>;
  const methods: Array<keyof DictationBridge> = [
    'requestMicrophonePermission',
    'startDictation',
    'appendDictationAudio',
    'stopDictation',
    'cancelDictation',
    'onDictationEvent',
  ];
  if (methods.some((method) => typeof bridge[method] !== 'function'))
    throw Object.assign(new Error('Dictation bridge is unavailable.'), {
      code: 'unsupported',
    });
  return bridge as DictationBridge;
};

const statusForFailure = (cause: unknown): DictationStatus => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'offline';
  const name =
    typeof cause === 'object' && cause !== null && 'name' in cause
      ? String(cause.name)
      : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
    return 'denied';
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    name === 'NotSupportedError'
  )
    return 'unsupported';
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String(cause.code)
      : '';
  switch (code) {
    case 'offline':
      return 'offline';
    case 'needs-sign-in':
    case 'provider-failed':
    case 'rate-limited':
      return 'disconnected';
    case 'unsupported':
      return 'unsupported';
    case 'permission-revoked':
      return 'denied';
    default:
      return 'failed';
  }
};

const runCleanup = (cleanup: () => void) => {
  try {
    cleanup();
  } catch {
    return;
  }
};

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Dictation operation timed out.')),
        timeoutMs,
      );
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
};

type UseDictationInput = {
  sessionId: string;
  composerRevision: number;
  onProvisional: (text: string | null) => void;
  onFinal: (transcript: AcceptedTranscript) => void;
  onCancel: () => void;
  disabled?: boolean;
};

export const useDictation = ({
  sessionId,
  composerRevision,
  onProvisional,
  onFinal,
  onCancel,
  disabled = false,
}: UseDictationInput) => {
  const [status, setStatusState] = useState<DictationStatus>('idle');
  const mountedRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const composerRevisionRef = useRef(composerRevision);
  const disabledRef = useRef(disabled);
  const onProvisionalRef = useRef(onProvisional);
  const onFinalRef = useRef(onFinal);
  const onCancelRef = useRef(onCancel);
  const pendingRef = useRef<CaptureAttempt | null>(null);
  const activeRef = useRef<ActiveDictation | null>(null);

  sessionIdRef.current = sessionId;
  composerRevisionRef.current = composerRevision;
  disabledRef.current = disabled;
  onProvisionalRef.current = onProvisional;
  onFinalRef.current = onFinal;
  onCancelRef.current = onCancel;

  const setStatus = (nextStatus: DictationStatus) => {
    if (mountedRef.current) setStatusState(nextStatus);
  };

  const releaseAttempt = (attempt: CaptureAttempt) => {
    if (pendingRef.current === attempt) pendingRef.current = null;
    if (activeRef.current?.token === attempt.token) activeRef.current = null;
    if (activeCaptureToken === attempt.token) activeCaptureToken = null;
  };

  const cleanupAttempt = (
    attempt: CaptureAttempt,
    cancelRelay: boolean,
  ): Promise<void> => {
    if (attempt.cleanupPromise) return attempt.cleanupPromise;
    attempt.cancelled = true;
    runCleanup(() => attempt.unsubscribe?.());
    attempt.unsubscribe = undefined;
    runCleanup(() => attempt.lifecycleCleanup?.());
    attempt.lifecycleCleanup = undefined;
    let workletStopped = Promise.resolve();
    if (cancelRelay && attempt.processor) {
      runCleanup(() => attempt.processor?.port.postMessage({ kind: 'cancel' }));
      if (attempt.stoppedPromise)
        workletStopped = withTimeout(attempt.stoppedPromise, 250).catch(
          () => undefined,
        );
    }
    const cancelRelayPromise =
      cancelRelay && attempt.operationId
        ? Promise.resolve()
            .then(() =>
              attempt.bridge.cancelDictation({
                operationId: attempt.operationId!,
              }),
            )
            .catch(() => undefined)
        : Promise.resolve();
    if (!attempt.captureStopped) {
      runCleanup(() => attempt.source?.disconnect());
      runCleanup(() => attempt.processor?.disconnect());
      runCleanup(() => attempt.mutedOutput?.disconnect());
      let tracks: MediaStreamTrack[] = [];
      runCleanup(() => {
        tracks = attempt.stream?.getTracks() ?? [];
      });
      for (const track of tracks) runCleanup(() => track.stop());
      attempt.captureStopped = true;
    }
    const closeContext = workletStopped.then(async () => {
      runCleanup(() => {
        const port = attempt.processor?.port;
        if (!port) return;
        port.onmessage = null;
        port.close();
      });
      if (!attempt.context || attempt.context.state === 'closed') return;
      await withTimeout(
        Promise.resolve().then(() => attempt.context!.close()),
        contextCloseTimeoutMs,
      ).catch(() => undefined);
    });
    releaseAttempt(attempt);
    attempt.cleanupPromise = Promise.all([
      withTimeout(cancelRelayPromise, 1_500).catch(() => undefined),
      closeContext,
    ]).then(() => undefined);
    return attempt.cleanupPromise;
  };

  const stopCaptureHardware = async (active: ActiveDictation) => {
    if (active.captureStopped) return;
    active.captureStopped = true;
    runCleanup(() => active.lifecycleCleanup?.());
    active.lifecycleCleanup = undefined;
    runCleanup(() => active.source.disconnect());
    runCleanup(() => active.processor.disconnect());
    runCleanup(() => active.mutedOutput.disconnect());
    let tracks: MediaStreamTrack[] = [];
    runCleanup(() => {
      tracks = active.stream.getTracks();
    });
    for (const track of tracks) runCleanup(() => track.stop());
    if (active.context.state !== 'closed')
      await withTimeout(
        Promise.resolve().then(() => active.context.close()),
        contextCloseTimeoutMs,
      ).catch(() => undefined);
  };

  const cancelActive = async (
    active: ActiveDictation,
    nextStatus: DictationStatus,
    notifyComposer: boolean,
  ) => {
    if (active.cancelled || active.settled) return;
    if (active.transcript.final) {
      active.settled = true;
      setStatus('final');
      for (const bytes of active.audioBuffers) bytes.fill(0);
      active.audioBuffers.clear();
      active.pendingBytes = 0;
      await cleanupAttempt(active, true);
      return;
    }
    active.cancelled = true;
    active.transcript = cancelTranscript(active.transcript);
    active.resolveFinal(null);
    onProvisionalRef.current(null);
    if (notifyComposer) onCancelRef.current();
    setStatus(nextStatus);
    for (const bytes of active.audioBuffers) bytes.fill(0);
    active.audioBuffers.clear();
    active.pendingBytes = 0;
    await cleanupAttempt(active, true);
  };

  const cancelPending = async (
    attempt: CaptureAttempt,
    notifyComposer: boolean,
  ) => {
    if (attempt.cancelled) return;
    attempt.cancelled = true;
    onProvisionalRef.current(null);
    if (notifyComposer) onCancelRef.current();
    setStatus('cancelled');
    await cleanupAttempt(attempt, true);
  };

  const enqueueAudio = (active: ActiveDictation, buffer: ArrayBuffer) => {
    const bytes = new Uint8Array(buffer);
    if (
      active.cancelled ||
      bytes.byteLength === 0 ||
      bytes.byteLength > maxAudioChunkBytes ||
      bytes.byteLength % 2 !== 0
    ) {
      bytes.fill(0);
      if (!active.cancelled) void cancelActive(active, 'failed', false);
      return;
    }
    active.pendingBytes += bytes.byteLength;
    if (active.pendingBytes > maxPendingAudioBytes) {
      bytes.fill(0);
      active.pendingBytes = Math.max(0, active.pendingBytes - bytes.byteLength);
      void cancelActive(active, 'failed', false);
      return;
    }

    active.audioBuffers.add(bytes);
    const sequence = active.nextAudioSequence;
    active.nextAudioSequence += 1;
    active.uploadTail = active.uploadTail
      .then(async () => {
        if (active.cancelled) return;
        const result = await active.bridge.appendDictationAudio({
          operationId: active.operationId,
          sequence,
          bytes,
        });
        if (result.acceptedSequence !== sequence)
          throw new Error('Dictation audio sequence was not accepted.');
        if (!active.cancelled)
          active.processor.port.postMessage({ kind: 'credit', count: 1 });
      })
      .catch((cause: unknown) => {
        active.uploadFailure = cause;
        if (!active.cancelled)
          void cancelActive(active, statusForFailure(cause), false);
      })
      .finally(() => {
        bytes.fill(0);
        active.audioBuffers.delete(bytes);
        active.pendingBytes = Math.max(
          0,
          active.pendingBytes - bytes.byteLength,
        );
      });
  };

  const handleDictationEvent = (
    active: ActiveDictation,
    event: DictationEvent,
  ) => {
    if (active.cancelled || active.settled) return;
    if (sessionIdRef.current !== active.capture.sessionId) {
      void cancelActive(active, 'cancelled', false);
      return;
    }
    const previousTranscript = active.transcript;
    const update = applyDictationEvent(previousTranscript, event);
    if (update.state === previousTranscript) return;
    active.transcript = update.state;
    if (update.state.provisionalText !== previousTranscript.provisionalText)
      onProvisionalRef.current(update.state.provisionalText || null);
    if (update.acceptedFinal) {
      if (!active.stopping) void stop();
      try {
        onFinalRef.current(update.acceptedFinal);
      } finally {
        active.resolveFinal(update.acceptedFinal);
      }
    } else if (update.state.status === 'empty') {
      active.resolveFinal(null);
      if (active.stopping) setStatus('empty');
      else void cancelActive(active, 'empty', false);
    } else if (update.state.status === 'failed') {
      active.resolveFinal(null);
      void cancelActive(
        active,
        statusForFailure({ code: update.state.errorCode }),
        false,
      );
    } else if (update.state.status === 'ended') {
      active.resolveFinal(update.state.final);
      if (update.state.final) {
        if (!active.stopping) void cancelActive(active, 'final', false);
      } else if (active.stopping) setStatus('empty');
      else void cancelActive(active, 'empty', false);
    }
  };

  const start = async (selection: DraftSelection) => {
    if (
      disabledRef.current ||
      pendingRef.current ||
      activeRef.current ||
      activeCaptureToken
    )
      return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setStatus('offline');
      return;
    }

    let bridge: DictationBridge;
    try {
      bridge = getDictationBridge();
    } catch (cause) {
      setStatus(statusForFailure(cause));
      return;
    }
    const capture: TranscriptCapture = {
      operationId: '',
      sessionId: sessionIdRef.current,
      composerRevision: composerRevisionRef.current,
      selection: {
        start: Math.max(0, selection.start),
        end: Math.max(0, selection.end),
      },
    };
    if (
      !capture.sessionId ||
      !Number.isSafeInteger(capture.composerRevision) ||
      !Number.isSafeInteger(capture.selection.start) ||
      !Number.isSafeInteger(capture.selection.end) ||
      capture.selection.end < capture.selection.start
    ) {
      setStatus('failed');
      return;
    }
    const attempt: CaptureAttempt = {
      token: Symbol('dictation-capture'),
      capture,
      bridge,
      cancelled: false,
    };
    pendingRef.current = attempt;
    activeCaptureToken = attempt.token;
    setStatus('requesting-permission');

    const isCurrentAttempt = () =>
      pendingRef.current === attempt &&
      !attempt.cancelled &&
      sessionIdRef.current === capture.sessionId &&
      composerRevisionRef.current === capture.composerRevision;

    try {
      const permission = await bridge.requestMicrophonePermission({
        sessionId: capture.sessionId,
      });
      if (!isCurrentAttempt()) {
        await cleanupAttempt(attempt, Boolean(attempt.operationId));
        return;
      }
      if (permission.state !== 'granted') {
        setStatus(permission.state === 'denied' ? 'denied' : 'unsupported');
        await cleanupAttempt(attempt, false);
        return;
      }
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.getUserMedia)
        throw Object.assign(new Error('Microphone capture is unsupported.'), {
          code: 'unsupported',
        });
      const stream = await mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 } },
        video: false,
      });
      if (!isCurrentAttempt()) {
        for (const track of stream.getTracks()) track.stop();
        await cleanupAttempt(attempt, false);
        return;
      }
      attempt.stream = stream;
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length !== 1 || audioTracks[0]?.readyState !== 'live')
        throw Object.assign(new Error('No active microphone track.'), {
          code: 'unsupported',
        });
      const settings = audioTracks[0].getSettings();
      if (
        (settings.sampleRate !== undefined &&
          (!Number.isFinite(settings.sampleRate) ||
            settings.sampleRate <= 0)) ||
        (settings.channelCount !== undefined &&
          (!Number.isSafeInteger(settings.channelCount) ||
            settings.channelCount <= 0))
      )
        throw Object.assign(new Error('Microphone settings are unsupported.'), {
          code: 'unsupported',
        });

      if (typeof AudioContext === 'undefined')
        throw Object.assign(new Error('Audio capture is unsupported.'), {
          code: 'unsupported',
        });
      const context = new AudioContext();
      attempt.context = context;
      if (!Number.isFinite(context.sampleRate) || context.sampleRate <= 0)
        throw Object.assign(new Error('Audio sample rate is unsupported.'), {
          code: 'unsupported',
        });
      await context.resume();
      if (!isCurrentAttempt()) {
        await cleanupAttempt(attempt, false);
        return;
      }
      if (!context.audioWorklet)
        throw Object.assign(new Error('AudioWorklet is unsupported.'), {
          code: 'unsupported',
        });
      await context.audioWorklet.addModule(pcmWorkletUrl);
      if (!isCurrentAttempt()) {
        await cleanupAttempt(attempt, false);
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(context, pcmWorkletName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const mutedOutput = context.createGain();
      mutedOutput.gain.value = 0;
      attempt.source = source;
      attempt.processor = processor;
      attempt.mutedOutput = mutedOutput;

      if (
        typeof crypto === 'undefined' ||
        typeof crypto.randomUUID !== 'function'
      )
        throw Object.assign(new Error('Secure request IDs are unavailable.'), {
          code: 'unsupported',
        });
      const operation = await bridge.startDictation({
        sessionId: capture.sessionId,
        requestId: crypto.randomUUID(),
        composerRevision: capture.composerRevision,
      });
      attempt.operationId = operation.operationId;
      if (!isCurrentAttempt()) {
        if (operation.operationId)
          await bridge
            .cancelDictation({ operationId: operation.operationId })
            .catch(() => undefined);
        await cleanupAttempt(attempt, false);
        return;
      }
      if (!operation.operationId)
        throw Object.assign(new Error('Dictation operation was not created.'), {
          code: 'disconnected',
        });

      let resolveStopped: () => void = () => undefined;
      const stoppedPromise = new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });
      let resolveFinal: (result: AcceptedTranscript | null) => void = () =>
        undefined;
      const finalPromise = new Promise<AcceptedTranscript | null>((resolve) => {
        resolveFinal = resolve;
      });
      const active: ActiveDictation = {
        ...attempt,
        operationId: operation.operationId,
        stream,
        context,
        source,
        processor,
        mutedOutput,
        transcript: createTranscriptState({
          ...capture,
          operationId: operation.operationId,
        }),
        captureStopped: false,
        stopping: false,
        settled: false,
        pendingBytes: 0,
        nextAudioSequence: 0,
        audioBuffers: new Set(),
        uploadTail: Promise.resolve(),
        uploadFailure: null,
        stoppedPromise,
        resolveStopped,
        finalPromise,
        resolveFinal,
        trackEnded: () => void cancelActive(active, 'unsupported', false),
        trackMuted: () => void cancelActive(active, 'denied', false),
        wentOffline: () => void cancelActive(active, 'offline', false),
      };
      pendingRef.current = null;
      activeRef.current = active;
      active.unsubscribe = bridge.onDictationEvent((event) =>
        handleDictationEvent(active, event),
      );
      processor.port.onmessage = (
        event: MessageEvent<{
          kind: 'chunk' | 'stopped' | 'error';
          buffer?: ArrayBuffer;
          code?: 'unsupported' | 'limit-exceeded';
        }>,
      ) => {
        if (event.data.kind === 'chunk' && event.data.buffer) {
          enqueueAudio(active, event.data.buffer);
        } else if (event.data.kind === 'stopped') {
          active.resolveStopped();
        } else if (event.data.kind === 'error') {
          void cancelActive(
            active,
            statusForFailure({ code: event.data.code }),
            false,
          );
        }
      };
      const track = audioTracks[0]!;
      track.addEventListener('ended', active.trackEnded, { once: true });
      track.addEventListener('mute', active.trackMuted, { once: true });
      window.addEventListener('offline', active.wentOffline, { once: true });
      active.lifecycleCleanup = () => {
        track.removeEventListener('ended', active.trackEnded);
        track.removeEventListener('mute', active.trackMuted);
        window.removeEventListener('offline', active.wentOffline);
      };
      processor.port.postMessage({ kind: 'credit', count: 3 });
      source.connect(processor);
      processor.connect(mutedOutput);
      mutedOutput.connect(context.destination);
      setStatus('recording');
    } catch (cause) {
      if (attempt.cancelled) return;
      const failureStatus = statusForFailure(cause);
      if (attempt.operationId && !attempt.cancelled)
        await cleanupAttempt(attempt, true);
      else await cleanupAttempt(attempt, false);
      setStatus(failureStatus);
    }
  };

  const stop = async () => {
    const active = activeRef.current;
    if (!active || active.cancelled || active.settled || active.stopping)
      return;
    active.stopping = true;
    setStatus('stopping');
    active.processor.port.postMessage({ kind: 'stop' });
    try {
      await withTimeout(active.stoppedPromise, 1_000);
      await stopCaptureHardware(active);
      await withTimeout(active.uploadTail, stopFlushTimeoutMs);
      if (active.cancelled) return;
      if (active.uploadFailure) throw active.uploadFailure;
      await active.bridge.stopDictation({ operationId: active.operationId });
      const finalTranscript = await withTimeout(
        active.finalPromise,
        finalDrainTimeoutMs,
      );
      if (active.cancelled) return;
      setStatus(finalTranscript ? 'final' : 'empty');
      active.settled = true;
      active.resolveFinal(finalTranscript);
      await cleanupAttempt(active, false);
    } catch (cause) {
      if (!active.cancelled)
        await cancelActive(active, statusForFailure(cause), false);
    }
  };

  const cancel = async () => {
    const active = activeRef.current;
    if (active) {
      await cancelActive(active, 'cancelled', true);
      return;
    }
    const pending = pendingRef.current;
    if (pending) await cancelPending(pending, true);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeRef.current;
      if (active?.capture.sessionId === sessionId)
        void cancelActive(active, 'cancelled', false);
      const pending = pendingRef.current;
      if (pending?.capture.sessionId === sessionId)
        void cancelPending(pending, false);
    };
  }, [sessionId]);

  return { status, start, stop, cancel };
};
