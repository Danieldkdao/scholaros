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
import type { CourseDetail } from '../types';

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

const course = (overrides: Partial<CourseDetail> = {}): CourseDetail => ({
  id: 'course-1',
  name: 'Biology 101',
  code: 'BIOL 101',
  term: 'Fall 2026',
  url: 'https://canvas.school.edu/courses/1',
  active: true,
  sourceName: 'Canvas',
  sourceHost: 'canvas.school.edu',
  sourceState: 'connected',
  lastSeenAt: '2026-03-08T09:00:00.000Z',
  overviewSyncedAt: '2026-03-08T09:00:00.000Z',
  instructor: null,
  description: null,
  announcementCount: 0,
  assignmentCount: 0,
  announcementsStatus: 'complete',
  announcementsSyncedAt: '2026-03-08T09:00:00.000Z',
  assignmentsStatus: 'complete',
  assignmentsSyncedAt: '2026-03-08T09:00:00.000Z',
  announcements: [],
  assignments: [],
  ...overrides,
});

const child = (
  id: string,
  overrides: Partial<CourseDetail['announcements'][number]> = {},
) => ({
  id,
  title: `Item ${id}`,
  body: null,
  dateValue: null,
  dateText: null,
  url: 'https://canvas.school.edu/courses/1',
  active: true,
  lastSeenAt: '2026-03-08T09:00:00.000Z',
  ...overrides,
});

