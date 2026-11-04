// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ContextItemDTO } from '@scholaros/services/learning/context-contracts';
import type {
  CreateStudySessionInput,
  StudySessionDTO,
} from '@scholaros/services/learning/study-contracts';
import type {
  CourseDetail,
  CourseSummary,
  CoursesSnapshot,
} from '../../courses/types';
import { StudySetup, type StudySetupProps } from '../components/study-setup';
import type { StudySetupPrefill } from '../components/study-landing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const course = (id: string, name: string): CourseSummary => ({
  id,
  name,
  code: 'BIOL 101',
  term: 'Fall 2026',
  url: `https://school.example/courses/${id}`,
  connectionId: 'connection-1',
  active: true,
  sourceName: 'Canvas',
  sourceHost: 'school.example',
  sourceState: 'connected',
  lastSeenAt: '2026-10-25T09:00:00.000Z',
  overviewSyncedAt: '2026-10-25T09:00:00.000Z',
  announcementsStatus: 'complete',
  announcementsSyncedAt: '2026-10-25T09:00:00.000Z',
  assignmentsStatus: 'complete',
  assignmentsSyncedAt: '2026-10-25T09:00:00.000Z',
  assignmentCount: 1,
  announcementCount: 0,
});

const assignment = {
  id: 'assignment-1',
  title: 'Cell structure review',
  body: null,
  dateValue: null,
  dateText: null,
  url: 'https://school.example/assignments/1',
  active: true,
  lastSeenAt: '2026-10-25T09:00:00.000Z',
};

const courseDetail = (id = 'course-1'): CourseDetail => ({
  ...course(id, 'Biology 101'),
  instructor: null,
  description: null,
  assignments: [assignment],
  announcements: [],
});

const contextItem = (
  id: string,
  courseIds: string[] = ['course-1'],
): ContextItemDTO => ({
  id,
  title: id === 'material-1' ? 'Cell structure notes' : 'Study preferences',
  kind: 'document',
  provenance: 'user-uploaded',
  courseIds,
  currentVersionId: 'version-1',
  status: 'complete',
  usable: true,
  createdAt: '2026-10-25T09:00:00.000Z',
  updatedAt: '2026-10-25T09:00:00.000Z',
  revision: 1,
  source: null,
});

const session = (input: CreateStudySessionInput): StudySessionDTO => ({
  id: 'session-1',
  courseId: input.courseId,
  title: input.title ?? 'Biology 101 study session',
  activity: input.activity,
  targetAssignmentId: input.targetAssignmentId ?? null,
  topic: input.topic ?? null,
  status: 'saved',
  revision: 1,
  generationEpoch: 0,
  createdAt: '2026-11-03T12:00:00.000Z',
  updatedAt: '2026-11-03T12:00:00.000Z',
  lastOpenedAt: '2026-11-03T12:00:00.000Z',
  draft: { text: '', revision: 0 },
  timer: {
    deadlineAt:
      input.durationMinutes === null ? null : '2026-11-03T12:25:00.000Z',
    revision: 0,
    expiredRevision: null,
    resolvedExpiredRevision: null,
    finishedAt: null,
  },
});

let snapshot: CoursesSnapshot;
let detail: CourseDetail;
let root: ReturnType<typeof createRoot> | null = null;
let createStudySession: ReturnType<typeof vi.fn>;
let listContextItems: ReturnType<typeof vi.fn>;
let onStarted: NonNullable<StudySetupProps['onStarted']>;

const renderSetup = async (props: Partial<StudySetupProps> = {}) => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(StudySetup, {
        accountId: 'student-1',
        onStarted,
        ...props,
      }),
    );
  });
  await act(async () => {});
  return host;
};

const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (element) =>
      element.getAttribute('aria-label') === label ||
      element.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;

const setInput = async (label: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
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

const setTextarea = async (label: string, value: string) => {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  );
  expect(textarea).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(textarea, value);
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const selectOption = async (triggerLabel: string, optionLabel: string) => {
  const trigger = button(triggerLabel);
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (element) => element.textContent?.trim() === optionLabel,
  );
  expect(option).toBeTruthy();
  await act(async () => (option as HTMLElement).click());
};

