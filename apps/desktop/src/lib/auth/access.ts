import { getCurrentUser } from './helpers';

export const routeGroups = ['auth', 'onboarding', 'dashboard'] as const;
export type RouteGroup = (typeof routeGroups)[number];
export type RouteAccess =
  | { authorized: true }
  | { authorized: false; route: '/auth' | '/onboarding' | '/dashboard' };

export const routeGroupForPath = (pathname: string): RouteGroup => {
  if (pathname === '/auth') return 'auth';
  if (pathname === '/onboarding') return 'onboarding';
  // Unknown application paths stay protected until a route claims them.
  return 'dashboard';
};

export const authorizeRoute = async (
  group: RouteGroup,
): Promise<RouteAccess> => {
  const user = await getCurrentUser();
  if (!user) {
    return group === 'auth'
      ? { authorized: true as const }
      : { authorized: false as const, route: '/auth' };
  }
  if (!user.hasCompletedOnboarding) {
    return group === 'onboarding'
      ? { authorized: true as const }
      : { authorized: false as const, route: '/onboarding' };
  }
  return group === 'dashboard'
    ? { authorized: true as const }
    : { authorized: false as const, route: '/dashboard' };
};

export const isPublicDemoPath = (pathname: string) => pathname === '/demo';

export const authorizePath = async (pathname: string): Promise<RouteAccess> =>
  isPublicDemoPath(pathname)
    ? { authorized: true }
    : authorizeRoute(routeGroupForPath(pathname));
