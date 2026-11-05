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
import { CourseChildEditor } from '../components/course-record-editor';
import type { CourseDetail, SavedCourseChild } from '../types';

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
  connectionId: 'canvas',
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
    onAcademicReconnect: vi.fn(() => () => {}),
    onProductEvent: vi.fn(() => () => {}),
    onCoursesChange: vi.fn(() => () => {}),
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
    getLearningProgress: vi.fn(async ({ courseId }: { courseId?: string }) => ({
      courseId: courseId ?? null,
      strengths: [],
      practiceTopics: [],
      recentChanges: [],
      unknownCount: 0,
      revision: 0,
    })),
    listContextItems: vi.fn(async () => ({
      items: [],
      nextCursor: null,
      revision: 0,
    })),
    refreshCourse: vi.fn(async () => detail),
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

it('shows the four course tabs with the overview first', async () => {
  await open();
  expect(
    [...document.querySelectorAll('[role="tab"]')].map((item) =>
      item.textContent?.trim(),
    ),
  ).toEqual(['Overview', 'Announcements', 'Assignments', 'Materials']);
  expect(tab('Overview').getAttribute('aria-selected')).toBe('true');
  await openTab('Assignments');
  expect(tab('Assignments').getAttribute('aria-selected')).toBe('true');
  await openTab('Materials');
  expect(tab('Materials').getAttribute('aria-selected')).toBe('true');
  expect(window.scholar.listContextItems).toHaveBeenCalledWith({
    courseId: 'course-1',
    limit: 25,
  });
  expect(text()).toContain('No course materials yet');
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

it('keeps source-verified assignments visible while their submission status is uncertain', async () => {
  detail = course({
    assignmentsStatus: 'partial',
    assignments: [
      child('uncertain', {
        title: 'Observed assignment',
        content: {
          title: 'Observed assignment',
          description: null,
          kind: 'assignment',
          state: 'unknown',
          due: null,
          availableFrom: null,
          availableUntil: null,
          pointsPossible: null,
          url: null,
          sourceId: null,
          resources: [],
          evidence: {
            sourceUrl: 'https://canvas.school.edu/courses/1',
            excerpts: ['Observed assignment'],
            targetIds: [],
          },
        },
      }),
    ],
  });
  await open();
  await openTab('Assignments');
  expect(text()).toContain('Observed assignment');
  expect(
    document.querySelector('[aria-label="Submission status unverified"]'),
  ).not.toBeNull();
  expect(text()).not.toContain('Completed');
});

it('shows the verified course section in overview metadata', async () => {
  detail = course({
    content: {
      name: 'Biology 101',
      code: 'BIO',
      section: 'A1',
      term: null,
      description: null,
      instructors: [],
      sourceId: null,
      url: 'https://canvas.school.edu/courses/1',
      evidence: {
        sourceUrl: 'https://canvas.school.edu/courses',
        excerpts: ['Biology 101'],
        targetIds: [],
      },
    },
  });
  await open();
  expect(text()).toContain('Section');
  expect(text()).toContain('A1');
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
  expect(text()).toContain('Checked');
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
  const datedChild = (id: string, date: string, original: string) =>
    child(id, {
      content: {
        title: `Item ${id}`,
        description: null,
        kind: 'assignment',
        state: 'active-unsubmitted',
        due: { kind: 'local', date, time: '23:59', original },
        availableFrom: null,
        availableUntil: null,
        pointsPossible: null,
        url: null,
        sourceId: null,
        resources: [],
        evidence: {
          sourceUrl: 'https://canvas.school.edu/courses/1',
          excerpts: [`Item ${id}`],
          targetIds: [],
        },
      },
    });
  detail = course({
    assignmentsStatus: 'partial',
    assignments: [
      datedChild(
        'calendar-later',
        '2026-11-09',
        'Monday, November 9, 2026 11:59 pm',
      ),
      datedChild(
        'calendar-sooner',
        '2026-11-02',
        'Monday, November 2, 2026 11:59 pm',
      ),
      datedChild(
        'detail-later',
        '2026-11-09',
        'Due Monday, November 9, 2026 at 11:59 pm',
      ),
      datedChild(
        'detail-sooner',
        '2026-11-02',
        'Due Monday, November 2, 2026 at 11:59 pm',
      ),
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
  expect(text()).toContain('Checked');
});

it('refreshes the current course with an accessible button', async () => {
  await open();
  const button = document.querySelector('button[aria-label="Refresh course"]')!;
  expect(button).not.toBeNull();
  await click(button);
  expect(window.scholar.refreshCourse).toHaveBeenCalledWith('course-1');
});

it('shows a stop action for a running course refresh', async () => {
  detail = course({ refreshing: true });
  window.scholar.cancelCourseRefresh = vi.fn(async () => undefined);
  await open();
  const stop = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Stop refreshing course"]',
  );
  expect(stop).not.toBeNull();
  await act(async () => stop!.click());
  expect(window.scholar.cancelCourseRefresh).toHaveBeenCalledWith('course-1');
});

it('opens a validated course edit dialog from its actions menu', async () => {
  window.scholar.updateCourseRecord = vi.fn(async () => undefined);
  await open();
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Actions for Biology 101"]',
      )!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.includes('Edit'))!
      .click(),
  );
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Edit course',
  );
  const input = document.querySelector<HTMLInputElement>('input[name="name"]');
  expect(input?.value).toBe('Biology 101');
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(window.scholar.updateCourseRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'courses',
      courseId: 'course-1',
      values: expect.objectContaining({ name: 'Biology 101' }),
    }),
  );
});

