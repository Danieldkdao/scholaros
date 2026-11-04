// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HiddenCourseRecords } from '../components/hidden-course-records';
import {
  CourseRecordEditor,
  CourseChildEditor,
} from '../components/course-record-editor';
import { CourseRecordActions } from '../components/course-record-actions';
import type {
  CourseRecordSuppressionView,
  CourseChildLocalOverrideView,
  CourseLocalOverrideView,
} from '../services/store';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const courseSuppression: CourseRecordSuppressionView = {
  suppressionId: 'group-course-1',
  kind: 'courses',
  title: 'Biology 101',
  context: 'Canvas',
  hiddenAt: '2026-10-01T12:00:00.000Z',
  legacy: false,
  restoreInput: { scope: 'group', suppressionId: 'group-course-1' },
};
const legacySuppression: CourseRecordSuppressionView = {
  suppressionId: 'legacy-course-1',
  kind: 'courses',
  title: 'Legacy hidden courses',
  context: 'Canvas',
  hiddenAt: '2026-09-01T12:00:00.000Z',
  legacy: true,
  restoreInput: {
    scope: 'legacy',
    connectionId: 'connection-1',
    courseId: '*',
    kind: 'courses',
  },
};

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

const render = async (props: ComponentProps<typeof HiddenCourseRecords>) => {
  await act(async () => {
    root.render(createElement(HiddenCourseRecords, props));
  });
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

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (item) =>
      item.getAttribute('aria-label') === label ||
      item.textContent?.trim() === label,
  )!;

const settle = async () => act(async () => {});

