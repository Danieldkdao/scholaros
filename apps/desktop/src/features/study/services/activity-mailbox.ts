import { z } from 'zod';

export type ActivityMailboxBinding = {
  runtimeVersion: 'activity-runtime-v1';
  sessionId: string;
  artifactId: string;
  contentVersionId: string;
  attemptId: string;
  runId: string;
  readOnly?: boolean;
};

export const activityMessageLimits = {
  ordinaryEventBytes: 16 * 1024,
  stateBytes: 64 * 1024,
  stateEnvelopeBytes: 96 * 1024,
  queueBytes: 256 * 1024,
  queueEntries: 8,
  eventsPerSecond: 10,
  eventBurst: 20,
  checkpointsPerSecond: 2,
  checkpointBurst: 2,
  maximumDepth: 12,
} as const;

const idSchema = z.string().min(1).max(300);
const jsonValueSchema = z.unknown();
const activityEnvelopeSchema = z.object({
  protocolVersion: z.literal(1),
  runtimeVersion: z.literal('activity-runtime-v1'),
  source: z.literal('activity'),
  sessionId: idSchema,
  artifactId: idSchema,
  contentVersionId: idSchema,
  attemptId: idSchema,
  runId: idSchema,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  baseStateRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const activityMessageSchema = z.discriminatedUnion('kind', [
  activityEnvelopeSchema
    .extend({
      kind: z.literal('ready'),
      payload: z
        .object({ contentDigest: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
    })
    .strict(),
  activityEnvelopeSchema
    .extend({
      kind: z.literal('state-proposed'),
      payload: z.object({ state: jsonValueSchema }).strict(),
    })
    .strict(),
  activityEnvelopeSchema
    .extend({
      kind: z.literal('interaction'),
      payload: z
        .object({
          action: z.string().min(1).max(100),
          value: jsonValueSchema.nullable(),
        })
        .strict(),
    })
    .strict(),
  activityEnvelopeSchema
    .extend({
      kind: z.literal('runtime-error'),
      payload: z.object({ code: z.string().min(1).max(80) }).strict(),
    })
    .strict(),
]);

export type ActivityProtocolMessage = z.infer<typeof activityMessageSchema>;

type MessageBucket = {
  capacity: number;
  refillPerSecond: number;
  tokens: number;
  lastUpdatedAt: number;
};

type QueuedActivityMessage = {
  raw: string;
  byteLength: number;
  message: ActivityProtocolMessage;
};

export type ActivityMailbox = {
  enqueue: (serializedMessage: string) => boolean;
  readNext: () => string | null;
  acknowledge: (revision: number) => void;
  clear: () => void;
  readonly queuedEntries: number;
  readonly queuedBytes: number;
  readonly stateRevision: number;
  readonly lastSequence: number;
};

export const isBoundedJsonValue = (value: unknown, maximumBytes: number) => {
  const visited = new Set<object>();
  const visit = (candidate: unknown, depth: number): boolean => {
    if (depth > activityMessageLimits.maximumDepth) return false;
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      typeof candidate === 'string'
    )
      return (
        typeof candidate !== 'string' ||
        Buffer.byteLength(candidate, 'utf8') <= maximumBytes
      );
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate !== 'object') return false;
    if (visited.has(candidate)) return false;
    visited.add(candidate);

    if (Array.isArray(candidate)) {
      if (candidate.length > 1000) return false;
      const valid = candidate.every((item) => visit(item, depth + 1));
      visited.delete(candidate);
      return valid;
    }

    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(candidate);
    if (entries.length > 1000) return false;
    for (const [key, item] of entries) {
      if (
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor' ||
        Buffer.byteLength(key, 'utf8') > 256 ||
        !visit(item, depth + 1)
      )
        return false;
    }
    visited.delete(candidate);
    return true;
  };

  if (!visit(value, 0)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes;
  } catch {
    return false;
  }
};

export const decodeActivityMessage = (
  serializedMessage: string,
  binding: ActivityMailboxBinding,
  stateRevision: number,
): ActivityProtocolMessage | null => {
  if (
    Buffer.byteLength(serializedMessage, 'utf8') >
    activityMessageLimits.stateEnvelopeBytes
  )
    return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedMessage);
  } catch {
    return null;
  }
  const result = activityMessageSchema.safeParse(parsed);
  if (!result.success) return null;

  const message = result.data;
  if (
    message.runtimeVersion !== binding.runtimeVersion ||
    message.sessionId !== binding.sessionId ||
    message.artifactId !== binding.artifactId ||
    message.contentVersionId !== binding.contentVersionId ||
    message.attemptId !== binding.attemptId ||
    message.runId !== binding.runId ||
    (binding.readOnly === true &&
      (message.kind === 'state-proposed' || message.kind === 'interaction')) ||
    message.baseStateRevision !== stateRevision
  )
    return null;

  if (message.kind === 'state-proposed') {
    if (
      Buffer.byteLength(serializedMessage, 'utf8') >
        activityMessageLimits.stateEnvelopeBytes ||
      !isBoundedJsonValue(
        message.payload.state,
        activityMessageLimits.stateBytes,
      )
    )
      return null;
  } else if (
    Buffer.byteLength(serializedMessage, 'utf8') >
    activityMessageLimits.ordinaryEventBytes
  ) {
    return null;
  } else if (
    message.kind === 'interaction' &&
    !isBoundedJsonValue(
      message.payload.value,
      activityMessageLimits.ordinaryEventBytes,
    )
  ) {
    return null;
  }

  return message;
};

