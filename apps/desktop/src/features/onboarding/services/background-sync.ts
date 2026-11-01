import { errorMessage } from '../../../lib/error-message';
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
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  now?: () => string;
  intervalMs?: number;
  initialDelayMs?: number;
  onChange?: (state: BackgroundSyncState, result: TResult | null) => void;
};

export const createBackgroundSyncController = <TResult>({
  runDiscovery,
  syncFailure,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelSchedule = (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  now = () => new Date().toISOString(),
  intervalMs = 30 * 60_000,
  initialDelayMs = 60_000,
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
    if (!isScheduled() || suspensions.size || userPaused || running) return;
    if (!configuration.isCurrent()) {
      stop();
      return;
    }
    const runGeneration = generation;
    running = true;
    error = null;
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
      const failure = syncFailure?.(result) ?? null;
      if (failure) error = failure;
      else {
        lastSyncedAt = now();
        error = null;
      }
    } catch (cause) {
      if (runGeneration !== generation) return;
      error = errorMessage(cause, 'Background sync could not finish.');
    } finally {
      if (runGeneration === generation) {
        running = false;
        active = null;
        if (error) {
          failures += 1;
          retryBlocked = /sign in|password/i.test(error) || failures >= 3;
        } else {
          failures = 0;
          retryBlocked = false;
        }
        if (isScheduled() && !suspensions.size && !userPaused && !retryBlocked)
          scheduleTick(intervalMs * 2 ** Math.max(0, failures - 1));
        notify(completedResult);
      }
    }
  };

  const configure = (next: BackgroundSyncConfiguration) => {
    const key = `${next.userId ?? ''}:${next.enabled ? 1 : 0}`;
    if (configuration.userId !== next.userId) {
      lastSyncedAt = null;
      suspensions.clear();
    }
    configuration = next;
    if (key === configurationKey) return getState();
    configurationKey = key;
    halt();
    error = null;
    failures = 0;
    retryBlocked = false;
    userPaused = false;
    if (isScheduled() && !suspensions.size) scheduleTick(initialDelayMs);
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
    if (!isScheduled()) return getState();
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
    cancelTimer();
    abortActive();
    notify();
    return getState();
  };

  return { configure, pause, resume, suspend, stop, getState };
};
