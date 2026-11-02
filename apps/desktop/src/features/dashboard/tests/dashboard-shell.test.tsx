// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../../components/providers';
import { getCurrentUser } from '../../../lib/auth/helpers';
import { routeTree } from '../../../route-tree.gen';
import type { CurrentUser } from '../../onboarding/types';

vi.mock('../../../lib/auth/helpers', () => ({ getCurrentUser: vi.fn() }));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const installDomStubs = () => {
  globalThis.ResizeObserver ??=
    ResizeObserverStub as unknown as typeof ResizeObserver;
  // jsdom reports a media query list without the legacy listener next-themes uses.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  window.scrollTo = () => undefined;
};

const finishedUser: CurrentUser = {
  id: 'student-a',
  name: 'Ada Lovelace',
  email: 'ada@example.edu',
  image: null,
  hasCompletedOnboarding: true,
};

const bridge = {
  getCurrentUser: vi.fn(),
  getState: vi.fn(async () => ({
    accountId: 'student-a',
    connections: [],
    settings: { decisionTimeSeconds: 1, blockedWords: [] },
    discovery: {},
    preferences: {},
  })),
  getWatchSettings: vi.fn(async () => ({ watchEnabled: false, watchUrls: [] })),
  getWatchRuntimeState: vi.fn(async () => ({ enabled: false, status: 'off' })),
  saveWatchSettings: vi.fn(async (settings) => settings),
  onWatchChange: vi.fn(() => () => undefined),
  onCoursesChange: vi.fn(() => () => undefined),
  onBackgroundSyncChange: vi.fn(() => () => undefined),
  onConnectChange: vi.fn(() => () => undefined),
  getConnectRun: vi.fn(async () => ({ status: 'idle', accountId: null })),
  signOut: vi.fn(async () => undefined),
} as unknown as typeof window.scholar;

const buildRouter = (path: string) =>
  createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: false,
  });

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
let activeRouter: ReturnType<typeof buildRouter> | undefined;

const openRoute = async (path: string) => {
  installDomStubs();
  const router = buildRouter(path);
  activeRouter = router;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(Providers, null, createElement(RouterProvider, { router })),
    );
  });
  await act(async () => {
    await router.load();
  });
  return router;
};

const navigate = async (path: string) => {
  await act(async () => {
    await activeRouter?.navigate({ to: path });
  });
};

const heading = () => document.querySelector('h1');

const pageRegion = () => heading()?.parentElement;

const navLinks = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-content"] a'),
];

const currentNavLink = () =>
  navLinks().find((link) => link.getAttribute('aria-current') === 'page');

const dispatchPointerClick = async (element: Element) => {
  await act(async () => {
    for (const type of [
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'click',
    ])
      element.dispatchEvent(
        type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles: true, cancelable: true })
          : new MouseEvent(type, { bubbles: true, cancelable: true }),
      );
  });
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCurrentUser).mockResolvedValue(finishedUser);
  bridge.getCurrentUser = vi.fn(async () => finishedUser);
  bridge.signOut = vi.fn(async () => undefined);
  window.scholar = bridge;
  window.onAuthenticated = vi.fn(() => () => undefined);
  window.onUserUpdated = vi.fn(() => () => undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  activeRouter = undefined;
  document.body.replaceChildren();
});

