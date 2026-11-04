import { afterEach, expect, it, vi } from 'vitest';
import { getPreview, resetPreview, startPreview } from '../services/preview';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  getMode: vi.fn(),
  withStagehand: vi.fn(),
  createAdapter: vi.fn(),
  runMission: vi.fn(),
  validateCards: vi.fn(),
  getState: vi.fn(),
  getWorkspace: vi.fn(),
  protect: vi.fn(),
}));
vi.mock('../services/academic-tasks', () => ({
  academicTasks: { run: mocks.run },
}));
vi.mock('../../../lib/auth/main', () => ({ accountRequest: vi.fn() }));
vi.mock('../services/store', () => ({ getOnboardingState: mocks.getState }));
vi.mock('../services/browser-mode', () => ({
  getBrowserNavigationMode: mocks.getMode,
}));
vi.mock('../services/browser-workspace', () => ({
  getWorkspace: mocks.getWorkspace,
  withMissionStagehand: mocks.withStagehand,
}));
vi.mock('../services/browser-navigation', () => ({
  createBrowserNavigationAdapter: mocks.createAdapter,
}));
vi.mock('../services/mission', () => ({
  runReadOnlyMission: mocks.runMission,
}));
vi.mock('../services/mission-navigation', () => ({
  createMissionNavigator: () => vi.fn(async () => undefined),
}));
vi.mock('../services/mission-request-guard', () => ({
  protectMissionPage: mocks.protect,
}));
vi.mock('../services/page-content', () => ({
  readPage: vi.fn(),
  revealCourseNavigation: vi.fn(),
}));
vi.mock('../services/page-readiness', () => ({
  waitForMissionPage: vi.fn(async () => undefined),
}));
vi.mock('../lib/preview-validation', () => ({
  validatePreviewCards: mocks.validateCards,
}));

afterEach(() => {
  resetPreview();
  vi.clearAllMocks();
});

it('uses the server-selected inout adapter for preview navigation and extraction', async () => {
  const page = {
    close: vi.fn(async () => undefined),
    url: vi.fn(async () => 'https://canvas.school.edu/courses'),
  };
  const connection = {
    id: 'connection-a',
    name: 'Canvas',
    host: 'canvas.school.edu',
    url: 'https://canvas.school.edu/courses',
    kind: 'canvas',
    status: 'verified',
    notes: null,
  };
  const choose = vi.fn(async () => ({ operation: 'DONE', target: null }));
  const extract = vi.fn(async () => ({ courses: [] }));
  mocks.getMode.mockResolvedValueOnce('inout');
  mocks.getState.mockReturnValue({
    settings: { consent: true, notes: '' },
    connections: [connection],
    primaryLms: connection.id,
  });
  mocks.getWorkspace.mockResolvedValue({
    cdpUrl: 'http://127.0.0.1:9222',
    browser: {
      context: {
        setDomainPolicy: vi.fn(async () => undefined),
        newPage: vi.fn(async () => page),
      },
    },
  });
  mocks.withStagehand.mockImplementationOnce(
    async (_workspace, _options, run) => run({ mission: true }),
  );
  mocks.protect.mockResolvedValueOnce(
    Object.assign(
      vi.fn(async () => undefined),
      {
        assertReadable: vi.fn(),
      },
    ),
  );
  mocks.createAdapter.mockReturnValueOnce({ choose, extract });
  mocks.runMission.mockImplementationOnce(async ({ choose: choosePage }) => {
    await choosePage([], []);
    return {
      snapshots: [{ links: [] }],
      evidence: [],
      outcome: 'complete',
    };
  });
  mocks.validateCards.mockReturnValueOnce([{ title: 'Biology 101' }]);
  mocks.run.mockImplementationOnce(async (_userId, task, signal) =>
    task(signal),
  );

  await startPreview('student-a', 'courses');
  await vi.waitFor(() =>
    expect(getPreview('student-a').status).toBe('complete'),
  );

  expect(mocks.createAdapter).toHaveBeenCalledWith(
    'inout',
    expect.objectContaining({ page, stagehand: { mission: true } }),
  );
  expect(choose).toHaveBeenCalledOnce();
  expect(extract).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'courses' }),
  );
});

it.each(['complete', 'failed', 'reset'] as const)(
  'releases browser ownership only after the %s preview task settles',
  async (outcome) => {
    let resolve!: () => void;
    let reject!: (cause: Error) => void;
    mocks.run.mockReturnValueOnce(
      new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
    );
    const release = vi.fn();
    await startPreview('student-a', 'courses', release);
    expect(release).not.toHaveBeenCalled();
    if (outcome === 'reset') resetPreview();
    expect(release).not.toHaveBeenCalled();
    if (outcome === 'failed') reject(new Error('Page unavailable'));
    else resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  },
);
