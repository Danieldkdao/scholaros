import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  dictationAudioChunkSchema,
  dictationEventSchema,
  dictationStartInputSchema,
  type DictationEvent,
  type DictationStartInput,
} from '../learning/speech-contracts';
import { idSchema, type SafeErrorCode } from '../learning/product-contracts';
import {
  createDictationRegistry,
  getDictationRegistry,
  type DictationOperation,
  type DictationRegistry,
  type DictationRateLimitKind,
} from './dictation-registry';

export const dictationControlActions = ['stop', 'cancel'] as const;
export type DictationControlAction = (typeof dictationControlActions)[number];

const META_REALTIME_URL = 'wss://api.meta.ai/v1/asr/realtime';
const META_MODEL = 'muse-voice-transcribe-1.0';
const AUDIO_BYTES_PER_SECOND = 48_000;
const MAX_FRAME_BYTES = 16_384;
const MAX_AUDIO_BYTES = AUDIO_BYTES_PER_SECOND * 120;
const MAX_PENDING_AUDIO_BYTES = AUDIO_BYTES_PER_SECOND;
const MAX_UPSTREAM_BUFFERED_BYTES = AUDIO_BYTES_PER_SECOND;
const MAX_AUDIO_CHUNKS = 1_200;
const MAX_RATE_LIMIT_ENTRIES = 1_024;
const MAX_LIVE_OPERATIONS = 32;
const MAX_REGISTRY_OPERATIONS = 256;
const MAX_QUEUED_EVENTS = 64;
const MAX_QUEUED_EVENT_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_DURATION_MS = 120_000;
const FINAL_DRAIN_TIMEOUT_MS = 15_000;
const TERMINAL_RETENTION_MS = 60_000;
const RATE_LIMITS: Record<
  DictationRateLimitKind,
  { limit: number; windowMs: number }
> = {
  start: { limit: 5, windowMs: 60_000 },
  audio: { limit: 1_200, windowMs: 60_000 },
  control: { limit: 60, windowMs: 60_000 },
  events: { limit: 10, windowMs: 60_000 },
};

type DictationOperationInput = {
  operationId: string;
  sessionId: string;
  composerRevision: number;
};

type DictationAudioInput = DictationOperationInput & {
  sequence: number;
  bytes: Uint8Array;
};

type DictationCreated = { operationId: string };
type DictationAcceptedAudio = { acceptedSequence: number };

type DictationEventIterator = AsyncIterableIterator<DictationEvent>;
type DictationEventWithoutSequence<Event = DictationEvent> = Event extends {
  sequence: number;
}
  ? Omit<Event, 'sequence'>
  : never;

type DictationErrorOptions = {
  status?: number;
  message?: string;
};

export class DictationError extends Error {
  readonly code: SafeErrorCode;
  readonly status: number;

  constructor(code: SafeErrorCode, options: DictationErrorOptions = {}) {
    super(options.message ?? safeMessageForCode(code));
    this.name = 'DictationError';
    this.code = code;
    this.status = options.status ?? statusForCode(code);
  }
}

export type DictationServiceDependencies = {
  registry?: DictationRegistry;
  getApiKey?: () => string | undefined | Promise<string | undefined>;
  createWebSocket?: (
    url: string,
    options: WebSocket.ClientOptions,
  ) => WebSocket;
  now?: () => number;
};

export type DictationService = {
  createDictation: (
    accountId: string,
    input: DictationStartInput,
    signal?: AbortSignal,
  ) => Promise<DictationCreated>;
  appendDictationAudio: (
    accountId: string,
    input: DictationAudioInput,
  ) => Promise<DictationAcceptedAudio>;
  getDictationEvents: (
    accountId: string,
    input: DictationOperationInput,
  ) => DictationEventIterator;
  stopDictation: (
    accountId: string,
    input: DictationOperationInput,
  ) => Promise<void>;
  cancelDictation: (
    accountId: string,
    input: DictationOperationInput,
  ) => Promise<void>;
};

