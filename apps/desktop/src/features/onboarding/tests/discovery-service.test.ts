import { beforeEach, expect, it, vi } from 'vitest';
import { discoverAcademicContext } from '../services/discovery';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  apply: vi.fn(),
  running: vi.fn(),
  ready: vi.fn(),
  read: vi.fn(),
  order: [] as string[],
  page: {
    goto: vi.fn(),
    close: vi.fn(),
    url: vi.fn(async () => 'https://school.example/'),
  },
  policy: vi.fn(),
}));
vi.mock('../services/store', () => ({
  getOnboardingState: mocks.getState,
  applyAcademicDiscovery: mocks.apply,
  markAcademicDiscoveryRunning: mocks.running,
}));
vi.mock('../services/browser-workspace', () => ({
  getWorkspace: async () => ({
    browser: {
      context: {
        setDomainPolicy: mocks.policy,
        newPage: async () => mocks.page,
      },
    },
    cdpUrl: 'http://127.0.0.1:9222',
  }),
}));
vi.mock('../services/mission-request-guard', () => ({
  protectMissionPage: async () => async () => undefined,
}));
vi.mock('../services/page-content', () => ({
  readPage: mocks.read,
  revealCourseNavigation: async () => 'not-found',
}));
vi.mock('../services/page-readiness', () => ({
  waitForMissionPage: mocks.ready,
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: async () => ({ courses: [] }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.policy.mockResolvedValue(undefined);
  mocks.page.close.mockResolvedValue(undefined);
  mocks.page.goto.mockResolvedValue(undefined);
  mocks.getState.mockReturnValue({
    settings: { consent: true, notes: '' },
    workspace: { ready: true },
    connections: [
      {
        id: 'a',
        host: 'school.example',
        url: 'https://school.example/',
        kind: 'resource',
        status: 'confirmed',
      },
      {
        id: 'b',
        host: 'other.example',
        url: 'https://other.example/',
        kind: 'resource',
        status: 'needs-sign-in',
      },
    ],
  });
  mocks.ready.mockImplementation(async () => {
    mocks.order.push('ready');
  });
  mocks.read.mockImplementation(async () => {
    mocks.order.push('read');
    return {
      url: 'https://school.example/',
      title: 'Courses',
      text: 'No courses enrolled.',
      links: [],
      password: false,
    };
  });
});
it('waits for content before reading every discovery snapshot', async () => {
  await discoverAcademicContext('student');
  expect(mocks.ready).toHaveBeenCalled();
  expect(mocks.order.indexOf('ready')).toBeLessThan(
    mocks.order.indexOf('read'),
  );
});
it('includes connections needing sign-in in coverage', async () => {
  await discoverAcademicContext('student');
  expect(mocks.apply.mock.calls.at(-1)?.[1]).toContainEqual(
    expect.objectContaining({ connectionId: 'b', outcome: 'needs-sign-in' }),
  );
});
it('records cancellation instead of leaving discovery running', async () => {
  const controller = new AbortController();
  mocks.read.mockImplementation(async () => {
    controller.abort();
    return {
      url: 'https://school.example/',
      title: 'Courses',
      text: '',
      links: [],
    };
  });
  await expect(
    discoverAcademicContext('student', () => true, controller.signal),
  ).rejects.toThrow();
  expect(mocks.apply).toHaveBeenCalledWith('student', expect.any(Array), {
    cancelled: true,
  });
});

vi.mock('../services/mission-navigation', () => ({
  createMissionNavigator: () => async () => undefined,
}));
