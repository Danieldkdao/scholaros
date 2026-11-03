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
  refreshCourse: vi.fn(),
  refreshConnection: vi.fn(),
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
  refreshSingleCourse: mocks.refreshCourse,
  startConnectionRefresh: mocks.refreshConnection,
}));
vi.mock('../services/browser-session', () => ({
  settleWatchPage: vi.fn(),
  createWatchBrowserSession: (options: unknown) => {
    mocks.browserOptions = options as NonNullable<typeof mocks.browserOptions>;
    return { closeAll: vi.fn(), setMutationHandler: vi.fn() };
  },
}));
vi.mock('../services/controller', () => ({
  createWatchController: (options: unknown) => {
    mocks.controllerOptions = options as NonNullable<
      typeof mocks.controllerOptions
    >;
    return {
      start: vi.fn(),
      stop: vi.fn(),
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
  getWatchTargets: () => [{ id: 'target', status: 'active' }],
  markWatchTargetProcessed: vi.fn(),
  recordWatchFailure: vi.fn(),
  recordWatchObservation: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = 'watching';
});

const start = async () => {
  const runtime = createWatchRuntime({ onStatus: vi.fn() });
  await runtime.configure('student', true, () => true);
  return runtime;
};

it('opens an inactive watch tab through the protected background-page helper', async () => {
  await start();
  const signal = new AbortController().signal;
  await mocks.browserOptions!.createPage(target, signal);

  expect(mocks.openBackgroundPage).toHaveBeenCalledWith(
    mocks.workspace,
    signal,
  );
  expect(mocks.workspace.browser.context.newPage).not.toHaveBeenCalled();
});

it('does not process a course revision when material refresh is partial', async () => {
  await start();
  mocks.refreshCourse.mockResolvedValue({
    materialRefreshStatus: 'partial',
    overviewSyncedAt: 'now',
    assignmentsStatus: 'complete',
    announcementsStatus: 'complete',
  });

  await expect(
    mocks.refreshOptions!.startRefresh!(target, new AbortController().signal),
  ).resolves.toEqual({ complete: false });
});

it('does not process a connection revision when material refresh is partial', async () => {
  await start();
  mocks.refreshConnection.mockResolvedValue({
    materialRefreshStatus: 'partial',
    snapshot: {
      sources: [{ connectionId: 'connection', outcome: 'complete' }],
      courses: [],
    },
  });

  await expect(
    mocks.refreshOptions!.startRefresh!(
      { ...target, courseId: null },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ complete: false });
});

it('returns current controller health in snapshots after a running watcher fails', async () => {
  const runtime = await start();
  mocks.status = 'blocked';

  expect(runtime.getState('student').status).toBe('blocked');
});

it('daily reconciliation refreshes connected course resources without requiring scheduled full sync', async () => {
  await start();
  mocks.refreshConnection.mockResolvedValue({
    materialRefreshStatus: 'complete',
    snapshot: {
      sources: [{ connectionId: 'connection', outcome: 'complete' }],
      courses: [],
    },
  });
  const signal = new AbortController().signal;

  await expect(
    mocks.controllerOptions!.reconcileCourses!.run('student', signal),
  ).resolves.toBe(true);
  expect(mocks.refreshConnection).toHaveBeenCalledWith(
    'student',
    'connection',
    expect.any(Function),
    signal,
  );

  mocks.refreshConnection.mockRejectedValue(
    new Error('Another academic task is running'),
  );
  await expect(
    mocks.controllerOptions!.reconcileCourses!.run('student', signal),
  ).resolves.toBe('busy');
});
