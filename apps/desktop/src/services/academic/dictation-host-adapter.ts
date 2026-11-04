import {
  dictationAudioChunkSchema,
  dictationStartInputSchema,
  type DictationAudioChunk,
  type DictationEvent,
  type DictationStartInput,
} from '@scholaros/services/learning/speech-contracts';
import { idSchema } from '@scholaros/services/learning/product-contracts';
import {
  createDictationClient,
  DictationClientError,
  type AuthorizedDictationFetch,
} from '../../features/speech/services/dictation-client';

const maxAudioFrameBytes = 16_384;
const maxPendingAudioBytes = 48_000;
const maxAudioBytes = 48_000 * 120;

export type DictationHostOwner = {
  accountId: string;
  senderId: number;
};

export type DictationHostScope = DictationHostOwner & {
  operationId?: string;
  sessionId: string;
  composerRevision: number;
};

export type DictationHostAdapterDependencies = {
  authorizedFetch: AuthorizedDictationFetch;
  isCurrent: (scope: DictationHostScope) => boolean | Promise<boolean>;
  publishEvent: (senderId: number, event: DictationEvent) => void;
};

export type DictationHostAdapter = {
  startDictation: (
    input: DictationStartInput,
    owner: DictationHostOwner,
  ) => Promise<{ operationId: string }>;
  appendDictationAudio: (
    input: DictationAudioChunk,
    owner: DictationHostOwner,
  ) => Promise<{ acceptedSequence: number }>;
  stopDictation: (
    input: { operationId: string },
    owner: DictationHostOwner,
  ) => Promise<void>;
  cancelDictation: (
    input: { operationId: string },
    owner: DictationHostOwner,
  ) => Promise<void>;
  cancelForOwner: (owner: DictationHostOwner) => Promise<void>;
  cancelForSession: (input: {
    accountId: string;
    sessionId: string;
  }) => Promise<void>;
  dispose: () => Promise<void>;
};

type HostOperation = {
  scope: DictationHostScope & { operationId: string };
  invalidated: boolean;
  terminal: boolean;
  lastEventSequence: number;
  nextAudioSequence: number;
  pendingAudioBytes: number;
  pendingAudioRequests: Set<Promise<void>>;
  acceptedAudioBytes: number;
  eventPump: Promise<void> | null;
  eventError: unknown | null;
  stopPromise: Promise<void> | null;
  cancelPromise: Promise<void> | null;
  cancelSettlement: Promise<void> | null;
};

type PendingStart = {
  scope: DictationHostScope;
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
};

type PendingCancellation = {
  operation: HostOperation;
  promise: Promise<void>;
  settled: Promise<void>;
};

const ownerMatches = (
  operationOwner: DictationHostOwner,
  caller: DictationHostOwner,
) =>
  operationOwner.accountId === caller.accountId &&
  operationOwner.senderId === caller.senderId;

const requireOwner = (owner: DictationHostOwner) => {
  if (
    !idSchema.safeParse(owner.accountId).success ||
    !Number.isSafeInteger(owner.senderId) ||
    owner.senderId <= 0
  )
    throw new DictationClientError('invalid-input');
};

