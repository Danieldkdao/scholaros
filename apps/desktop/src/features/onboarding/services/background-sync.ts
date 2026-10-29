import { errorMessage } from '../../../lib/error-message';
import type { BackgroundSyncState } from '../types';

type BackgroundSyncConfiguration = {
  userId: string | null;
  enabled: boolean;
  isCurrent: () => boolean;
};

type BackgroundSyncDependencies = {
  runDiscovery: (
    userId: string,
    isCurrent: () => boolean,
    signal: AbortSignal,
  ) => Promise<unknown>;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  now?: () => string;
  intervalMs?: number;
  initialDelayMs?: number;
  onChange?: (state: BackgroundSyncState) => void;
};

export const createBackgroundSyncController = ({
  runDiscovery,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelSchedule = (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  now = () => new Date().toISOString(),
  intervalMs = 30 * 60_000,
  initialDelayMs = 60_000,
  onChange,
}: BackgroundSyncDependencies) => {
  let configuration: BackgroundSyncConfiguration = {
    userId: null,
    enabled: false,
    isCurrent: () => false,
  };
  let configurationKey: string | null = null;
  let generation = 0;
  let paused = false;
  let running = false;
  let error: string | null = null;
  let lastSyncedAt: string | null = null;
  let timer: unknown = null;
  let active: AbortController | null = null;

  const getState = (): BackgroundSyncState => {
    if (!configuration.userId || !configuration.enabled)
      return { status: 'off', message: null, lastSyncedAt };
    if (paused)
      return {
        status: 'paused',
        message: 'Background sync is paused; resume whenever you want.',
        lastSyncedAt,
      };
    if (running)
      return {
        status: 'syncing',
        message: 'Checking your connected course pages.',
        lastSyncedAt,
      };
    if (error) return { status: 'blocked', message: error, lastSyncedAt };
    return {
      status: 'waiting',
      message: 'Waiting for the next scheduled sync.',
      lastSyncedAt,
    };
  };

  const notify = () => {
    try {
      onChange?.(getState());
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

  const scheduleTick = (delayMs: number) => {
    cancelTimer();
    timer = schedule(() => {
      timer = null;
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (!configuration.userId || !configuration.enabled || paused || running)
      return;
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
    try {
      await runDiscovery(
        configuration.userId,
        () => configuration.isCurrent() && !controller.signal.aborted,
        controller.signal,
      );
      if (runGeneration !== generation) return;
      lastSyncedAt = now();
      error = null;
    } catch (cause) {
      if (runGeneration !== generation) return;
      error = errorMessage(cause, 'Background sync could not finish.');
    } finally {
      if (runGeneration === generation) {
        running = false;
        active = null;
        if (configuration.userId && configuration.enabled)
          scheduleTick(intervalMs);
        notify();
      }
    }
  };

  const configure = (next: BackgroundSyncConfiguration) => {
    const key = `${next.userId ?? ''}:${next.enabled ? 1 : 0}`;
    if (configuration.userId !== next.userId) lastSyncedAt = null;
    configuration = next;
    if (key === configurationKey) return getState();
    configurationKey = key;
    generation += 1;
    cancelTimer();
    abortActive();
    error = null;
    paused = false;
    if (next.userId && next.enabled) scheduleTick(initialDelayMs);
    notify();
    return getState();
  };

  const pause = () => {
    if (!configuration.userId || !configuration.enabled) return getState();
    paused = true;
    generation += 1;
    cancelTimer();
    abortActive();
    notify();
    return getState();
  };

  const resume = () => {
    if (!configuration.userId || !configuration.enabled) return getState();
    paused = false;
    generation += 1;
    scheduleTick(initialDelayMs);
    notify();
    return getState();
  };

  const stop = () => {
    configuration = { userId: null, enabled: false, isCurrent: () => false };
    configurationKey = ':0';
    generation += 1;
    paused = false;
    error = null;
    lastSyncedAt = null;
    cancelTimer();
    abortActive();
    notify();
    return getState();
  };

  return { configure, pause, resume, stop, getState };
};

export type BackgroundSyncController = ReturnType<
  typeof createBackgroundSyncController
>;
