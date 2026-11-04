import { beforeEach, expect, it, vi } from 'vitest';
import type { WatchTargetSelectData } from '../../../db/schema';

const mocks = vi.hoisted(() => ({
  workspace: { browser: { context: { newPage: vi.fn() } } },
  openBackgroundPage: vi.fn(async () => ({})),
  status: 'watching',
  browserOptions: null as
    | Parameters<
        typeof import('../services/browser-session').createWatchBrowserSession
      >[0]
    | null,
  refreshOptions: null as
    | Parameters<
        typeof import('../services/refresh').createWatchRefreshProcessor
      >[0]
    | null,
  refreshCourseWithReceipt: vi.fn(),
  refreshConnectionWithReceipt: vi.fn(),
  controllerStart: vi.fn(),
  controllerStop: vi.fn(),
  controllerTick: vi.fn(),
  browserCloseAll: vi.fn(),
  markWatchTargetProcessed: vi.fn(),
  resetWatchTargetsAfterReconnect: vi.fn(),
  watchTargets: [] as Record<string, unknown>[],
  watchHealth: {} as {
    status: string;
    pendingRevisionCount: number;
    oldestPendingSince: string | null;
    oldestPendingSinceEstimated: boolean;
    lastSuccessfulCheckAt: string | null;
    nextRetryAt: string | null;
    failures: Array<{ category: string; targetCount: number }>;
  },
  controllerOptions: null as
    | Parameters<
        typeof import('../services/controller').createWatchController
      >[0]
    | null,
}));

vi.mock('../../onboarding/services/academic-tasks', () => ({
  academicTasks: {},
}));
vi.mock('../../onboarding/services/store', () => ({
  getOnboardingState: () => ({
    settings: { consent: true, localSetupCompletedAt: 'now' },
    workspace: { ready: true },
    connections: [
      {
        id: 'connection',
        host: 'school.edu',
        url: 'https://school.edu/',
        isCourseResource: true,
        status: 'verified',
      },
    ],
  }),
}));
vi.mock('../../onboarding/services/browser-workspace', () => ({
  getWorkspace: async () => mocks.workspace,
}));
vi.mock('../../onboarding/services/background-page', () => ({
  openBackgroundPage: mocks.openBackgroundPage,
}));
vi.mock('../../onboarding/services/mission-navigation', () => ({
  createMissionNavigator: vi.fn(),
}));
vi.mock('../../onboarding/services/mission-request-guard', () => ({
  protectMissionPage: vi.fn(),
}));
vi.mock('../../courses/services/refresh', () => ({
  refreshSingleCourseWithReceipt: mocks.refreshCourseWithReceipt,
  startConnectionRefreshWithReceipt: mocks.refreshConnectionWithReceipt,
}));
vi.mock('../services/browser-session', () => ({
  settleWatchPage: vi.fn(),
  createWatchBrowserSession: (options: unknown) => {
    mocks.browserOptions = options as NonNullable<typeof mocks.browserOptions>;
    return {
      closeAll: mocks.browserCloseAll,
      setMutationHandler: vi.fn(),
    };
  },
}));
vi.mock('../services/controller', () => ({
  createWatchController: (options: unknown) => {
    mocks.controllerOptions = options as NonNullable<
      typeof mocks.controllerOptions
    >;
    return {
      start: mocks.controllerStart,
      stop: mocks.controllerStop,
      tick: mocks.controllerTick,
      getStatus: () => mocks.status,
      getMetrics: () => null,
    };
  },
}));
vi.mock('../services/refresh', () => ({
  isTaskRunnerBusy: (error: unknown) =>
    error instanceof Error && error.message.includes('Another academic task'),
  createWatchRefreshProcessor: (options: unknown) => {
    mocks.refreshOptions = options as NonNullable<typeof mocks.refreshOptions>;
    return vi.fn();
  },
}));
vi.mock('../services/page-observer', () => ({
  installPageObserver: vi.fn(),
  readPageMutationState: vi.fn(),
  readWatchPageSnapshot: vi.fn(),
  disconnectPageObserver: vi.fn(),
}));
vi.mock('../services/store', () => ({
  getWatchSettings: () => ({ watchEnabled: true, watchUrls: [] }),
  getWatchTargets: () => mocks.watchTargets,
  getWatchHealthSummary: (_userId: string, runtimeStatus: string) =>
    mocks.watchHealth.status === 'needs-sign-in' ||
    mocks.watchHealth.status === 'blocked'
      ? mocks.watchHealth
      : { ...mocks.watchHealth, status: runtimeStatus },
  markWatchTargetProcessed: mocks.markWatchTargetProcessed,
  recordWatchFailure: vi.fn(),
  recordWatchObservation: vi.fn(),
  resetWatchTargetsAfterReconnect: mocks.resetWatchTargetsAfterReconnect,
  scheduleWatchTargetCheck: vi.fn(),
  synchronizeWatchTargets: vi.fn(),
  getLastWatchReconciledAt: vi.fn(() => null),
  recordWatchReconciledAt: vi.fn(),
}));

