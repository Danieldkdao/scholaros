import type {
  ActionCleanup,
  LearningLifecycle,
} from '@scholaros/services/learning/product-contracts';
import type { LearningActionRegistrar } from './contracts';

export type LearningActionModule = (
  registrar: LearningActionRegistrar,
) => ActionCleanup | void;
export type LearningLifecycleRuntime = LearningLifecycle & {
  cancelOperations: (key?: string) => void;
  cancelOperationsAndWait: () => Promise<void>;
  invalidate: () => Promise<void>;
  trackOperation: <TResult>(
    operationId: string,
    operation: () => Promise<TResult>,
  ) => Promise<TResult>;
};

type RegisteredLearningOperation = {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
};

export const createLearningLifecycle = (): LearningLifecycleRuntime => {
  let epoch = 0;
  let controller = new AbortController();
  let invalidating: Promise<void> | null = null;
  let cancellationCount = 0;
  const operations = new Map<
    string,
    Map<string, RegisteredLearningOperation>
  >();
  const pendingOperations = new Map<string, Promise<unknown>>();
  const teardownCallbacks = new Set<() => void | Promise<void>>();

  const removeOperation = (key: string, operationId: string) => {
    const scopedOperations = operations.get(key);
    const operation = scopedOperations?.get(operationId);
    if (operation) {
      scopedOperations?.delete(operationId);
      operation.settle();
    }
    if (scopedOperations?.size === 0) operations.delete(key);
  };

  const cancelOperations = (key?: string) => {
    for (const [operationKey, scopedOperations] of operations) {
      if (key !== undefined && operationKey !== key) continue;
      for (const operation of scopedOperations.values())
        operation.controller.abort();
    }
  };

  const waitForOperations = async () => {
    while (true) {
      const requests = [...pendingOperations.values()];
      const registered = [...operations.values()].flatMap((scopedOperations) =>
        [...scopedOperations.values()].map((operation) => operation.settled),
      );
      const pending = [...requests, ...registered];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  };

  const waitForRegisteredOperations = async () => {
    let emptyPass = false;
    while (true) {
      const pending = [...operations.values()].flatMap((scopedOperations) =>
        [...scopedOperations.values()].map((operation) => operation.settled),
      );
      if (pending.length === 0) {
        if (emptyPass) return;
        emptyPass = true;
        await Promise.resolve();
        continue;
      }
      emptyPass = false;
      await Promise.allSettled(pending);
    }
  };

  const cancelOperationsAndWait = async () => {
    cancellationCount += 1;
    try {
      cancelOperations();
      await waitForRegisteredOperations();
    } finally {
      cancellationCount -= 1;
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
    void Promise.all([waitForOperations(), Promise.allSettled(teardowns)]).then(
      ([, results]) => {
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (invalidating === currentInvalidation) invalidating = null;
        if (failures.length > 0)
          rejectInvalidation(
            new AggregateError(failures, 'Learning teardown failed.'),
          );
        else {
          controller = new AbortController();
          resolveInvalidation();
        }
      },
    );
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
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      scopedOperations.set(operationId, {
        controller: operation,
        settled,
        settle,
      });
      operations.set(key, scopedOperations);
      if (cancellationCount > 0) operation.abort();
      return () => removeOperation(key, operationId);
    },
    onTeardown: (cleanup) => {
      teardownCallbacks.add(cleanup);
    },
    cancelOperations,
    cancelOperationsAndWait,
    invalidate,
    trackOperation: (operationId, operation) => {
      if (!operationId.trim())
        throw new Error('Learning operations need an identifier.');
      if (invalidating || controller.signal.aborted)
        throw new Error('Learning work is being cancelled.');
      if (pendingOperations.has(operationId))
        throw new Error('This learning request is already active.');
      const pendingOperation = Promise.resolve().then(operation);
      pendingOperations.set(operationId, pendingOperation);
      const removePendingOperation = () => {
        if (pendingOperations.get(operationId) === pendingOperation)
          pendingOperations.delete(operationId);
      };
      void pendingOperation.then(
        removePendingOperation,
        removePendingOperation,
      );
      return pendingOperation;
    },
  };
};

const once = (cleanup: ActionCleanup): ActionCleanup => {
  let completion: Promise<void> | null = null;
  return () => (completion ??= Promise.resolve().then(cleanup));
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

export const registerLearningActions = async (
  registrar: LearningActionRegistrar,
  modules: readonly LearningActionModule[],
): Promise<ActionCleanup> => {
  const cleanups: ActionCleanup[] = [];
  try {
    for (const module of modules) {
      const cleanup = module(registrar);
      if (cleanup) cleanups.push(once(cleanup));
    }
    for (const cleanup of cleanups) registrar.lifecycle.onTeardown(cleanup);
  } catch (error) {
    await runCleanups(cleanups).catch(() => undefined);
    throw error;
  }

  return () => runCleanups(cleanups);
};

export const loadLearningActionModules = async (): Promise<
  LearningActionModule[]
> => {
  const [
    contextActions,
    gradeActions,
    sessionActions,
    artifactActions,
    artifactStoreModule,
    activityAdapterModule,
    memoryActions,
    todayActions,
    notificationActions,
    sessionStoreModule,
    originalStore,
    database,
  ] = await Promise.all([
    import('../../features/context/services/library-actions'),
    import('../../features/grades/services/grade-actions'),
    import('../../features/study/services/session-actions'),
    import('../../features/study/services/artifact-actions'),
    import('../../features/study/services/artifact-store'),
    import('./activity-adapter'),
    import('../../features/memory/services/memory-actions'),
    import('../../features/today/services/today-actions'),
    import('../../features/notifications/services/notification-actions'),
    import('../../features/study/services/session-store'),
    import('../../features/context/services/original-store'),
    import('../../db'),
  ]);

  let sessionStore: ReturnType<
    typeof sessionStoreModule.createSessionStore
  > | null = null;

  return [
    contextActions.registerContextActions,
    (registrar) => {
      sessionStore = sessionStoreModule.createSessionStore({
        now: () => registrar.lifecycle.now(),
        publish: (event) => registrar.publish(event),
        cleanupOriginals: async (context, userId, storageKeys) => {
          if (context.userId !== userId)
            throw new Error('The study session owner changed.');
          await Promise.all(
            storageKeys.map((storageKey) =>
              originalStore.removeContextOriginal(userId, storageKey),
            ),
          );
        },
      });
      return sessionActions.registerSessionActions(registrar, {
        store: sessionStore,
      });
    },
    (registrar) => {
      if (!sessionStore)
        throw new Error('The study session store is unavailable.');
      const activeSessionStore = sessionStore;
      return gradeActions.registerGradeActions(registrar, {
        onSettingsChanged: async (context, settings, deletedCollected) => {
          if (!settings.enabled || deletedCollected)
            await activeSessionStore.purgeGradeDerivedStudyContent(context, {
              consentRevision: settings.revision,
            });
        },
      });
    },
    (registrar) => {
      const store = artifactStoreModule.createArtifactStore({
        db: database.db,
      });
      const adapter = activityAdapterModule.createAcademicActivityAdapter({
        store,
      });
      const cleanupArtifacts = artifactActions.registerArtifactActions(
        registrar,
        store,
      );
      registrar.handleInternal('authorizeActivityRun', (context, request) =>
        adapter.authorizeActivityRun(context, request),
      );
      registrar.handleInternal('checkpointArtifactState', (context, proposal) =>
        adapter.checkpointArtifactState(context, proposal),
      );
      registrar.handleInternal('releaseActivityRun', (_context, request) =>
        adapter.releaseActivityRun(request),
      );
      return async () => {
        await adapter.dispose();
        await cleanupArtifacts();
      };
    },
    memoryActions.registerMemoryActions,
    todayActions.registerTodayActions,
    notificationActions.registerNotificationActions,
  ];
};