it('announces loading and places the hidden records in a focus-managed dialog', async () => {
  let finishLoading!: (items: CourseRecordSuppressionView[]) => void;
  const listSuppressions = vi.fn(
    () =>
      new Promise<CourseRecordSuppressionView[]>((resolve) => {
        finishLoading = resolve;
      }),
  );
  await render({
    courseId: 'course-1',
    courseTitle: 'Biology 101',
    connectionId: 'connection-1',
    listSuppressions,
    restoreSuppression: vi.fn(async () => undefined),
  });
  const trigger = button('Hidden records for Biology 101');
  trigger.focus();
  await click(trigger);
  await settle();

  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
  expect(document.body.textContent).toContain('Loading hidden records');
  expect(listSuppressions).toHaveBeenCalledWith({
    connectionId: 'connection-1',
    courseId: 'course-1',
    limit: 50,
  });

  await act(async () => finishLoading([courseSuppression]));
  expect(document.body.textContent).toContain('Biology 101');
  expect(button('Restore')).toBeDefined();

  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('keeps a suppression visible and reports restoration failures', async () => {
  const listSuppressions = vi.fn(async () => [courseSuppression]);
  const restoreSuppression = vi.fn(async () => {
    throw new Error('This course is refreshing; try again shortly.');
  });
  await render({
    courseId: 'course-1',
    courseTitle: 'Biology 101',
    listSuppressions,
    restoreSuppression,
  });
  await click(button('Hidden records for Biology 101'));
  await settle();
  await click(button('Restore'));
  await settle();

  expect(restoreSuppression).toHaveBeenCalledWith(
    courseSuppression.restoreInput,
  );
  expect(document.body.textContent).toContain('Biology 101');
  expect(document.body.textContent).toContain(
    'This course is refreshing; try again shortly.',
  );
});

it('refreshes the visible suppression list after a successful restore', async () => {
  let currentSuppressions = [courseSuppression];
  const listSuppressions = vi.fn(async () => currentSuppressions);
  const restoreSuppression = vi.fn(async () => {
    currentSuppressions = [];
  });
  const onRestored = vi.fn();
  await render({
    courseId: 'course-1',
    courseTitle: 'Biology 101',
    listSuppressions,
    restoreSuppression,
    onRestored,
  });
  await click(button('Hidden records for Biology 101'));
  await settle();
  await click(button('Restore'));
  await settle();

  expect(restoreSuppression).toHaveBeenCalledWith(
    courseSuppression.restoreInput,
  );
  expect(onRestored).toHaveBeenCalledOnce();
  expect(listSuppressions).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain('No hidden records');
});

it('requires explicit confirmation before scope-wide legacy restoration', async () => {
  const listSuppressions = vi.fn(async () => [legacySuppression]);
  const restoreSuppression = vi.fn(async () => undefined);
  await render({
    courseId: 'course-1',
    courseTitle: 'Biology 101',
    listSuppressions,
    restoreSuppression,
  });
  await click(button('Hidden records for Biology 101'));
  await settle();
  await click(button('Restore scope'));
  await settle();

  expect(document.body.textContent).toContain(
    'Restore all legacy hidden courses?',
  );
  expect(document.body.textContent).toContain(
    'Previously deleted local records cannot be recovered.',
  );
  expect(restoreSuppression).not.toHaveBeenCalled();

  await click(button('Restore all'));
  await settle();
  expect(restoreSuppression).toHaveBeenCalledWith(
    legacySuppression.restoreInput,
  );
});

it('lists legacy records even when their source course is no longer visible', async () => {
  const listSuppressions = vi.fn(async () => [legacySuppression]);
  await render({
    listSuppressions,
    restoreSuppression: vi.fn(async () => undefined),
  });
  await click(button('Hidden course records'));
  await settle();

  expect(listSuppressions).toHaveBeenCalledWith({ limit: 50 });
  expect(document.body.textContent).toContain('Legacy hidden courses');
});

it('opens hidden records from the course action surface', async () => {
  const listSuppressions = vi.fn(async () => []);
  window.scholar = {
    listCourseRecordSuppressions: listSuppressions,
    restoreCourseRecordSuppression: vi.fn(async () => undefined),
    updateCourseRecord: vi.fn(async () => undefined),
    deleteCourseRecord: vi.fn(async () => undefined),
  } as unknown as typeof window.scholar;
  await act(async () => {
    root.render(
      createElement(CourseRecordActions, {
        kind: 'courses',
        courseId: 'course-1',
        course: {
          id: 'course-1',
          name: 'Biology 101',
          code: null,
          term: null,
          instructor: null,
          description: null,
          url: 'https://canvas.school.edu/courses/1',
          connectionId: 'connection-1',
          active: true,
          sourceName: 'Canvas',
          sourceHost: 'canvas.school.edu',
          sourceState: 'connected',
          lastSeenAt: '2026-10-01T12:00:00.000Z',
          overviewSyncedAt: '2026-10-01T12:00:00.000Z',
          announcementsStatus: 'complete',
          announcementsSyncedAt: '2026-10-01T12:00:00.000Z',
          assignmentsStatus: 'complete',
          assignmentsSyncedAt: '2026-10-01T12:00:00.000Z',
          announcementCount: 0,
          assignmentCount: 0,
        },
      }),
    );
  });

  await click(button('Hidden records for Biology 101'));
  await settle();
  expect(listSuppressions).toHaveBeenCalledWith({
    connectionId: 'connection-1',
    courseId: 'course-1',
    limit: 50,
  });
  expect(document.body.textContent).toContain('No hidden records');
});

it('labels source record removal as a reversible hide', async () => {
  window.scholar = {
    listCourseRecordSuppressions: vi.fn(async () => []),
    restoreCourseRecordSuppression: vi.fn(async () => undefined),
    updateCourseRecord: vi.fn(async () => undefined),
    deleteCourseRecord: vi.fn(async () => undefined),
  } as unknown as typeof window.scholar;
  await act(async () => {
    root.render(
      createElement(CourseRecordActions, {
        kind: 'courses',
        courseId: 'course-1',
        course: {
          id: 'course-1',
          name: 'Biology 101',
          code: null,
          term: null,
          instructor: null,
          description: null,
          url: 'https://canvas.school.edu/courses/1',
          connectionId: 'connection-1',
          active: true,
          sourceName: 'Canvas',
          sourceHost: 'canvas.school.edu',
          sourceState: 'connected',
          lastSeenAt: '2026-10-01T12:00:00.000Z',
          overviewSyncedAt: '2026-10-01T12:00:00.000Z',
          announcementsStatus: 'complete',
          announcementsSyncedAt: '2026-10-01T12:00:00.000Z',
          assignmentsStatus: 'complete',
          assignmentsSyncedAt: '2026-10-01T12:00:00.000Z',
          announcementCount: 0,
          assignmentCount: 0,
          local: {
            source: {
              name: 'Biology 101',
              code: null,
              term: null,
              instructor: null,
              description: null,
            },
            effective: {
              name: 'Biology 101',
              code: null,
              term: null,
              instructor: null,
              description: null,
            },
            overrides: {},
            overriddenFields: [],
            localEditedAt: null,
            sourceUncertain: false,
            origin: 'source',
          },
        },
      }),
    );
  });

  await click(button('Actions for Biology 101'));
  const menuItems = [...document.querySelectorAll('[role="menuitem"]')];
  expect(menuItems.map((item) => item.textContent?.trim())).toContain('Hide');
  expect(menuItems.map((item) => item.textContent?.trim())).not.toContain(
    'Delete',
  );
  await click(menuItems.find((item) => item.textContent?.includes('Hide'))!);
  expect(document.body.textContent).toContain(
    'Restore them later from Hidden records',
  );
  expect(window.scholar.deleteCourseRecord).not.toHaveBeenCalled();
});

it('shows field-level source resets only for overridden course fields', async () => {
  const onReset = vi.fn(async () => undefined);
  const local: CourseLocalOverrideView = {
    source: {
      name: 'Biology from source',
      code: 'BIO 101',
      term: 'Fall 2026',
      instructor: 'Dr. Source',
      description: null,
    },
    effective: {
      name: 'My Biology',
      code: 'BIO 101',
      term: 'Fall 2026',
      instructor: 'Dr. Source',
      description: null,
    },
    overrides: { name: 'My Biology' },
    overriddenFields: ['name'],
    localEditedAt: '2026-10-01T12:00:00.000Z',
    sourceUncertain: false,
    origin: 'source',
  };
  await act(async () => {
    root.render(
      createElement(CourseRecordEditor, {
        course: {
          id: 'course-1',
          name: 'My Biology',
          code: 'BIO 101',
          term: 'Fall 2026',
          instructor: 'Dr. Source',
          description: null,
          url: 'https://canvas.school.edu/courses/1',
          active: true,
          connectionId: 'connection-1',
          sourceName: 'Canvas',
          sourceHost: 'canvas.school.edu',
          sourceState: 'connected',
          lastSeenAt: '2026-10-01T12:00:00.000Z',
          overviewSyncedAt: '2026-10-01T12:00:00.000Z',
          announcementsStatus: 'complete',
          announcementsSyncedAt: '2026-10-01T12:00:00.000Z',
          assignmentsStatus: 'complete',
          assignmentsSyncedAt: '2026-10-01T12:00:00.000Z',
          announcementCount: 0,
          assignmentCount: 0,
          local,
        },
        local,
        onSave: vi.fn(async () => undefined),
        onCancel: vi.fn(),
        onReset,
      }),
    );
  });

  expect(button('Reset Name to source')).toBeDefined();
  expect(
    [...document.querySelectorAll('button')].some(
      (item) => item.getAttribute('aria-label') === 'Reset Code to source',
    ),
  ).toBe(false);
  await click(button('Reset Name to source'));
  expect(onReset).toHaveBeenCalledWith(['name']);
});

it('uses effective child values and resets a due-date override as one field group', async () => {
  const local: CourseChildLocalOverrideView = {
    source: {
      title: 'Essay from source',
      body: 'Source directions',
      dateValue: '2026-12-15',
      dateText: 'December 15, 2026',
    },
    effective: {
      title: 'My essay title',
      body: 'My local notes',
      dateValue: '2026-12-02',
      dateText: '2026-12-02',
    },
    overrides: {
      title: 'My essay title',
      body: 'My local notes',
      dateValue: '2026-12-02',
      dateText: '2026-12-02',
    },
    overriddenFields: ['title', 'body', 'dateValue', 'dateText'],
    localEditedAt: '2026-10-01T12:00:00.000Z',
    sourceUncertain: false,
    origin: 'source',
  };
  const onReset = vi.fn(async () => undefined);
  await act(async () => {
    root.render(
      createElement(CourseChildEditor, {
        kind: 'assignments',
        item: {
          id: 'assignment-1',
          title: 'My essay title',
          body: 'My local notes',
          dateValue: '2026-12-02',
          dateText: '2026-12-02',
          url: 'https://canvas.school.edu/courses/1/assignments/essay-1',
          active: true,
          lastSeenAt: '2026-10-01T12:00:00.000Z',
          content: {
            title: 'Essay from source',
            description: 'Source directions',
            kind: 'assignment',
            state: 'active-unsubmitted',
            due: {
              kind: 'date',
              date: '2026-12-15',
              original: 'December 15, 2026',
            },
            availableFrom: null,
            availableUntil: null,
            pointsPossible: null,
            sourceId: 'essay-1',
            url: 'https://canvas.school.edu/courses/1/assignments/essay-1',
            resources: [],
            evidence: {
              sourceUrl: 'https://canvas.school.edu/courses/1/assignments',
              excerpts: ['Essay from source essay-1'],
              targetIds: [],
            },
          },
          local,
        },
        local,
        onSave: vi.fn(async () => undefined),
        onCancel: vi.fn(),
        onReset,
      }),
    );
  });

  expect(
    document.querySelector<HTMLInputElement>('input[name="title"]')?.value,
  ).toBe('My essay title');
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value,
  ).toBe('My local notes');
  await click(button('Reset Due date to source'));
  expect(onReset).toHaveBeenCalledWith(['dateValue', 'dateText']);
});
