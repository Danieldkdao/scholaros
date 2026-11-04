import { errorMessage } from '../../../lib/error-message';
import { isAcademicTaskDeferred } from './academic-tasks';
import type { BackgroundSyncState } from '../types';

type BackgroundSyncConfiguration = {
  userId: string | null;
  enabled: boolean;
  isCurrent: () => boolean;
};

type BackgroundSyncDependencies<TResult> = {
  runDiscovery: (
    userId: string,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ) => Promise<TResult>;
  // A run that resolved without reading anything must not count as a sync.
  syncFailure?: (result: TResult) => string | null;
  isPartial?: (result: TResult) => boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  now?: () => string;
  intervalMs?: number;
  initialDelayMs?: number;
  deferredDelayMs?: number;
  onChange?: (state: BackgroundSyncState, result: TResult | null) => void;
};

const refreshStatusFrom = (
  result: unknown,
): 'complete' | 'partial' | 'sign-in-required' | null => {
  if (typeof result !== 'object' || result === null || !('status' in result))
    return null;
  const status = result.status;
  return status === 'complete' ||
    status === 'partial' ||
    status === 'sign-in-required'
    ? status
    : null;
};

export const createBackgroundSyncController = <TResult>({
  runDiscovery,
  syncFailure,
  isPartial,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelSchedule = (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  now = () => new Date().toISOString(),
  intervalMs = 30 * 60_000,
  initialDelayMs = 60_000,
  deferredDelayMs = 60_000,
  onChange,
}: BackgroundSyncDependencies<TResult>) => {
  let configuration: BackgroundSyncConfiguration = {
    userId: null,
    enabled: false,
    isCurrent: () => false,
  };
  let configurationKey: string | null = null;
  let generation = 0;
  let userPaused = false;
  const suspensions = new Set<symbol>();
  let running = false;
  let error: string | null = null;
  let failures = 0;
  let retryBlocked = false;
  let needsReconnect = false;
  let deferred = false;
  let partial = false;
  let lastSyncedAt: string | null = null;
  let timer: unknown = null;
  let active: AbortController | null = null;

  const isScheduled = () => !!configuration.userId && configuration.enabled;

  const getState = (): BackgroundSyncState => {
    if (!isScheduled()) return { status: 'off', message: null, lastSyncedAt };
    if (suspensions.size)
      return {
        status: 'paused',
        message: 'Background sync resumes when this action finishes.',
        lastSyncedAt,
      };
    if (userPaused)
      return {
        status: 'paused',
        message: 'Background sync is paused; resume whenever you want.',
        lastSyncedAt,
      };
    if (running)
      return {
        status: 'syncing',
        message: 'Checking your selected course sources.',
        lastSyncedAt,
      };
    if (error) return { status: 'blocked', message: error, lastSyncedAt };
    if (deferred)
      return {
        status: 'waiting',
        message: 'Background sync is waiting for other academic work.',
        lastSyncedAt,
      };
    if (partial)
      return {
        status: 'waiting',
        message: 'The last background sync had incomplete source coverage.',
        lastSyncedAt,
      };
    return {
      status: 'waiting',
      message: 'Waiting for the next scheduled sync.',
      lastSyncedAt,
    };
  };

  const notify = (result: TResult | null = null) => {
    try {
      onChange?.(getState(), result);
    } catch {
      // Status reporting must not interrupt background work.
    }
  };

  const cancelTimer = () => {
    if (timer === null) return;
    cancelSchedule(timer);
    timer = null;
  };

  const abortActive = () => {
    active?.abort();
    active = null;
    running = false;
  };

  const halt = () => {
    generation += 1;
    cancelTimer();
    abortActive();
  };

  const scheduleTick = (delayMs: number) => {
    cancelTimer();
    timer = schedule(() => {
      timer = null;
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (
      !isScheduled() ||
      suspensions.size ||
      userPaused ||
      retryBlocked ||
      running
    )
      return;
    if (!configuration.isCurrent()) {
      stop();
      return;
    }
    const runGeneration = generation;
    running = true;
    error = null;
    deferred = false;
    partial = false;
    notify();
    const controller = new AbortController();
    active = controller;
    const isCurrent = configuration.isCurrent;
    let completedResult: TResult | null = null;
    try {
      const result = await runDiscovery(
        configuration.userId!,
        isCurrent,
        controller.signal,
      );
      if (runGeneration !== generation) return;
      completedResult = result;
      const refreshStatus = refreshStatusFrom(result);
      const failure = syncFailure?.(result) ?? null;
      if (failure || refreshStatus === 'sign-in-required') {
        error =
          failure ??
          'Sign in in your study browser, then resume background sync.';
        needsReconnect =
          refreshStatus === 'sign-in-required' ||
          /sign in|password/i.test(error);
      } else if (isPartial ? isPartial(result) : refreshStatus === 'partial')
        partial = true;
      else {
        lastSyncedAt = now();
        error = null;
      }
    } catch (cause) {
      if (runGeneration !== generation) return;
      if (isAcademicTaskDeferred(cause)) deferred = true;
      else {
        error = errorMessage(cause, 'Background sync could not finish.');
        needsReconnect = /sign in|password/i.test(error);
      }
    } finally {
      if (runGeneration === generation) {
        running = false;
        active = null;
        if (error) {
          failures += 1;
          retryBlocked = needsReconnect || failures >= 3;
        } else if (!deferred && !partial) {
          failures = 0;
          retryBlocked = false;
        }
        if (isScheduled() && !suspensions.size && !userPaused && !retryBlocked)
          scheduleTick(
            deferred
              ? deferredDelayMs
              : error
                ? failures === 1
                  ? 60_000
                  : 5 * 60_000
                : intervalMs,
          );
        notify(completedResult);
      }
    }
  };

  const configure = (next: BackgroundSyncConfiguration) => {
    const key = `${next.userId ?? ''}:${next.enabled ? 1 : 0}`;
    const sameUser = configuration.userId === next.userId;
    if (!sameUser) {
      lastSyncedAt = null;
      suspensions.clear();
      needsReconnect = false;
    }
    configuration = next;
    if (key === configurationKey) return getState();
    configurationKey = key;
    halt();
    if (!needsReconnect) error = null;
    failures = 0;
    retryBlocked = needsReconnect;
    deferred = false;
    partial = false;
    userPaused = false;
    if (isScheduled() && !suspensions.size && !needsReconnect)
      scheduleTick(initialDelayMs);
    notify();
    return getState();
  };

  const pause = () => {
    if (!isScheduled()) return getState();
    userPaused = true;
    halt();
    notify();
    return getState();
  };

  const resume = () => {
    if (!isScheduled() || needsReconnect) return getState();
    failures = 0;
    retryBlocked = false;
    error = null;
    userPaused = false;
    halt();
    if (!suspensions.size) scheduleTick(initialDelayMs);
    notify();
    return getState();
  };

  // A foreground browser action owns the study browser, so scheduled work waits
  // for every owner to release it instead of staying paused for the session.
  const suspend = () => {
    const token = Symbol();
    suspensions.add(token);
    halt();
    notify();
    return () => {
      if (!suspensions.delete(token)) return getState();
      if (isScheduled() && !suspensions.size && !userPaused && !retryBlocked)
        scheduleTick(initialDelayMs);
      notify();
      return getState();
    };
  };

  const stop = () => {
    configuration = { userId: null, enabled: false, isCurrent: () => false };
    configurationKey = ':0';
    generation += 1;
    userPaused = false;
    suspensions.clear();
    error = null;
    failures = 0;
    retryBlocked = false;
    lastSyncedAt = null;
    needsReconnect = false;
    deferred = false;
    partial = false;
    cancelTimer();
    abortActive();
    notify();
    return getState();
  };

  const connectionRestored = (userId: string) => {
    if (
      configuration.userId !== userId ||
      !isScheduled() ||
      !needsReconnect ||
      !configuration.isCurrent()
    )
      return getState();
    needsReconnect = false;
    retryBlocked = false;
    failures = 0;
    error = null;
    if (!suspensions.size && !userPaused) scheduleTick(initialDelayMs);
    notify();
    return getState();
  };

  return {
    configure,
    pause,
    resume,
    suspend,
    stop,
    getState,
    connectionRestored,
  };
};