const createBucket = (
  capacity: number,
  refillPerSecond: number,
  now: number,
): MessageBucket => ({
  capacity,
  refillPerSecond,
  tokens: capacity,
  lastUpdatedAt: now,
});

const consumeToken = (bucket: MessageBucket, now: number) => {
  const elapsed = Math.max(0, now - bucket.lastUpdatedAt);
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + (elapsed * bucket.refillPerSecond) / 1000,
  );
  bucket.lastUpdatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
};

export const createActivityMailbox = (input: {
  binding: ActivityMailboxBinding;
  stateRevision: number;
  now?: () => number;
}): ActivityMailbox => {
  const now = input.now ?? Date.now;
  const initialTime = now();
  const eventBucket = createBucket(
    activityMessageLimits.eventBurst,
    activityMessageLimits.eventsPerSecond,
    initialTime,
  );
  const checkpointBucket = createBucket(
    activityMessageLimits.checkpointBurst,
    activityMessageLimits.checkpointsPerSecond,
    initialTime,
  );
  const queue: QueuedActivityMessage[] = [];
  let queueBytes = 0;
  let currentStateRevision = input.stateRevision;
  let lastSequence = 0;

  const mailbox: ActivityMailbox = {
    enqueue: (serializedMessage) => {
      const byteLength = Buffer.byteLength(serializedMessage, 'utf8');
      if (byteLength > activityMessageLimits.stateEnvelopeBytes) return false;

      const message = decodeActivityMessage(
        serializedMessage,
        input.binding,
        currentStateRevision,
      );
      if (!message || message.sequence !== lastSequence + 1) return false;
      if (
        message.kind === 'state-proposed' &&
        !consumeToken(checkpointBucket, now())
      )
        return false;
      if (!consumeToken(eventBucket, now())) return false;
      if (
        queue.length >= activityMessageLimits.queueEntries ||
        queueBytes + byteLength > activityMessageLimits.queueBytes
      )
        return false;

      queue.push({ raw: serializedMessage, byteLength, message });
      queueBytes += byteLength;
      lastSequence = message.sequence;
      return true;
    },
    readNext: () => {
      while (queue.length > 0) {
        const item = queue.shift()!;
        queueBytes -= item.byteLength;
        if (item.message.baseStateRevision === currentStateRevision)
          return item.raw;
      }
      return null;
    },
    acknowledge: (revision) => {
      if (revision !== currentStateRevision + 1)
        throw new Error(
          'Activity state revision did not advance exactly once.',
        );
      currentStateRevision = revision;
    },
    clear: () => {
      queue.length = 0;
      queueBytes = 0;
    },
    get queuedEntries() {
      return queue.length;
    },
    get queuedBytes() {
      return queueBytes;
    },
    get stateRevision() {
      return currentStateRevision;
    },
    get lastSequence() {
      return lastSequence;
    },
  };

  return mailbox;
};
