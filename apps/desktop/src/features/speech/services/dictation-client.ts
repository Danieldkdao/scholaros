import { createHash } from 'node:crypto';
import {
  dictationAudioChunkSchema,
  dictationEventSchema,
  dictationStartInputSchema,
  type DictationEvent,
  type DictationStartInput,
} from '@scholaros/services/learning/speech-contracts';
import {
  idSchema,
  revisionSchema,
  safeErrorCodeSchema,
  type SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';
import { z } from 'zod';

const maxAudioFrameBytes = 16_384;
const maxEventFrameBytes = 64 * 1024;
const maxResponseBytes = 8 * 1024;
const maxAudioChunks = 500;
const startRequestTimeoutMs = 18_000;
const controlRequestTimeoutMs = 5_000;
const apiStartPath = '/api/dictation' as const;
type DictationQueryPath =
  | `/api/dictation/audio?operationId=${string}`
  | `/api/dictation/events?operationId=${string}`
  | `/api/dictation/control?operationId=${string}`;
export type DictationApiPath =
  | typeof apiStartPath
  | DictationQueryPath
  | '/api/dictation/control';

export type DictationRequestInit = Pick<
  RequestInit,
  'body' | 'headers' | 'method' | 'signal'
> & { cache?: RequestCache };

export type AuthorizedDictationFetch = (
  path: DictationApiPath,
  init: DictationRequestInit,
) => Promise<Response>;

export class DictationClientError extends Error {
  readonly code: SafeErrorCode;

  constructor(code: SafeErrorCode) {
    super(safeMessageForCode(code));
    this.name = 'DictationClientError';
    this.code = code;
  }
}

type StartResponse = {
  operationId: string;
};

const startResponseSchema = z.strictObject({
  operationId: idSchema,
});
export type StartResponseSchema = z.infer<typeof startResponseSchema>;
const audioResponseSchema = z.strictObject({
  acceptedSequence: revisionSchema,
});
export type AudioResponseSchema = z.infer<typeof audioResponseSchema>;
const controlResponseSchema = startResponseSchema;
const safeErrorResponseSchema = z.strictObject({
  error: z.string().max(300),
  code: safeErrorCodeSchema,
});
export type SafeErrorResponseSchema = z.infer<typeof safeErrorResponseSchema>;

type ActiveDictation = {
  operationId: string;
  sessionId: string;
  composerRevision: number;
  nextAudioSequence: number;
  audioDigests: Map<number, string>;
  pendingAudioDigests: Map<number, string>;
  pendingAudioPromises: Map<number, Promise<{ acceptedSequence: number }>>;
  lastEventSequence: number;
  readySeen: boolean;
  stopRequested: boolean;
  finalAccepted: boolean;
  eventsStarted: boolean;
  lifecycleController: AbortController;
  eventController: AbortController | null;
};

export type DictationClient = {
  startDictation: (
    input: DictationStartInput,
    signal?: AbortSignal,
  ) => Promise<StartResponse>;
  appendDictationAudio: (
    operationId: string,
    sequence: number,
    bytes: Uint8Array,
  ) => Promise<{ acceptedSequence: number }>;
  getDictationEvents: (
    operationId: string,
  ) => AsyncIterableIterator<DictationEvent>;
  stopDictation: (operationId: string) => Promise<void>;
  cancelDictation: (operationId: string) => Promise<void>;
  cancelAll: () => Promise<void>;
  activeOperationCount: () => number;
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

const readBoundedText = async (response: Response, limit: number) => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
      return null;
    if (declaredLength > limit) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) {
      for (const chunk of chunks) chunk.fill(0);
      value.fill(0);
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    chunk.fill(0);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
};

const readJson = async (response: Response, fallbackCode: SafeErrorCode) => {
  const text = await readBoundedText(response, maxResponseBytes);
  if (text === null) throw new DictationClientError('limit-exceeded');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DictationClientError(fallbackCode);
  }
};

const readResponseError = async (response: Response) => {
  const result = await readJson(response, 'provider-failed');
  const parsed = safeErrorResponseSchema.safeParse(result);
  throw new DictationClientError(
    parsed.success ? parsed.data.code : 'provider-failed',
  );
};

const getPathWithOperation = (
  path:
    | '/api/dictation/audio'
    | '/api/dictation/events'
    | '/api/dictation/control',
  operationId: string,
): DictationQueryPath =>
  `${path}?operationId=${encodeURIComponent(operationId)}` as DictationQueryPath;

