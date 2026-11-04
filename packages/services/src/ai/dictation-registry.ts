import type WebSocket from 'ws';
import type { DictationEvent } from '../learning/speech-contracts';
import type { SafeErrorCode } from '../learning/product-contracts';

export type DictationOperationState =
  | 'connecting'
  | 'ready'
  | 'stopping'
  | 'terminal'
  | 'cancelled';

export type DictationRateLimitKind = 'start' | 'audio' | 'control' | 'events';

export type DictationOperation = {
  id: string;
  accountId: string;
  requestId: string;
  requestDigest: string;
  sessionId: string;
  composerRevision: number;
  state: DictationOperationState;
  createdAt: number;
  readyAt: number | null;
  terminalAt: number | null;
  socket: WebSocket | null;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  closedPromise: Promise<void>;
  resolveClosed: () => void;
  connectionTimer: ReturnType<typeof setTimeout> | null;
  durationTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  terminalTimer: ReturnType<typeof setTimeout> | null;
  audioChain: Promise<void>;
  pendingAudioBuffers: Map<number, Buffer>;
  pendingAudioBytes: number;
  chunkDigests: Map<number, string>;
  pendingChunkDigests: Map<number, string>;
  pendingChunkPromises: Map<number, Promise<{ acceptedSequence: number }>>;
  nextAudioSequence: number;
  audioBytes: number;
  processedAudioMs: number;
  acceptingAudio: boolean;
  finalAccepted: boolean;
  terminalErrorCode: SafeErrorCode | null;
  eventSequence: number;
  eventQueue: DictationEvent[];
  eventQueueBytes: number;
  eventWaiters: Array<(event: DictationEvent | null) => void>;
  eventReaderClaimed: boolean;
  eventReaderClosed: boolean;
  stopPromise: Promise<void> | null;
  invalidated: boolean;
};

export type DictationRegistry = {
  operations: Map<string, DictationOperation>;
  activeByAccount: Map<string, string>;
  requestOperations: Map<string, string>;
  rateLimits: Map<string, { windowStartedAt: number; count: number }>;
};

export const createDictationRegistry = (): DictationRegistry => ({
  operations: new Map(),
  activeByAccount: new Map(),
  requestOperations: new Map(),
  rateLimits: new Map(),
});

// Shared by route bundles in this process; it does not provide host affinity.
const dictationRegistrySymbol = Symbol.for('scholaros.dictation-registry.v1');
type DictationRegistryGlobal = typeof globalThis & {
  [key: symbol]: unknown;
};

export const getDictationRegistry = (): DictationRegistry => {
  const globalRegistry = globalThis as DictationRegistryGlobal;
  const existingRegistry = globalRegistry[dictationRegistrySymbol];
  if (existingRegistry) return existingRegistry as DictationRegistry;

  const registry = createDictationRegistry();
  globalRegistry[dictationRegistrySymbol] = registry;
  return registry;
};