const safeMessageForCode = (code: SafeErrorCode) => {
  switch (code) {
    case 'invalid-input':
      return 'The dictation request is invalid.';
    case 'not-found':
    case 'scope-denied':
      return 'This dictation is unavailable.';
    case 'session-changed':
      return 'The study session changed; start dictation again.';
    case 'permission-revoked':
      return 'Dictation permission is no longer available.';
    case 'busy':
      return 'A dictation is already active.';
    case 'revision-conflict':
      return 'The dictation audio sequence changed.';
    case 'cancelled':
      return 'Dictation was cancelled.';
    case 'offline':
      return 'Dictation services are offline.';
    case 'needs-sign-in':
      return 'Sign in again to use dictation.';
    case 'rate-limited':
      return 'Too many dictation requests; try again later.';
    case 'capability-changed':
      return 'Dictation availability changed; try again.';
    case 'feature-unavailable':
      return 'Meta dictation is unavailable.';
    case 'unsupported':
      return 'This dictation request is unsupported.';
    case 'unreadable':
      return 'The audio could not be understood.';
    case 'limit-exceeded':
      return 'Dictation reached its audio or time limit.';
    case 'provider-failed':
      return 'Meta dictation could not finish.';
    case 'storage-failed':
      return 'Dictation could not be saved.';
  }
};

const statusForCode = (code: SafeErrorCode) => {
  switch (code) {
    case 'invalid-input':
      return 400;
    case 'not-found':
    case 'scope-denied':
      return 404;
    case 'session-changed':
    case 'permission-revoked':
    case 'revision-conflict':
      return 409;
    case 'busy':
    case 'rate-limited':
      return 429;
    case 'limit-exceeded':
      return 413;
    case 'offline':
    case 'needs-sign-in':
      return 503;
    case 'feature-unavailable':
    case 'capability-changed':
      return 503;
    case 'cancelled':
      return 409;
    case 'unsupported':
      return 415;
    case 'unreadable':
    case 'provider-failed':
      return 502;
    case 'storage-failed':
      return 500;
  }
};

const makeError = (code: SafeErrorCode, options?: DictationErrorOptions) =>
  new DictationError(code, options);

const accountRequestKey = (accountId: string, requestId: string) =>
  `${accountId}\u0000${requestId}`;

const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
  if (timer) clearTimeout(timer);
};

const scheduleTimer = (callback: () => void, delayMs: number) => {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  return timer;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toMessageBuffer = (data: WebSocket.RawData) => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
};

const operationEvent = (
  operation: DictationOperation,
  event: DictationEventWithoutSequence,
): DictationEvent =>
  dictationEventSchema.parse({
    ...event,
    sequence: ++operation.eventSequence,
  });

