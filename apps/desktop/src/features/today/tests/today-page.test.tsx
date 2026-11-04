// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type {
  Recommendation,
  TodayOverview,
} from '@scholaros/services/learning/today-contracts';
import type { StudySessionDTO } from '@scholaros/services/learning/study-contracts';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  today: {
    snapshot: null as TodayOverview | null,
    loading: false,
    error: null as string | null,
    offline: false,
    reload: vi.fn(),
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock('../hooks/use-today', () => ({
  useToday: () => mocks.today,
}));

import { TodayPage } from '../components/today-page';

let root: Root;
let container: HTMLDivElement;

const overview = (overrides: Partial<TodayOverview> = {}): TodayOverview => ({
  attention: [],
  freshness: [],
  upcoming: [],
  announcements: [],
  recentCourses: [],
  recentMaterials: [],
  recentSessions: [],
  progress: {
    courseId: null,
    strengths: [],
    practiceTopics: [],
    recentChanges: [],
    unknownCount: 0,
    revision: 0,
  },
  recommendations: [],
  revision: 1,
  ...overrides,
});

const recommendation: Recommendation = {
  id: 'recommendation-1',
  courseId: 'biology',
  activity: 'prepare-exam',
  targetAssignmentId: 'exam-1',
  topic: null,
  reason: 'Your Biology exam is listed for November 8.',
  sourceReferences: [
    {
      sourceKind: 'assignment',
      sourceId: 'exam-1',
      versionId: null,
      courseId: 'biology',
      locator: null,
      title: 'Cell biology exam',
      provenance: 'connected-source',
      observedAt: '2026-11-03T12:00:00Z',
      state: 'current',
    },
  ],
  inputsRevision: 3,
};

const recentSession: StudySessionDTO = {
  id: 'session-1',
  courseId: 'biology',
  title: 'Cell biology review',
  activity: 'understand-topic',
  targetAssignmentId: null,
  topic: 'Cell division',
  status: 'interrupted',
  revision: 4,
  generationEpoch: 1,
  createdAt: '2026-11-02T12:00:00Z',
  updatedAt: '2026-11-03T11:30:00Z',
  lastOpenedAt: '2026-11-03T11:30:00Z',
  draft: { text: 'Keep my notes', revision: 2 },
  timer: {
    deadlineAt: null,
    revision: 0,
    expiredRevision: null,
    resolvedExpiredRevision: null,
    finishedAt: null,
  },
};

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.navigate.mockReset();
  mocks.today.snapshot = overview();
  mocks.today.loading = false;
  mocks.today.error = null;
  mocks.today.offline = false;
  mocks.today.reload.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

const DefaultProgressSummaryComponent = ({
  accountId,
}: {
  accountId: string;
}) => createElement('p', null, `Progress for ${accountId}`);

const renderPage = async (props: Record<string, unknown> = {}) => {
  await act(async () => {
    root.render(
      createElement(TodayPage, {
        accountId: 'student-a',
        ProgressSummaryComponent: DefaultProgressSummaryComponent,
        ...props,
      }),
    );
  });
};

const click = async (name: string) => {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name ||
      candidate.textContent?.trim() === name,
  );
  expect(button, `missing button ${name}`).toBeTruthy();
  await act(async () =>
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
};

describe('TodayPage', () => {
  it('does not present an unselected account as a Today load failure', async () => {
    mocks.today.snapshot = null;
    mocks.today.loading = false;
    await renderPage({ accountId: null });

    expect(container.textContent).toContain('Waiting for your account');
    expect(container.textContent).not.toContain('Retry Today overview');
    expect(container.textContent).not.toContain('Today could not load');
  });

  it('gives a new account useful next actions without invented cards', async () => {
    mocks.today.snapshot = overview();
    await renderPage();

    expect(container.textContent).toContain('Connect a course');
    expect(container.textContent).toContain('No upcoming assignments or exams');
    expect(container.textContent).not.toMatch(/\b\d+%\b|overdue|mastered/i);
    expect(
      container.querySelectorAll('[data-slot="card"]').length,
    ).toBeGreaterThan(0);
    expect(container.querySelector('[data-slot="empty"]')).toBeTruthy();
  });

  it('opens Connections, Context and Settings from their quick actions', async () => {
    await renderPage();

    await click('Manage connections');
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '/dashboard/connections',
    });

    await click('Open Context');
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '/dashboard/context',
    });

    await click('Open settings');
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '/dashboard/settings',
      search: { section: 'connections' },
    });
  });

  it('prefills one course and target without creating or starting a session', async () => {
    mocks.today.snapshot = overview({ recommendations: [recommendation] });
    await renderPage();

    expect(container.textContent).toContain(recommendation.reason);
    await click('Prepare for exam');

    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '/dashboard/study',
      search: {
        activity: 'prepare-exam',
        courseId: 'biology',
        targetAssignmentId: 'exam-1',
      },
    });
  });

  it('opens a still-current course source only through the guarded source action', async () => {
    const getCourse = vi.fn(
      async () =>
        ({
          assignments: [
            {
              id: 'exam-1',
              active: true,
              url: 'https://school.example.test/courses/biology/assignments/exam-1',
            },
          ],
          announcements: [],
        }) as unknown as Awaited<ReturnType<typeof window.scholar.getCourse>>,
    );
    const openSource = vi.fn(async () => undefined);
    window.scholar = {
      getCourse,
      openSource,
    } as unknown as typeof window.scholar;
    mocks.today.snapshot = overview({ recommendations: [recommendation] });
    await renderPage();

    await click('View assignment in course');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getCourse).toHaveBeenCalledWith('biology');
    expect(openSource).toHaveBeenCalledWith(
      'https://school.example.test/courses/biology/assignments/exam-1',
    );
  });

  it('resumes the existing session and preserves its saved state', async () => {
    mocks.today.snapshot = overview({ recentSessions: [recentSession] });
    await renderPage();

    expect(container.textContent).toContain(recentSession.title);
    expect(container.textContent).toContain(recentSession.draft.text);
    await click('Resume session');

    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: '/study/$sessionId',
      params: { sessionId: 'session-1' },
    });
  });

  it('renders the shared progress summary supplied by the integration layer', async () => {
    const ProgressSummaryComponent = ({ accountId }: { accountId: string }) =>
      createElement('p', null, `Progress for ${accountId}`);
    await renderPage({ ProgressSummaryComponent });

    expect(container.textContent).toContain('Progress for student-a');
  });

  it('keeps the previous snapshot visible with an offline notice and retry action', async () => {
    mocks.today.error = 'Could not reach the local service.';
    mocks.today.offline = true;
    await renderPage();

    expect(container.textContent).toContain(
      'Saved information may be out of date',
    );
    expect(container.textContent).toContain(
      'Connect again to refresh this overview',
    );
    await click('Retry Today overview');
    expect(mocks.today.reload).toHaveBeenCalledOnce();
  });
});

it('keeps a populated course list free of a contradictory materials empty card', async () => {
  mocks.today.snapshot = overview({
    recentCourses: [
      {
        id: 'biology',
        name: 'Biology',
        code: null,
        term: null,
        connectionId: null,
        active: true,
        sourceName: 'Schoology',
        sourceHost: 'school.example.test',
        lastSeenAt: '2026-11-03T12:00:00Z',
        assignmentCount: 0,
        announcementCount: 0,
      },
    ],
  });
  await renderPage();
  expect(container.textContent).toContain('Biology');
  expect(container.textContent).not.toContain('No course materials saved');
});

it('renders announcement content and its course even outside the recent course list', async () => {
  mocks.today.snapshot = overview({
    announcements: [
      {
        id: 'notice',
        courseId: 'biology',
        courseName: 'Biology',
        title: 'Lab reminder',
        preview: 'Bring your lab notebook.',
        publishedAt: null,
        sourceReference: {
          ...recommendation.sourceReferences[0]!,
          sourceKind: 'announcement',
          sourceId: 'notice',
        },
      },
    ],
  });
  await renderPage();
  expect(container.textContent).toContain('Bring your lab notebook.');
  expect(container.textContent).toContain('Biology');
});
