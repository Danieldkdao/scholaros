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
const connections = [
  {
    id: 'a',
    name: 'Canvas',
    host: 'school.edu',
    url: 'https://school.edu',
    kind: 'canvas',
    status: 'verified',
    verifiedAt: null,
    notes: 'Biology lab',
    favicon: 'data:image/png;base64,icon',
  },
  {
    id: 'b',
    name: 'Books',
    host: 'books.edu',
    url: 'https://books.edu',
    kind: 'resource',
    status: 'needs-sign-in',
    verifiedAt: null,
    notes: null,
    favicon: null,
  },
];
let root: ReturnType<typeof createRoot>;
const state = {
  accountId: 'student',
  connections,
  settings: { consent: true },
  preferences: { backgroundSync: { status: 'off' } },
  discovery: {},
};
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
  // Base UI popovers take pointer capture, which jsdom does not implement.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  window.scrollTo = () => undefined;
  window.scholar = {
    getCurrentUser: vi.fn(async () => ({ id: 'student' })),
    getState: vi.fn(async () => state),
    onBackgroundSyncChange: vi.fn(() => () => {}),
    onConnectChange: vi.fn(() => () => {}),
    getConnectRun: vi.fn(async () => ({ status: 'idle', accountId: null })),
    confirmResource: vi.fn(async () => state),
    removeResource: vi.fn(async () => ({
      ...state,
      connections: [connections[1]],
    })),
    saveConnectionNotes: vi.fn(async () => state),
  } as unknown as typeof window.scholar;
  window.onAuthenticated = vi.fn(() => () => {});
  window.onUserUpdated = vi.fn(() => () => {});
});
afterEach(() => {
  act(() => root?.unmount());
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
  root = createRoot(node);
  await act(async () => {
    root.render(
      createElement(Providers, null, createElement(RouterProvider, { router })),
    );
    await router.load();
  });
  await act(async () => {});
  return router;
};
const click = async (element: Element) => {
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

it('restores URL filters and displays matching connections with add controls', async () => {
  await open('/dashboard/connections?q=biology&status=verified');
  expect(document.body.textContent).toContain('Canvas');
  expect(document.body.textContent).toContain('school.edu');
  expect(document.body.textContent).not.toContain('books.edu');
  const addLink = document.querySelector(
    'a[href="/dashboard/connections/add"]',
  );
  expect(addLink?.textContent).toContain('New Connection');
  expect(document.body.textContent).not.toContain(
    'Find your school or a learning service',
  );
  expect(
    document
      .querySelector('a[href="/dashboard/connections"]')
      ?.getAttribute('aria-current'),
  ).toBe('page');
});
it('shows the restored filters inside the filter popover', async () => {
  await open('/dashboard/connections?status=needs-sign-in&kind=resource');
  await click(
    document.querySelector('button[aria-label="Connection filters"]')!,
  );
  const values = [...document.querySelectorAll('[data-slot="select-value"]')];
  expect(values.map((value) => value.textContent)).toEqual([
    'Needs confirmation',
    'Academic resource',
  ]);
});

it('writes the search to the address bar only after typing pauses', async () => {
  const router = await open('/dashboard/connections');
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder^="Search connections"]',
  )!;
  const type = (value: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await type('bi');
  await type('bio');
  expect(input.value).toBe('bio');
  // Both keystrokes land inside the pause, so the address is still untouched.
  expect(router.state.location.search.q).toBe('');
  await act(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (router.state.location.search.q === 'bio') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
  expect(router.state.location.search.q).toBe('bio');
});

it('shows the stored site icon and falls back to a globe', async () => {
  await open('/dashboard/connections');
  const card = (name: string) =>
    [...document.querySelectorAll('[data-slot="connection-card"]')].find(
      (item) => item.textContent?.includes(name),
    )!;
  expect(card('Canvas').querySelector('img')?.getAttribute('src')).toBe(
    'data:image/png;base64,icon',
  );
  const fallback = card('Books').querySelector('img');
  expect(fallback).toBeNull();
  expect(card('Books').querySelector('svg.lucide-globe')).toBeTruthy();
});

it('offers confirmation for connections needing sign in', async () => {
  await open('/dashboard/connections');
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('I’m signed in'),
  )!;
  await act(async () => button.click());
  expect(window.scholar.confirmResource).toHaveBeenCalledWith('b');
});

it('asks before removing a connection and updates the list after confirmation', async () => {
  await open('/dashboard/connections');
  const remove = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove Canvas"]',
  )!;
  await act(async () => remove.click());
  expect(window.scholar.removeResource).not.toHaveBeenCalled();
  const confirm = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Remove',
  )!;
  await act(async () => confirm.click());
  expect(window.scholar.removeResource).toHaveBeenCalledWith('a');
  expect(document.body.textContent).not.toContain('school.edu');
});

it('refreshes saved connections when the active connection run completes', async () => {
  let publish!: (state: unknown) => void;
  window.scholar.onConnectChange = vi.fn((listener) => {
    publish = listener as (state: unknown) => void;
    return () => {};
  });
  await open('/dashboard/connections');
  const refreshed = {
    ...state,
    connections: [
      ...connections,
      {
        id: 'c',
        name: 'New library',
        host: 'library.edu',
        url: 'https://library.edu/',
        kind: 'resource',
        status: 'confirmed',
        verifiedAt: null,
        notes: null,
      },
    ],
  };
  vi.mocked(window.scholar.getState).mockResolvedValue(refreshed as never);
  await act(async () =>
    publish({
      accountId: 'student',
      status: 'complete',
      events: [],
      awaiting: null,
      results: [],
    }),
  );
  expect(document.body.textContent).toContain('library.edu');
});