const removeQueuedPartials = (operation: DictationOperation) => {
  const keptEvents = operation.eventQueue.filter(
    (event) => event.kind !== 'partial',
  );
  operation.eventQueue = keptEvents;
  operation.eventQueueBytes = keptEvents.reduce(
    (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
    0,
  );
};

const publishEvent = (
  operation: DictationOperation,
  event: DictationEventWithoutSequence,
) => {
  if (operation.invalidated && event.kind !== 'error' && event.kind !== 'ended')
    return;
  if (operation.finalAccepted && event.kind === 'partial') return;

  const nextEvent = operationEvent(operation, event);
  if (nextEvent.kind === 'partial') removeQueuedPartials(operation);
  const waiter = operation.eventWaiters.shift();
  if (waiter) {
    waiter(nextEvent);
    return;
  }

  const eventBytes = Buffer.byteLength(JSON.stringify(nextEvent));
  if (
    operation.eventQueue.length >= MAX_QUEUED_EVENTS ||
    operation.eventQueueBytes + eventBytes > MAX_QUEUED_EVENT_BYTES
  ) {
    if (nextEvent.kind === 'partial') return;
    removeQueuedPartials(operation);
    if (
      operation.eventQueue.length >= MAX_QUEUED_EVENTS ||
      operation.eventQueueBytes + eventBytes > MAX_QUEUED_EVENT_BYTES
    ) {
      operation.eventQueue = [];
      operation.eventQueueBytes = 0;
    }
  }
  operation.eventQueue.push(nextEvent);
  operation.eventQueueBytes += eventBytes;
};

const wakeEventWaiters = (operation: DictationOperation) => {
  while (operation.eventWaiters.length > 0 && operation.eventQueue.length > 0) {
    const event = operation.eventQueue.shift();
    if (event) {
      operation.eventQueueBytes -= Buffer.byteLength(JSON.stringify(event));
      operation.eventWaiters.shift()?.(event);
    }
  }
  if (
    operation.eventQueue.length === 0 &&
    (operation.state === 'terminal' || operation.state === 'cancelled')
  )
    for (const resolve of operation.eventWaiters.splice(0)) resolve(null);
};

const nextEvent = (operation: DictationOperation) => {
  if (operation.eventQueue.length > 0) {
    const event = operation.eventQueue.shift();
    if (event) {
      operation.eventQueueBytes -= Buffer.byteLength(JSON.stringify(event));
      return Promise.resolve(event);
    }
  }
  if (operation.state === 'terminal' || operation.state === 'cancelled')
    return Promise.resolve(null);
  return new Promise<DictationEvent | null>((resolve) => {
    operation.eventWaiters.push(resolve);
  });
};

const clearOperationBuffers = (operation: DictationOperation) => {
  for (const buffer of operation.pendingAudioBuffers.values()) buffer.fill(0);
  operation.pendingAudioBuffers.clear();
  operation.pendingAudioBytes = 0;
};

const removeOperation = (
  registry: DictationRegistry,
  operation: DictationOperation,
) => {
  clearTimer(operation.connectionTimer);
  clearTimer(operation.durationTimer);
  clearTimer(operation.stopTimer);
  clearTimer(operation.terminalTimer);
  clearOperationBuffers(operation);
  operation.chunkDigests.clear();
  operation.pendingChunkDigests.clear();
  operation.pendingChunkPromises.clear();
  operation.eventQueue = [];
  operation.eventQueueBytes = 0;
  if (registry.activeByAccount.get(operation.accountId) === operation.id)
    registry.activeByAccount.delete(operation.accountId);
  const requestKey = accountRequestKey(
    operation.accountId,
    operation.requestId,
  );
  if (registry.requestOperations.get(requestKey) === operation.id)
    registry.requestOperations.delete(requestKey);
  registry.operations.delete(operation.id);
  for (const resolve of operation.eventWaiters.splice(0)) resolve(null);
};

const retainTerminalOperation = (
  registry: DictationRegistry,
  operation: DictationOperation,
  now: () => number,
) => {
  operation.terminalAt = now();
  clearTimer(operation.connectionTimer);
  clearTimer(operation.durationTimer);
  clearTimer(operation.stopTimer);
  clearTimer(operation.terminalTimer);
  operation.connectionTimer = null;
  operation.durationTimer = null;
  operation.stopTimer = null;
  operation.terminalTimer = null;
  clearOperationBuffers(operation);
  if (registry.activeByAccount.get(operation.accountId) === operation.id)
    registry.activeByAccount.delete(operation.accountId);
  operation.resolveClosed();
  operation.terminalTimer = scheduleTimer(
    () => removeOperation(registry, operation),
    TERMINAL_RETENTION_MS,
  );
  wakeEventWaiters(operation);
};

const pruneRegistry = (registry: DictationRegistry, now: number) => {
  for (const operation of registry.operations.values()) {
    if (
      (operation.state === 'terminal' || operation.state === 'cancelled') &&
      operation.terminalAt !== null &&
      now - operation.terminalAt >= TERMINAL_RETENTION_MS
    )
      removeOperation(registry, operation);
  }
  for (const [key, limit] of registry.rateLimits)
    if (now - limit.windowStartedAt >= 60_000) registry.rateLimits.delete(key);
};

const consumeRateLimit = (
  registry: DictationRegistry,
  accountId: string,
  kind: DictationRateLimitKind,
  now: number,
) => {
  const { limit, windowMs } = RATE_LIMITS[kind];
  const key = `${accountId}\u0000${kind}`;
  const current = registry.rateLimits.get(key);
  if (!current || now - current.windowStartedAt >= windowMs) {
    if (!current && registry.rateLimits.size >= MAX_RATE_LIMIT_ENTRIES)
      throw makeError('busy');
    registry.rateLimits.set(key, { windowStartedAt: now, count: 1 });
    return;
  }
  if (current.count >= limit) throw makeError('rate-limited');
  current.count += 1;
};

const createDeferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const requestKeyFor = (accountId: string, requestId: string) =>
  accountRequestKey(accountId, requestId);

const getOwnedOperation = (
  registry: DictationRegistry,
  accountId: string,
  input: DictationOperationInput,
  now: number,
) => {
  if (
    !idSchema.safeParse(accountId).success ||
    !idSchema.safeParse(input.operationId).success ||
    !idSchema.safeParse(input.sessionId).success ||
    !Number.isSafeInteger(input.composerRevision) ||
    input.composerRevision < 0
  )
    throw makeError('invalid-input');
  pruneRegistry(registry, now);
  const operation = registry.operations.get(input.operationId);
  if (!operation || operation.accountId !== accountId)
    throw makeError('not-found');
  if (
    operation.sessionId !== input.sessionId ||
    operation.composerRevision !== input.composerRevision
  )
    throw makeError('session-changed');
  return operation;
};

const releaseOperation = (
  registry: DictationRegistry,
  operation: DictationOperation,
) => {
  if (registry.activeByAccount.get(operation.accountId) === operation.id)
    registry.activeByAccount.delete(operation.accountId);
};

const cancelOperation = async (
  registry: DictationRegistry,
  operation: DictationOperation,
  now: () => number,
) => {
  if (operation.state === 'cancelled' || operation.state === 'terminal') return;
  operation.invalidated = true;
  operation.acceptingAudio = false;
  operation.state = 'cancelled';
  operation.terminalErrorCode = 'cancelled';
  clearOperationBuffers(operation);
  operation.eventQueue = [];
  operation.eventQueueBytes = 0;
  if (operation.socket?.readyState === WebSocket.CONNECTING) {
    operation.socket.terminate();
  } else if (operation.socket?.readyState === WebSocket.OPEN) {
    operation.socket.terminate();
  }
  operation.rejectReady(makeError('cancelled'));
  publishEvent(operation, {
    version: 1,
    operationId: operation.id,
    sessionId: operation.sessionId,
    composerRevision: operation.composerRevision,
    kind: 'ended',
  });
  releaseOperation(registry, operation);
  retainTerminalOperation(registry, operation, now);
};

const finishOperation = (
  registry: DictationRegistry,
  operation: DictationOperation,
  now: () => number,
) => {
  if (operation.state === 'terminal' || operation.state === 'cancelled') return;
  operation.state = 'terminal';
  operation.acceptingAudio = false;
  publishEvent(operation, {
    version: 1,
    operationId: operation.id,
    sessionId: operation.sessionId,
    composerRevision: operation.composerRevision,
    kind: 'ended',
  });
  retainTerminalOperation(registry, operation, now);
};

const failOperation = (
  registry: DictationRegistry,
  operation: DictationOperation,
  error: DictationError,
  now: () => number,
) => {
  if (operation.state === 'terminal' || operation.state === 'cancelled') return;
  const wasReady = operation.readyAt !== null;
  operation.invalidated = true;
  operation.acceptingAudio = false;
  operation.state = 'terminal';
  operation.terminalErrorCode = error.code;
  if (!wasReady) operation.rejectReady(error);
  else
    publishEvent(operation, {
      version: 1,
      operationId: operation.id,
      sessionId: operation.sessionId,
      composerRevision: operation.composerRevision,
      kind: 'error',
      errorCode: error.code,
    });
  if (operation.socket?.readyState === WebSocket.OPEN)
    operation.socket.terminate();
  if (wasReady)
    publishEvent(operation, {
      version: 1,
      operationId: operation.id,
      sessionId: operation.sessionId,
      composerRevision: operation.composerRevision,
      kind: 'ended',
    });
  releaseOperation(registry, operation);
  retainTerminalOperation(registry, operation, now);
};

const sendSocketFrame = (
  socket: WebSocket,
  data: string | Buffer,
  binary: boolean,
) =>
  new Promise<void>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(makeError('provider-failed'));
      return;
    }
    if (binary)
      socket.send(data as Buffer, { binary: true }, (error) =>
        error ? reject(makeError('provider-failed')) : resolve(),
      );
    else
      socket.send(data as string, (error) =>
        error ? reject(makeError('provider-failed')) : resolve(),
      );
  });

