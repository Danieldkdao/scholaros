import { describe, expect, it } from 'vitest';
import {
  dashboardNavigation,
  dashboardPageForPath,
  dashboardPagePath,
  dashboardPages,
} from '../lib/navigation';
import { formatDashboardPage } from '../lib/formatters';

describe('dashboard pages', () => {
  it('gives every page a title and an icon', () => {
    for (const page of dashboardPages) {
      const formatted = formatDashboardPage(page);
      expect(formatted.title.length).toBeGreaterThan(0);
      expect(formatted.Icon).toBeTruthy();
    }
  });

  it.each([
    ['today', '/dashboard'],
    ['courses', '/dashboard/courses'],
    ['study', '/dashboard/study'],
    ['planner', '/dashboard/planner'],
    ['connections', '/dashboard/connections'],
    ['settings', '/dashboard/settings'],
  ] as const)('routes %s to %s', (page, path) => {
    expect(dashboardPagePath(page)).toBe(path);
  });

  it.each([
    ['/dashboard', 'today'],
    ['/dashboard/courses', 'courses'],
    ['/dashboard/study', 'study'],
    ['/dashboard/planner', 'planner'],
    ['/dashboard/connections', 'connections'],
    ['/dashboard/settings', 'settings'],
  ] as const)('reads %s as the %s page', (pathname, page) => {
    expect(dashboardPageForPath(pathname)).toBe(page);
  });

  it('claims no page for another route', () => {
    expect(dashboardPageForPath('/onboarding')).toBeNull();
    expect(dashboardPageForPath('/auth')).toBeNull();
    expect(dashboardPageForPath('/dashboard/unknown')).toBeNull();
  });
});

describe('sidebar navigation', () => {
  it('leaves Settings to the profile menu', () => {
    expect(dashboardNavigation).not.toContain('settings');
    expect(dashboardPages).toContain('settings');
  });

  it('links each navigation entry to its own page', () => {
    for (const page of dashboardNavigation)
      expect(dashboardPageForPath(dashboardPagePath(page))).toBe(page);
  });
});