const { createWatchRuntime } = await import('../services/runtime');
const target = {
  id: 'target',
  userId: 'student',
  connectionId: 'connection',
  courseId: 'course',
  requestedUrl: 'https://school.edu/course',
} as WatchTargetSelectData;
const observedAt = '2026-11-01T12:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.controllerStart.mockReset().mockResolvedValue(undefined);
  mocks.controllerStop.mockReset().mockResolvedValue(undefined);
  mocks.controllerTick.mockReset().mockResolvedValue(undefined);
  mocks.browserCloseAll.mockReset().mockResolvedValue(undefined);
  mocks.markWatchTargetProcessed.mockReset();
  mocks.resetWatchTargetsAfterReconnect.mockReset().mockReturnValue([]);
  mocks.refreshCourseWithReceipt.mockReset();
  mocks.refreshConnectionWithReceipt.mockReset();
  mocks.watchTargets = [];
  mocks.watchHealth = {
    status: 'watching',
    pendingRevisionCount: 0,
    oldestPendingSince: null,
    oldestPendingSinceEstimated: false,
    lastSuccessfulCheckAt: null,
    nextRetryAt: null,
    failures: [],
  };
  mocks.status = 'watching';
});

const start = async () => {
  const runtime = createWatchRuntime({ onStatus: vi.fn() });
  await runtime.configure('student', true, () => true);
  return runtime;
};

it('aborts startup before waiting for the first tick and awaits shared page cleanup', async () => {
  let startSignal: AbortSignal | undefined;
  let releaseStart!: () => void;
  let releaseClose!: () => void;
  let closeCalls = 0;
  mocks.controllerStart.mockImplementation(
    (_userId: string, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        startSignal = signal;
        releaseStart = resolve;
        signal?.addEventListener('abort', () => resolve(), { once: true });
      }),
  );
  mocks.browserCloseAll.mockImplementation(() => {
    closeCalls += 1;
    if (closeCalls === 1) return Promise.resolve();
    return new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
  });
  const runtime = createWatchRuntime({ onStatus: vi.fn() });

  const configuring = runtime.configure('student', true, () => true);
  await vi.waitFor(() => expect(mocks.controllerStart).toHaveBeenCalledOnce());
  let stopSettled = false;
  const stopping = runtime.stop().then(() => {
    stopSettled = true;
  });
  const abortedBeforeRelease = startSignal?.aborted === true;
  releaseStart();
  await vi.waitFor(() => expect(closeCalls).toBe(2));
  await Promise.resolve();

  expect(abortedBeforeRelease).toBe(true);
  expect(stopSettled).toBe(false);
  releaseClose();
  await Promise.all([configuring, stopping]);
  expect(runtime.getState('student').status).toBe('off');
});

it('publishes bounded target health with a monotonic snapshot revision', async () => {
  mocks.watchTargets = [
    {
      ...target,
      verifiedUrl: null,
      urlIdentity: target.requestedUrl,
      lastAttemptAt: observedAt,
      lastSuccessfulCheckAt: observedAt,
      detectedFingerprint: 'a'.repeat(64),
      processedFingerprint: null,
      pendingChange: true,
      pendingSince: '2026-10-31T12:00:00.000Z',
      pendingSinceEstimated: true,
      lastFailureCategory: 'needs-sign-in',
      nextCheckAt: null,
      status: 'suspended',
      failureCount: 0,
      retryAt: null,
      recipeVersion: 1,
      createdAt: observedAt,
      updatedAt: observedAt,
    },
  ];
  mocks.watchHealth = {
    status: 'needs-sign-in',
    pendingRevisionCount: 1,
    oldestPendingSince: '2026-10-31T12:00:00.000Z',
    oldestPendingSinceEstimated: true,
    lastSuccessfulCheckAt: observedAt,
    nextRetryAt: null,
    failures: [{ category: 'needs-sign-in', targetCount: 1 }],
  };
  const onStatus = vi.fn();
  const runtime = createWatchRuntime({ onStatus });
  await runtime.configure('student', true, () => true);

  const state = runtime.getState('student');
  const eventRevisions = onStatus.mock.calls.map((call) => call[3]);

  expect(state.status).toBe('needs-sign-in');
  expect(state.health).toMatchObject({
    status: 'needs-sign-in',
    pendingRevisionCount: 1,
    oldestPendingSince: '2026-10-31T12:00:00.000Z',
    oldestPendingSinceEstimated: true,
    lastSuccessfulCheckAt: observedAt,
    failures: [{ category: 'needs-sign-in', targetCount: 1 }],
  });
  expect(JSON.stringify(state.health)).not.toContain('school.edu');
  expect(eventRevisions.length).toBeGreaterThan(0);
  expect(eventRevisions).toEqual(
    [...eventRevisions].sort((left, right) => left - right),
  );
  expect(state.revision).toBe(eventRevisions.at(-1));
});

