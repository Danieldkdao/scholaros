// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Providers } from '../../../components/providers';
import { routeTree } from '../../../route-tree.gen';

vi.mock('../../../lib/auth/helpers', () => ({
  getCurrentUser: vi.fn(async () => ({
    id: 'student',
    name: 'Student',
    email: 'student@example.edu',
    image: null,
    hasCompletedOnboarding: true,
  })),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
  accountId: 'student',
  connections: [],
  settings: { consent: true },
  preferences: { backgroundSync: { status: 'off' } },
  discovery: {},
};

let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  window.scrollTo = () => undefined;
  window.scholar = {
    onAcademicReconnect: vi.fn(() => () => {}),
    getCurrentUser: vi.fn(async () => ({ id: 'student' })),
    getState: vi.fn(async () => state),
    onBackgroundSyncChange: vi.fn(() => () => {}),
    onConnectChange: vi.fn(() => () => {}),
    getConnectRun: vi.fn(async () => ({ status: 'idle', accountId: null })),
    suggestConnections: vi.fn(async () => null),
    previewResource: vi.fn(async () => null),
  } as unknown as typeof window.scholar;
  window.onAuthenticated = vi.fn(() => () => {});
  window.onUserUpdated = vi.fn(() => () => {});
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const open = async (path: string) => {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    isServer: false,
  });
  const node = document.createElement('div');
  document.body.append(node);
  const instance = createRoot(node);
  root = instance;
  await act(async () => {
    instance.render(
      createElement(Providers, null, createElement(RouterProvider, { router })),
    );
    await router.load();
  });
  await act(async () => {});
};

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
};

it('shows the connection activity panel on the add route', async () => {
  window.scholar.getConnectRun = vi.fn(async () => ({
    accountId: 'student',
    status: 'running' as const,
    awaiting: null,
    events: [],
    results: [],
  }));
  await open('/dashboard/connections/add');
  expect(
    document.querySelector('[aria-label="Connection activity"]'),
  ).toBeTruthy();
});

it('opens the manual picker on the add route', async () => {
  await open('/dashboard/connections/add');
  expect(document.body.textContent).toContain('Add New Connection');
  expect(document.body.textContent).toContain(
    'Find your school or a learning service',
  );
  expect(document.body.textContent).not.toContain(
    'What would you like to connect?',
  );
});

it('links back to the connections list through a breadcrumb trail', async () => {
  await open('/dashboard/connections/add');
  const trail = document.querySelector('[data-slot="breadcrumb"]')!;
  expect(trail.getAttribute('aria-label')).toBe('breadcrumb');
  const back = [...trail.querySelectorAll('a')].find(
    (anchor) =>
      anchor.getAttribute('href')?.split('?')[0] === '/dashboard/connections',
  )!;
  expect(back.textContent).toBe('Connections');
  // The list requires every filter, so the trail links to its catch-all state.
  expect(back.getAttribute('href')).toContain('status=all');
  expect(back.getAttribute('href')).toContain('kind=all');
  const current = trail.querySelector('[data-slot="breadcrumb-page"]');
  expect(current?.textContent).toBe('Add New Connection');
  expect(current?.getAttribute('aria-current')).toBe('page');
  // Only the ancestor is clickable; the page they landed on is not.
  expect(trail.querySelectorAll('a')).toHaveLength(1);
  expect(document.querySelector('h1')?.textContent).toBe('Add New Connection');
});
it('switches the add route to the agent finder', async () => {
  await open('/dashboard/connections/add');
  const trigger = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Auto'),
  )!;
  await click(trigger);
  expect(document.querySelector('textarea#connection-request')).not.toBeNull();
});
