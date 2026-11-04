import type {
  CourseRefreshActivity,
  CourseRefreshMetricName,
  CourseRefreshMetrics,
} from '../../courses/types';

export type AcademicTaskExecutionContext = {
  runId: string;
  sessionEpoch: number;
  coveredRevisions: Readonly<Record<string, string>>;
};

type AcademicTaskExecutionScope = Omit<AcademicTaskExecutionContext, 'runId'>;
type AcademicTaskOutcome = 'complete' | 'partial';
type AcademicTaskActivity = Omit<CourseRefreshActivity, 'status'> & {
  status: CourseRefreshActivity['status'] | 'partial';
};

type AcademicTask = {
  accountId: string;
  controller: AbortController;
  completion: Promise<unknown>;
  key?: string;
  exclusive: boolean;
  signal: AbortSignal;
  activity?: AcademicTaskActivity;
  partial?: boolean;
  signInRequired?: boolean;
  startedAt: number;
};

export class AcademicTaskDeferredError extends Error {
  readonly status = 'deferred';
  readonly reason = 'busy';

  constructor(message: string) {
    super(message);
    this.name = 'AcademicTaskDeferredError';
  }
}

export const isAcademicTaskDeferred = (
  error: unknown,
): error is AcademicTaskDeferredError =>
  error instanceof AcademicTaskDeferredError;

type BrowserCapabilityChangedError = Error & {
  name: 'BrowserCapabilityChangedError';
};

const isBrowserCapabilityChangedError = (
  error: unknown,
): error is BrowserCapabilityChangedError =>
  error instanceof Error && error.name === 'BrowserCapabilityChangedError';

const emptyMetrics = (): CourseRefreshMetrics => ({
  pagesOpened: 0,
  modelCalls: 0,
  knownDestinationsReused: 0,
  navigationRepairs: 0,
  candidatesExtracted: 0,
  duplicatesReconciled: 0,
  ambiguousIdentityConflicts: 0,
  recordsCreated: 0,
  recordsUpdated: 0,
  recordsRetired: 0,
  firstFindingMs: null,
  durationMs: null,
});