let detail: CourseDetail | null = course();
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  detail = course();
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
    getCurrentUser: vi.fn(async () => ({ id: 'student' })),
    getState: vi.fn(async () => ({
      accountId: 'student',
      connections: [],
      settings: { consent: true },
      preferences: { backgroundSync: { status: 'off' } },
      discovery: {},
    })),
    onBackgroundSyncChange: vi.fn(() => () => {}),
    onConnectChange: vi.fn(() => () => {}),
    getConnectRun: vi.fn(async () => ({ status: 'idle', accountId: null })),
    getCourses: vi.fn(async () => ({
      courses: [],
      sources: [],
      lastSuccessfulAt: null,
    })),
    getCourse: vi.fn(async () => detail),
    openSource: vi.fn(async () => undefined),
  } as unknown as typeof window.scholar;
  window.onAuthenticated = vi.fn(() => () => {});
  window.onUserUpdated = vi.fn(() => () => {});
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const open = async (path = '/dashboard/courses/course-1') => {
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

const text = () => document.body.textContent ?? '';
const tab = (label: string) =>
  [...document.querySelectorAll('[role="tab"]')].find((item) =>
    item.textContent?.includes(label),
  )!;
const openTab = async (label: string) => {
  await click(tab(label));
  await act(async () => {});
};

it('reads the course from the address bar and offers a way back', async () => {
  await open();
  expect(window.scholar.getCourse).toHaveBeenCalledWith('course-1');
  expect(text()).toContain('Biology 101');
  expect(document.querySelector('a[href="/dashboard/courses"]')).not.toBeNull();
});

it('shows the three tabs with the overview first', async () => {
  await open();
  expect(
    [...document.querySelectorAll('[role="tab"]')].map((item) =>
      item.textContent?.trim(),
    ),
  ).toEqual(['Overview', 'Announcements', 'Assignments']);
  expect(tab('Overview').getAttribute('aria-selected')).toBe('true');
  await openTab('Assignments');
  expect(tab('Assignments').getAttribute('aria-selected')).toBe('true');
});

it('shows only the overview fields the source really provided', async () => {
  detail = course({ description: 'Cells and systems' });
  await open();
  expect(text()).toContain('BIOL 101');
  expect(text()).toContain('Fall 2026');
  expect(text()).toContain('Cells and systems');
  expect(text()).not.toContain('Instructor');
});

it('never renders a label for a field it does not have', async () => {
  detail = course({ code: null, term: null });
  await open();
  expect(text()).not.toContain('Code');
  expect(text()).not.toContain('Term');
  expect(text()).toContain('Canvas');
});

it('says when the course page itself was never read', async () => {
  detail = course({ overviewSyncedAt: null });
  await open();
  expect(text()).toContain('Not read yet');
});

it('labels a source the student removed and offers no way to open it', async () => {
  detail = course({ sourceState: 'removed' });
  await open();
  expect(text()).toContain('Source removed');
  expect(document.querySelector('button[aria-label="Open source"]')).toBeNull();
});

it('labels a source the student stopped selecting', async () => {
  detail = course({ sourceState: 'unmarked' });
  await open();
  expect(text()).toContain('No longer selected');
});

it('opens the course at its source through the guarded bridge', async () => {
  await open();
  await click(document.querySelector('button[aria-label="Open source"]')!);
  expect(window.scholar.openSource).toHaveBeenCalledWith(
    'https://canvas.school.edu/courses/1',
  );
});

it('lists announcements newest first with the date the source gave', async () => {
  detail = course({
    announcements: [
      child('a', { title: 'Older', dateValue: '2026-01-04' }),
      child('b', { title: 'Newer', dateValue: '2026-03-05' }),
      child('c', { title: 'Undated' }),
    ],
  });
  await open();
  await openTab('Announcements');
  const titles = [
    ...document.querySelectorAll('[data-slot="announcements-card"]'),
  ].map((card) => card.querySelector('p')?.textContent);
  expect(titles).toEqual(['Newer', 'Older', 'Undated']);
  expect(text()).toContain('Mar 5, 2026');
});

it('shows a timestamp with its time and marks a due date that passed', async () => {
  detail = course({
    assignments: [
      child('a', { title: 'Done', dateValue: '2026-01-04T09:00:00Z' }),
      child('b', { title: 'Upcoming', dateValue: '2099-01-04' }),
    ],
  });
  await open();
  await openTab('Assignments');
  const cards = [
    ...document.querySelectorAll('[data-slot="assignments-card"]'),
  ];
  expect(cards.map((card) => card.querySelector('p')?.textContent)).toEqual([
    'Done',
    'Upcoming',
  ]);
  expect(cards[0]?.textContent).toContain('Past due');
  expect(cards[1]?.textContent).not.toContain('Past due');
});

it('keeps the source wording for a date it could not place', async () => {
  detail = course({
    assignments: [child('a', { title: 'Essay', dateText: 'Due Friday' })],
  });
  await open();
  await openTab('Assignments');
  expect(text()).toContain('Due Friday');
});

it('gives every collection state its own wording', async () => {
  const wording = async (overrides: Partial<CourseDetail>) => {
    detail = course(overrides);
    await open();
    await openTab('Announcements');
    const notice = document
      .querySelector('[role="tabpanel"]')
      ?.textContent?.trim();
    act(() => root?.unmount());
    document.body.replaceChildren();
    return notice;
  };
  const pending = await wording({
    announcementsStatus: 'pending',
    announcementsSyncedAt: null,
  });
  const empty = await wording({ announcementsStatus: 'complete' });
  const partial = await wording({ announcementsStatus: 'partial' });
  const blocked = await wording({ announcementsStatus: 'blocked' });
  const signIn = await wording({ announcementsStatus: 'needs-sign-in' });
  const cancelled = await wording({ announcementsStatus: 'cancelled' });
  expect(
    new Set([pending, empty, partial, blocked, signIn, cancelled]).size,
  ).toBe(6);
  expect(empty).toContain('No announcements found');
});

it('keeps saved announcements visible after their refresh fails', async () => {
  detail = course({
    announcementsStatus: 'blocked',
    announcementsSyncedAt: '2026-02-01T09:00:00.000Z',
    announcements: [child('a', { title: 'Still here' })],
  });
  await open();
  await openTab('Announcements');
  expect(text()).toContain('Still here');
  expect(text()).not.toContain('Not found');
  expect(text()).toContain('Updated');
});

it('explains a missing course without saying whether it exists elsewhere', async () => {
  detail = null;
  await open();
  expect(text()).toContain('This course is not available.');
  expect(document.querySelector('[role="tablist"]')).toBeNull();
});

it('offers a retry when the course could not be loaded', async () => {
  vi.mocked(window.scholar.getCourse).mockRejectedValueOnce(
    new Error('Please sign in to ScholarOS.'),
  );
  await open();
  expect(text()).toContain('Please sign in to ScholarOS.');
  expect(
    [...document.querySelectorAll('button')].some((button) =>
      button.textContent?.includes('Retry'),
    ),
  ).toBe(true);
});

it('opens an item at its own source', async () => {
  detail = course({
    announcements: [
      child('a', {
        title: 'Midterm moved',
        url: 'https://canvas.school.edu/courses/1/announcements',
      }),
    ],
  });
  await open();
  await openTab('Announcements');
  await click(
    document.querySelector(
      'button[aria-label="Open Midterm moved at its source"]',
    )!,
  );
  expect(window.scholar.openSource).toHaveBeenCalledWith(
    'https://canvas.school.edu/courses/1/announcements',
  );
});

it('sorts the displayed LMS due dates and hides the partial-read label', async () => {
  detail = course({
    assignmentsStatus: 'partial',
    assignments: [
      child('calendar-later', {
        dateText: 'Monday, November 9, 2026 11:59 pm',
      }),
      child('calendar-sooner', {
        dateText: 'Monday, November 2, 2026 11:59 pm',
      }),
      child('detail-later', {
        dateText: 'Due Monday, November 9, 2026 at 11:59 pm',
      }),
      child('detail-sooner', {
        dateText: 'Due Monday, November 2, 2026 at 11:59 pm',
      }),
    ],
  });
  await open();
  await openTab('Assignments');
  expect(
    [...document.querySelectorAll('[data-slot="assignments-card"]')].map(
      (card) => card.querySelector('p')?.textContent,
    ),
  ).toEqual([
    'Item calendar-sooner',
    'Item detail-sooner',
    'Item calendar-later',
    'Item detail-later',
  ]);
  expect(text()).not.toContain('Partly read');
  expect(text()).toContain('Updated');
});