const chooseCourse = async (name: string) => {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Course"]',
  );
  expect(input).toBeTruthy();
  await act(async () => {
    input!.focus();
    input!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await setInput('Course', name);
  await act(async () => {});
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (element) => element.textContent?.includes(name),
  );
  expect(option).toBeTruthy();
  await act(async () => (option as HTMLElement).click());
  await act(async () => {});
};

beforeEach(() => {
  snapshot = {
    courses: [
      course('course-1', 'Biology 101'),
      course('course-2', 'Chemistry 201'),
    ],
    sources: [],
    lastSuccessfulAt: null,
  };
  detail = courseDetail();
  onStarted = vi.fn<(session: StudySessionDTO) => void>();
  createStudySession = vi.fn(async (input: CreateStudySessionInput) =>
    session(input),
  );
  listContextItems = vi.fn(async (input: { courseId?: string | null }) => ({
    items:
      input.courseId === null
        ? [contextItem('material-global', [])]
        : [contextItem('material-1')],
    nextCursor: null,
    revision: 1,
  }));
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
    getCourses: vi.fn(async () => snapshot),
    getCourse: vi.fn(async (courseId: string) =>
      courseId === detail.id ? detail : null,
    ),
    onCoursesChange: vi.fn(() => () => {}),
    onBackgroundSyncChange: vi.fn(() => () => {}),
    createStudySession,
    listContextItems,
  } as unknown as typeof window.scholar;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

it('offers exactly the five intentional activity labels', async () => {
  await renderSetup();
  await act(async () => button('Study activity')?.click());
  const labels = [...document.querySelectorAll('[role="option"]')].map((item) =>
    item.textContent?.trim(),
  );
  expect(labels).toEqual([
    'Understand a topic',
    'Prepare for an exam',
    'Practice what I know',
    'Review graded mistakes',
    'Help me get started on an assignment',
  ]);
});

it('requires one current course and never sends an inferred or hidden second course', async () => {
  await renderSetup();
  expect(button('Start study session')?.disabled).toBe(true);
  await selectOption('Study activity', 'Understand a topic');
  await chooseCourse('Biology 101');
  await act(async () => button('Start study session')?.click());
  expect(createStudySession).toHaveBeenCalledOnce();
  const input = createStudySession.mock.calls[0][0] as CreateStudySessionInput;
  expect(input).toMatchObject({
    courseId: 'course-1',
    activity: 'understand-topic',
    contextItemIds: [],
    durationMinutes: 25,
  });
  expect(Object.keys(input).sort()).toEqual([
    'activity',
    'contextItemIds',
    'courseId',
    'durationMinutes',
    'requestId',
  ]);
  expect(onStarted).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'session-1' }),
  );
});

it('prefills a recommendation without creating a session or starting inference', async () => {
  const prefill: StudySetupPrefill = {
    activity: 'prepare-exam',
    courseId: 'course-1',
    targetAssignmentId: 'assignment-1',
    topic: 'Cell membranes',
    contextItemIds: ['material-1'],
  };
  await renderSetup({ initialSetup: prefill });
  expect(createStudySession).not.toHaveBeenCalled();
  expect(text()).toContain('Cell membranes');
  expect(text()).toContain('Cell structure notes');
  expect(text()).toContain('Prepare for an exam');
});

it('prefills allowed materials only for their original course selection', async () => {
  await renderSetup({
    initialSetup: {
      activity: 'understand-topic',
      courseId: 'course-1',
      contextItemIds: ['material-1'],
    },
  });
  const material = document.getElementById('study-material-material-1');
  expect((material as HTMLInputElement | null)?.checked).toBe(true);
  await chooseCourse('Chemistry 201');
  expect(text()).not.toContain(
    'Some recommended materials are no longer available for this course',
  );
});

