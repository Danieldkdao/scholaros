// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Page } from '@scholaros/services/learning/product-contracts';
import type { StudySessionDTO } from '@scholaros/services/learning/study-contracts';
import type { CourseSummary, CoursesSnapshot } from '../../courses/types';
import { StudyHistory } from '../components/study-history';
import { useStudyHistory } from '../hooks/use-study-history';
import {
  formatStudyActivity,
  formatStudySessionStatus,
} from '../lib/formatters';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const course = (id: string, name: string): CourseSummary => ({
  id,
  name,
  code: null,
  term: null,
  url: `https://school.example/courses/${id}`,
  connectionId: null,
  active: true,
  sourceName: 'Manual',
  sourceHost: 'school.example',
  sourceState: 'manual',
  lastSeenAt: '2026-10-25T09:00:00.000Z',
  overviewSyncedAt: null,
  announcementsStatus: 'pending',
  announcementsSyncedAt: null,
  assignmentsStatus: 'pending',
  assignmentsSyncedAt: null,
  assignmentCount: 0,
  announcementCount: 0,
});

const session = (
  id: string,
  status: StudySessionDTO['status'],
  overrides: Partial<StudySessionDTO> = {},
): StudySessionDTO => ({
  id,
  courseId: id === 'session-2' ? 'course-2' : 'course-1',
  title: id === 'session-1' ? 'Biology review' : `Study session ${id}`,
  activity: 'understand-topic',
  targetAssignmentId: null,
  topic: 'Cell structure',
  status,
  revision: 4,
  generationEpoch: 0,
  createdAt: '2026-10-25T09:00:00.000Z',
  updatedAt: '2026-11-03T12:00:00.000Z',
  lastOpenedAt: '2026-11-03T12:00:00.000Z',
  draft: { text: '', revision: 0 },
  timer: {
    deadlineAt: null,
    revision: 0,
    expiredRevision: null,
    resolvedExpiredRevision: null,
    finishedAt: null,
  },
  ...overrides,
});

let snapshot: CoursesSnapshot;
let page: Page<StudySessionDTO>;
let root: ReturnType<typeof createRoot> | null = null;
let listStudySessions: ReturnType<typeof vi.fn>;
let renameStudySession: ReturnType<typeof vi.fn>;
let deleteStudySession: ReturnType<typeof vi.fn>;
let onResume: (sessionId: string) => void | Promise<void>;

const renderHistory = async (props: { offline?: boolean } = {}) => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(StudyHistory, {
        accountId: 'student-1',
        onResume,
        ...props,
      }),
    );
  });
  await act(async () => {});
  return host;
};

const HistoryRequestProbe = ({ accountId }: { accountId: string | null }) => {
  useStudyHistory({ accountId });
  return null;
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

const selectOption = async (triggerLabel: string, optionLabel: string) => {
  let trigger = button(triggerLabel);
  if (!trigger) {
    await act(async () => button('Study history filters')!.click());
    trigger = button(triggerLabel);
  }
  expect(trigger).toBeDefined();
  await act(async () => trigger!.click());
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (element) => element.textContent?.trim() === optionLabel,
  );
  expect(option).not.toBeNull();
  await act(async () => (option as HTMLElement).click());
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
  page = {
    items: [
      session('session-1', 'saved'),
      session('session-2', 'in-progress'),
      session('session-3', 'finished'),
      session('session-4', 'interrupted'),
    ],
    nextCursor: null,
    revision: 1,
  };
  listStudySessions = vi.fn(async () => page);
  renameStudySession = vi.fn(
    async (input: {
      sessionId: string;
      title: string;
      expectedRevision: number;
    }) =>
      session(input.sessionId, 'saved', {
        title: input.title,
        revision: input.expectedRevision + 1,
      }),
  );
  deleteStudySession = vi.fn(async () => undefined);
  onResume = vi.fn<(sessionId: string) => void>();
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
    onCoursesChange: vi.fn(() => () => {}),
    onBackgroundSyncChange: vi.fn(() => () => {}),
    listStudySessions,
    renameStudySession,
    deleteStudySession,
  } as unknown as typeof window.scholar;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

it('formats all five activities and all four saved session states exhaustively', () => {
  expect([
    formatStudyActivity('understand-topic').label,
    formatStudyActivity('prepare-exam').label,
    formatStudyActivity('practice-knowledge').label,
    formatStudyActivity('review-graded-mistakes').label,
    formatStudyActivity('assignment-start').label,
  ]).toEqual([
    'Understand a topic',
    'Prepare for an exam',
    'Practice what I know',
    'Review graded mistakes',
    'Help me get started on an assignment',
  ]);
  expect([
    formatStudySessionStatus('saved').label,
    formatStudySessionStatus('in-progress').label,
    formatStudySessionStatus('finished').label,
    formatStudySessionStatus('interrupted').label,
  ]).toEqual(['Saved', 'In progress', 'Finished', 'Interrupted']);
});