it('opens an inactive watch tab through the protected background-page helper', async () => {
  mocks.watchTargets = [{ ...target, status: 'active' }];
  await start();
  const signal = new AbortController().signal;
  await mocks.browserOptions!.createPage(target, signal);

  expect(mocks.openBackgroundPage).toHaveBeenCalledWith(
    mocks.workspace,
    signal,
  );
  expect(mocks.workspace.browser.context.newPage).not.toHaveBeenCalled();
});

it('captures and forwards the exact revision through the P06 admitted-course receipt', async () => {
  const fingerprint = 'f'.repeat(64);
  const collections = ['assignments', 'announcements', 'materials'] as const;
  mocks.refreshCourseWithReceipt.mockImplementation(
    async (
      _userId: string,
      _courseId: string,
      captureExecutionScope: () => {
        sessionEpoch: number;
        coveredRevisions: Readonly<Record<string, string>>;
      },
    ) => {
      const scope = captureExecutionScope();
      return {
        result: { id: 'course' },
        receipt: {
          ...scope,
          runId: 'refresh-a',
          status: 'complete',
          collections: collections.map((kind) => ({
            connectionId: 'connection',
            courseId: 'course',
            kind,
            status: 'complete',
          })),
        },
      };
    },
  );
  await start();
  const signal = new AbortController().signal;

  const outcome = await mocks.refreshOptions!.startRefresh!(
    target,
    fingerprint,
    signal,
  );

  expect(mocks.refreshCourseWithReceipt).toHaveBeenCalledWith(
    'student',
    'course',
    expect.any(Function),
    expect.any(Function),
    signal,
  );
  const captureExecutionScope = mocks.refreshCourseWithReceipt.mock.calls[0][2];
  expect(captureExecutionScope()).toEqual({
    sessionEpoch: outcome.receipt?.sessionEpoch,
    coveredRevisions: { target: fingerprint },
  });
  expect(outcome).toMatchObject({
    complete: true,
    receipt: {
      runId: 'refresh-a',
      coveredRevisions: [{ targetId: 'target', fingerprint }],
    },
  });
});

it('retries only targets reset by an explicit successful reconnect', async () => {
  mocks.resetWatchTargetsAfterReconnect.mockReturnValue(['target-a']);
  const runtime = await start();

  const resetTargetIds = await runtime.reconnectSucceeded(
    'student',
    'connection',
  );

  expect(mocks.resetWatchTargetsAfterReconnect).toHaveBeenCalledWith(
    'student',
    'connection',
  );
  expect(resetTargetIds).toEqual(['target-a']);
  await runtime.stop();
});

it('fences refresh receipts when the same account starts a new session', async () => {
  let sessionIsCurrent = true;
  const firstSessionIsCurrent = () => sessionIsCurrent;
  mocks.refreshCourseWithReceipt.mockImplementation(
    async (_userId, _courseId, captureExecutionScope) => ({
      result: { id: 'course' },
      receipt: {
        ...captureExecutionScope(),
        runId: 'refresh-a',
        status: 'complete',
        collections: ['assignments', 'announcements', 'materials'].map(
          (kind) => ({
            connectionId: 'connection',
            courseId: 'course',
            kind,
            status: 'complete',
          }),
        ),
      },
    }),
  );
  const runtime = createWatchRuntime({ onStatus: vi.fn() });
  await runtime.configure('student', true, firstSessionIsCurrent);
  const firstOutcome = await mocks.refreshOptions!.startRefresh!(
    target,
    'f'.repeat(64),
    new AbortController().signal,
  );
  const oldSessionEpoch = firstOutcome.receipt?.sessionEpoch;

  sessionIsCurrent = false;
  await runtime.configure('student', true, () => true);
  const nextOutcome = await mocks.refreshOptions!.startRefresh!(
    target,
    'f'.repeat(64),
    new AbortController().signal,
  );
  const staleResult = mocks.refreshOptions!.markProcessed({
    userId: 'student',
    targetId: target.id,
    fingerprint: 'f'.repeat(64),
    processedAt: observedAt,
    sessionEpoch: oldSessionEpoch,
  });

  expect(nextOutcome.receipt?.sessionEpoch).toBeGreaterThan(
    oldSessionEpoch ?? 0,
  );
  expect(staleResult).toBeNull();
  expect(mocks.markWatchTargetProcessed).not.toHaveBeenCalled();
  await runtime.stop();
});

