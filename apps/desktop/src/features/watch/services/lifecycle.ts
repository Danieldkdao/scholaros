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
  ) => Promise<WatchRuntimeStatus | void>;
  stop: (userId: string) => Promise<void>;
  onStatus: (userId: string, status: WatchRuntimeStatus) => void;
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

export const createWatchLifecycle = (
  dependencies: WatchLifecycleDependencies,
) => {
  let current: WatchLifecycleConfiguration | null = null;
  let activeUserId: string | null = null;
  let activeKey: string | null = null;
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
  const stopActive = async () => {
    const userId = activeUserId;
    if (!userId) return;
    activeUserId = null;
    activeKey = null;
    await dependencies.stop(userId);
  };
  const configure = (configuration: WatchLifecycleConfiguration) => {
    current = configuration;
    const runGeneration = ++generation;
    const operation = queue.then(async () => {
      if (runGeneration !== generation) return;
      const key =
        configuration.key ??
        JSON.stringify([
          configuration.enabled,
          configuration.setupComplete,
          configuration.consent,
          configuration.workspaceReady,
          configuration.hasCourseResource,
          configuration.needsSignIn,
        ]);
      if (activeUserId && activeUserId !== configuration.userId)
        await stopActive();
      if (activeUserId === configuration.userId && activeKey !== key)
        await stopActive();
      if (runGeneration !== generation) return;
      const requestedStatus = statusFor(configuration);
      if (
        isSuspended() ||
        requestedStatus !== 'starting' ||
        !configuration.isCurrent()
      ) {
        const alreadyStopped = activeUserId === configuration.userId;
        if (alreadyStopped) {
          await stopActive();
          inactiveKeys.set(configuration.userId, key);
        }
        if (!alreadyStopped && inactiveKeys.get(configuration.userId) !== key) {
          await dependencies.stop(configuration.userId).catch(() => undefined);
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
      if (
        activeUserId === configuration.userId &&
        activeKey === key &&
        configuration.isCurrent()
      )
        return;
      if (failedKeys.get(configuration.userId) === key) return;
      publish(configuration.userId, 'starting');
      try {
        const startedStatus = await dependencies.start(
          configuration.userId,
          configuration.isCurrent,
        );
        if (runGeneration !== generation || !configuration.isCurrent()) {
          await dependencies.stop(configuration.userId);
          return;
        }
        activeUserId = configuration.userId;
        activeKey = key;
        inactiveKeys.delete(configuration.userId);
        failedKeys.delete(configuration.userId);
        publish(configuration.userId, startedStatus ?? 'watching');
      } catch {
        await dependencies.stop(configuration.userId).catch(() => undefined);
        failedKeys.set(configuration.userId, key);
        inactiveKeys.set(configuration.userId, key);
        if (runGeneration === generation)
          publish(configuration.userId, 'blocked');
      }
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
  const pause = async () => {
    systemPaused = true;
    generation += 1;
    await queue;
    await stopActive();
    if (current) {
      const status = statusFor(current);
      publish(current.userId, status === 'starting' ? 'paused' : status);
    }
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
    await queue;
    await stopActive();
    if (current) {
      const status = statusFor(current);
      publish(current.userId, status === 'starting' ? 'paused' : status);
    }
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
  const stop = async () => {
    generation += 1;
    current = null;
    systemPaused = false;
    foregroundSuspensions.clear();
    failedKeys.clear();
    inactiveKeys.clear();
    await queue;
    await stopActive();
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
