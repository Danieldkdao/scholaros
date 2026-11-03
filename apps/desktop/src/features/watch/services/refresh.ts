import { academicTasks } from '../../onboarding/services/academic-tasks';
import type { WatchTargetSelectData } from '../../../db/schema';
import type { WatchProcessedRevision, WatchRefreshResult } from '../types';

type WatchRefreshOutcome = { complete: boolean };
type StartWatchRefresh = (
  target: WatchTargetSelectData,
  signal: AbortSignal,
) => Promise<WatchRefreshOutcome>;
type RunAcademicTask = <T>(
  accountId: string,
  action: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
  key?: string,
) => Promise<T>;

type WatchRefreshProcessorOptions = {
  refreshTarget?: (
    target: WatchTargetSelectData,
    signal: AbortSignal,
  ) => Promise<WatchRefreshOutcome>;
  startRefresh?: StartWatchRefresh;
  markProcessed: (revision: WatchProcessedRevision) => unknown;
  runTask?: RunAcademicTask;
  now?: () => Date;
};

export const isTaskRunnerBusy = (error: unknown) =>
  error instanceof Error &&
  (error.message.includes('Another academic task') ||
    error.message.includes('Two courses are already refreshing'));

export const createWatchRefreshProcessor =
  ({
    refreshTarget,
    startRefresh,
    markProcessed,
    runTask = academicTasks.run,
    now = () => new Date(),
  }: WatchRefreshProcessorOptions) =>
  async (
    target: WatchTargetSelectData,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<WatchRefreshResult> => {
    const taskKey = target.courseId ?? 'courses';
    try {
      const outcome = startRefresh
        ? await startRefresh(target, signal)
        : refreshTarget
          ? await runTask(
              target.userId,
              (taskSignal) => refreshTarget(target, taskSignal),
              signal,
              taskKey,
            )
          : null;
      if (!outcome) throw new Error('No course refresh action was provided.');
      signal.throwIfAborted();
      if (!outcome.complete) return false;
      const processed = markProcessed({
        userId: target.userId,
        targetId: target.id,
        fingerprint,
        processedAt: now().toISOString(),
      });
      return !!processed;
    } catch (error) {
      if (isTaskRunnerBusy(error)) return 'busy';
      throw error;
    }
  };