const providerFailureForClose = (code: number) =>
  code === 1013 ? makeError('rate-limited') : makeError('provider-failed');

const createEventIterator = (
  operation: DictationOperation,
  close: () => Promise<void>,
): DictationEventIterator => {
  const iterator: DictationEventIterator = {
    async next() {
      const event = await nextEvent(operation);
      return event
        ? { value: event, done: false }
        : { value: undefined, done: true };
    },
    async return() {
      operation.eventReaderClosed = true;
      await close();
      return { value: undefined, done: true };
    },
    async throw(error?: unknown) {
      operation.eventReaderClosed = true;
      await close();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
};

export const createDictationService = (
  dependencies: DictationServiceDependencies = {},
): DictationService => {
  const registry = dependencies.registry ?? createDictationRegistry();
  const now = dependencies.now ?? Date.now;
  const getApiKey =
    dependencies.getApiKey ??
    (async () =>
      (await import('@scholaros/env/server')).serverEnv.META_API_KEY);
  const createWebSocket =
    dependencies.createWebSocket ??
    ((url: string, options: WebSocket.ClientOptions) =>
      new WebSocket(url, options));

  const createDictation = async (
    accountId: string,
    input: DictationStartInput,
    signal?: AbortSignal,
  ): Promise<DictationCreated> => {
    const parsedInput = dictationStartInputSchema.safeParse(input);
    if (!idSchema.safeParse(accountId).success || !parsedInput.success)
      throw makeError('invalid-input');
    const apiKey = await getApiKey();
    if (!apiKey) throw makeError('feature-unavailable');

    const currentTime = now();
    pruneRegistry(registry, currentTime);
    consumeRateLimit(registry, accountId, 'start', currentTime);
    const requestDigest = createHash('sha256')
      .update(JSON.stringify(parsedInput.data))
      .digest('hex');
    const requestKey = requestKeyFor(accountId, parsedInput.data.requestId);
    const existingId = registry.requestOperations.get(requestKey);
    if (existingId) {
      const existingOperation = registry.operations.get(existingId);
      if (existingOperation?.requestDigest !== requestDigest)
        throw makeError('revision-conflict');
      if (existingOperation) {
        await existingOperation.readyPromise;
        return { operationId: existingOperation.id };
      }
    }
    if (registry.activeByAccount.has(accountId)) throw makeError('busy');
    if (registry.activeByAccount.size >= MAX_LIVE_OPERATIONS)
      throw makeError('busy');
    if (registry.operations.size >= MAX_REGISTRY_OPERATIONS)
      throw makeError('busy');

    const deferredReady = createDeferred();
    const deferredClosed = createDeferred();
    const operationId = randomUUID();
    const operation: DictationOperation = {
      id: operationId,
      accountId,
      requestId: parsedInput.data.requestId,
      requestDigest,
      sessionId: parsedInput.data.sessionId,
      composerRevision: parsedInput.data.composerRevision,
      state: 'connecting',
      createdAt: currentTime,
      readyAt: null,
      terminalAt: null,
      socket: null,
      readyPromise: deferredReady.promise,
      resolveReady: deferredReady.resolve,
      rejectReady: deferredReady.reject,
      closedPromise: deferredClosed.promise,
      resolveClosed: deferredClosed.resolve,
      connectionTimer: null,
      durationTimer: null,
      stopTimer: null,
      terminalTimer: null,
      audioChain: Promise.resolve(),
      pendingAudioBuffers: new Map(),
      pendingAudioBytes: 0,
      chunkDigests: new Map(),
      pendingChunkDigests: new Map(),
      pendingChunkPromises: new Map(),
      nextAudioSequence: 0,
      audioBytes: 0,
      processedAudioMs: 0,
      acceptingAudio: false,
      finalAccepted: false,
      terminalErrorCode: null,
      eventSequence: 0,
      eventQueue: [],
      eventQueueBytes: 0,
      eventWaiters: [],
      eventReaderClaimed: false,
      eventReaderClosed: false,
      stopPromise: null,
      invalidated: false,
    };
    registry.operations.set(operation.id, operation);
    registry.activeByAccount.set(accountId, operation.id);
    registry.requestOperations.set(requestKey, operation.id);

    const fail = (error: DictationError) =>
      failOperation(registry, operation, error, now);
    const handleMessage = (data: WebSocket.RawData) => {
      if (operation.invalidated) return;
      const messageBuffer = toMessageBuffer(data);
      if (!messageBuffer || messageBuffer.byteLength > 32_768) {
        fail(makeError('provider-failed'));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(messageBuffer.toString('utf8'));
      } catch {
        fail(makeError('provider-failed'));
        return;
      }
      if (!isPlainRecord(message)) {
        fail(makeError('provider-failed'));
        return;
      }
      if (operation.state === 'connecting') {
        if (
          message.type === undefined &&
          typeof message.sessionId === 'string' &&
          message.sessionId.length > 0 &&
          message.sessionId.length <= 300
        ) {
          clearTimer(operation.connectionTimer);
          operation.connectionTimer = null;
          operation.readyAt = now();
          operation.state = 'ready';
          operation.acceptingAudio = true;
          operation.resolveReady();
          publishEvent(operation, {
            version: 1,
            operationId: operation.id,
            sessionId: operation.sessionId,
            composerRevision: operation.composerRevision,
            kind: 'ready',
          });
          operation.durationTimer = scheduleTimer(
            () => fail(makeError('limit-exceeded')),
            MAX_DURATION_MS,
          );
          return;
        }
        fail(
          message.type === 'error'
            ? makeError('provider-failed')
            : makeError('provider-failed'),
        );
        return;
      }
      if (message.type === 'audioProgress') {
        if (
          typeof message.audioProcessedMs === 'number' &&
          Number.isFinite(message.audioProcessedMs) &&
          message.audioProcessedMs >= operation.processedAudioMs
        )
          operation.processedAudioMs = message.audioProcessedMs;
        return;
      }
      if (message.type === 'error') {
        fail(makeError('provider-failed'));
        return;
      }
      if (message.type !== 'transcript') return;
      if (
        typeof message.transcript !== 'string' ||
        message.transcript.length > 8_000 ||
        typeof message.final !== 'boolean'
      ) {
        fail(makeError('provider-failed'));
        return;
      }
      if (operation.finalAccepted) return;
      if (message.final) {
        if (operation.state !== 'stopping') {
          fail(makeError('provider-failed'));
          return;
        }
        operation.finalAccepted = true;
        publishEvent(operation, {
          version: 1,
          operationId: operation.id,
          sessionId: operation.sessionId,
          composerRevision: operation.composerRevision,
          kind: 'final',
          text: message.transcript,
        });
        return;
      }
      publishEvent(operation, {
        version: 1,
        operationId: operation.id,
        sessionId: operation.sessionId,
        composerRevision: operation.composerRevision,
        kind: 'partial',
        text: message.transcript,
      });
    };

    try {
      const upstreamUrl = new URL(META_REALTIME_URL);
      upstreamUrl.searchParams.set('sessionId', operation.id);
      operation.socket = createWebSocket(upstreamUrl.href, {
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: 32_768,
        perMessageDeflate: false,
      });
      operation.socket.on('open', () => {
        if (operation.state !== 'connecting') return;
        operation.connectionTimer = scheduleTimer(
          () => fail(makeError('provider-failed')),
          HANDSHAKE_TIMEOUT_MS,
        );
        const handshake = JSON.stringify({
          authorization: { accessToken: `Bearer ${apiKey}` },
          model: META_MODEL,
          audioEncoding: 'PCM_24KHZ',
          mode: 'PUSH_TO_TALK',
          partialMode: 'CUMULATIVE',
          emitAudioProgress: true,
          languageBias: ['English'],
          keywords: [],
        });
        void sendSocketFrame(operation.socket!, handshake, false).catch(() =>
          fail(makeError('provider-failed')),
        );
      });
      operation.socket.on('message', handleMessage);
      operation.socket.on('close', (code: number) => {
        if (operation.state === 'terminal' || operation.state === 'cancelled')
          return;
        if (operation.state === 'stopping' && code === 1000) {
          if (!operation.finalAccepted) {
            fail(makeError('provider-failed'));
            return;
          }
          finishOperation(registry, operation, now);
          return;
        }
        fail(providerFailureForClose(code));
      });
      operation.socket.on('unexpected-response', (_request, response) => {
        const error =
          response.statusCode === 429
            ? makeError('rate-limited')
            : makeError('feature-unavailable');
        response.resume();
        fail(error);
      });
      operation.socket.on('error', (error: NodeJS.ErrnoException) => {
        const statusCode = (
          error as NodeJS.ErrnoException & { statusCode?: number }
        ).statusCode;
        fail(
          statusCode === 429
            ? makeError('rate-limited')
            : makeError('provider-failed'),
        );
      });
      operation.connectionTimer = scheduleTimer(
        () => fail(makeError('provider-failed')),
        HANDSHAKE_TIMEOUT_MS * 2,
      );
      if (signal) {
        const onAbort = () => fail(makeError('cancelled'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        try {
          await operation.readyPromise;
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
      } else await operation.readyPromise;
      return { operationId: operation.id };
    } catch (error) {
      if (operation.state !== 'terminal' && operation.state !== 'cancelled')
        fail(
          error instanceof DictationError
            ? error
            : makeError('provider-failed'),
        );
      removeOperation(registry, operation);
      if (error instanceof DictationError) throw error;
      throw makeError('provider-failed');
    }
  };

  const appendDictationAudio = async (
    accountId: string,
    input: DictationAudioInput,
  ): Promise<DictationAcceptedAudio> => {
    if (
      input?.bytes instanceof Uint8Array &&
      input.bytes.byteLength > MAX_FRAME_BYTES
    ) {
      input.bytes.fill(0);
      throw makeError('limit-exceeded');
    }
    const parsedChunk = dictationAudioChunkSchema.safeParse({
      operationId: input.operationId,
      sequence: input.sequence,
      bytes: input.bytes,
    });
    if (
      !idSchema.safeParse(accountId).success ||
      !idSchema.safeParse(input.sessionId).success ||
      !Number.isSafeInteger(input.composerRevision) ||
      input.composerRevision < 0 ||
      !parsedChunk.success
    )
      throw makeError('invalid-input');
    const operation = getOwnedOperation(registry, accountId, input, now());
    if (
      operation.state !== 'ready' ||
      !operation.acceptingAudio ||
      !operation.socket
    )
      throw makeError('revision-conflict');
    consumeRateLimit(registry, accountId, 'audio', now());
    const { sequence, bytes } = parsedChunk.data;
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
      bytes.fill(0);
      throw makeError('invalid-input');
    }
    if (bytes.byteLength > MAX_FRAME_BYTES) {
      bytes.fill(0);
      throw makeError('limit-exceeded');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const previousDigest = operation.chunkDigests.get(sequence);
    if (previousDigest) {
      bytes.fill(0);
      if (previousDigest !== digest) throw makeError('revision-conflict');
      return { acceptedSequence: sequence };
    }
    const pendingChunk = operation.pendingChunkPromises.get(sequence);
    if (pendingChunk) {
      const pendingDigest = operation.pendingChunkDigests.get(sequence);
      bytes.fill(0);
      if (pendingDigest !== digest) throw makeError('revision-conflict');
      return pendingChunk;
    }
    if (
      sequence !== operation.nextAudioSequence ||
      sequence >= MAX_AUDIO_CHUNKS
    ) {
      bytes.fill(0);
      throw makeError('revision-conflict');
    }
    if (
      operation.pendingAudioBytes + bytes.byteLength >
      MAX_PENDING_AUDIO_BYTES
    ) {
      bytes.fill(0);
      throw makeError('busy');
    }

    const audioBuffer = Buffer.from(bytes);
    operation.pendingAudioBuffers.set(sequence, audioBuffer);
    operation.pendingAudioBytes += audioBuffer.byteLength;
    operation.pendingChunkDigests.set(sequence, digest);
    const appendPromise = operation.audioChain.then(async () => {
      try {
        if (
          operation.invalidated ||
          (operation.state !== 'ready' && operation.state !== 'stopping')
        )
          throw makeError('cancelled');
        const nextAudioBytes = operation.audioBytes + audioBuffer.byteLength;
        if (nextAudioBytes > MAX_AUDIO_BYTES) throw makeError('limit-exceeded');
        const inputDurationMs =
          nextAudioBytes / (AUDIO_BYTES_PER_SECOND / 1_000);
        const elapsedMs = Math.max(0, now() - (operation.readyAt ?? now()));
        const ingressAheadMs = inputDurationMs - elapsedMs;
        const processingBacklogMs =
          inputDurationMs - operation.processedAudioMs;
        if (ingressAheadMs > 1_000 || processingBacklogMs > 1_000)
          throw makeError('busy');
        if (
          operation.pendingAudioBytes > MAX_PENDING_AUDIO_BYTES ||
          operation.socket!.bufferedAmount + audioBuffer.byteLength >
            MAX_UPSTREAM_BUFFERED_BYTES
        )
          throw makeError('busy');
        await sendSocketFrame(operation.socket!, audioBuffer, true);
        if (operation.invalidated) throw makeError('cancelled');
        operation.audioBytes = nextAudioBytes;
        operation.chunkDigests.set(sequence, digest);
        operation.nextAudioSequence += 1;
        return { acceptedSequence: sequence };
      } finally {
        operation.pendingAudioBuffers.delete(sequence);
        operation.pendingAudioBytes = Math.max(
          0,
          operation.pendingAudioBytes - audioBuffer.byteLength,
        );
        audioBuffer.fill(0);
        bytes.fill(0);
      }
    });
    operation.pendingChunkPromises.set(sequence, appendPromise);
    operation.audioChain = appendPromise.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await appendPromise;
    } catch (error) {
      if (operation.invalidated) throw makeError('cancelled');
      if (
        error instanceof DictationError &&
        (error.code === 'provider-failed' || error.code === 'limit-exceeded')
      )
        failOperation(registry, operation, error, now);
      throw error;
    } finally {
      if (operation.pendingChunkPromises.get(sequence) === appendPromise)
        operation.pendingChunkPromises.delete(sequence);
      if (operation.pendingChunkDigests.get(sequence) === digest)
        operation.pendingChunkDigests.delete(sequence);
    }
  };

  const getDictationEvents = (
    accountId: string,
    input: DictationOperationInput,
  ): DictationEventIterator => {
    const operation = getOwnedOperation(registry, accountId, input, now());
    consumeRateLimit(registry, accountId, 'events', now());
    if (operation.state === 'connecting') throw makeError('busy');
    if (operation.eventReaderClaimed) throw makeError('busy');
    operation.eventReaderClaimed = true;
    return createEventIterator(operation, async () => {
      if (operation.state !== 'terminal' && operation.state !== 'cancelled')
        await cancelOperation(registry, operation, now);
      else operation.eventReaderClosed = true;
    });
  };

  const stopDictation = async (
    accountId: string,
    input: DictationOperationInput,
  ) => {
    const operation = getOwnedOperation(registry, accountId, input, now());
    consumeRateLimit(registry, accountId, 'control', now());
    if (operation.state === 'cancelled') throw makeError('cancelled');
    if (operation.state === 'terminal') return;
    if (operation.stopPromise) return operation.stopPromise;
    operation.acceptingAudio = false;
    operation.state = 'stopping';
    clearTimer(operation.durationTimer);
    operation.durationTimer = null;
    operation.stopPromise = (async () => {
      await operation.audioChain;
      if (operation.state === 'cancelled') throw makeError('cancelled');
      const socket = operation.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        const error = makeError('provider-failed');
        failOperation(registry, operation, error, now);
        throw error;
      }
      try {
        await sendSocketFrame(socket, '{"type":"endStream"}', false);
      } catch (error) {
        const dictationError =
          error instanceof DictationError
            ? error
            : makeError('provider-failed');
        failOperation(registry, operation, dictationError, now);
        throw dictationError;
      }
      await Promise.race([
        operation.closedPromise,
        new Promise<void>((_, reject) => {
          operation.stopTimer = scheduleTimer(
            () => reject(makeError('provider-failed')),
            FINAL_DRAIN_TIMEOUT_MS,
          );
        }),
      ]).catch((error) => {
        if (operation.state !== 'terminal' && operation.state !== 'cancelled') {
          failOperation(
            registry,
            operation,
            error instanceof DictationError
              ? error
              : makeError('provider-failed'),
            now,
          );
          operation.socket?.terminate();
        }
        throw error instanceof DictationError
          ? error
          : makeError('provider-failed');
      });
      clearTimer(operation.stopTimer);
      operation.stopTimer = null;
      if (operation.terminalErrorCode)
        throw makeError(operation.terminalErrorCode);
    })();
    return operation.stopPromise;
  };

  const cancelDictation = async (
    accountId: string,
    input: DictationOperationInput,
  ) => {
    const operation = getOwnedOperation(registry, accountId, input, now());
    consumeRateLimit(registry, accountId, 'control', now());
    await cancelOperation(registry, operation, now);
  };

  return {
    createDictation,
    appendDictationAudio,
    getDictationEvents,
    stopDictation,
    cancelDictation,
  };
};

const defaultDictationService = createDictationService({
  registry: getDictationRegistry(),
});

export const createDictation = defaultDictationService.createDictation;
export const appendDictationAudio =
  defaultDictationService.appendDictationAudio;
export const getDictationEvents = defaultDictationService.getDictationEvents;
export const stopDictation = defaultDictationService.stopDictation;
export const cancelDictation = defaultDictationService.cancelDictation;
