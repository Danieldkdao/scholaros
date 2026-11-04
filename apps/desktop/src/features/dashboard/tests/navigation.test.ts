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
    ['context', '/dashboard/context'],
    ['connections', '/dashboard/connections'],
    ['settings', '/dashboard/settings'],
  ] as const)('routes %s to %s', (page, path) => {
    expect(dashboardPagePath(page)).toBe(path);
  });

  it.each([
    ['/dashboard', 'today'],
    ['/dashboard/courses', 'courses'],
    ['/dashboard/study', 'study'],
    ['/dashboard/context', 'context'],
    ['/dashboard/connections', 'connections'],
    ['/dashboard/settings', 'settings'],
  ] as const)('reads %s as the %s page', (pathname, page) => {
    expect(dashboardPageForPath(pathname)).toBe(page);
  });

  it('claims no page for another route', () => {
    expect(dashboardPageForPath('/onboarding')).toBeNull();
    expect(dashboardPageForPath('/auth')).toBeNull();
    expect(dashboardPageForPath('/dashboard/unknown')).toBeNull();
    expect(dashboardPageForPath('/dashboard/planner')).toBeNull();
  });
});

describe('sidebar navigation', () => {
  it('replaces Planner with Context in the sidebar', () => {
    expect(dashboardNavigation).toContain('context');
    expect(dashboardNavigation).not.toContain('planner');
    expect(dashboardNavigation).not.toContain('settings');
    expect(dashboardPages).not.toContain('planner');
    expect(dashboardPages).toContain('settings');
  });

  it('links each navigation entry to its own page', () => {
    for (const page of dashboardNavigation)
      expect(dashboardPageForPath(dashboardPagePath(page))).toBe(page);
  });
});