it('accepts a material linked to the selected course in any position', async () => {
  listContextItems.mockImplementation(
    async (input: { courseId?: string | null }) => ({
      items:
        input.courseId === 'course-2'
          ? [contextItem('shared-material', ['course-1', 'course-2'])]
          : [],
      nextCursor: null,
      revision: 1,
    }),
  );
  await renderSetup({
    initialSetup: {
      activity: 'understand-topic',
      courseId: 'course-2',
      contextItemIds: ['shared-material'],
    },
  });
  expect(text()).toContain('Study preferences');
  expect(
    (
      document.getElementById(
        'study-material-shared-material',
      ) as HTMLInputElement | null
    )?.checked,
  ).toBe(true);
});

it('rejects a stale course and a target that no longer belongs to the selected course', async () => {
  await renderSetup({
    initialSetup: {
      activity: 'assignment-start',
      courseId: 'course-missing',
      targetAssignmentId: 'assignment-1',
    },
  });
  expect(text()).toContain(
    'That course is no longer available. Select a current course to continue.',
  );
  expect(button('Start study session')?.disabled).toBe(true);
  expect(createStudySession).not.toHaveBeenCalled();

  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  await renderSetup({
    initialSetup: {
      activity: 'assignment-start',
      courseId: 'course-1',
      targetAssignmentId: 'stale-assignment',
    },
  });
  expect(text()).toContain(
    'The recommended assignment is no longer available in this course.',
  );
  expect(button('Start study session')?.disabled).toBe(true);
  expect(createStudySession).not.toHaveBeenCalled();
});

it('rejects an inactive assignment as a stale setup target', async () => {
  detail = {
    ...detail,
    assignments: [{ ...assignment, active: false }],
  };
  await renderSetup({
    initialSetup: {
      activity: 'assignment-start',
      courseId: 'course-1',
      targetAssignmentId: 'assignment-1',
    },
  });
  expect(text()).toContain(
    'The recommended assignment is no longer available in this course.',
  );
  expect(button('Start study session')?.disabled).toBe(true);
  expect(createStudySession).not.toHaveBeenCalled();
});

it('gives saved-material checkboxes an enclosing accessible label', async () => {
  await renderSetup({
    initialSetup: { activity: 'understand-topic', courseId: 'course-1' },
  });
  const checkbox = document.getElementById('study-material-material-1');
  expect(checkbox?.closest('label')).not.toBeNull();
});

it('selects optional topic and materials, and creates an untimed session', async () => {
  await renderSetup();
  await selectOption('Study activity', 'Practice what I know');
  await chooseCourse('Biology 101');
  await setTextarea('Topic or study goal', 'Cell membranes');
  const material = [...document.querySelectorAll('label')].find((label) =>
    label.textContent?.includes('Cell structure notes'),
  );
  expect(material).not.toBeNull();
  await act(async () => (material as HTMLLabelElement).click());
  await selectOption('Study duration', 'Untimed');
  await act(async () => button('Start study session')?.click());
  expect(createStudySession).toHaveBeenCalledOnce();
  expect(createStudySession.mock.calls[0][0]).toMatchObject({
    courseId: 'course-1',
    activity: 'practice-knowledge',
    topic: 'Cell membranes',
    contextItemIds: ['material-1'],
    durationMinutes: null,
  });
});

it('explains that graded-mistake review still requires connected verification', async () => {
  await renderSetup({ initialSetup: { activity: 'review-graded-mistakes' } });
  expect(text()).toContain(
    'Reviewing graded mistakes requires current connected-source verification.',
  );
  expect(text()).toContain(
    'Choosing this activity does not grant permission to view grades or answers.',
  );
});

it('keeps setup choices after a failed create and prevents a duplicate while pending', async () => {
  let finish: ((value: StudySessionDTO) => void) | undefined;
  createStudySession.mockImplementationOnce(
    () =>
      new Promise<StudySessionDTO>((resolve) => {
        finish = resolve;
      }),
  );
  await renderSetup({
    initialSetup: {
      activity: 'understand-topic',
      courseId: 'course-1',
      topic: 'Mitosis',
    },
  });
  const start = button('Start study session');
  expect(start?.disabled).toBe(false);
  await act(async () => start?.click());
  expect(start?.disabled).toBe(true);
  await act(async () => start?.click());
  expect(createStudySession).toHaveBeenCalledOnce();
  await act(async () =>
    finish?.(
      session(createStudySession.mock.calls[0][0] as CreateStudySessionInput),
    ),
  );
  expect(onStarted).toHaveBeenCalledOnce();
  expect(text()).toContain('Mitosis');
});