describe('dashboard shell', () => {
  it('renders Today at the dashboard index', async () => {
    await openRoute('/dashboard');
    expect(heading()?.textContent).toBe('Today');
  });

  it.each([
    ['/dashboard/courses', 'Courses'],
    ['/dashboard/study', 'Study'],
    ['/dashboard/planner', 'Planner'],
    ['/dashboard/connections', 'Connections'],
    ['/dashboard/settings', 'Settings'],
  ])('renders %s as a refreshed deep link', async (path, title) => {
    await openRoute(path);
    expect(heading()?.textContent).toBe(title);
  });

  it('focuses the watcher section after loading its settings deep link', async () => {
    await openRoute('/dashboard/settings?section=watch');
    const section = await vi.waitFor(() => {
      const target = document.querySelector('#watch-course-pages');
      expect(target).toBeTruthy();
      return target;
    });
    expect(document.activeElement).toBe(section);
  });

  it.each([
    ['/dashboard/courses', 'Courses'],
    ['/dashboard/study', 'Study'],
    ['/dashboard/planner', 'Planner'],
    ['/dashboard/connections', 'Connections'],
  ])('opens %s from its sidebar link', async (path, title) => {
    await openRoute('/dashboard');
    const link = navLinks().find(
      (element) => element.getAttribute('href') === path,
    );
    expect(link, `missing a sidebar link to ${path}`).toBeTruthy();
    await dispatchPointerClick(link!);
    expect(activeRouter?.state.location.pathname).toBe(path);
    expect(heading()?.textContent).toBe(title);
  });

  it('keeps the shell mounted while navigating between pages', async () => {
    await openRoute('/dashboard');
    const shell = document.querySelector('[data-slot="sidebar-wrapper"]');
    expect(shell).toBeTruthy();
    await navigate('/dashboard/planner');
    expect(document.querySelector('[data-slot="sidebar-wrapper"]')).toBe(shell);
  });

  it('marks only the open page as current', async () => {
    await openRoute('/dashboard/courses');
    expect(currentNavLink()?.getAttribute('href')).toBe('/dashboard/courses');
    expect(
      navLinks().filter((link) => link.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
  });

  it('stops marking Today as current on a nested page', async () => {
    await openRoute('/dashboard');
    expect(currentNavLink()?.getAttribute('href')).toBe('/dashboard');
    await navigate('/dashboard/settings');
    expect(currentNavLink()).toBeUndefined();
  });

  it('keeps the branding link out of the current page on nested pages', async () => {
    await openRoute('/dashboard/planner');
    const brand = document.querySelector('[data-slot="sidebar-header"] a');
    expect(brand).toBeTruthy();
    expect(brand?.getAttribute('aria-current')).toBeNull();
  });

  it('keeps the header to the sidebar toggle and theme control', async () => {
    await openRoute('/dashboard/planner');
    const header = document.querySelector('[data-slot="dashboard-header"]');
    expect(header?.querySelector('[data-slot="sidebar-trigger"]')).toBeTruthy();
    expect(header?.querySelector('button[aria-haspopup="menu"]')).toBeTruthy();
    expect(heading()?.textContent).toBe('Planner');
  });

  it('keeps every page body down to its title', async () => {
    // Only the remaining placeholder pages have no content beyond their title.
    for (const path of [
      '/dashboard',
      '/dashboard/study',
      '/dashboard/planner',
    ]) {
      await openRoute(path);
      expect(pageRegion()?.children).toHaveLength(1);
      expect(pageRegion()?.textContent?.trim()).toBe(heading()?.textContent);
      act(() => root?.unmount());
      document.body.replaceChildren();
    }
  });

  it('leaves the retired setup and discovery content out of the shell', async () => {
    await openRoute('/dashboard');
    for (const retired of [
      'Academic resources',
      'Course map',
      'This computer is ready',
      'Exit and sign out',
    ])
      expect(document.body.textContent).not.toContain(retired);
  });

  it('keeps connection activity off the rest of the dashboard', async () => {
    const previous = bridge.getConnectRun;
    bridge.getConnectRun = vi.fn(async () => ({
      accountId: 'student-a',
      status: 'running' as const,
      awaiting: null,
      events: [],
      results: [],
    }));
    await openRoute('/dashboard');
    expect(
      document.querySelector('[aria-label="Connection activity"]'),
    ).toBeNull();
    bridge.getConnectRun = previous;
  });

  it('collapses and expands the sidebar from the header toggle', async () => {
    await openRoute('/dashboard');
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');
    await dispatchPointerClick(
      document.querySelector('[data-slot="sidebar-trigger"]')!,
    );
    expect(sidebar?.getAttribute('data-state')).toBe('collapsed');
    await dispatchPointerClick(
      document.querySelector('[data-slot="sidebar-trigger"]')!,
    );
    expect(sidebar?.getAttribute('data-state')).toBe('expanded');
  });
});

describe('account outage screen', () => {
  it('states which service could not be reached', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(
      new Error(
        "Error invoking remote method 'scholar:getCurrentUser': Error: ScholarOS could not reach its services at http://localhost:3000.",
      ),
    );
    await openRoute('/dashboard');
    expect(document.body.textContent).toContain(
      'ScholarOS could not reach its services at http://localhost:3000.',
    );
    expect(document.body.textContent).not.toContain(
      'Error invoking remote method',
    );
  });

  it('recovers to the shell once the account service answers again', async () => {
    let offline = true;
    vi.mocked(getCurrentUser).mockImplementation(async () => {
      if (offline)
        throw new Error(
          "Error invoking remote method 'scholar:getCurrentUser': Error: ScholarOS could not reach its services at http://localhost:3000.",
        );
      return finishedUser;
    });
    await openRoute('/dashboard');
    expect(document.body.textContent).toContain('This screen could not load');
    offline = false;
    await dispatchPointerClick(
      [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Try again'),
      )!,
    );
    // The reload settles after several awaited passes, so wait on the screen
    // rather than guessing a duration.
    await act(async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (heading()?.textContent === 'Today') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    });
    expect(heading()?.textContent).toBe('Today');
  });
});