export const createDictationHostAdapter = (
  dependencies: DictationHostAdapterDependencies,
): DictationHostAdapter => {
  const client = createDictationClient(dependencies.authorizedFetch);
  const operations = new Map<string, HostOperation>();
  const pendingStarts = new Set<PendingStart>();
  const pendingCancellations = new Set<PendingCancellation>();
  let disposed = false;
  let disposal: Promise<void> | null = null;

  const ensureCurrent = async (scope: DictationHostScope) => {
    let current = false;
    try {
      current = await dependencies.isCurrent(scope);
    } catch {
      current = false;
    }
    if (!current) throw new DictationClientError('session-changed');
  };

  const getOperation = (operationId: string, caller: DictationHostOwner) => {
    const operation = operations.get(operationId);
    if (!operation || !ownerMatches(operation.scope, caller))
      throw new DictationClientError('not-found');
    if (operation.invalidated || operation.terminal)
      throw new DictationClientError('not-found');
    return operation;
  };

  const beginCancellation = (operation: HostOperation) => {
    operation.invalidated = true;
    if (operations.get(operation.scope.operationId) === operation)
      operations.delete(operation.scope.operationId);
    if (!operation.cancelPromise) {
      const promise = client.cancelDictation(operation.scope.operationId);
      operation.cancelPromise = promise;
      const cancellation = {
        operation,
        promise,
        settled: Promise.allSettled([
          promise,
          ...operation.pendingAudioRequests,
          ...(operation.eventPump ? [operation.eventPump] : []),
        ]).then(() => undefined),
      };
      operation.cancelSettlement = cancellation.settled;
      pendingCancellations.add(cancellation);
      void cancellation.settled.then(() =>
        pendingCancellations.delete(cancellation),
      );
      void operation.cancelPromise.catch(() => undefined);
    }
    return operation.cancelPromise;
  };

  const assertOperationCurrent = async (operation: HostOperation) => {
    if (operation.invalidated || disposed)
      throw new DictationClientError('cancelled');
    try {
      await ensureCurrent(operation.scope);
    } catch (error) {
      void beginCancellation(operation).catch(() => undefined);
      throw error;
    }
    if (operation.invalidated || disposed)
      throw new DictationClientError('cancelled');
  };

  const startEventPump = (operation: HostOperation) => {
    if (operation.eventPump) return operation.eventPump;
    const eventStream = client.getDictationEvents(operation.scope.operationId);
    operation.eventPump = (async () => {
      try {
        for await (const event of eventStream) {
          if (operation.invalidated || disposed) return;
          if (
            event.operationId !== operation.scope.operationId ||
            event.sessionId !== operation.scope.sessionId ||
            event.composerRevision !== operation.scope.composerRevision ||
            !Number.isSafeInteger(event.sequence) ||
            event.sequence <= operation.lastEventSequence
          )
            throw new DictationClientError('session-changed');
          await assertOperationCurrent(operation);
          if (operation.invalidated || disposed) return;
          try {
            dependencies.publishEvent(operation.scope.senderId, event);
          } catch {
            void beginCancellation(operation).catch(() => undefined);
            return;
          }
          operation.lastEventSequence = event.sequence;
          if (event.kind === 'ended') {
            operation.terminal = true;
            operations.delete(operation.scope.operationId);
            return;
          }
        }
        if (!operation.invalidated && !operation.terminal)
          throw new DictationClientError('offline');
      } catch (error) {
        if (operation.invalidated || disposed) return;
        const eventError =
          error instanceof DictationClientError
            ? error
            : new DictationClientError('offline');
        operation.eventError = eventError;
        try {
          await ensureCurrent(operation.scope);
          if (!operation.invalidated && !disposed) {
            const eventBase = {
              version: 1 as const,
              operationId: operation.scope.operationId,
              sessionId: operation.scope.sessionId,
              composerRevision: operation.scope.composerRevision,
            };
            const errorEvent: DictationEvent = {
              ...eventBase,
              sequence: operation.lastEventSequence + 1,
              kind: 'error',
              errorCode: eventError.code,
            };
            const endedEvent: DictationEvent = {
              ...eventBase,
              sequence: errorEvent.sequence + 1,
              kind: 'ended',
            };
            dependencies.publishEvent(operation.scope.senderId, errorEvent);
            dependencies.publishEvent(operation.scope.senderId, endedEvent);
            operation.lastEventSequence = endedEvent.sequence;
            operation.terminal = true;
          }
        } catch {
          // A stale session must never receive a provider failure event.
        }
        void beginCancellation(operation).catch(() => undefined);
        throw eventError;
      } finally {
        if (operation.invalidated || operation.terminal)
          operations.delete(operation.scope.operationId);
      }
    })();
    void operation.eventPump.catch(() => undefined);
    return operation.eventPump;
  };

  const cancelOperation = async (operation: HostOperation) => {
    const cancellation = beginCancellation(operation);
    await Promise.allSettled([
      cancellation,
      operation.cancelSettlement ?? Promise.resolve(),
      operation.eventPump ?? Promise.resolve(),
    ]);
    await cancellation;
  };

  const startDictation = async (
    input: DictationStartInput,
    owner: DictationHostOwner,
  ) => {
    if (disposed) throw new DictationClientError('cancelled');
    requireOwner(owner);
    const parsedInput = dictationStartInputSchema.safeParse(input);
    if (!parsedInput.success) throw new DictationClientError('invalid-input');
    if (
      operations.size > 0 ||
      pendingStarts.size > 0 ||
      pendingCancellations.size > 0 ||
      client.activeOperationCount() > 0
    )
      throw new DictationClientError('busy');

    const controller = new AbortController();
    const scope: DictationHostScope = {
      ...owner,
      sessionId: parsedInput.data.sessionId,
      composerRevision: parsedInput.data.composerRevision,
    };
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const pending: PendingStart = {
      scope,
      controller,
      settled,
      settle,
    };
    pendingStarts.add(pending);

    try {
      await ensureCurrent(scope);
      if (controller.signal.aborted || disposed)
        throw new DictationClientError('cancelled');
      const started = await client.startDictation(
        parsedInput.data,
        controller.signal,
      );
      const operation: HostOperation = {
        scope: { ...scope, operationId: started.operationId },
        invalidated: false,
        terminal: false,
        lastEventSequence: -1,
        nextAudioSequence: 0,
        pendingAudioBytes: 0,
        pendingAudioRequests: new Set(),
        acceptedAudioBytes: 0,
        eventPump: null,
        eventError: null,
        stopPromise: null,
        cancelPromise: null,
        cancelSettlement: null,
      };
      operations.set(started.operationId, operation);
      if (controller.signal.aborted || disposed) {
        await cancelOperation(operation).catch(() => undefined);
        throw new DictationClientError('cancelled');
      }
      try {
        await ensureCurrent(operation.scope);
      } catch (error) {
        await cancelOperation(operation).catch(() => undefined);
        throw error;
      }
      return started;
    } catch (error) {
      if (error instanceof DictationClientError) throw error;
      if (controller.signal.aborted || disposed)
        throw new DictationClientError('cancelled');
      throw new DictationClientError('offline');
    } finally {
      pendingStarts.delete(pending);
      pending.settle();
    }
  };

  const appendDictationAudio = async (
    input: DictationAudioChunk,
    owner: DictationHostOwner,
  ) => {
    const candidateBytes =
      typeof input === 'object' &&
      input !== null &&
      'bytes' in input &&
      input.bytes instanceof Uint8Array
        ? input.bytes
        : null;
    let operation: HostOperation | null = null;
    let audioSettlement: Promise<void> | null = null;
    let settleAudio: () => void = () => undefined;
    let reservedBytes = 0;
    let audioRequestStarted = false;
    try {
      requireOwner(owner);
      if (candidateBytes && candidateBytes.byteLength > maxAudioFrameBytes)
        throw new DictationClientError('limit-exceeded');
      const parsedInput = dictationAudioChunkSchema.safeParse(input);
      if (!parsedInput.success) throw new DictationClientError('invalid-input');
      operation = getOperation(parsedInput.data.operationId, owner);
      if (operation.stopPromise) throw new DictationClientError('busy');
      audioSettlement = new Promise<void>((resolve) => {
        settleAudio = resolve;
      });
      operation.pendingAudioRequests.add(audioSettlement);
      await assertOperationCurrent(operation);
      const { bytes, sequence } = parsedInput.data;
      if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0)
        throw new DictationClientError('invalid-input');
      if (bytes.byteLength > maxAudioFrameBytes)
        throw new DictationClientError('limit-exceeded');
      if (sequence > operation.nextAudioSequence)
        throw new DictationClientError('revision-conflict');
      if (operation.pendingAudioBytes + bytes.byteLength > maxPendingAudioBytes)
        throw new DictationClientError('busy');
      const isNextChunk = sequence === operation.nextAudioSequence;
      if (
        isNextChunk &&
        operation.acceptedAudioBytes +
          operation.pendingAudioBytes +
          bytes.byteLength >
          maxAudioBytes
      )
        throw new DictationClientError('limit-exceeded');
      operation.pendingAudioBytes += bytes.byteLength;
      reservedBytes = bytes.byteLength;
      startEventPump(operation);
      audioRequestStarted = true;
      const accepted = await client.appendDictationAudio(
        parsedInput.data.operationId,
        sequence,
        bytes,
      );
      await assertOperationCurrent(operation);
      if (sequence === operation.nextAudioSequence) {
        operation.nextAudioSequence += 1;
        operation.acceptedAudioBytes += bytes.byteLength;
      }
      return accepted;
    } catch (error) {
      if (operation && audioRequestStarted) {
        candidateBytes?.fill(0);
        await beginCancellation(operation).catch(() => undefined);
      }
      if (error instanceof DictationClientError) throw error;
      throw new DictationClientError('offline');
    } finally {
      if (operation && reservedBytes > 0)
        operation.pendingAudioBytes = Math.max(
          0,
          operation.pendingAudioBytes - reservedBytes,
        );
      candidateBytes?.fill(0);
      if (operation && audioSettlement) {
        operation.pendingAudioRequests.delete(audioSettlement);
        settleAudio();
      }
    }
  };

  const stopDictation = async (
    input: { operationId: string },
    owner: DictationHostOwner,
  ) => {
    requireOwner(owner);
    if (!idSchema.safeParse(input?.operationId).success)
      throw new DictationClientError('invalid-input');
    const operation = getOperation(input.operationId, owner);
    if (operation.stopPromise) return operation.stopPromise;
    operation.stopPromise = (async () => {
      try {
        await assertOperationCurrent(operation);
        startEventPump(operation);
        await Promise.allSettled(operation.pendingAudioRequests);
        await assertOperationCurrent(operation);
        await client.stopDictation(operation.scope.operationId);
        if (operation.eventPump) await operation.eventPump;
        if (operation.eventError) throw operation.eventError;
      } catch (error) {
        await cancelOperation(operation).catch(() => undefined);
        if (error instanceof DictationClientError) throw error;
        throw new DictationClientError('offline');
      }
    })();
    return operation.stopPromise;
  };

  const cancelDictation = async (
    input: { operationId: string },
    owner: DictationHostOwner,
  ) => {
    requireOwner(owner);
    if (!idSchema.safeParse(input?.operationId).success)
      throw new DictationClientError('invalid-input');
    const operation = operations.get(input.operationId);
    if (operation && !ownerMatches(operation.scope, owner))
      throw new DictationClientError('not-found');
    if (operation) {
      await cancelOperation(operation);
      return;
    }
    const pendingCancellation = [...pendingCancellations].find(
      ({ operation: pendingOperation }) =>
        pendingOperation.scope.operationId === input.operationId &&
        ownerMatches(pendingOperation.scope, owner),
    );
    if (!pendingCancellation) return;
    await Promise.allSettled([
      pendingCancellation.settled,
      pendingCancellation.operation.eventPump ?? Promise.resolve(),
    ]);
    await pendingCancellation.promise;
  };

  const cancelMatching = async (
    matches: (pending: PendingStart | HostOperation) => boolean,
  ) => {
    const pending = [...pendingStarts].filter(matches);
    for (const start of pending) start.controller.abort();
    const active = [...operations.values()].filter(matches);
    const activeTasks = active.map((operation) => cancelOperation(operation));
    const cancellations = [...pendingCancellations].filter(({ operation }) =>
      matches(operation),
    );
    await Promise.allSettled([
      ...activeTasks,
      ...cancellations.map(({ settled }) => settled),
      ...cancellations.flatMap(({ operation }) =>
        operation.eventPump ? [operation.eventPump] : [],
      ),
      ...(pending.length > 0 ? [client.cancelAll()] : []),
      ...pending.map((start) => start.settled),
    ]);
  };

  const cancelForOwner = async (requestedOwner: DictationHostOwner) => {
    requireOwner(requestedOwner);
    await cancelMatching((entry) => ownerMatches(entry.scope, requestedOwner));
  };

  const cancelForSession = async (input: {
    accountId: string;
    sessionId: string;
  }) => {
    if (
      !idSchema.safeParse(input?.accountId).success ||
      !idSchema.safeParse(input?.sessionId).success
    )
      throw new DictationClientError('invalid-input');
    await cancelMatching(
      (entry) =>
        entry.scope.accountId === input.accountId &&
        entry.scope.sessionId === input.sessionId,
    );
  };

  const dispose = () => {
    if (disposal) return disposal;
    disposed = true;
    const pending = [...pendingStarts];
    for (const start of pending) start.controller.abort();
    const active = [...operations.values()];
    const activeTasks = active.map((operation) => cancelOperation(operation));
    const cancellations = [...pendingCancellations];
    disposal = (async () => {
      await Promise.allSettled([
        ...activeTasks,
        ...cancellations.map(({ settled }) => settled),
        ...cancellations.flatMap(({ operation }) =>
          operation.eventPump ? [operation.eventPump] : [],
        ),
        ...(pending.length > 0 ? [client.cancelAll()] : []),
        ...pending.map((start) => start.settled),
      ]);
      await Promise.allSettled(
        active.flatMap((operation) =>
          operation.eventPump ? [operation.eventPump] : [],
        ),
      );
    })();
    return disposal;
  };

  return {
    startDictation,
    appendDictationAudio,
    stopDictation,
    cancelDictation,
    cancelForOwner,
    cancelForSession,
    dispose,
  };
};
