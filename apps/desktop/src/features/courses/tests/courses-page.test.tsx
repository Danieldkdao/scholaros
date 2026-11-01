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
import type { CourseSummary, CoursesSnapshot } from '../types';

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

const connection = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id === 'canvas' ? 'Canvas' : 'Portal',
  host: id === 'canvas' ? 'canvas.school.edu' : 'portal.school.edu',
  url: `https://${id}.school.edu/`,
  kind: 'canvas',
  status: 'verified',
  verifiedAt: null,
  notes: null,
  favicon: null,
  isCourseResource: true,
  ...overrides,
});

const course = (
  id: string,
  overrides: Partial<CourseSummary> = {},
): CourseSummary => ({
  id,
  name: 'Biology 101',
  code: 'BIOL 101',
  term: 'Fall 2026',
  url: `https://canvas.school.edu/courses/${id}`,
  connectionId: 'canvas',
  active: true,
  sourceName: 'Canvas',
  sourceHost: 'canvas.school.edu',
  sourceState: 'connected',
  lastSeenAt: '2026-03-08T09:00:00.000Z',
  overviewSyncedAt: '2026-03-08T09:00:00.000Z',
  announcementCount: 2,
  assignmentCount: 3,
  announcementsStatus: 'complete',
  announcementsSyncedAt: '2026-03-08T09:00:00.000Z',
  assignmentsStatus: 'complete',
  assignmentsSyncedAt: '2026-03-08T09:00:00.000Z',
  ...overrides,
});

let snapshot: CoursesSnapshot = {
  courses: [],
  sources: [],
  lastSuccessfulAt: null,
};
let connections: unknown[] = [connection('canvas')];
let root: ReturnType<typeof createRoot>;

const state = () => ({
  accountId: 'student',
  connections,
  settings: { consent: true },
  preferences: { backgroundSync: { status: 'off' } },
  discovery: {},
});

beforeEach(() => {
  snapshot = {
    courses: [course('1')],
    sources: [
      {
        connectionId: 'canvas',
        outcome: 'complete',
        message: null,
        lastAttemptedAt: '2026-03-08T09:00:00.000Z',
        lastSuccessfulAt: '2026-03-08T09:00:00.000Z',
      },
    ],
    lastSuccessfulAt: '2026-03-08T09:00:00.000Z',
  };
  connections = [connection('canvas')];
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
  window.scholar = {
    onCoursesChange: vi.fn(() => () => {}),
    getCurrentUser: vi.fn(async () => ({ id: 'student' })),
    getState: vi.fn(async () => state()),
    onBackgroundSyncChange: vi.fn(() => () => {}),
    onConnectChange: vi.fn(() => () => {}),
    getConnectRun: vi.fn(async () => ({ status: 'idle', accountId: null })),
    getCourses: vi.fn(async () => snapshot),
    refreshCourses: vi.fn(async () => snapshot),
    cancelCourseRefresh: vi.fn(async () => undefined),
    getCourse: vi.fn(async () => null),
    openSource: vi.fn(async () => undefined),
  } as unknown as typeof window.scholar;
  window.onAuthenticated = vi.fn(() => () => {});
  window.onUserUpdated = vi.fn(() => () => {});
});

afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
  document.body.replaceChildren();
});

const open = async (path = '/dashboard/courses') => {
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

const text = () => document.body.textContent ?? '';
const buttonWith = (label: string) =>
  [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;

const searchCourses = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Search courses"]',
  );
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

it('debounces course search, resets the delay while typing, and restores courses when cleared', async () => {
  snapshot.courses.push(
    course('2', { name: 'Chemistry 201', code: 'CHEM 201' }),
  );
  await open();
  vi.useFakeTimers();
  await searchCourses('bi');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  await searchCourses('biology');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(249);
  });
  expect(text()).toContain('Chemistry 201');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(text()).toContain('Biology 101');
  expect(text()).not.toContain('Chemistry 201');
  await searchCourses('');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(text()).toContain('Chemistry 201');
});

it.each(['  biology  ', 'biol', 'fall 2026', 'canvas', 'canvas.school.edu'])(
  'searches course metadata without case sensitivity: %s',
  async (query) => {
    snapshot.courses.push(
      course('2', {
        name: 'Chemistry 201',
        code: 'CHEM 201',
        term: 'Spring 2027',
        sourceName: 'Portal',
        sourceHost: 'portal.school.edu',
      }),
    );
    await open();
    vi.useFakeTimers();
    await searchCourses(query);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(document.querySelector('[data-slot="course-card"]')).not.toBeNull();
    expect(text()).not.toContain('Chemistry 201');
  },
);