export const createAcademicTaskRunner = (
  options: { now?: () => number } = {},
) => {
  const active = new Set<AcademicTask>();
  const history: { accountId: string; activity: AcademicTaskActivity }[] = [];
  const now = options.now ?? Date.now;
  // P01 owns the shared DTO and has not added partial yet.
  const getActivity = (accountId: string): CourseRefreshActivity[] =>
    history
      .filter((run) => run.accountId === accountId)
      .map((run) => run.activity as unknown as CourseRefreshActivity);
  const report = (signal: AbortSignal, message: string, partial = false) => {
    const task = [...active].find((task) => task.signal === signal);
    if (!task?.activity || signal.aborted) return;
    if (task.activity.events.at(-1) === message && !partial) return;
    if (partial) task.partial = true;
    task.activity.events = [...task.activity.events, message].slice(-100);
    notify(task.accountId);
  };
  const listeners = new Set<(accountId: string) => void>();
  const notify = (accountId: string) => {
    for (const listener of listeners) {
      try {
        listener(accountId);
      } catch {
        /* Observers do not own task cleanup. */
      }
    }
  };
  const recordMetric = (
    signal: AbortSignal,
    metric: CourseRefreshMetricName,
    amount = 1,
  ) => {
    const task = [...active].find((item) => item.signal === signal);
    if (
      !task?.activity?.metrics ||
      signal.aborted ||
      !Number.isFinite(amount) ||
      amount < 0
    )
      return;
    task.activity.metrics[metric] =
      (task.activity.metrics[metric] ?? 0) + amount;
    notify(task.accountId);
  };
  const markFirstFinding = (signal: AbortSignal) => {
    const task = [...active].find((item) => item.signal === signal);
    if (
      !task?.activity?.metrics ||
      signal.aborted ||
      task.activity.metrics.firstFindingMs !== null
    )
      return;
    task.activity.metrics.firstFindingMs = Math.max(0, now() - task.startedAt);
    notify(task.accountId);
  };
  const reportSignInRequired = (signal: AbortSignal, _message: string) => {
    const task = [...active].find((task) => task.signal === signal);
    if (!task?.activity || signal.aborted) return;
    task.signInRequired = true;
    task.activity.events = [
      ...task.activity.events,
      'Sign in to your academic source to refresh it.',
    ].slice(-100);
    notify(task.accountId);
  };
  const subscribe = (listener: (accountId: string) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const getRefreshState = (accountId: string) => {
    const tasks = [...active].filter((task) => task.accountId === accountId);
    return {
      allCourses: tasks.some(
        (task) => task.key === 'courses' || task.exclusive,
      ),
      courseIds: tasks.flatMap((task) =>
        task.key && task.key !== 'courses' && !task.exclusive ? [task.key] : [],
      ),
    };
  };
  const run = <T>(
    accountId: string,
    action: (
      signal: AbortSignal,
      execution: AcademicTaskExecutionContext,
    ) => Promise<T>,
    externalSignal?: AbortSignal,
    key?: string,
    options: {
      exclusive?: boolean;
      classifyOutcome?: (value: T) => AcademicTaskOutcome;
      captureExecutionScope?: () => AcademicTaskExecutionScope;
    } = {},
  ): Promise<T> => {
    const exclusive = options.exclusive ?? key === 'courses';
    const duplicate =
      key &&
      [...active].find(
        (task) =>
          task.accountId === accountId &&
          task.key === key &&
          task.exclusive === exclusive &&
          !task.controller.signal.aborted,
      );
    if (duplicate && !externalSignal?.aborted)
      return duplicate.completion as Promise<T>;
    if (
      [...active].some(
        (task) =>
          !key ||
          exclusive ||
          task.exclusive ||
          !task.key ||
          key === 'courses' ||
          task.key === 'courses' ||
          task.key === key ||
          task.accountId !== accountId,
      )
    )
      return Promise.reject(
        new AcademicTaskDeferredError(
          'Another academic task is running; stop it or try again shortly.',
        ),
      );
    if (active.size >= 2)
      return Promise.reject(
        new AcademicTaskDeferredError(
          'Two courses are already refreshing; try again shortly.',
        ),
      );
    const controller = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    const startedAt = now();
    const runId = crypto.randomUUID();
    const completion = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        const scope = options.captureExecutionScope?.() ?? {
          sessionEpoch: 0,
          coveredRevisions: {},
        };
        return action(signal, {
          runId,
          sessionEpoch: scope.sessionEpoch,
          coveredRevisions: Object.freeze({ ...scope.coveredRevisions }),
        });
      })
      .then(
        (value) => {
          if (task.activity) {
            if (task.activity.metrics)
              task.activity.metrics.durationMs = Math.max(0, now() - startedAt);
            const outcome = options.classifyOutcome?.(value);
            task.activity.status = signal.aborted
              ? 'cancelled'
              : task.signInRequired
                ? 'sign-in-required'
                : task.partial || outcome === 'partial'
                  ? 'partial'
                  : 'complete';
          }
          return value;
        },
        (error) => {
          if (isBrowserCapabilityChangedError(error))
            for (const sibling of active)
              if (sibling.accountId === accountId && sibling !== task)
                sibling.controller.abort();
          if (task.activity) {
            if (task.activity.metrics)
              task.activity.metrics.durationMs = Math.max(0, now() - startedAt);
            task.activity.status = signal.aborted ? 'cancelled' : 'failed';
            if (!signal.aborted) task.activity.events.push('Refresh failed.');
          }
          throw error;
        },
      )
      .finally(() => {
        active.delete(task);
        notify(accountId);
      });
    const activity: AcademicTaskActivity | undefined = key
      ? {
          id: runId,
          key,
          status: 'running',
          events: ['Starting refresh'],
          metrics: emptyMetrics(),
        }
      : undefined;
    const task: AcademicTask = {
      accountId,
      controller,
      completion,
      key,
      exclusive,
      signal,
      activity,
      startedAt,
    };
    if (activity) {
      const previous = history.findIndex(
        (run) => run.accountId === accountId && run.activity.key === key,
      );
      if (previous >= 0) history.splice(previous, 1);
      history.push({ accountId, activity });
      if (history.length > 12)
        history.splice(
          history.findIndex(
            (run) =>
              ![...active].some((task) => task.activity === run.activity),
          ),
          1,
        );
    }
    active.add(task);
    notify(accountId);
    return completion;
  };
  const cancel = (accountId?: string, key?: string) => {
    for (const task of active)
      if (
        (!accountId || task.accountId === accountId) &&
        (!key || task.key === key)
      )
        task.controller.abort();
  };
  const cancelAndWait = async (timeoutMs = 2500) => {
    const tasks = [...active];
    if (!tasks.length) return;
    for (const task of tasks) task.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(
          tasks.map((task) => task.completion.catch(() => undefined)),
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Stopping the previous academic task; try again shortly.',
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    run,
    cancel,
    cancelAndWait,
    subscribe,
    getRefreshState,
    getActivity,
    report,
    reportSignInRequired,
    recordMetric,
    markFirstFinding,
  };
};
export const academicTasks = createAcademicTaskRunner();
