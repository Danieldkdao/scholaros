import type { WatchTargetSelectData } from '../../../db/schema';
import { createPageFingerprint } from '../lib/page-fingerprint';
import {
  maxWatchFailures,
  maxWatchedPages,
  watchIntervalMs,
  watchRetryBackoffMs,
  courseReconcileIntervalMs,
} from '../constants';
import type {
  WatchFailureRecord,
  WatchObservation,
  WatchPageSnapshot,
  WatchRuntimeMetrics,
  WatchRuntimeStatus,
  WatchSettings,
  WatchRefreshResult,
} from '../types';

type WatchControllerDependencies = {
  getSettings: (userId: string) => WatchSettings;
  getTargets: (userId: string) => WatchTargetSelectData[];
  checkTarget: (
    target: WatchTargetSelectData,
    signal: AbortSignal,
    options: { reload: boolean },
  ) => Promise<WatchPageSnapshot>;
  recordObservation: (
    observation: WatchObservation,
  ) => WatchTargetSelectData | null;
  recordFailure: (failure: WatchFailureRecord) => WatchTargetSelectData | null;
  scheduleCheck: (schedule: {
    userId: string;
    targetId: string;
    checkedAt: string;
    nextCheckAt: string;
    attempted?: boolean;
  }) => WatchTargetSelectData | null;
  processChange: (
    target: WatchTargetSelectData,
    fingerprint: string,
    signal: AbortSignal,
  ) => Promise<WatchRefreshResult>;
  reconcileCourses?: {
    lastSuccessfulAt: (userId: string) => string | null;
    run: (userId: string, signal: AbortSignal) => Promise<WatchRefreshResult>;
    markSuccessful: (userId: string, reconciledAt: string) => void;
  };
  subscribeCapacity?: (userId: string, listener: () => void) => () => void;
  onStatus?: (userId: string, status: WatchRuntimeStatus) => void;
  now?: () => number;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
};

type WatchRun = {
  controller: AbortController;
  cursor: number;
  timer: ReturnType<typeof setTimeout> | null;
  ticking: Promise<void> | null;
  stopped: boolean;
  status: WatchRuntimeStatus;
  healthStatus: 'needs-sign-in' | 'blocked' | null;
  processing: Map<string, Promise<WatchRefreshResult>>;
  refreshRetries: Map<string, { fingerprint: string; retryAt: number }>;
  requestedChecks: Set<string>;
  unsubscribeCapacity: (() => void) | null;
  changesDetected: number;
  changesProcessed: number;
  pendingSince: Map<string, number>;
  retryAfterProcessing: boolean;
  reconciling: Promise<void> | null;
  reconcileRetryAt: number;
};

const toIso = (time: number) => new Date(time).toISOString();