it('shows a search empty state and keeps inactive courses hidden until requested', async () => {
  snapshot.courses.push(course('2', { name: 'History 201', active: false }));
  await open();
  vi.useFakeTimers();
  await searchCourses('history');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(text()).toContain('No courses match your search.');
  expect(document.querySelector('[data-slot="course-card"]')).toBeNull();
  await act(async () => {
    buttonWith('Show 1 inactive course')!.click();
  });
  expect(text()).toContain('History 201');
  expect(text()).not.toContain('No courses match your search.');
});

it('lists saved courses with their code, term and source', async () => {
  await open();
  expect(text()).toContain('Biology 101');
  expect(text()).toContain('BIOL 101');
  expect(text()).toContain('Fall 2026');
  expect(text()).toContain('Canvas');
  expect(text()).toContain('Updated');
});

it('links each course to its own page', async () => {
  await open();
  expect(
    document.querySelector('a[href="/dashboard/courses/1"]'),
  ).not.toBeNull();
});

it('offers a refresh once courses have been saved', async () => {
  await open();
  expect(buttonWith('Add courses')).toBeTruthy();
  await openAddCourses();
  expect(syncOption()?.getAttribute('aria-disabled')).not.toBe('true');
});

it('explains how to choose course resources when nothing is marked', async () => {
  connections = [connection('canvas', { isCourseResource: false })];
  snapshot = { courses: [], sources: [], lastSuccessfulAt: null };
  await open();
  expect(text()).toContain(
    'Add courses manually or select a course resource in Connections to enable syncing.',
  );
  expect(
    document.querySelector('a[href="/dashboard/connections"]'),
  ).not.toBeNull();
  await openAddCourses();
  expect(syncOption()?.getAttribute('aria-disabled')).toBe('true');
  expect(document.querySelector('[role="menu"]')?.textContent).toContain(
    'Add manually',
  );
});

it('explains that every marked resource needs a sign-in', async () => {
  connections = [connection('canvas', { status: 'needs-sign-in' })];
  snapshot = { courses: [], sources: [], lastSuccessfulAt: null };
  await open();
  expect(text()).toContain('Sign in in your study browser');
  await openAddCourses();
  expect(syncOption()?.getAttribute('aria-disabled')).not.toBe('true');
});

it('names a resource that needs sign-in beside the ready ones', async () => {
  connections = [
    connection('canvas'),
    connection('portal', { status: 'needs-sign-in' }),
  ];
  await open();
  expect(text()).toContain('Portal needs you to sign in again.');
  expect(buttonWith('Add courses')?.disabled).toBe(false);
});

it('offers a first scan before anything was saved', async () => {
  snapshot = { courses: [], sources: [], lastSuccessfulAt: null };
  await open();
  expect(buttonWith('Add courses')).toBeTruthy();
  expect(text()).toContain('No courses saved yet.');
});

it('reports a verified empty result as an answer', async () => {
  snapshot = {
    courses: [],
    sources: [
      {
        connectionId: 'canvas',
        outcome: 'complete',
        message: null,
        lastAttemptedAt: '2026-03-08T09:00:00.000Z',
        lastSuccessfulAt: '2026-03-08T09:00:00.000Z',
      },
    ],
    lastSuccessfulAt: '2026-03-08T09:00:00.000Z',
  };
  await open();
  expect(text()).toContain('listed no courses');
});

it('reports an unreadable resource instead of claiming it was empty', async () => {
  snapshot = {
    courses: [],
    sources: [
      {
        connectionId: 'canvas',
        outcome: 'blocked',
        message: 'ScholarOS could not read this resource safely.',
        lastAttemptedAt: '2026-03-08T09:00:00.000Z',
        lastSuccessfulAt: null,
      },
    ],
    lastSuccessfulAt: null,
  };
  await open();
  expect(text()).toContain('not found');
  expect(text()).not.toContain('listed no courses');
  const notice = [...document.querySelectorAll('p')].find((node) =>
    node.textContent?.includes('saved courses are unchanged'),
  );
  expect(notice?.classList.contains('text-base')).toBe(true);
});

it('shows a source sign-in failure even when the connection was previously confirmed', async () => {
  snapshot.sources[0] = {
    ...snapshot.sources[0],
    outcome: 'needs-sign-in',
    message: 'Sign in in your study browser, then refresh your courses.',
  };
  await open();
  expect(text()).toContain('Sign in in your study browser');
  const openButton = document.querySelector(
    'button[aria-label="Open Canvas in study browser"]',
  ) as HTMLButtonElement;
  expect(openButton).not.toBeNull();
  await act(async () => openButton.click());
  expect(window.scholar.openSource).toHaveBeenCalledWith(
    'https://canvas.school.edu/',
  );
});

