import { academicTasks } from '../../onboarding/services/academic-tasks';
import type { WatchTargetSelectData } from '../../../db/schema';
import type { WatchTargetFailureCategory } from '../../../db/shared';
import type {
  InternalWatchExecutionCoverageReceipt,
  WatchProcessedRevision,
  WatchRefreshResult,
} from '../types';

type WatchRefreshOutcome = {
  complete: boolean;
  receipt: InternalWatchExecutionCoverageReceipt | null;
  failureCategory?: WatchTargetFailureCategory;
};
type StartWatchRefresh = (
  target: WatchTargetSelectData,
  fingerprint: string,
  signal: AbortSignal,
) => Promise<WatchRefreshOutcome>;
type RunAcademicTask = <T>(
  accountId: string,
  action: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
  key?: string,
) => Promise<T>;

type WatchRefreshProcessorOptions = {
  refreshTarget?: StartWatchRefresh;
  startRefresh?: StartWatchRefresh;
  markProcessed: (revision: WatchProcessedRevision) => unknown;
  runTask?: RunAcademicTask;
  now?: () => Date;
};

export const isTaskRunnerBusy = (error: unknown) =>
  error instanceof Error &&
  (('status' in error &&
    error.status === 'deferred' &&
    'reason' in error &&
    error.reason === 'busy') ||
    error.message.includes('Another academic task') ||
    error.message.includes('Two courses are already refreshing'));

const hasCompleteCoverage = (
  target: WatchTargetSelectData,
  receipt: InternalWatchExecutionCoverageReceipt,
) => {
  if (!target.courseId)
    return receipt.collectionCoverage.every(
      (collection) => collection.status === 'complete',
    );
  const courseCollections = receipt.collectionCoverage.filter(
    (collection) => collection.courseId === target.courseId,
  );
  const requiredCollections = [
    'assignments',
    'announcements',
    'materials',
  ] as const;
  return (
    requiredCollections.every((collectionKind) =>
      courseCollections.some(
        (collection) =>
          collection.collectionKind === collectionKind &&
          collection.status === 'complete',
      ),
    ) &&
    courseCollections.every((collection) => collection.status === 'complete')
  );
};

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
        ? await startRefresh(target, fingerprint, signal)
        : refreshTarget
          ? await runTask(
              target.userId,
              (taskSignal) => refreshTarget(target, fingerprint, taskSignal),
              signal,
              taskKey,
            )
          : null;
      if (!outcome) throw new Error('No course refresh action was provided.');
      signal.throwIfAborted();
      const receipt = outcome.receipt;
      if (!receipt)
        throw new Error('Academic refresh returned no admission receipt.');
      if (
        !receipt.runId ||
        !Number.isSafeInteger(receipt.sessionEpoch) ||
        receipt.sessionEpoch < 0
      )
        throw new Error(
          'Academic refresh returned an invalid admission receipt.',
        );
      const exactRevisionWasCovered = receipt.coveredRevisions.some(
        (revision) =>
          revision.targetId === target.id &&
          revision.fingerprint === fingerprint,
      );
      if (!exactRevisionWasCovered) return 'superseded';
      if (outcome.failureCategory === 'needs-sign-in') return 'needs-sign-in';
      if (outcome.failureCategory) return 'source-failed';
      if (!outcome.complete) return 'source-failed';
      if (!hasCompleteCoverage(target, receipt)) return 'source-failed';
      const processed = markProcessed({
        userId: target.userId,
        targetId: target.id,
        fingerprint,
        processedAt: now().toISOString(),
        sessionEpoch: receipt.sessionEpoch,
      });
      return !!processed;
    } catch (error) {
      if (isTaskRunnerBusy(error)) return 'busy';
      throw error;
    }
  };
