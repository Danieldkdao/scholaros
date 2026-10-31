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
  detail = useCourse(id);
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
    getCourses: vi.fn(async () => snapshot('current')),
    getCourse: vi.fn(async () => null),
    refreshCourses: vi.fn(async () => snapshot('refreshed')),
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
