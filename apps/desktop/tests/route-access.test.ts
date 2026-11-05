import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeRoute,
  authorizePath,
  routeGroupForPath,
} from '../src/lib/auth/access';
import { getCurrentUser } from '../src/lib/auth/helpers';

vi.mock('../src/lib/auth/helpers', () => ({ getCurrentUser: vi.fn() }));
const user = {
  id: 'student-a',
  name: 'Student',
  email: 'student@example.com',
  image: null,
  hasCompletedOnboarding: false,
};
beforeEach(() => vi.resetAllMocks());
describe('route groups', () => {
  it.each([
    ['/auth', 'auth'],
    ['/onboarding', 'onboarding'],
    ['/dashboard', 'dashboard'],
    ['/dashboard/courses', 'dashboard'],
    ['/dashboard/study', 'dashboard'],
    ['/dashboard/planner', 'dashboard'],
    ['/dashboard/connections', 'dashboard'],
    ['/dashboard/settings', 'dashboard'],
    ['/', 'dashboard'],
    ['/missing-page', 'dashboard'],
  ] as const)('treats %s as the %s group', (pathname, group) => {
    expect(routeGroupForPath(pathname)).toBe(group);
  });
});
describe('central route access', () => {
  it.each(['onboarding', 'dashboard'] as const)(
    'redirects signed-out users from %s',
    async (group) => {
      vi.mocked(getCurrentUser).mockResolvedValue(null);
      expect(await authorizeRoute(group)).toEqual({
        authorized: false,
        route: '/auth',
      });
    },
  );
  it('allows signed-out auth access', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    expect(await authorizeRoute('auth')).toEqual({ authorized: true });
  });
  it.each(['auth', 'dashboard'] as const)(
    'requires onboarding before %s',
    async (group) => {
      vi.mocked(getCurrentUser).mockResolvedValue(user);
      expect(await authorizeRoute(group)).toEqual({
        authorized: false,
        route: '/onboarding',
      });
    },
  );
  it('allows unfinished onboarding', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(user);
    expect(await authorizeRoute('onboarding')).toEqual({ authorized: true });
  });
  it.each(['auth', 'onboarding'] as const)(
    'keeps completed users out of %s',
    async (group) => {
      vi.mocked(getCurrentUser).mockResolvedValue({
        ...user,
        hasCompletedOnboarding: true,
      });
      expect(await authorizeRoute(group)).toEqual({
        authorized: false,
        route: '/dashboard',
      });
    },
  );
  it('allows completed dashboard access', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({
      ...user,
      hasCompletedOnboarding: true,
    });
    expect(await authorizeRoute('dashboard')).toEqual({ authorized: true });
  });
  it('does not treat account-service failure as a signed-out session', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('Unavailable'));
    await expect(authorizeRoute('dashboard')).rejects.toThrow('Unavailable');
  });
});

describe('public guest demo boundary', () => {
  it('opens the exact guest demo without reading credentials', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(
      new Error('Secure storage unavailable'),
    );
    expect(await authorizePath('/demo')).toEqual({ authorized: true });
    expect(getCurrentUser).not.toHaveBeenCalled();
  });
  it.each([
    '/demo/private',
    '/demonstration',
    '/dashboard',
    '/study/session-1',
  ])('keeps %s protected', async (pathname) => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    expect(await authorizePath(pathname)).toEqual({
      authorized: false,
      route: '/auth',
    });
    expect(getCurrentUser).toHaveBeenCalledOnce();
  });
});