it('shows exact saved metadata and resumes the existing session without creating a copy', async () => {
  await renderHistory();
  expect(text()).toContain('Biology review');
  expect(text()).toContain('Biology 101');
  expect(text()).toContain('Understand a topic');
  expect(text()).toContain('Saved');
  expect(
    document.querySelector('time[datetime="2026-11-03T12:00:00.000Z"]'),
  ).not.toBeNull();
  await act(async () => button('Resume session: Biology review')?.click());
  expect(onResume).toHaveBeenCalledWith('session-1');
  expect(listStudySessions).toHaveBeenCalledOnce();
});

it('searches and filters history by one course and status through the paged read', async () => {
  await renderHistory();
  vi.useFakeTimers();
  await setInput('Search study history', 'biology');
  await selectOption('History course', 'Biology 101');
  await selectOption('History status', 'Finished');
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(listStudySessions).toHaveBeenLastCalledWith({
    query: 'biology',
    courseId: 'course-1',
    status: 'finished',
    limit: 25,
  });
});

it('loads the next page without duplicating session IDs', async () => {
  page = {
    items: [session('session-1', 'saved')],
    nextCursor: 'cursor-1',
    revision: 1,
  };
  listStudySessions.mockImplementation(async (input: { cursor?: string }) =>
    input.cursor
      ? {
          items: [
            session('session-1', 'saved', { title: 'Updated biology review' }),
            session('session-5', 'finished'),
          ],
          nextCursor: null,
          revision: 2,
        }
      : page,
  );
  await renderHistory();
  expect(text()).toContain('Load more sessions');
  await act(async () => button('Load more sessions')?.click());
  expect(listStudySessions).toHaveBeenLastCalledWith({
    cursor: 'cursor-1',
    limit: 25,
  });
  expect(
    document.querySelectorAll('[data-study-session-id="session-1"]'),
  ).toHaveLength(1);
  expect(text()).toContain('Updated biology review');
  expect(text()).toContain('Study session session-5');
});

it('releases load-more state when a filter refresh supersedes the page request', async () => {
  page = {
    items: [session('session-1', 'saved')],
    nextCursor: 'cursor-1',
    revision: 1,
  };
  let finishMore: ((result: Page<StudySessionDTO>) => void) | undefined;
  listStudySessions.mockImplementation((input: { cursor?: string }) =>
    input.cursor
      ? new Promise<Page<StudySessionDTO>>((resolve) => {
          finishMore = resolve;
        })
      : Promise.resolve(page),
  );
  await renderHistory();
  await act(async () => button('Load more sessions')?.click());
  expect(button('Load more sessions')?.disabled).toBe(true);
  await selectOption('History status', 'Finished');
  await act(async () => {});
  expect(button('Load more sessions')?.disabled).toBe(false);
  await act(async () =>
    finishMore?.({ items: [], nextCursor: null, revision: 1 }),
  );
});

it('preserves the rename draft and leaves the dialog open when revision checking fails', async () => {
  renameStudySession.mockRejectedValueOnce(
    new Error('The session changed. Reload and try again.'),
  );
  await renderHistory();
  await act(async () => button('Rename session: Biology review')?.click());
  await setInput('Session title', 'Renamed biology review');
  await act(async () => button('Rename session')?.click());
  expect(renameStudySession).toHaveBeenCalledWith({
    sessionId: 'session-1',
    title: 'Renamed biology review',
    expectedRevision: 4,
  });
  expect(
    (
      document.querySelector(
        'input[aria-label="Session title"]',
      ) as HTMLInputElement
    )?.value,
  ).toBe('Renamed biology review');
  expect(text()).toContain('The session changed. Reload and try again.');
});

it('hides a renamed session when it no longer matches the active search', async () => {
  listStudySessions.mockImplementation(async (input: { query?: string }) => {
    const matches = page.items.some((item) =>
      item.title.toLowerCase().includes(input.query?.toLowerCase() ?? ''),
    );
    return input.query && !matches
      ? { items: [], nextCursor: null, revision: page.revision }
      : page;
  });
  renameStudySession.mockImplementationOnce(async (input) => {
    const renamed = session(input.sessionId, 'saved', {
      title: input.title,
      revision: input.expectedRevision + 1,
    });
    page = {
      ...page,
      items: page.items.map((item) =>
        item.id === renamed.id ? renamed : item,
      ),
      revision: page.revision + 1,
    };
    return renamed;
  });
  await renderHistory();
  vi.useFakeTimers();
  await setInput('Search study history', 'biology');
  await act(async () => vi.advanceTimersByTimeAsync(250));
  await act(async () => button('Rename session: Biology review')?.click());
  await setInput('Session title', 'Chemistry review');
  await act(async () => button('Rename session')?.click());
  expect(text()).toContain('No matching study sessions');
  expect(
    document.querySelector('[data-study-session-id="session-1"]'),
  ).toBeNull();
});

