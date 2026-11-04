import type { WatchRuntimeStatus } from '../types';

export type WatchLifecycleConfiguration = {
  userId: string;
  enabled: boolean;
  setupComplete: boolean;
  consent: boolean;
  workspaceReady: boolean;
  hasCourseResource: boolean;
  needsSignIn: boolean;
  key?: string;
  isCurrent: () => boolean;
};

type WatchLifecycleDependencies = {
  start: (
    userId: string,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ) => Promise<WatchRuntimeStatus | void>;
  stop: (userId: string) => Promise<void>;
  onStatus: (userId: string, status: WatchRuntimeStatus) => void;
};

type WatchOwner = {
  userId: string;
  key: string;
  controller: AbortController;
  phase: 'starting' | 'active' | 'stopping';
  startOperation: Promise<WatchRuntimeStatus | void>;
  startPromise: Promise<WatchRuntimeStatus | void | null>;
  cleanupPromise: Promise<void> | null;
};

const statusFor = (
  configuration: WatchLifecycleConfiguration,
): WatchRuntimeStatus => {
  if (!configuration.enabled) return 'off';
  if (configuration.needsSignIn) return 'needs-sign-in';
  if (
    !configuration.setupComplete ||
    !configuration.consent ||
    !configuration.workspaceReady ||
    !configuration.hasCourseResource
  )
    return 'paused';
  return 'starting';
};

const keyFor = (configuration: WatchLifecycleConfiguration) =>
  configuration.key ??
  JSON.stringify([
    configuration.enabled,
    configuration.setupComplete,
    configuration.consent,
    configuration.workspaceReady,
    configuration.hasCourseResource,
    configuration.needsSignIn,
  ]);

