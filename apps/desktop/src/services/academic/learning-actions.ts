import type {
  ActionCleanup,
  AuthorizedRegistrar,
  LearningLifecycle,
} from '@scholaros/services/learning/product-contracts';

export type LearningActionModule = (
  registrar: AuthorizedRegistrar,
) => ActionCleanup | void;
export type LearningLifecycleRuntime = LearningLifecycle & {
  cancelOperations: (key?: string) => void;
  invalidate: () => Promise<void>;
};

export const createLearningLifecycle = (): LearningLifecycleRuntime => {
  let epoch = 0;
  let controller = new AbortController();
  let invalidating: Promise<void> | null = null;
  const operations = new Map<string, Map<string, AbortController>>();
  const teardownCallbacks = new Set<() => void | Promise<void>>();

  const removeOperation = (key: string, operationId: string) => {
    const scopedOperations = operations.get(key);
    scopedOperations?.delete(operationId);
    if (scopedOperations?.size === 0) operations.delete(key);
  };

  const cancelOperations = (key?: string) => {
    for (const [operationKey, scopedOperations] of operations) {
      if (key !== undefined && operationKey !== key) continue;
      for (const operation of scopedOperations.values()) operation.abort();
      operations.delete(operationKey);
    }
  };

  const invalidate = () => {
    if (invalidating) return invalidating;

    epoch += 1;
    controller.abort();
    cancelOperations();

    let resolveInvalidation!: () => void;
    let rejectInvalidation!: (reason: unknown) => void;
    const currentInvalidation = new Promise<void>((resolve, reject) => {
      resolveInvalidation = resolve;
      rejectInvalidation = reject;
    });
    invalidating = currentInvalidation;
    const teardowns = [...teardownCallbacks].map((cleanup) => {
      try {
        return Promise.resolve(cleanup());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    teardownCallbacks.clear();
    void Promise.allSettled(teardowns).then((results) => {
      controller = new AbortController();
      if (invalidating === currentInvalidation) invalidating = null;
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0)
        rejectInvalidation(
          new AggregateError(failures, 'Learning teardown failed.'),
        );
      else resolveInvalidation();
    });
    return currentInvalidation;
  };

  return {
    get epoch() {
      return epoch;
    },
    get signal() {
      return controller.signal;
    },
    isCurrent: (capturedEpoch) =>
      capturedEpoch === epoch && !controller.signal.aborted,
    now: () => Date.now(),
    registerOperation: (key, operationId, operation) => {
      if (!key.trim() || !operationId.trim())
        throw new Error('Learning operations need a scope and identifier.');
      if (invalidating || controller.signal.aborted)
        throw new Error('Learning work is being cancelled.');
      const scopedOperations = operations.get(key) ?? new Map();
      if (scopedOperations.has(operationId))
        throw new Error('This learning operation is already registered.');
      scopedOperations.set(operationId, operation);
      operations.set(key, scopedOperations);
      return () => removeOperation(key, operationId);
    },
    onTeardown: (cleanup) => {
      teardownCallbacks.add(cleanup);
    },
    cancelOperations,
    invalidate,
  };
};

const runCleanups = async (cleanups: ActionCleanup[]) => {
  const results = await Promise.allSettled(
    [...cleanups].reverse().map((cleanup) => cleanup()),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(failures, 'Learning action cleanup failed.');
};

export const registerLearningActions = (
  registrar: AuthorizedRegistrar,
  modules: readonly LearningActionModule[],
): ActionCleanup => {
  const cleanups: ActionCleanup[] = [];
  try {
    for (const module of modules) {
      const cleanup = module(registrar);
      if (cleanup) {
        cleanups.push(cleanup);
        registrar.lifecycle.onTeardown(cleanup);
      }
    }
  } catch (error) {
    void runCleanups(cleanups).catch(() => undefined);
    throw error;
  }

  return () => runCleanups(cleanups);
};