it('renames the session using its current revision', async () => {
  await renderHistory();
  await act(async () => button('Rename session: Biology review')?.click());
  await setInput('Session title', 'Cell membranes');
  await act(async () => button('Rename session')?.click());
  expect(text()).toContain('Cell membranes');
  expect(renameStudySession).toHaveBeenCalledWith({
    sessionId: 'session-1',
    title: 'Cell membranes',
    expectedRevision: 4,
  });
});

it('confirms transcript deletion while explaining independently retained data', async () => {
  await renderHistory();
  await act(async () => button('Delete session: Biology review')?.click());
  expect(text()).toContain(
    'Deleting removes the session transcript. Separately saved Context items, artifacts, memories, and learning observations stay available and can be removed separately.',
  );
  await act(async () => button('Cancel')?.click());
  expect(deleteStudySession).not.toHaveBeenCalled();
  await act(async () => button('Delete session: Biology review')?.click());
  await act(async () => button('Delete session')?.click());
  expect(deleteStudySession).toHaveBeenCalledWith({
    sessionId: 'session-1',
    expectedRevision: 4,
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
  });
  expect(
    document.querySelector('[data-study-session-id="session-1"]'),
  ).toBeNull();
});

it('reuses a delete request ID when retrying the same revision after an error', async () => {
  deleteStudySession.mockRejectedValueOnce(
    new Error('The service is offline.'),
  );
  await renderHistory();
  await act(async () => button('Delete session: Biology review')?.click());
  await act(async () => button('Delete session')?.click());
  const firstRequest = deleteStudySession.mock.calls[0][0] as {
    requestId: string;
    expectedRevision: number;
  };
  expect(text()).toContain('The service is offline.');
  await act(async () => button('Delete session')?.click());
  const retryRequest = deleteStudySession.mock.calls[1][0] as {
    requestId: string;
    expectedRevision: number;
  };
  expect(retryRequest.requestId).toBe(firstRequest.requestId);
  expect(retryRequest.expectedRevision).toBe(firstRequest.expectedRevision);
});

it('fills the list from the next page after deleting its last visible session', async () => {
  page = {
    items: [session('session-1', 'saved')],
    nextCursor: 'cursor-1',
    revision: 1,
  };
  listStudySessions.mockImplementation(async () => page);
  deleteStudySession.mockImplementationOnce(async () => {
    page = {
      items: [session('session-2', 'in-progress')],
      nextCursor: null,
      revision: 2,
    };
  });
  await renderHistory();
  await act(async () => button('Delete session: Biology review')?.click());
  await act(async () => button('Delete session')?.click());
  await act(async () => {});
  expect(text()).toContain('Study session session-2');
  expect(text()).not.toContain('No study sessions yet');
});

it('does not resurrect a deleted session from an older in-flight history snapshot', async () => {
  await renderHistory();
  let finishList: ((page: Page<StudySessionDTO>) => void) | undefined;
  listStudySessions.mockImplementationOnce(
    () =>
      new Promise<Page<StudySessionDTO>>((resolve) => {
        finishList = resolve;
      }),
  );
  await act(async () => button('Refresh history')?.click());
  await act(async () => button('Delete session: Biology review')?.click());
  await act(async () => button('Delete session')?.click());
  await act(async () =>
    finishList?.({
      items: [session('session-1', 'saved')],
      nextCursor: null,
      revision: 1,
    }),
  );
  expect(
    document.querySelector('[data-study-session-id="session-1"]'),
  ).toBeNull();
});

it('keeps authorized offline history readable but disables rename and delete', async () => {
  await renderHistory({ offline: true });
  expect(text()).toContain('Offline history is read-only');
  expect(text()).toContain('Biology review');
  expect(button('Rename session: Biology review')?.disabled).toBe(true);
  expect(button('Delete session: Biology review')?.disabled).toBe(true);
  expect(renameStudySession).not.toHaveBeenCalled();
  expect(deleteStudySession).not.toHaveBeenCalled();
});

it('announces loading until the first history page resolves', async () => {
  let finishList: ((result: Page<StudySessionDTO>) => void) | undefined;
  listStudySessions.mockImplementationOnce(
    () =>
      new Promise<Page<StudySessionDTO>>((resolve) => {
        finishList = resolve;
      }),
  );
  await renderHistory();
  expect(text()).toContain('Loading study history');
  expect(text()).not.toContain('No study sessions yet');
  await act(async () => finishList?.(page));
  expect(text()).toContain('Biology review');
});

it('distinguishes a failed history read from an empty saved history', async () => {
  listStudySessions.mockResolvedValueOnce(null);
  await renderHistory();
  expect(text()).toContain('Could not load your study history.');
  expect(text()).not.toContain('No study sessions yet.');

  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  listStudySessions.mockResolvedValue({
    items: [],
    nextCursor: null,
    revision: 1,
  });
  await renderHistory();
  expect(text()).toContain('No study sessions yet');
});

it('does not request history without an account, even when the window regains focus', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(HistoryRequestProbe, { accountId: null }));
  });
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(listStudySessions).not.toHaveBeenCalled();
});
