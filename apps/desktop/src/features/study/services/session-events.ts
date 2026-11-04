import { productEventV1Schema } from '@scholaros/services/learning/product-contracts';
import type {
  AuthorizedContext,
  ProductEventV1,
  SafeErrorCode,
} from '@scholaros/services/learning/product-contracts';

export class StudySessionError extends Error {
  readonly code: SafeErrorCode;

  constructor(code: SafeErrorCode, message: string) {
    super(message);
    this.name = 'StudySessionError';
    this.code = code;
  }
}

type RegisteredStudyOperation = {
  controller: AbortController;
  detachAccountSignal: () => void;
  detachControllerSignal: () => void;
};

const operations = new Map<string, Map<string, RegisteredStudyOperation>>();

const sessionOperationKey = (userId: string, sessionId: string) =>
  JSON.stringify([userId, sessionId]);

export const registerStudySessionOperation = (
  context: AuthorizedContext,
  sessionId: string,
  operationId: string,
  controller: AbortController,
) => {
  if (
    !context.isCurrent() ||
    context.signal.aborted ||
    controller.signal.aborted
  ) {
    controller.abort();
    throw new StudySessionError(
      'session-changed',
      'The study session changed.',
    );
  }

  const key = sessionOperationKey(context.userId, sessionId);
  const sessionOperations = operations.get(key) ?? new Map();
  if (sessionOperations.has(operationId))
    throw new StudySessionError(
      'revision-conflict',
      'This study operation already exists.',
    );

  const abortOnAccountChange = () => controller.abort();
  const removeOperation = () => {
    const currentOperations = operations.get(key);
    const operation = currentOperations?.get(operationId);
    if (!operation) return;
    operation.detachAccountSignal();
    operation.detachControllerSignal();
    currentOperations?.delete(operationId);
    if (currentOperations?.size === 0) operations.delete(key);
  };
  context.signal.addEventListener('abort', abortOnAccountChange, {
    once: true,
  });
  controller.signal.addEventListener('abort', removeOperation, { once: true });
  sessionOperations.set(operationId, {
    controller,
    detachAccountSignal: () =>
      context.signal.removeEventListener('abort', abortOnAccountChange),
    detachControllerSignal: () =>
      controller.signal.removeEventListener('abort', removeOperation),
  });
  operations.set(key, sessionOperations);

  return removeOperation;
};

export const hasStudySessionOperation = (
  userId: string,
  sessionId: string,
  operationId?: string,
) => {
  const sessionOperations = operations.get(
    sessionOperationKey(userId, sessionId),
  );
  if (!sessionOperations) return false;
  return operationId
    ? sessionOperations.has(operationId)
    : sessionOperations.size > 0;
};

export const cancelStudySessionOperations = (
  userId: string,
  sessionId: string,
) => {
  const key = sessionOperationKey(userId, sessionId);
  const sessionOperations = operations.get(key);
  if (!sessionOperations) return;

  for (const operation of sessionOperations.values()) {
    operation.detachAccountSignal();
    operation.detachControllerSignal();
    operation.controller.abort();
  }
  operations.delete(key);
};

export const createStudySessionEvent = (
  context: AuthorizedContext,
  input: {
    revision: number;
    sessionId: string;
    operationId?: string;
    outcome?: ProductEventV1['outcome'];
  },
): ProductEventV1 =>
  productEventV1Schema.parse({
    version: 1,
    accountId: context.userId,
    revision: input.revision,
    resource: 'study',
    targetId: input.sessionId,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
  });

export const publishStudySessionEvent = (
  publish: (event: ProductEventV1) => void,
  event: ProductEventV1,
) => {
  try {
    publish(event);
  } catch {
    // The event only invalidates a committed snapshot; it cannot undo storage.
  }
};