it('requires confirmation before hiding a source course and preserves it on failure', async () => {
  window.scholar.deleteCourseRecord = vi.fn(async () => {
    throw new Error('Storage unavailable');
  });
  await open();
  await click(
    document.querySelector('button[aria-label="Actions for Biology 101"]')!,
  );
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('Hide'),
    )!,
  );
  expect(window.scholar.deleteCourseRecord).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Hide Biology 101?',
  );
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    'Restore them later from Hidden records',
  );
  await click(
    [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (node) => node.textContent?.trim() === 'Hide',
    )!,
  );
  expect(window.scholar.deleteCourseRecord).toHaveBeenCalledWith({
    kind: 'courses',
    courseId: 'course-1',
    id: 'course-1',
  });
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(text()).toContain('Biology 101');
});

it.each(['assignments', 'announcements'] as const)(
  'offers a dialog to edit %s',
  async (kind) => {
    detail = course({ [kind]: [child('editable')] });
    window.scholar.updateCourseRecord = vi.fn(async () => undefined);
    await open();
    await openTab(kind === 'assignments' ? 'Assignments' : 'Announcements');
    await click(
      document.querySelector('button[aria-label="Actions for Item editable"]')!,
    );
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
        node.textContent?.includes('Edit'),
      )!,
    );
    expect(
      document.querySelector<HTMLInputElement>('input[name="title"]')?.value,
    ).toBe('Item editable');
    await act(async () =>
      document
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(window.scholar.updateCourseRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        kind,
        id: 'editable',
        values: expect.objectContaining({ title: 'Item editable' }),
      }),
    );
  },
);

it('shows an inline error when an assignment deadline changes to a past time', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date(2026, 9, 15, 12, 0, 0));
    const node = document.createElement('div');
    document.body.append(node);
    root = createRoot(node);
    const onSave = vi.fn(async () => undefined);
    const item: SavedCourseChild = {
      id: 'assignment-1',
      title: 'Current assignment',
      body: null,
      dateValue: '2026-10-15T12:30',
      dateText: '2026-10-15T12:30',
      url: 'https://canvas.school.edu/courses/1/assignments/1',
      active: true,
      lastSeenAt: '2026-10-01T12:00:00.000Z',
      content: null,
    };
    await act(async () =>
      root.render(
        createElement(CourseChildEditor, {
          item,
          kind: 'assignments',
          onSave,
          onCancel: vi.fn(),
        }),
      ),
    );
    const time = node.querySelector<HTMLInputElement>('input[type="time"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(time, '11:00');
      time.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      node
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain(
      'Choose a date and time in the future.',
    );
  } finally {
    vi.useRealTimers();
  }
});

it('shows inline validation and does not save an empty course name', async () => {
  detail = course({ name: '' });
  window.scholar.updateCourseRecord = vi.fn(async () => undefined);
  await open();
  await click(document.querySelector('button[aria-label="Actions for "]')!);
  await click(
    [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
      node.textContent?.includes('Edit'),
    )!,
  );
  await act(async () =>
    document
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(window.scholar.updateCourseRecord).not.toHaveBeenCalled();
  expect(
    document.querySelector('input[name="name"]')?.getAttribute('aria-invalid'),
  ).toBe('true');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Enter a course name.',
  );
});

it.each(['assignments', 'announcements'] as const)(
  'creates a manual %s record with the shared form',
  async (kind) => {
    window.scholar.createCourseRecord = vi.fn(async () => 'manual-id');
    await open();
    await click(tab(kind === 'assignments' ? 'Assignments' : 'Announcements'));
    const label = kind === 'assignments' ? 'assignment' : 'announcement';
    await click(document.querySelector(`button[aria-label="Add ${label}"]`)!);
    const input = document.querySelector<HTMLInputElement>(
      'input[name="title"]',
    )!;
    expect(input.value).toBe('');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'Manual record');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('form')!
        .dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
    expect(window.scholar.createCourseRecord).toHaveBeenCalledWith({
      kind,
      courseId: 'course-1',
      values: { title: 'Manual record', body: '', date: '' },
    });
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  },
);

it.each(['Assignments', 'Announcements'])(
  'debounces search in %s',
  async (label) => {
    detail = course({
      assignments: [child('assignment')],
      announcements: [child('announcement')],
    });
    await open();
    await click(tab(label));
    const kind = label.toLowerCase();
    const input = document.querySelector<HTMLInputElement>(
      `input[aria-label="Search ${kind}"]`,
    )!;
    const before = document.querySelectorAll(
      `[data-slot="${kind}-card"]`,
    ).length;
    expect(before).toBeGreaterThan(0);
    vi.useFakeTimers();
    try {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, 'no matching record');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(
        document.querySelectorAll(`[data-slot="${kind}-card"]`).length,
      ).toBe(before);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(
        document.querySelectorAll(`[data-slot="${kind}-card"]`).length,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