it('does not navigate after setup unmounts while session creation is pending', async () => {
  let finish: ((value: StudySessionDTO) => void) | undefined;
  createStudySession.mockImplementationOnce(
    () =>
      new Promise<StudySessionDTO>((resolve) => {
        finish = resolve;
      }),
  );
  await renderSetup({
    initialSetup: { activity: 'understand-topic', courseId: 'course-1' },
  });
  await act(async () => button('Start study session')?.click());
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  await act(async () =>
    finish?.(
      session(createStudySession.mock.calls[0][0] as CreateStudySessionInput),
    ),
  );
  expect(onStarted).not.toHaveBeenCalled();
});

it('retries navigation from the persisted session without creating another session', async () => {
  const onStarted = vi
    .fn<(session: StudySessionDTO) => Promise<void>>()
    .mockRejectedValueOnce(new Error('Navigation is temporarily unavailable.'));
  await renderSetup({
    initialSetup: { activity: 'understand-topic', courseId: 'course-1' },
    onStarted,
  });
  await act(async () => button('Start study session')?.click());
  expect(createStudySession).toHaveBeenCalledOnce();
  expect(text()).toContain(
    'Your session is saved, but could not be opened. Resume it from study history.',
  );
  await act(async () => button('Start study session')?.click());
  expect(createStudySession).toHaveBeenCalledOnce();
  expect(onStarted).toHaveBeenCalledTimes(2);
});

it('keeps a custom duration within the inclusive 1 to 240 minute range', async () => {
  await renderSetup({
    initialSetup: { activity: 'understand-topic', courseId: 'course-1' },
  });
  await selectOption('Study duration', 'Custom duration');
  await setInput('Custom duration in minutes', '241');
  expect(button('Start study session')?.disabled).toBe(true);
  expect(text()).toContain('Choose a duration from 1 to 240 minutes.');
  await setInput('Custom duration in minutes', '1');
  expect(button('Start study session')?.disabled).toBe(false);
  await setInput('Custom duration in minutes', '240');
  expect(button('Start study session')?.disabled).toBe(false);
});

it('shows a read-only offline history notice and does not create a session', async () => {
  await renderSetup({
    offline: true,
    initialSetup: { activity: 'understand-topic', courseId: 'course-1' },
  });
  expect(text()).toContain(
    'Offline history is read-only. Reconnect to start or change a study session.',
  );
  expect(button('Start study session')?.disabled).toBe(true);
  expect(createStudySession).not.toHaveBeenCalled();
});

it('preserves setup and reuses each request ID after a failed create and edits', async () => {
  createStudySession.mockRejectedValueOnce(
    new Error('Storage is temporarily unavailable.'),
  );
  await renderSetup({
    initialSetup: {
      activity: 'understand-topic',
      courseId: 'course-1',
      topic: 'Mitosis',
    },
  });
  await act(async () => button('Start study session')?.click());
  const firstRequest = createStudySession.mock
    .calls[0][0] as CreateStudySessionInput;
  expect(text()).toContain('Storage is temporarily unavailable.');
  expect(
    (
      document.querySelector(
        'textarea[aria-label="Topic or study goal"]',
      ) as HTMLTextAreaElement
    )?.value,
  ).toBe('Mitosis');
  await setTextarea('Topic or study goal', 'Cell division');
  await act(async () => button('Start study session')?.click());
  const editedRequest = createStudySession.mock
    .calls[1][0] as CreateStudySessionInput;
  expect(editedRequest.requestId).not.toBe(firstRequest.requestId);
  expect(editedRequest.topic).toBe('Cell division');
  await setTextarea('Topic or study goal', 'Mitosis');
  await act(async () => button('Start study session')?.click());
  const retryRequest = createStudySession.mock
    .calls[2][0] as CreateStudySessionInput;
  expect(retryRequest.requestId).toBe(firstRequest.requestId);
  expect(retryRequest.topic).toBe('Mitosis');
  expect(onStarted).toHaveBeenCalledTimes(2);
});