it('rejects a processed receipt after its session owner stops', async () => {
  mocks.refreshCourseWithReceipt.mockImplementation(
    async (_userId, _courseId, captureExecutionScope) => ({
      result: { id: 'course' },
      receipt: {
        ...captureExecutionScope(),
        runId: 'refresh-a',
        status: 'complete',
        collections: ['assignments', 'announcements', 'materials'].map(
          (kind) => ({
            connectionId: 'connection',
            courseId: 'course',
            kind,
            status: 'complete',
          }),
        ),
      },
    }),
  );
  const runtime = await start();
  const fingerprint = 'f'.repeat(64);
  const outcome = await mocks.refreshOptions!.startRefresh!(
    target,
    fingerprint,
    new AbortController().signal,
  );
  await runtime.stop();

  const processed = mocks.refreshOptions!.markProcessed({
    userId: 'student',
    targetId: target.id,
    fingerprint,
    processedAt: observedAt,
    sessionEpoch: outcome.receipt?.sessionEpoch,
  });

  expect(processed).toBeNull();
  expect(mocks.markWatchTargetProcessed).not.toHaveBeenCalled();
});

it('does not process a course revision when material refresh is partial', async () => {
  await start();
  mocks.refreshCourseWithReceipt.mockImplementation(
    async (_userId, _courseId, captureExecutionScope) => ({
      result: { id: 'course' },
      receipt: {
        ...captureExecutionScope(),
        runId: 'refresh-a',
        status: 'partial',
        collections: [
          {
            connectionId: 'connection',
            courseId: 'course',
            kind: 'assignments',
            status: 'complete',
          },
          {
            connectionId: 'connection',
            courseId: 'course',
            kind: 'announcements',
            status: 'complete',
          },
          {
            connectionId: 'connection',
            courseId: 'course',
            kind: 'materials',
            status: 'partial',
          },
        ],
      },
    }),
  );

  await expect(
    mocks.refreshOptions!.startRefresh!(
      target,
      'f'.repeat(64),
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ complete: false });
});

it('does not process a connection revision when material refresh is partial', async () => {
  await start();
  mocks.refreshConnectionWithReceipt.mockImplementation(
    async (_userId, _connectionId, captureExecutionScope) => ({
      result: {
        materialRefreshStatus: 'partial',
      },
      receipt: {
        ...captureExecutionScope(),
        runId: 'refresh-a',
        status: 'partial',
        collections: [
          {
            connectionId: 'connection',
            courseId: null,
            kind: 'courses',
            status: 'partial',
          },
        ],
      },
    }),
  );

  await expect(
    mocks.refreshOptions!.startRefresh!(
      { ...target, courseId: null },
      'f'.repeat(64),
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ complete: false });
});

it('returns current controller health in snapshots after a running watcher fails', async () => {
  const runtime = await start();
  mocks.status = 'blocked';

  expect(runtime.getState('student').status).toBe('blocked');
});

it('daily reconciliation uses exact connection coverage and preserves busy outcomes', async () => {
  await start();
  const completeReceipt = (
    captureExecutionScope: () => {
      sessionEpoch: number;
      coveredRevisions: Readonly<Record<string, string>>;
    },
    status: 'complete' | 'partial',
  ) => ({
    result: {
      materialRefreshStatus: 'complete',
      snapshot: {
        sources: [{ connectionId: 'connection', outcome: 'complete' }],
        courses: [],
      },
    },
    receipt: {
      ...captureExecutionScope(),
      runId: 'refresh-a',
      status,
      collections: [
        {
          connectionId: 'connection',
          courseId: null,
          kind: 'courses',
          status: status === 'complete' ? 'complete' : 'partial',
        },
      ],
    },
  });
  mocks.refreshConnectionWithReceipt.mockImplementation(
    async (_userId, _connectionId, captureExecutionScope) =>
      completeReceipt(captureExecutionScope, 'complete'),
  );
  const signal = new AbortController().signal;

  await expect(
    mocks.controllerOptions!.reconcileCourses!.run('student', signal),
  ).resolves.toBe(true);
  expect(mocks.refreshConnectionWithReceipt).toHaveBeenCalledWith(
    'student',
    'connection',
    expect.any(Function),
    expect.any(Function),
    signal,
  );
  expect(mocks.refreshConnectionWithReceipt.mock.calls[0][2]()).toMatchObject({
    coveredRevisions: {},
  });

  mocks.refreshConnectionWithReceipt.mockImplementation(
    async (_userId, _connectionId, captureExecutionScope) =>
      completeReceipt(captureExecutionScope, 'partial'),
  );
  await expect(
    mocks.controllerOptions!.reconcileCourses!.run('student', signal),
  ).resolves.toBe(false);

  mocks.refreshConnectionWithReceipt.mockRejectedValue(
    new Error('Another academic task is running'),
  );
  await expect(
    mocks.controllerOptions!.reconcileCourses!.run('student', signal),
  ).resolves.toBe('busy');
});
