// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCourse } from '../hooks/use-course';
import { useCourses } from '../hooks/use-courses';
import type { CourseDetail, CoursesSnapshot } from '../types';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let catalog: ReturnType<typeof useCourses>;
let detail: ReturnType<typeof useCourse>;
const catalogProbe = ({ id }: { id: string | null }) => {
  catalog = useCourses(id);
  return null;
};
const detailProbe = ({ id }: { id: string }) => {
  detail = useCourse(id, 'student');
  return null;
};
const snapshot = (id: string): CoursesSnapshot => ({
  courses: [],
  sources: [
    {
      connectionId: id,
      outcome: 'complete',
      message: null,
      lastAttemptedAt: '',
      lastSuccessfulAt: null,
    },
  ],
  lastSuccessfulAt: null,
});

beforeEach(() => {
  const node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  window.scholar = {
    onCoursesChange: vi.fn(() => () => {}),
    getCourses: vi.fn(async () => snapshot('current')),
    getCourse: vi.fn(async () => null),
    refreshCourses: vi.fn(async () => snapshot('refreshed')),
    refreshCourse: vi.fn(async () => null),
    onBackgroundSyncChange: vi.fn(() => () => {}),
  } as unknown as typeof window.scholar;
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it('reloads for an account change and ignores the previous account response', async () => {
  let resolveOld!: (value: CoursesSnapshot) => void;
  vi.mocked(window.scholar.getCourses).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  await act(async () =>
    root.render(createElement(catalogProbe, { id: 'old' })),
  );
  await act(async () =>
    root.render(createElement(catalogProbe, { id: 'current' })),
  );
  await act(async () => resolveOld(snapshot('old')));
  expect(catalog.snapshot?.sources[0].connectionId).toBe('current');
});

it('ignores a course response after navigating to another course', async () => {
  let resolveOld!: (value: CourseDetail | null) => void;
  vi.mocked(window.scholar.getCourse).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  await act(async () => root.render(createElement(detailProbe, { id: 'old' })));
  await act(async () =>
    root.render(createElement(detailProbe, { id: 'current' })),
  );
  await act(async () => resolveOld({ id: 'old' } as CourseDetail));
  expect(detail.course).toBeNull();
});

it('keeps a successful empty catalog distinct from a failed nullable read', async () => {
  vi.mocked(window.scholar.getCourses).mockResolvedValueOnce({
    courses: [],
    sources: [],
    lastSuccessfulAt: null,
  });
  await act(async () =>
    root.render(createElement(catalogProbe, { id: 'current' })),
  );
  expect(catalog.snapshot?.courses).toEqual([]);
  expect(catalog.loadError).toBeNull();

  vi.mocked(window.scholar.getCourses).mockResolvedValueOnce(
    snapshot('loaded'),
  );
  await act(async () => catalog.reload());
  expect(catalog.snapshot?.sources[0].connectionId).toBe('loaded');

  vi.mocked(window.scholar.getCourses).mockResolvedValueOnce(null);
  await act(async () => catalog.reload());
  expect(catalog.snapshot?.sources[0].connectionId).toBe('loaded');
  expect(catalog.loadError).toBe('Could not load your courses.');

  vi.mocked(window.scholar.getCourses).mockResolvedValueOnce(
    snapshot('recovered'),
  );
  await act(async () => catalog.reload());
  expect(catalog.snapshot?.sources[0].connectionId).toBe('recovered');
  expect(catalog.loadError).toBeNull();
});

it('keeps a missing detail response as a not-found result', async () => {
  await act(async () =>
    root.render(createElement(detailProbe, { id: 'missing' })),
  );
  expect(detail.course).toBeNull();
  expect(detail.loadError).toBeNull();
});

it('reloads persisted outcomes after a refresh is cancelled or fails', async () => {
  await act(async () =>
    root.render(createElement(catalogProbe, { id: 'current' })),
  );
  vi.mocked(window.scholar.refreshCourses).mockRejectedValueOnce(
    new Error('Refresh stopped'),
  );
  vi.mocked(window.scholar.getCourses).mockResolvedValueOnce(
    snapshot('cancelled'),
  );
  await act(async () => catalog.refresh());
  expect(catalog.snapshot?.sources[0].connectionId).toBe('cancelled');
  expect(catalog.refreshing).toBe(false);
});

it('reattaches to a running refresh after navigation without starting another job', async () => {
  let complete!: (value: CoursesSnapshot) => void;
  vi.mocked(window.scholar.refreshCourses).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () =>
    root.render(createElement(catalogProbe, { id: 'current' })),
  );
  let running!: Promise<void>;
  await act(async () => {
    running = catalog.refresh();
  });
  await act(async () => root.render(null));
  await act(async () =>
    root.render(createElement(catalogProbe, { id: 'current' })),
  );
  expect(catalog.refreshing).toBe(true);
  expect(window.scholar.refreshCourses).toHaveBeenCalledTimes(1);
  await act(async () => {
    complete(snapshot('finished'));
    await running;
  });
  expect(catalog.refreshing).toBe(false);
  expect(catalog.snapshot?.sources[0].connectionId).toBe('finished');
});

it('keeps course refreshes running across navigation and reattaches only to that course', async () => {
  const completions = new Map<string, (value: CourseDetail | null) => void>();
  vi.mocked(window.scholar.refreshCourse).mockImplementation(
    (id) => new Promise((resolve) => completions.set(id, resolve)),
  );
  await act(async () => root.render(createElement(detailProbe, { id: 'a' })));
  let a!: Promise<void>;
  await act(async () => {
    a = detail.refresh();
  });
  expect(detail.refreshing).toBe(true);
  await act(async () => root.render(createElement(detailProbe, { id: 'b' })));
  expect(detail.refreshing).toBe(false);
  let b!: Promise<void>;
  await act(async () => {
    b = detail.refresh();
  });
  await act(async () => root.render(createElement(detailProbe, { id: 'a' })));
  expect(detail.refreshing).toBe(true);
  expect(window.scholar.refreshCourse).toHaveBeenCalledTimes(2);
  await act(async () => {
    completions.get('b')!({ id: 'b' } as CourseDetail);
    await b;
  });
  expect(detail.course?.id).not.toBe('b');
  expect(detail.refreshing).toBe(true);
  await act(async () => {
    completions.get('a')!({ id: 'a' } as CourseDetail);
    await a;
  });
  expect(detail.course?.id).toBe('a');
  expect(detail.refreshing).toBe(false);
});

it('finishes non-authentication refresh presentation and reloads saved progress', async () => {
  await act(async () => root.render(createElement(detailProbe, { id: 'a' })));
  vi.mocked(window.scholar.refreshCourse).mockRejectedValueOnce(
    new Error('Connection lost'),
  );
  vi.mocked(window.scholar.getCourse).mockResolvedValueOnce({
    id: 'a',
  } as CourseDetail);
  await act(async () => detail.refresh());
  expect(detail.refreshError).toBeNull();
  expect(detail.course?.id).toBe('a');
  expect(detail.refreshing).toBe(false);
});

it('reloads snapshots after service resource events and ignores events belonging to another account', async () => {
  const listeners = new Set<
    (change: { accountId: string; courseId: string | null }) => void
  >();
  window.scholar.onCoursesChange = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement(catalogProbe, { id: 'student' }),
        createElement(detailProbe, { id: 'course-1' }),
      ),
    ),
  );
  await act(async () => {
    for (const listener of listeners)
      listener({ accountId: 'other', courseId: null });
  });
  expect(window.scholar.getCourses).toHaveBeenCalledOnce();
  expect(window.scholar.getCourse).toHaveBeenCalledOnce();
  await act(async () => {
    for (const listener of listeners)
      listener({ accountId: 'student', courseId: 'course-1' });
  });
  expect(window.scholar.getCourses).toHaveBeenCalledTimes(2);
  expect(window.scholar.getCourse).toHaveBeenCalledTimes(2);
});

it.each([
  'Please sign in to ScholarOS.',
  'Your session has expired. Reconnect to continue.',
])(
  'preserves authentication guidance on failed refresh: %s',
  async (message) => {
    await act(async () => root.render(createElement(detailProbe, { id: 'a' })));
    vi.mocked(window.scholar.refreshCourse).mockRejectedValueOnce(
      new Error(message),
    );
    await act(async () => detail.refresh());
    expect(detail.refreshError).toBe(message);
    expect(detail.refreshing).toBe(false);
  },
);
