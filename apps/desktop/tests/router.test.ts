// @vitest-environment jsdom
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCurrentUser } from '../src/lib/auth/helpers';
import { routeTree } from '../src/route-tree.gen';
import type { CurrentUser } from '../src/features/onboarding/types';

vi.mock('../src/lib/auth/helpers', () => ({ getCurrentUser: vi.fn() }));

const unfinishedUser: CurrentUser = {
  id: 'student-a',
  name: 'Student',
  email: 'student@example.com',
  image: null,
  hasCompletedOnboarding: false,
};
const finishedUser: CurrentUser = {
  ...unfinishedUser,
  id: 'student-b',
  hasCompletedOnboarding: true,
};

const loadRoute = async (path: string, user: CurrentUser | null) => {
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: false,
  });
  await router.load();
  return router;
};

const allMatchesSucceeded = (router: Awaited<ReturnType<typeof loadRoute>>) =>
  router.state.matches.every((match) => match.status === 'success');

const matchedRouteIds = (router: Awaited<ReturnType<typeof loadRoute>>) =>
  router.state.matches.map((match) => match.routeId);

const nestedDashboardPaths = [
  '/dashboard/courses',
  '/dashboard/study',
  '/dashboard/planner',
  '/dashboard/connections',
  '/dashboard/settings',
];

beforeEach(() => vi.resetAllMocks());

describe('desktop route access', () => {
  it('shows sign-in to signed-out users', async () => {
    const router = await loadRoute('/auth', null);
    expect(router.state.location.pathname).toBe('/auth');
    expect(allMatchesSucceeded(router)).toBe(true);
  });

  it.each(['/', '/dashboard', '/onboarding', '/missing-page'])(
    'sends signed-out users from %s to sign-in',
    async (path) => {
      const router = await loadRoute(path, null);
      expect(router.state.location.pathname).toBe('/auth');
    },
  );

  it('resumes an unfinished account at onboarding on restart', async () => {
    const router = await loadRoute('/dashboard', unfinishedUser);
    expect(router.state.location.pathname).toBe('/onboarding');
    expect(allMatchesSucceeded(router)).toBe(true);
  });

  it.each(['/auth', '/'])(
    'sends unfinished accounts from %s to onboarding',
    async (path) => {
      const router = await loadRoute(path, unfinishedUser);
      expect(router.state.location.pathname).toBe('/onboarding');
    },
  );

  it('keeps finished accounts out of onboarding and sign-in', async () => {
    const fromOnboarding = await loadRoute('/onboarding', finishedUser);
    expect(fromOnboarding.state.location.pathname).toBe('/dashboard');
    const fromAuth = await loadRoute('/auth', finishedUser);
    expect(fromAuth.state.location.pathname).toBe('/dashboard');
  });

  it('opens the dashboard for a finished account', async () => {
    const router = await loadRoute('/dashboard', finishedUser);
    expect(router.state.location.pathname).toBe('/dashboard');
    expect(allMatchesSucceeded(router)).toBe(true);
  });

  it('redirects the root to the dashboard for a finished account', async () => {
    const router = await loadRoute('/', finishedUser);
    expect(router.state.location.pathname).toBe('/dashboard');
  });

  it('keeps unknown routes protected and shows not found only when authorized', async () => {
    const router = await loadRoute('/missing-page', finishedUser);
    expect(router.state.location.pathname).toBe('/missing-page');
    expect(
      router.state.matches.some(
        (match) => match.status === 'notFound' || match._notFound,
      ),
    ).toBe(true);
  });
});

describe('nested dashboard pages', () => {
  it.each(nestedDashboardPaths)(
    'sends signed-out users from %s to sign-in',
    async (path) => {
      const router = await loadRoute(path, null);
      expect(router.state.location.pathname).toBe('/auth');
    },
  );

  it.each(nestedDashboardPaths)(
    'sends unfinished accounts from %s to onboarding',
    async (path) => {
      const router = await loadRoute(path, unfinishedUser);
      expect(router.state.location.pathname).toBe('/onboarding');
    },
  );

  it.each(nestedDashboardPaths)(
    'opens %s for a finished account inside the shared layout',
    async (path) => {
      const router = await loadRoute(path, finishedUser);
      expect(router.state.location.pathname).toBe(path);
      expect(allMatchesSucceeded(router)).toBe(true);
      expect(matchedRouteIds(router)).toEqual(['__root__', '/dashboard', path]);
    },
  );

  it('matches the Today index only at the dashboard root', async () => {
    const index = await loadRoute('/dashboard', finishedUser);
    expect(matchedRouteIds(index)).toEqual([
      '__root__',
      '/dashboard',
      '/dashboard/',
    ]);
    const nested = await loadRoute('/dashboard/courses', finishedUser);
    expect(matchedRouteIds(nested)).not.toContain('/dashboard/');
  });
});