it('does not call all sources empty when another source could not be read', async () => {
  snapshot.courses = [];
  snapshot.sources.push({
    ...snapshot.sources[0],
    connectionId: 'portal',
    outcome: 'blocked',
    message: null,
  });
  await open();
  expect(text()).not.toContain('were read and listed no courses');
});

it('keeps saved courses visible while refreshing and offers a way to stop', async () => {
  let finish!: () => void;
  vi.mocked(window.scholar.refreshCourses).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(snapshot);
      }),
  );
  await open();
  await openAddCourses();
  await act(async () => {
    syncOption()?.click();
  });
  expect(text()).toContain('Biology 101');
  expect(text()).toContain('Refreshing your courses');
  expect(buttonWith('Stop')).toBeTruthy();
  await act(async () => {
    buttonWith('Stop')?.click();
  });
  expect(window.scholar.cancelCourseRefresh).toHaveBeenCalled();
  await act(async () => {
    finish();
  });
});

it('reports a failed refresh and keeps the saved courses', async () => {
  vi.mocked(window.scholar.refreshCourses).mockRejectedValueOnce(
    new Error(
      'Another academic task is running; stop it or try again shortly.',
    ),
  );
  await open();
  await openAddCourses();
  await act(async () => {
    syncOption()?.click();
  });
  await act(async () => {});
  expect(text()).toContain('Another academic task is running');
  expect(text()).toContain('Biology 101');
  expect(text()).toContain('Updated');
});

it('hides inactive courses until the student asks for them', async () => {
  snapshot = {
    courses: [
      course('1'),
      course('2', { name: 'Old Chemistry', active: false }),
    ],
    sources: [],
    lastSuccessfulAt: null,
  };
  await open();
  expect(text()).toContain('Biology 101');
  expect(text()).not.toContain('Old Chemistry');
  await act(async () => {
    buttonWith('Show 1 inactive course')?.click();
  });
  expect(text()).toContain('Old Chemistry');
});

it('ignores a snapshot that arrives for another account', async () => {
  let publish!: (change: unknown) => void;
  window.scholar.onBackgroundSyncChange = vi.fn((listener) => {
    publish = listener;
    return () => {};
  }) as unknown as typeof window.scholar.onBackgroundSyncChange;
  await open();
  expect(text()).toContain('Biology 101');
  await act(async () => {
    publish({
      accountId: 'someone-else',
      state: { status: 'waiting', message: null, lastSyncedAt: null },
      discovery: null,
    });
  });
  expect(window.scholar.getCourses).toHaveBeenCalledOnce();
});

it('reloads saved courses after a background refresh for this account', async () => {
  let publish!: (change: unknown) => void;
  window.scholar.onBackgroundSyncChange = vi.fn((listener) => {
    publish = listener;
    return () => {};
  }) as unknown as typeof window.scholar.onBackgroundSyncChange;
  await open();
  await act(async () => {
    publish({
      accountId: 'student',
      state: { status: 'waiting', message: null, lastSyncedAt: null },
      discovery: null,
    });
  });
  await act(async () => {});
  expect(window.scholar.getCourses).toHaveBeenCalledTimes(2);
});

it('shows courses alphabetically with their saved content counts', async () => {
  snapshot.courses = [
    course('z', { name: 'Zoology' }),
    course('a', { name: 'algebra', announcementCount: 0, assignmentCount: 1 }),
    course('b', { name: 'Biology' }),
  ];
  await open();
  const cards = [...document.querySelectorAll('[data-slot="course-card"]')];
  expect(cards.map((card) => card.querySelector('a')?.textContent)).toEqual([
    'algebra',
    'Biology',
    'Zoology',
  ]);
  expect(cards[0]?.textContent).toContain('0 announcements');
  expect(cards[0]?.textContent).toContain('1 assignment');
  expect(cards[1]?.textContent).toContain('2 announcements');
  expect(cards[1]?.textContent).toContain('3 assignments');
});

const openAddCourses = async () => {
  await act(async () => {
    buttonWith('Add courses')!.click();
  });
};
const syncOption = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent?.includes('Sync courses'),
  );

it('opens manual course creation without a course resource', async () => {
  connections = [];
  await open();
  await openAddCourses();
  await act(async () => {
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.includes('Add manually'))!
      .click();
  });
  expect(
    document.querySelector<HTMLInputElement>('input[name="name"]')?.value,
  ).toBe('');
});