export const createWatchLifecycle = (
  dependencies: WatchLifecycleDependencies,
) => {
  let current: WatchLifecycleConfiguration | null = null;
  let owner: WatchOwner | null = null;
  let systemPaused = false;
  const foregroundSuspensions = new Set<symbol>();
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  const statuses = new Map<string, WatchRuntimeStatus>();
  const inactiveKeys = new Map<string, string>();
  const failedKeys = new Map<string, string>();
  const publish = (userId: string, status: WatchRuntimeStatus) => {
    statuses.set(userId, status);
    dependencies.onStatus(userId, status);
  };
  const isSuspended = () => systemPaused || foregroundSuspensions.size > 0;
  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const isOwnerCurrent = (target: WatchOwner) => {
    const configuration = current;
    return (
      owner === target &&
      target.phase !== 'stopping' &&
      !target.controller.signal.aborted &&
      configuration?.userId === target.userId &&
      keyFor(configuration) === target.key &&
      statusFor(configuration) === 'starting' &&
      !isSuspended() &&
      configuration.isCurrent()
    );
  };
  const stopOwner = (target: WatchOwner) => {
    if (target.cleanupPromise) return target.cleanupPromise;
    target.phase = 'stopping';
    target.controller.abort(new Error('Watcher ownership was invalidated.'));
    const startSettled = target.startOperation.then(
      () => undefined,
      () => undefined,
    );
    const stopSettled = Promise.resolve()
      .then(() => dependencies.stop(target.userId))
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const cleanupPromise = Promise.all([startSettled, stopSettled]).then(
      ([, stopResult]) => {
        if (!stopResult.ok) throw stopResult.error;
        if (owner === target) owner = null;
      },
    );
    target.cleanupPromise = cleanupPromise;
    void cleanupPromise.catch(() => {
      if (target.cleanupPromise === cleanupPromise)
        target.cleanupPromise = null;
    });
    return cleanupPromise;
  };
  const stopAndPublish = async (target: WatchOwner) => {
    try {
      await stopOwner(target);
      publish(target.userId, 'off');
    } catch (error) {
      publish(target.userId, 'blocked');
      throw error;
    }
  };
  const configure = (configuration: WatchLifecycleConfiguration) => {
    current = configuration;
    const key = keyFor(configuration);
    const requestedStatus = statusFor(configuration);
    if (
      owner &&
      owner.userId === configuration.userId &&
      owner.key === key &&
      owner.phase !== 'stopping' &&
      requestedStatus === 'starting' &&
      !isSuspended() &&
      configuration.isCurrent()
    )
      return owner.startPromise;

    const runGeneration = ++generation;
    const previousOwner = owner;
    const cleanup = previousOwner ? stopOwner(previousOwner) : null;
    return enqueue(async () => {
      if (cleanup && previousOwner) await stopAndPublish(previousOwner);
      if (runGeneration !== generation || current !== configuration) return;
      if (
        isSuspended() ||
        requestedStatus !== 'starting' ||
        !configuration.isCurrent()
      ) {
        if (!previousOwner && inactiveKeys.get(configuration.userId) !== key) {
          await dependencies.stop(configuration.userId).catch(() => undefined);
          inactiveKeys.set(configuration.userId, key);
        } else if (previousOwner?.userId === configuration.userId) {
          inactiveKeys.set(configuration.userId, key);
        }
        const status =
          isSuspended() && requestedStatus === 'starting'
            ? 'paused'
            : requestedStatus === 'starting'
              ? 'off'
              : requestedStatus;
        publish(configuration.userId, status);
        return;
      }
      if (failedKeys.get(configuration.userId) === key) return;

      publish(configuration.userId, 'starting');
      const controller = new AbortController();
      let removeAbortListener: () => void = () => undefined;
      const aborted = new Promise<null>((resolve) => {
        const onAbort = () => resolve(null);
        if (controller.signal.aborted) onAbort();
        else {
          controller.signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () =>
            controller.signal.removeEventListener('abort', onAbort);
        }
      });
      let startOwner: WatchOwner;
      const startOperation = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return dependencies.start(
          configuration.userId,
          () => isOwnerCurrent(startOwner),
          controller.signal,
        );
      });
      const startPromise = Promise.race([startOperation, aborted]).then(
        (startedStatus) => {
          removeAbortListener();
          return startedStatus;
        },
        (error: unknown) => {
          removeAbortListener();
          throw error;
        },
      );
      startOwner = {
        userId: configuration.userId,
        key,
        controller,
        phase: 'starting',
        startOperation,
        startPromise,
        cleanupPromise: null,
      };
      owner = startOwner;
      try {
        const startedStatus = await startOwner.startPromise;
        if (startedStatus === null || !isOwnerCurrent(startOwner)) {
          await stopOwner(startOwner);
          return;
        }
        startOwner.phase = 'active';
        inactiveKeys.delete(configuration.userId);
        failedKeys.delete(configuration.userId);
        publish(configuration.userId, startedStatus ?? 'watching');
      } catch {
        await stopOwner(startOwner).catch(() => undefined);
        failedKeys.set(configuration.userId, key);
        inactiveKeys.set(configuration.userId, key);
        if (runGeneration === generation)
          publish(configuration.userId, 'blocked');
      }
    });
  };
  const pause = () => {
    systemPaused = true;
    generation += 1;
    const target = owner;
    const cleanup = target ? stopOwner(target) : null;
    return enqueue(async () => {
      if (cleanup && target) await stopAndPublish(target);
      if (current) {
        const status = statusFor(current);
        publish(current.userId, status === 'starting' ? 'paused' : status);
      }
    });
  };
  const resume = () => {
    systemPaused = false;
    if (current) {
      failedKeys.delete(current.userId);
      return configure(current);
    }
    return Promise.resolve();
  };
  const suspend = async () => {
    const token = Symbol();
    foregroundSuspensions.add(token);
    generation += 1;
    const target = owner;
    const cleanup = target ? stopOwner(target) : null;
    await enqueue(async () => {
      if (cleanup && target) await stopAndPublish(target);
      if (current) {
        const status = statusFor(current);
        publish(current.userId, status === 'starting' ? 'paused' : status);
      }
    });
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      foregroundSuspensions.delete(token);
      if (!isSuspended() && current) {
        failedKeys.delete(current.userId);
        await configure(current);
      }
    };
  };
  const stop = () => {
    generation += 1;
    const previous = current;
    current = null;
    systemPaused = false;
    foregroundSuspensions.clear();
    failedKeys.clear();
    inactiveKeys.clear();
    const target = owner;
    const cleanup = target ? stopOwner(target) : null;
    return enqueue(async () => {
      if (cleanup && target) await stopAndPublish(target);
      if (previous && previous.userId !== target?.userId)
        publish(previous.userId, 'off');
    });
  };
  return {
    configure,
    pause,
    resume,
    suspend,
    stop,
    getStatus: (userId: string) => statuses.get(userId) ?? 'off',
  };
};