const operationHeaders = (operation: ActiveDictation) => ({
  'X-Dictation-Session-Id': operation.sessionId,
  'X-Dictation-Composer-Revision': String(operation.composerRevision),
});

const raceWithAbort = <Value>(promise: Promise<Value>, signal: AbortSignal) => {
  if (signal.aborted)
    return Promise.reject(new DictationClientError('cancelled'));

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DictationClientError('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([promise, abortPromise]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  });
};

const decodeSseFrame = (frame: string) => {
  if (frame.startsWith(':')) return null;
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new DictationClientError('provider-failed');
  }
  return dictationEventSchema.safeParse(value);
};

export const createDictationClient = (
  authorizedFetch: AuthorizedDictationFetch,
): DictationClient => {
  const operations = new Map<string, ActiveDictation>();
  const pendingCancellations = new Map<string, Promise<void>>();
  let startingController: AbortController | null = null;

  const getOperation = (operationId: string) => {
    const operation = operations.get(operationId);
    if (!operation) throw new DictationClientError('not-found');
    return operation;
  };

  const removeOperation = (operation: ActiveDictation) => {
    operation.lifecycleController.abort();
    operation.eventController?.abort();
    operation.audioDigests.clear();
    operations.delete(operation.operationId);
  };

  const startDictation = async (
    input: DictationStartInput,
    signal?: AbortSignal,
  ): Promise<StartResponse> => {
    const parsedInput = dictationStartInputSchema.safeParse(input);
    if (!parsedInput.success) throw new DictationClientError('invalid-input');
    if (signal?.aborted) throw new DictationClientError('cancelled');
    if (operations.size > 0 || startingController)
      throw new DictationClientError('busy');
    const controller = new AbortController();
    startingController = controller;
    const requestSignal = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(startRequestTimeoutMs),
    ]);
    try {
      const startRequest = (async () => {
        const response = await authorizedFetch(apiStartPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, ...parsedInput.data }),
          signal: requestSignal,
        });
        if (!response.ok) await readResponseError(response);
        const parsedResponse = startResponseSchema.safeParse(
          await readJson(response, 'provider-failed'),
        );
        if (!parsedResponse.success)
          throw new DictationClientError('provider-failed');
        if (operations.has(parsedResponse.data.operationId))
          throw new DictationClientError('revision-conflict');
        const operation: ActiveDictation = {
          operationId: parsedResponse.data.operationId,
          sessionId: parsedInput.data.sessionId,
          composerRevision: parsedInput.data.composerRevision,
          nextAudioSequence: 0,
          audioDigests: new Map(),
          pendingAudioDigests: new Map(),
          pendingAudioPromises: new Map(),
          lastEventSequence: -1,
          readySeen: false,
          stopRequested: false,
          finalAccepted: false,
          eventsStarted: false,
          lifecycleController: new AbortController(),
          eventController: null,
        };
        operations.set(operation.operationId, operation);
        if (requestSignal.aborted) {
          await cancelDictation(operation.operationId).catch(() => undefined);
          throw new DictationClientError('cancelled');
        }
        return parsedResponse.data;
      })();
      const startResponse = await raceWithAbort(startRequest, requestSignal);
      if (requestSignal.aborted) {
        await cancelDictation(startResponse.operationId).catch(() => undefined);
        throw new DictationClientError('cancelled');
      }
      return startResponse;
    } catch (error) {
      if (error instanceof DictationClientError) throw error;
      if (requestSignal.aborted) throw new DictationClientError('cancelled');
      throw new DictationClientError('offline');
    } finally {
      if (startingController === controller) startingController = null;
    }
  };

  const appendDictationAudio = async (
    operationId: string,
    sequence: number,
    bytes: Uint8Array,
  ) => {
    try {
      if (!(bytes instanceof Uint8Array))
        throw new DictationClientError('invalid-input');
      const operation = getOperation(operationId);
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        bytes.byteLength === 0 ||
        bytes.byteLength % 2 !== 0
      )
        throw new DictationClientError('invalid-input');
      if (bytes.byteLength > maxAudioFrameBytes || sequence >= maxAudioChunks)
        throw new DictationClientError('limit-exceeded');
      const parsedChunk = dictationAudioChunkSchema.safeParse({
        operationId,
        sequence,
        bytes,
      });
      if (!parsedChunk.success) throw new DictationClientError('invalid-input');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const previousDigest = operation.audioDigests.get(sequence);
      if (previousDigest && previousDigest !== digest)
        throw new DictationClientError('revision-conflict');
      const pendingDigest = operation.pendingAudioDigests.get(sequence);
      if (pendingDigest) {
        if (pendingDigest !== digest)
          throw new DictationClientError('revision-conflict');
        return await operation.pendingAudioPromises.get(sequence)!;
      }
      if (!previousDigest && sequence !== operation.nextAudioSequence)
        throw new DictationClientError('revision-conflict');

      const audioCopy = new Uint8Array(bytes);
      const audioBuffer = audioCopy.buffer as ArrayBuffer;
      const audioRequest = (async () => {
        try {
          const response = await authorizedFetch(
            getPathWithOperation('/api/dictation/audio', operationId),
            {
              method: 'PUT',
              headers: {
                ...operationHeaders(operation),
                'X-Dictation-Sequence': String(sequence),
                'content-type': 'application/octet-stream',
              },
              body: audioBuffer,
              signal: AbortSignal.any([
                operation.lifecycleController.signal,
                AbortSignal.timeout(10_000),
              ]),
            },
          );
          if (!response.ok) await readResponseError(response);
          const parsedResponse = audioResponseSchema.safeParse(
            await readJson(response, 'provider-failed'),
          );
          if (
            !parsedResponse.success ||
            parsedResponse.data.acceptedSequence !== sequence
          )
            throw new DictationClientError('revision-conflict');
          return parsedResponse.data;
        } catch (error) {
          if (error instanceof DictationClientError) throw error;
          if (operation.lifecycleController.signal.aborted)
            throw new DictationClientError('cancelled');
          throw new DictationClientError('offline');
        } finally {
          audioCopy.fill(0);
        }
      })();
      operation.pendingAudioDigests.set(sequence, digest);
      operation.pendingAudioPromises.set(sequence, audioRequest);
      try {
        const acceptedAudio = await audioRequest;
        operation.audioDigests.set(sequence, digest);
        if (sequence === operation.nextAudioSequence)
          operation.nextAudioSequence += 1;
        return acceptedAudio;
      } finally {
        operation.pendingAudioDigests.delete(sequence);
        operation.pendingAudioPromises.delete(sequence);
      }
    } finally {
      if (bytes instanceof Uint8Array) bytes.fill(0);
    }
  };

  const getDictationEvents = (operationId: string) => {
    const operation = getOperation(operationId);
    if (operation.eventsStarted) throw new DictationClientError('busy');
    operation.eventsStarted = true;
    const eventController = new AbortController();
    operation.eventController = eventController;
    const signal = AbortSignal.any([
      operation.lifecycleController.signal,
      eventController.signal,
    ]);

    const readEvents = async function* () {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let ended = false;
      let pendingText = '';
      let lastSequence = operation.lastEventSequence;
      try {
        const response = await raceWithAbort(
          authorizedFetch(
            getPathWithOperation('/api/dictation/events', operationId),
            {
              method: 'GET',
              headers: {
                ...operationHeaders(operation),
                Accept: 'text/event-stream',
              },
              cache: 'no-store',
              signal,
            },
          ),
          signal,
        );
        if (signal.aborted) throw new DictationClientError('cancelled');
        if (!response.ok) await readResponseError(response);
        if (!response.body) throw new DictationClientError('provider-failed');
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for (;;) {
          if (signal.aborted) throw new DictationClientError('cancelled');
          const { done, value } = await raceWithAbort(reader.read(), signal);
          if (signal.aborted) throw new DictationClientError('cancelled');
          if (done) {
            pendingText += decoder.decode();
            if (pendingText.trim())
              throw new DictationClientError('provider-failed');
            break;
          }
          pendingText += decoder.decode(value, { stream: true });
          if (
            new TextEncoder().encode(pendingText).byteLength >
            maxEventFrameBytes
          )
            throw new DictationClientError('limit-exceeded');
          let boundary = pendingText.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = pendingText.slice(0, boundary).replace(/\r$/, '');
            pendingText = pendingText.slice(boundary + 2);
            const parsedEvent = decodeSseFrame(frame);
            if (parsedEvent === null) {
              boundary = pendingText.indexOf('\n\n');
              continue;
            }
            if (!parsedEvent.success)
              throw new DictationClientError('provider-failed');
            const event = parsedEvent.data;
            if (
              event.operationId !== operation.operationId ||
              event.sessionId !== operation.sessionId ||
              event.composerRevision !== operation.composerRevision
            )
              throw new DictationClientError('session-changed');
            if (event.sequence <= lastSequence) {
              boundary = pendingText.indexOf('\n\n');
              continue;
            }
            if (!operation.readySeen && event.kind !== 'ready')
              throw new DictationClientError('provider-failed');
            if (operation.finalAccepted && event.kind === 'partial') {
              boundary = pendingText.indexOf('\n\n');
              continue;
            }
            if (event.kind === 'ready') {
              if (operation.readySeen)
                throw new DictationClientError('provider-failed');
              operation.readySeen = true;
            }
            lastSequence = event.sequence;
            operation.lastEventSequence = event.sequence;
            if (event.kind === 'final') {
              if (!operation.stopRequested)
                throw new DictationClientError('provider-failed');
              if (operation.finalAccepted) {
                boundary = pendingText.indexOf('\n\n');
                continue;
              }
              operation.finalAccepted = true;
            }
            if (event.kind === 'ended') ended = true;
            yield event;
            if (ended) return;
            boundary = pendingText.indexOf('\n\n');
          }
        }
        if (!ended && !signal.aborted)
          throw new DictationClientError('offline');
      } catch (error) {
        if (error instanceof DictationClientError) throw error;
        if (signal.aborted) throw new DictationClientError('cancelled');
        throw new DictationClientError('offline');
      } finally {
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
        if (ended) removeOperation(operation);
        else if (!signal.aborted)
          void cancelDictation(operationId).catch(() => undefined);
      }
    };
    return readEvents();
  };

  const stopDictation = async (operationId: string) => {
    const operation = getOperation(operationId);
    operation.stopRequested = true;
    const response = await authorizedFetch('/api/dictation/control', {
      method: 'POST',
      headers: {
        ...operationHeaders(operation),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ operationId, action: 'stop' }),
      signal: AbortSignal.any([
        operation.lifecycleController.signal,
        AbortSignal.timeout(18_000),
      ]),
    }).catch(() => {
      if (operation.lifecycleController.signal.aborted)
        throw new DictationClientError('cancelled');
      throw new DictationClientError('offline');
    });
    if (!response.ok) await readResponseError(response);
    const parsedResponse = controlResponseSchema.safeParse(
      await readJson(response, 'provider-failed'),
    );
    if (
      !parsedResponse.success ||
      parsedResponse.data.operationId !== operationId
    )
      throw new DictationClientError('provider-failed');
  };

  const cancelDictation = (operationId: string) => {
    const pendingCancellation = pendingCancellations.get(operationId);
    if (pendingCancellation) return pendingCancellation;
    const operation = operations.get(operationId);
    if (!operation) return Promise.resolve();
    removeOperation(operation);

    const cancellation = (async () => {
      try {
        const response = await authorizedFetch(
          getPathWithOperation('/api/dictation/control', operationId),
          {
            method: 'DELETE',
            headers: operationHeaders(operation),
            signal: AbortSignal.timeout(controlRequestTimeoutMs),
          },
        );
        if (!response.ok) await readResponseError(response);
        const parsedResponse = controlResponseSchema.safeParse(
          await readJson(response, 'provider-failed'),
        );
        if (
          !parsedResponse.success ||
          parsedResponse.data.operationId !== operationId
        )
          throw new DictationClientError('provider-failed');
      } catch (error) {
        if (error instanceof DictationClientError) throw error;
        throw new DictationClientError('offline');
      }
    })();
    pendingCancellations.set(operationId, cancellation);
    void cancellation.then(
      () => {
        if (pendingCancellations.get(operationId) === cancellation)
          pendingCancellations.delete(operationId);
      },
      () => {
        if (pendingCancellations.get(operationId) === cancellation)
          pendingCancellations.delete(operationId);
      },
    );
    return cancellation;
  };

  const cancelAll = async () => {
    startingController?.abort();
    startingController = null;
    const activeCancellations = [...operations.keys()].map(cancelDictation);
    await Promise.allSettled([
      ...activeCancellations,
      ...pendingCancellations.values(),
    ]);
  };

  return {
    startDictation,
    appendDictationAudio,
    getDictationEvents,
    stopDictation,
    cancelDictation,
    cancelAll,
    activeOperationCount: () => operations.size,
  };
};
