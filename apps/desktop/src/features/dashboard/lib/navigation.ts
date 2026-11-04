export const dashboardPages = [
  'today',
  'courses',
  'study',
  'context',
  'connections',
  'settings',
] as const;

export type DashboardPage = (typeof dashboardPages)[number];

// Settings belongs to the profile menu, so the sidebar lists the study pages.
export const dashboardNavigation = [
  'today',
  'courses',
  'study',
  'context',
  'connections',
] as const;

export type DashboardRoutePath =
  | '/dashboard'
  | '/dashboard/courses'
  | '/dashboard/study'
  | '/dashboard/context'
  | '/dashboard/connections'
  | '/dashboard/settings';

export const dashboardPagePath = (page: DashboardPage): DashboardRoutePath => {
  switch (page) {
    case 'today':
      return '/dashboard';
    case 'courses':
      return '/dashboard/courses';
    case 'study':
      return '/dashboard/study';
    case 'context':
      return '/dashboard/context';
    case 'connections':
      return '/dashboard/connections';
    case 'settings':
      return '/dashboard/settings';
  }
};

export const dashboardPageForPath = (pathname: string): DashboardPage | null =>
  dashboardPages.find((page) => dashboardPagePath(page) === pathname) ?? null;