export const createWatchController = (
  dependencies: WatchControllerDependencies,
) => {
  const runs = new Map<string, WatchRun>();
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.schedule ?? setTimeout;
  const cancelSchedule = dependencies.cancelSchedule ?? clearTimeout;
  const publish = (
    userId: string,
    run: WatchRun,
    status: WatchRuntimeStatus,
  ) => {
    if (run.status === status) return;
    run.status = status;
    dependencies.onStatus?.(userId, status);
  };
  const scheduleNextTick = (
    userId: string,
    run: WatchRun,
    targets: WatchTargetSelectData[],
  ) => {
    if (run.stopped || !runs.has(userId)) return;
    if (run.timer) cancelSchedule(run.timer);
    const currentTime = now();
    const nextTime = targets
      .filter((target) => target.status === 'active')
      .flatMap((target) =>
        [target.retryAt, target.nextCheckAt]
          .filter((value): value is string => value !== null)
          .map((value) => Date.parse(value)),
      )
      .filter(Number.isFinite)
      .filter((value) => value > currentTime)
      .sort((left, right) => left - right)[0];
    const delay = Math.max(
      1000,
      Math.min(
        watchIntervalMs,
        (nextTime ?? currentTime + watchIntervalMs) - currentTime,
      ),
    );
    run.timer = schedule(() => {
      run.timer = null;
      void tick(userId, run);
    }, delay);
    if ('unref' in run.timer && typeof run.timer.unref === 'function')
      run.timer.unref();
  };
  const reconcileCourses = (userId: string, run: WatchRun) => {
    const reconciliation = dependencies.reconcileCourses;
    if (!reconciliation || run.reconciling || run.reconcileRetryAt > now())
      return;
    const lastSuccessfulAt = Date.parse(
      reconciliation.lastSuccessfulAt(userId) ?? '',
    );
    if (
      Number.isFinite(lastSuccessfulAt) &&
      lastSuccessfulAt <= now() &&
      now() - lastSuccessfulAt < courseReconcileIntervalMs
    )
      return;
    publish(userId, run, 'updating');
    run.reconciling = Promise.resolve()
      .then(() => reconciliation.run(userId, run.controller.signal))
      .then((result) => {
        if (run.stopped || run.controller.signal.aborted) return;
        if (result === true)
          reconciliation.markSuccessful(userId, toIso(now()));
        else if (result !== 'busy')
          run.reconcileRetryAt = now() + watchIntervalMs;
      })
      .catch(() => {
        run.reconcileRetryAt = now() + watchIntervalMs;
      })
      .finally(() => {
        run.reconciling = null;
        if (run.stopped) return;
        if (!run.ticking && !run.processing.size) {
          publish(userId, run, run.healthStatus ?? 'watching');
          if (run.retryAfterProcessing) {
            run.retryAfterProcessing = false;
            void tick(userId, run);
          }
        }
      });
  };
  const processPendingTarget = (
    userId: string,
    run: WatchRun,
    target: WatchTargetSelectData,
  ) => {
    const fingerprint = target.detectedFingerprint;
    const retry = run.refreshRetries.get(target.id);
    if (
      !target.pendingChange ||
      !fingerprint ||
      target.status !== 'active' ||
      (target.retryAt !== null && Date.parse(target.retryAt) > now()) ||
      (retry?.fingerprint === fingerprint && retry.retryAt > now()) ||
      run.processing.has(target.id) ||
      run.stopped
    )
      return;
    if (!run.pendingSince.has(target.id)) {
      const lastObservedAt = Date.parse(
        target.lastSuccessfulCheckAt ?? target.updatedAt,
      );
      run.pendingSince.set(
        target.id,
        Number.isFinite(lastObservedAt)
          ? Math.min(now(), lastObservedAt)
          : now(),
      );
    }
    publish(userId, run, 'updating');
    const processing = Promise.resolve()
      .then(() =>
        dependencies.processChange(target, fingerprint, run.controller.signal),
      )
      .then((processed) => {
        if (processed === false && !run.stopped)
          run.refreshRetries.set(target.id, {
            fingerprint,
            retryAt: now() + watchIntervalMs,
          });
        if (processed !== true || run.stopped) return processed;
        run.refreshRetries.delete(target.id);
        run.changesProcessed += 1;
        const currentTarget = dependencies
          .getTargets(userId)
          .find((item) => item.id === target.id);
        if (!currentTarget?.pendingChange) run.pendingSince.delete(target.id);
        return processed;
      })
      .catch(() => {
        run.refreshRetries.set(target.id, {
          fingerprint,
          retryAt: now() + watchIntervalMs,
        });
        return false;
      })
      .finally(() => {
        run.processing.delete(target.id);
        if (run.stopped) return;
        const settings = dependencies.getSettings(userId);
        if (settings.watchEnabled && !run.ticking && !run.reconciling)
          publish(userId, run, 'watching');
        if (run.retryAfterProcessing && !run.ticking && !run.reconciling) {
          run.retryAfterProcessing = false;
          void tick(userId, run);
        }
      });
    run.processing.set(target.id, processing);
  };
  const checkTarget = async (
    userId: string,
    run: WatchRun,
    target: WatchTargetSelectData,
    options: { reload: boolean },
  ) => {
    const checkedAt = now();
    try {
      run.controller.signal.throwIfAborted();
      const snapshot = await dependencies.checkTarget(
        target,
        run.controller.signal,
        options,
      );
      run.controller.signal.throwIfAborted();
      const fingerprint = createPageFingerprint(snapshot);
      const contentEquivalentToProcessed =
        !snapshot.complete &&
        target.processedFingerprint ===
          createPageFingerprint({ ...snapshot, complete: true });
      if (snapshot.complete || !contentEquivalentToProcessed) {
        const samePendingRevision =
          target.pendingChange && target.detectedFingerprint === fingerprint;
        const observation = dependencies.recordObservation({
          userId,
          targetId: target.id,
          fingerprint,
          checkedAt: toIso(checkedAt),
          nextCheckAt: toIso(checkedAt + watchIntervalMs),
          verifiedUrl: snapshot.url,
          recipeVersion: snapshot.recipeVersion,
        });
        if (observation?.pendingChange) {
          if (!samePendingRevision) {
            run.changesDetected += 1;
            run.pendingSince.set(target.id, checkedAt);
          }
          processPendingTarget(userId, run, observation);
        } else run.pendingSince.delete(target.id);
      } else {
        dependencies.scheduleCheck({
          userId,
          targetId: target.id,
          checkedAt: toIso(checkedAt),
          nextCheckAt: toIso(checkedAt + watchIntervalMs),
          attempted: false,
        });
      }
      if (run.healthStatus === 'needs-sign-in') run.healthStatus = null;
    } catch (error) {
      if (run.controller.signal.aborted) return;
      const failureCount = target.failureCount + 1;
      const blocked = failureCount >= maxWatchFailures;
      const retryAfter = blocked
        ? null
        : watchRetryBackoffMs[
            Math.min(failureCount - 1, watchRetryBackoffMs.length - 1)
          ];
      const failure: WatchFailureRecord = {
        userId,
        targetId: target.id,
        failedAt: toIso(now()),
        retryAt: retryAfter === null ? null : toIso(now() + retryAfter),
        blocked,
      };
      dependencies.recordFailure(failure);
      if (blocked) {
        run.healthStatus = 'blocked';
        publish(userId, run, 'blocked');
      } else if (
        /sign.?in|session|authenticat|\b401\b|\b403\b/i.test(String(error))
      ) {
        run.healthStatus = 'needs-sign-in';
        publish(userId, run, 'needs-sign-in');
      }
    }
  };
  const tick = (userId: string, run: WatchRun): Promise<void> => {
    if (run.stopped || run.ticking) return run.ticking ?? Promise.resolve();
    run.ticking = (async () => {
      try {
        const settings = dependencies.getSettings(userId);
        if (!settings.watchEnabled) {
          publish(userId, run, 'off');
          return;
        }
        const targets = dependencies.getTargets(userId);
        reconcileCourses(userId, run);
        if (
          targets.some((target) => target.status === 'blocked') &&
          !targets.some((target) => target.status === 'active')
        )
          run.healthStatus = 'blocked';
        for (const target of targets) processPendingTarget(userId, run, target);
        const currentTime = now();
        const dueTargets = targets.filter(
          (target) =>
            target.status === 'active' &&
            (!target.retryAt || Date.parse(target.retryAt) <= currentTime) &&
            (!target.nextCheckAt ||
              Date.parse(target.nextCheckAt) <= currentTime),
        );
        const requestedIds = new Set(run.requestedChecks);
        const dueIds = new Set(dueTargets.map((target) => target.id));
        if (dueTargets.length || requestedIds.size)
          publish(userId, run, 'checking');
        const startIndex = run.cursor % Math.max(1, targets.length);
        const rotatedTargets = [
          ...targets.slice(startIndex),
          ...targets.slice(0, startIndex),
        ];
        const selectedTargets = rotatedTargets
          .filter(
            (target) =>
              target.status === 'active' &&
              (!target.retryAt || Date.parse(target.retryAt) <= currentTime) &&
              (dueIds.has(target.id) || requestedIds.has(target.id)),
          )
          .slice(0, maxWatchedPages);
        const selectedTargetIds = new Set(
          selectedTargets.map((target) => target.id),
        );
        const deferredTargets = rotatedTargets.filter(
          (target) =>
            dueIds.has(target.id) && !selectedTargetIds.has(target.id),
        );
        deferredTargets.forEach((target, index) => {
          const waitMs = Math.ceil(
            ((index + 1) * watchIntervalMs) / (deferredTargets.length + 1),
          );
          dependencies.scheduleCheck({
            userId,
            targetId: target.id,
            checkedAt: toIso(currentTime),
            nextCheckAt: toIso(currentTime + waitMs),
            attempted: false,
          });
        });
        if (targets.length)
          run.cursor = (startIndex + selectedTargets.length) % targets.length;
        await Promise.all(
          selectedTargets.map((target) => {
            const requested = requestedIds.has(target.id);
            run.requestedChecks.delete(target.id);
            return checkTarget(userId, run, target, { reload: !requested });
          }),
        );
        if (!run.stopped && dependencies.getSettings(userId).watchEnabled) {
          const refreshedTargets = dependencies.getTargets(userId);
          const onlyBlockedTargets =
            refreshedTargets.some((target) => target.status === 'blocked') &&
            !refreshedTargets.some((target) => target.status === 'active');
          publish(
            userId,
            run,
            run.healthStatus ??
              (onlyBlockedTargets
                ? 'blocked'
                : run.processing.size || run.reconciling
                  ? 'updating'
                  : 'watching'),
          );
        }
        scheduleNextTick(userId, run, dependencies.getTargets(userId));
      } finally {
        run.ticking = null;
        if (
          run.retryAfterProcessing &&
          !run.processing.size &&
          !run.reconciling &&
          !run.stopped
        ) {
          run.retryAfterProcessing = false;
          void tick(userId, run);
        }
      }
    })();
    return run.ticking;
  };

  const start = async (userId: string) => {
    const existingRun = runs.get(userId);
    if (existingRun && !existingRun.stopped)
      return existingRun.ticking ?? Promise.resolve();
    const run: WatchRun = {
      controller: new AbortController(),
      cursor: 0,
      timer: null,
      ticking: null,
      stopped: false,
      status: 'starting',
      healthStatus: null,
      processing: new Map(),
      refreshRetries: new Map(),
      requestedChecks: new Set(),
      unsubscribeCapacity: null,
      changesDetected: 0,
      changesProcessed: 0,
      pendingSince: new Map(),
      retryAfterProcessing: false,
      reconciling: null,
      reconcileRetryAt: 0,
    };
    runs.set(userId, run);
    dependencies.onStatus?.(userId, 'starting');
    run.unsubscribeCapacity =
      dependencies.subscribeCapacity?.(userId, () => {
        if (run.stopped) return;
        if (run.ticking || run.processing.size || run.reconciling) {
          run.retryAfterProcessing = true;
          return;
        }
        void tick(userId, run);
      }) ?? null;
    return tick(userId, run);
  };

  const stop = async (userId: string) => {
    const run = runs.get(userId);
    if (!run) return;
    run.stopped = true;
    run.controller.abort();
    if (run.timer) cancelSchedule(run.timer);
    run.unsubscribeCapacity?.();
    runs.delete(userId);
    await Promise.all([
      run.ticking?.catch(() => undefined),
      run.reconciling,
      ...run.processing.values(),
    ]);
    publish(userId, run, 'off');
  };

  return {
    start,
    stop,
    tick: (userId: string) => {
      const run = runs.get(userId);
      return run ? tick(userId, run) : Promise.resolve();
    },
    requestCheck: (userId: string, targetId: string) => {
      const run = runs.get(userId);
      if (!run || run.stopped) return Promise.resolve();
      const target = dependencies
        .getTargets(userId)
        .find((item) => item.id === targetId && item.status === 'active');
      if (!target) return Promise.resolve();
      run.requestedChecks.add(targetId);
      return run.ticking
        ? run.ticking.then(() =>
            run.requestedChecks.has(targetId) ? tick(userId, run) : undefined,
          )
        : tick(userId, run);
    },
    getStatus: (userId: string) => runs.get(userId)?.status ?? 'off',
    getMetrics: (userId: string): WatchRuntimeMetrics | null => {
      const run = runs.get(userId);
      if (!run) return null;
      const pendingAges = [...run.pendingSince.values()].map((startedAt) =>
        Math.max(0, now() - startedAt),
      );
      return {
        changesDetected: run.changesDetected,
        changesProcessed: run.changesProcessed,
        pendingChangeAgeMs: pendingAges.length
          ? Math.max(...pendingAges)
          : null,
      };
    },
  };
};
