import type { WatchTargetSelectData } from '../../../db/schema';
import type { WatchTargetFailureCategory } from '../../../db/shared';
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
  ) => Promise<WatchRefreshResult | 'superseded'>;
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
  processing: Map<string, Promise<WatchRefreshResult | 'superseded'>>;
  processingFingerprints: Map<string, string>;
  refreshRetries: Map<string, { fingerprint: string; retryAt: number }>;
  requestedChecks: Set<string>;
  followUpTargets: Set<string>;
  unsubscribeCapacity: (() => void) | null;
  removeOwnerAbortListener: (() => void) | null;
  stopPromise: Promise<void> | null;
  changesDetected: number;
  changesProcessed: number;
  pendingSince: Map<string, number>;
  pendingFingerprints: Map<string, string>;
  retryAfterProcessing: boolean;
  reconciling: Promise<void> | null;
  reconcileRetryAt: number;
};

const toIso = (time: number) => new Date(time).toISOString();

export const createWatchController = (
  dependencies: WatchControllerDependencies,
) => {
  const runs = new Map<string, WatchRun>();
  const stoppingRuns = new Map<string, WatchRun>();
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.schedule ?? setTimeout;
  const cancelSchedule = dependencies.cancelSchedule ?? clearTimeout;
  const publish = (
    userId: string,
    run: WatchRun,
    requestedStatus: WatchRuntimeStatus,
    force = false,
  ) => {
    const targetHealth = dependencies.getTargets(userId);
    const status =
      requestedStatus === 'off' || requestedStatus === 'paused'
        ? requestedStatus
        : requestedStatus === 'needs-sign-in' ||
            targetHealth.some(
              (target) => target.lastFailureCategory === 'needs-sign-in',
            )
          ? 'needs-sign-in'
          : requestedStatus === 'blocked' ||
              targetHealth.some(
                (target) =>
                  target.status === 'blocked' || !!target.lastFailureCategory,
              )
            ? 'blocked'
            : requestedStatus;
    if (run.status === status && !force) return;
    run.status = status;
    dependencies.onStatus?.(userId, status);
  };
  const classifyFailure = (error: unknown): WatchTargetFailureCategory => {
    const message = String(error);
    if (/sign.?in|authenticat|\b401\b|\b403\b/i.test(message))
      return 'needs-sign-in';
    if (/\b429\b|rate.?limit|too many requests/i.test(message))
      return 'rate-limited';
    if (
      /session changed|permission|consent|scope changed|no longer (enabled|available)|connection (removed|unavailable)/i.test(
        message,
      )
    )
      return 'scope-changed';
    if (/navigat|redirect|page closed|target closed|err_aborted/i.test(message))
      return 'navigation';
    if (/network|fetch|timeout|timed out|econn|err_/i.test(message))
      return 'network';
    return 'unknown';
  };
  const recordTargetFailure = (
    userId: string,
    run: WatchRun,
    target: WatchTargetSelectData,
    error: unknown,
  ) => {
    if (run.controller.signal.aborted) return null;
    const currentTarget =
      dependencies.getTargets(userId).find((item) => item.id === target.id) ??
      target;
    const category = classifyFailure(error);
    const needsIntervention =
      category === 'needs-sign-in' || category === 'scope-changed';
    const failureCount = currentTarget.failureCount + 1;
    const blocked = !needsIntervention && failureCount >= maxWatchFailures;
    const retryAfter =
      needsIntervention || blocked
        ? null
        : watchRetryBackoffMs[Math.min(failureCount - 1, maxWatchFailures - 2)];
    const failure = dependencies.recordFailure({
      userId,
      targetId: target.id,
      failedAt: toIso(now()),
      retryAt: retryAfter === null ? null : toIso(now() + retryAfter),
      blocked,
      category,
    });
    if (failure) {
      const requestedStatus =
        category === 'needs-sign-in'
          ? 'needs-sign-in'
          : blocked
            ? 'blocked'
            : run.processing.size
              ? 'updating'
              : 'checking';
      publish(userId, run, requestedStatus, true);
    }
    return failure;
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
          publish(userId, run, 'watching');
          if (run.retryAfterProcessing || run.followUpTargets.size) {
            run.retryAfterProcessing = false;
            run.followUpTargets.clear();
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
      run.stopped
    )
      return;
    if (run.processing.has(target.id)) {
      if (run.processingFingerprints.get(target.id) !== fingerprint) {
        run.followUpTargets.add(target.id);
        run.retryAfterProcessing = true;
      }
      return;
    }
    if (run.pendingFingerprints.get(target.id) !== fingerprint) {
      const pendingSince = Date.parse(target.pendingSince ?? target.updatedAt);
      run.pendingSince.set(
        target.id,
        Number.isFinite(pendingSince) ? Math.min(now(), pendingSince) : now(),
      );
      run.pendingFingerprints.set(target.id, fingerprint);
    }
    publish(userId, run, 'updating');
    run.processingFingerprints.set(target.id, fingerprint);
    const processing = Promise.resolve()
      .then(() =>
        dependencies.processChange(target, fingerprint, run.controller.signal),
      )
      .then((processed) => {
        const currentTarget = dependencies
          .getTargets(userId)
          .find((item) => item.id === target.id);
        if (
          processed === 'superseded' ||
          (currentTarget &&
            currentTarget.detectedFingerprint !== fingerprint &&
            currentTarget.pendingChange)
        ) {
          run.followUpTargets.add(target.id);
          run.retryAfterProcessing = true;
          return 'superseded';
        }
        if (processed === 'needs-sign-in') {
          recordTargetFailure(
            userId,
            run,
            target,
            new Error('Sign in to the academic source.'),
          );
          return processed;
        }
        if (processed === 'source-failed') {
          recordTargetFailure(
            userId,
            run,
            target,
            new Error('Academic refresh coverage was incomplete.'),
          );
          return processed;
        }
        if (processed === false && !run.stopped)
          run.refreshRetries.set(target.id, {
            fingerprint,
            retryAt: now() + watchIntervalMs,
          });
        if (processed !== true || run.stopped || !currentTarget)
          return processed;
        run.refreshRetries.delete(target.id);
        run.changesProcessed += 1;
        if (!currentTarget.pendingChange) {
          run.pendingSince.delete(target.id);
          run.pendingFingerprints.delete(target.id);
        }
        return processed;
      })
      .catch((error: unknown) => {
        const failure = recordTargetFailure(userId, run, target, error);
        if (failure?.retryAt) {
          const retryAt = Date.parse(failure.retryAt);
          if (Number.isFinite(retryAt))
            run.refreshRetries.set(target.id, { fingerprint, retryAt });
        }
        return false;
      })
      .finally(() => {
        run.processing.delete(target.id);
        run.processingFingerprints.delete(target.id);
        if (run.stopped) return;
        if (dependencies.getSettings(userId).watchEnabled)
          publish(userId, run, 'watching', true);
        if (
          !run.ticking &&
          !run.reconciling &&
          !run.processing.size &&
          (run.retryAfterProcessing || run.followUpTargets.size)
        ) {
          run.retryAfterProcessing = false;
          run.followUpTargets.clear();
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
        if (!observation)
          throw new Error('The watch observation could not be persisted.');
        if (observation.pendingChange) {
          if (!samePendingRevision) run.changesDetected += 1;
          const pendingSince = Date.parse(
            observation.pendingSince ?? observation.updatedAt,
          );
          run.pendingSince.set(
            target.id,
            Number.isFinite(pendingSince)
              ? Math.min(now(), pendingSince)
              : now(),
          );
          run.pendingFingerprints.set(target.id, fingerprint);
          processPendingTarget(userId, run, observation);
        } else {
          run.pendingSince.delete(target.id);
          run.pendingFingerprints.delete(target.id);
        }
      } else {
        dependencies.scheduleCheck({
          userId,
          targetId: target.id,
          checkedAt: toIso(checkedAt),
          nextCheckAt: toIso(checkedAt + watchIntervalMs),
          attempted: false,
        });
      }
      publish(userId, run, run.processing.size ? 'updating' : 'checking', true);
    } catch (error) {
      if (run.controller.signal.aborted) return;
      recordTargetFailure(userId, run, target, error);
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
        const currentTime = now();
        for (const target of targets) {
          if (!target.pendingChange || !target.detectedFingerprint) {
            run.pendingSince.delete(target.id);
            run.pendingFingerprints.delete(target.id);
            continue;
          }
          if (
            run.pendingFingerprints.get(target.id) ===
            target.detectedFingerprint
          )
            continue;
          const pendingSince = Date.parse(
            target.pendingSince ?? target.updatedAt,
          );
          run.pendingSince.set(
            target.id,
            Number.isFinite(pendingSince)
              ? Math.min(currentTime, pendingSince)
              : currentTime,
          );
          run.pendingFingerprints.set(target.id, target.detectedFingerprint);
        }
        reconcileCourses(userId, run);
        for (const target of targets) processPendingTarget(userId, run, target);
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
          publish(
            userId,
            run,
            run.processing.size || run.reconciling ? 'updating' : 'watching',
          );
        }
        scheduleNextTick(userId, run, dependencies.getTargets(userId));
      } finally {
        run.ticking = null;
        if (
          (run.retryAfterProcessing || run.followUpTargets.size) &&
          !run.processing.size &&
          !run.reconciling &&
          !run.stopped
        ) {
          run.retryAfterProcessing = false;
          run.followUpTargets.clear();
          void tick(userId, run);
        }
      }
    })();
    return run.ticking;
  };

  const start = (userId: string, ownerSignal?: AbortSignal): Promise<void> => {
    if (ownerSignal?.aborted) return Promise.resolve();
    const existingRun = runs.get(userId);
    if (existingRun && !existingRun.stopped)
      return existingRun.ticking ?? Promise.resolve();
    const stoppingRun = stoppingRuns.get(userId);
    if (stoppingRun?.stopPromise)
      return stoppingRun.stopPromise.then(() => start(userId, ownerSignal));
    const run: WatchRun = {
      controller: new AbortController(),
      cursor: 0,
      timer: null,
      ticking: null,
      stopped: false,
      status: 'starting',
      processing: new Map(),
      processingFingerprints: new Map(),
      refreshRetries: new Map(),
      requestedChecks: new Set(),
      followUpTargets: new Set(),
      unsubscribeCapacity: null,
      removeOwnerAbortListener: null,
      stopPromise: null,
      changesDetected: 0,
      changesProcessed: 0,
      pendingSince: new Map(),
      pendingFingerprints: new Map(),
      retryAfterProcessing: false,
      reconciling: null,
      reconcileRetryAt: 0,
    };
    runs.set(userId, run);
    if (ownerSignal) {
      const abortFromOwner = () => {
        run.controller.abort(ownerSignal.reason);
        void stop(userId).catch(() => undefined);
      };
      ownerSignal.addEventListener('abort', abortFromOwner, { once: true });
      run.removeOwnerAbortListener = () =>
        ownerSignal.removeEventListener('abort', abortFromOwner);
    }
    run.unsubscribeCapacity =
      dependencies.subscribeCapacity?.(userId, () => {
        if (run.stopped) return;
        if (run.ticking || run.processing.size || run.reconciling) {
          run.retryAfterProcessing = true;
          return;
        }
        void tick(userId, run);
      }) ?? null;
    dependencies.onStatus?.(userId, 'starting');
    return tick(userId, run);
  };

  const stop = (userId: string): Promise<void> => {
    const run = runs.get(userId) ?? stoppingRuns.get(userId);
    if (!run) return Promise.resolve();
    if (run.stopPromise) return run.stopPromise;
    run.stopped = true;
    run.controller.abort();
    if (run.timer) cancelSchedule(run.timer);
    run.unsubscribeCapacity?.();
    run.removeOwnerAbortListener?.();
    runs.delete(userId);
    stoppingRuns.set(userId, run);
    run.stopPromise = Promise.all([
      run.ticking?.catch(() => undefined),
      run.reconciling,
      ...run.processing.values(),
    ]).then(() => {
      publish(userId, run, 'off');
      if (stoppingRuns.get(userId) === run) stoppingRuns.delete(userId);
    });
    return run.stopPromise;
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
