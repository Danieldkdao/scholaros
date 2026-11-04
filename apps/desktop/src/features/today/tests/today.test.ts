// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', () => ({ db: {} }));
vi.mock('../../onboarding/services/store', () => ({
  getOnboardingState: vi.fn(),
}));
vi.mock('../../courses/services/read-actions', () => ({
  getCoursesAction: vi.fn(),
}));

import type { LearningProgress } from '@scholaros/services/learning/memory-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import type {
  AttentionItem,
  FreshnessItem,
  TodayOverview,
} from '@scholaros/services/learning/today-contracts';
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import {
  applyTodayChildOverrides,
  isCurrentGradeEvidenceForCourse,
  isGradeEvidenceCurrentForAssignment,
  projectTodayOverview,
  summarizeCourseMaterialProcessing,
} from '../services/today';
import type {
  TodayCourseChild,
  TodayProjectedAssignment,
  TodayProjectionInput,
} from '../services/today';
import { dateValueFrom } from '../../courses/lib/dates';
import { formatTodayAcademicDate } from '../lib/formatters';
import { useToday } from '../hooks/use-today';

const progress: LearningProgress = {
  courseId: null,
  strengths: [],
  practiceTopics: [],
  recentChanges: [],
  unknownCount: 0,
  revision: 0,
};

const emptyProjection = (
  overrides: Partial<TodayProjectionInput> = {},
): TodayProjectionInput => ({
  attention: [],
  freshness: [],
  assignments: [],
  announcements: [],
  recentCourses: [],
  recentMaterials: [],
  recentSessions: [],
  progress,
  recommendations: [],
  revision: 1,
  ...overrides,
});

const sourceReference = (sourceId: string): SourceReference => ({
  sourceKind: 'assignment',
  sourceId,
  versionId: null,
  courseId: 'course-1',
  locator: null,
  title: sourceId,
  provenance: 'connected-source',
  observedAt: '2026-11-03T12:00:00Z',
  state: 'current',
});

const projectedAssignment = (
  id: string,
  date: Parameters<typeof dateValueFrom>[0],
): TodayProjectedAssignment => {
  const item: TodayCourseChild = {
    courseId: 'course-1',
    id,
    active: true,
    lastSeenAt: '2026-11-03T12:00:00Z',
    title: id,
    body: null,
    dateValue: dateValueFrom(date),
    dateText: date?.original ?? null,
    url: 'https://school.example.test/course/assignment',
    content: null,
    contentChangedAt: null,
  };
  return {
    courseId: 'course-1',
    courseName: 'Biology',
    kind: 'exam',
    state: 'active-unsubmitted',
    item,
    sourceReference: sourceReference(id),
  };
};

type TodayTestBridge = {
  getTodayOverview: (input?: {
    limit?: number;
  }) => Promise<TodayOverview | null>;
  onProductEvent: (listener: (event: ProductEventV1) => void) => () => void;
  onCoursesChange: (
    listener: (event: { accountId: string; courseId: string | null }) => void,
  ) => () => void;
  onBackgroundSyncChange: (
    listener: (event: { accountId: string }) => void,
  ) => () => void;
  onWatchChange: (
    listener: (event: { accountId: string }) => void,
  ) => () => void;
};

const todayBridge = () => window.scholar as unknown as TodayTestBridge;

let root: Root;
let container: HTMLDivElement;
let probe: ReturnType<typeof useToday>;
const renderedAccounts: {
  accountId: string | null;
  revision: number | null;
}[] = [];
const probeComponent = ({ accountId }: { accountId: string | null }) => {
  probe = useToday(accountId);
  useLayoutEffect(() => {
    renderedAccounts.push({
      accountId,
      revision: probe.snapshot?.revision ?? null,
    });
  });
  return null;
};
const snapshot = (revision: number): TodayOverview =>
  projectTodayOverview(emptyProjection({ revision }), 10);

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  renderedAccounts.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.scholar = {
    getTodayOverview: vi.fn(async () => snapshot(1)),
    onProductEvent: vi.fn(() => () => undefined),
    onCoursesChange: vi.fn(() => () => undefined),
    onBackgroundSyncChange: vi.fn(() => () => undefined),
    onWatchChange: vi.fn(() => () => undefined),
  } as unknown as typeof window.scholar;
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe('formatTodayAcademicDate', () => {
  it('marks only exact instants as timed overdue', () => {
    const now = '2026-11-03T12:00:00Z';
    expect(
      formatTodayAcademicDate(
        {
          kind: 'instant',
          instant: '2026-11-03T11:00:00Z',
          timezone: 'UTC',
          original: 'November 3 at 11 AM UTC',
        },
        now,
      ).overdue,
    ).toBe(true);
    expect(
      formatTodayAcademicDate(
        { kind: 'date', date: '2026-11-02', original: 'November 2' },
        now,
      ).overdue,
    ).toBe(false);
    expect(
      formatTodayAcademicDate(
        {
          kind: 'local',
          date: '2026-11-02',
          time: '11:00',
          original: 'November 2 at 11 AM',
        },
        now,
      ).overdue,
    ).toBe(false);
    expect(
      formatTodayAcademicDate(
        {
          kind: 'unresolved',
          original: 'after the next lecture',
          reason: 'No date is established.',
        },
        now,
      ).overdue,
    ).toBe(false);
  });
});

describe('applyTodayChildOverrides', () => {
  it('uses corrected date fields and preserves explicit cleared dates', () => {
    expect(
      applyTodayChildOverrides(
        {
          title: 'Exam',
          body: null,
          dateValue: '2026-11-10',
          dateText: 'Nov 10',
        },
        {
          title: 'Updated exam',
          dateValue: null,
          dateText: 'date not announced',
        },
      ),
    ).toEqual({
      title: 'Updated exam',
      body: null,
      dateValue: null,
      dateText: 'date not announced',
    });
  });
});

describe('isCurrentGradeEvidenceForCourse', () => {
  const evidence = {
    connectionId: 'connection-current',
    observedAt: '2026-11-03T11:00:00Z',
  };
  const course = {
    connectionId: 'connection-current',
    sourceState: 'connected',
  } as const;
  const connection = {
    isCourseResource: true,
    status: 'verified',
    verifiedAt: '2026-11-03T10:00:00Z',
  } as const;
  const workspaceVerifiedAt = '2026-11-03T09:00:00Z';

  it('requires current course, connection, workspace and permission evidence', () => {
    expect(
      isCurrentGradeEvidenceForCourse({
        evidence,
        course,
        connection,
        workspaceVerifiedAt,
        academicConsent: true,
      }),
    ).toBe(true);
    expect(
      isCurrentGradeEvidenceForCourse({
        evidence: { ...evidence, connectionId: 'connection-old' },
        course,
        connection,
        workspaceVerifiedAt,
        academicConsent: true,
      }),
    ).toBe(false);
    expect(
      isCurrentGradeEvidenceForCourse({
        evidence,
        course,
        connection: { ...connection, status: 'needs-sign-in' },
        workspaceVerifiedAt,
        academicConsent: true,
      }),
    ).toBe(false);
    expect(
      isCurrentGradeEvidenceForCourse({
        evidence,
        course,
        connection: { ...connection, status: 'confirmed' },
        workspaceVerifiedAt,
        academicConsent: true,
      }),
    ).toBe(false);
    expect(
      isCurrentGradeEvidenceForCourse({
        evidence,
        course,
        connection: { ...connection, isCourseResource: false },
        workspaceVerifiedAt,
        academicConsent: true,
      }),
    ).toBe(false);
    expect(
      isCurrentGradeEvidenceForCourse({
        evidence,
        course,
        connection,
        workspaceVerifiedAt: null,
        academicConsent: true,
      }),
    ).toBe(false);
    expect(
      isCurrentGradeEvidenceForCourse({
        evidence,
        course,
        connection,
        workspaceVerifiedAt,
        academicConsent: false,
      }),
    ).toBe(false);
    expect(
      isCurrentGradeEvidenceForCourse({
        evidence: { ...evidence, observedAt: '2026-11-03T09:00:00Z' },
        course,
        connection,
        workspaceVerifiedAt,
        academicConsent: true,
      }),
    ).toBe(false);
  });
});

describe('isGradeEvidenceCurrentForAssignment', () => {
  it('rejects grade evidence observed before the assignment source changed', () => {
    const assignment = {
      lastSeenAt: '2026-11-03T11:40:00Z',
      contentChangedAt: '2026-11-03T11:45:00Z',
    };
    expect(
      isGradeEvidenceCurrentForAssignment({
        observedAt: '2026-11-03T11:50:00Z',
        ...assignment,
      }),
    ).toBe(true);
    expect(
      isGradeEvidenceCurrentForAssignment({
        observedAt: '2026-11-03T11:44:00Z',
        ...assignment,
      }),
    ).toBe(false);
    expect(
      isGradeEvidenceCurrentForAssignment({
        observedAt: 'invalid',
        ...assignment,
      }),
    ).toBe(false);
  });
});

describe('summarizeCourseMaterialProcessing', () => {
  it('distinguishes queued extraction from incomplete and failed materials', () => {
    expect(
      summarizeCourseMaterialProcessing([
        { extractionStatus: 'pending' },
        { extractionStatus: 'complete' },
        { extractionStatus: 'partial' },
        { extractionStatus: 'unreadable' },
        { extractionStatus: 'failed' },
      ]),
    ).toEqual({ pendingCount: 1, needsAttentionCount: 3 });
  });
});

describe('projectTodayOverview', () => {
  it('returns honest empty collections for a new account', () => {
    const overview = projectTodayOverview(emptyProjection(), 10);

    expect(overview).toMatchObject({
      attention: [],
      freshness: [],
      upcoming: [],
      announcements: [],
      recentCourses: [],
      recentMaterials: [],
      recentSessions: [],
      recommendations: [],
      progress,
      revision: 1,
    });
  });

  it('preserves exact, date-only, local and unresolved date precision', () => {
    const exact = projectedAssignment('exact', {
      kind: 'instant',
      instant: '2026-11-04T15:00:00Z',
      timezone: 'UTC',
      original: 'November 4 at 3 PM UTC',
    });
    const dateOnly = projectedAssignment('date-only', {
      kind: 'date',
      date: '2026-11-04',
      original: 'November 4',
    });
    const local = projectedAssignment('local', {
      kind: 'local',
      date: '2026-11-05',
      time: '09:00',
      original: 'November 5 at 9 AM',
    });
    const unresolved = projectedAssignment('unresolved', {
      kind: 'unresolved',
      original: 'after the next lecture',
      reason: 'The source did not establish a date.',
    });

    const overview = projectTodayOverview(
      emptyProjection({ assignments: [unresolved, local, exact, dateOnly] }),
      10,
    );

    expect(overview.upcoming.map(({ resourceId }) => resourceId)).toEqual([
      'date-only',
      'exact',
      'local',
      'unresolved',
    ]);
    expect(overview.upcoming.map(({ date }) => date?.kind)).toEqual([
      'date',
      'instant',
      'local',
      'unresolved',
    ]);
  });

  it('keeps partial, stale, needs-sign-in and indexing states distinct', () => {
    const freshness: FreshnessItem[] = [
      {
        courseId: 'partial-course',
        status: 'partial',
        lastSuccessfulAt: null,
        pendingCount: 0,
      },
      {
        courseId: 'stale-course',
        status: 'stale',
        lastSuccessfulAt: '2026-11-02T12:00:00Z',
        pendingCount: 1,
      },
      {
        courseId: 'blocked-course',
        status: 'unavailable',
        lastSuccessfulAt: null,
        pendingCount: 0,
      },
    ];
    const attention: AttentionItem[] = [
      {
        kind: 'connection',
        code: 'needs-sign-in',
        label: 'Schoology needs sign-in.',
        route: { kind: 'settings', section: 'connections' },
      },
      {
        kind: 'context',
        code: 'indexing',
        label: 'Your materials are still indexing.',
        route: { kind: 'context', itemId: null },
      },
    ];
    const overview = projectTodayOverview(
      emptyProjection({ attention, freshness }),
      10,
    );

    expect(overview.freshness).toEqual(freshness);
    expect(overview.attention).toEqual(attention);
    expect(overview.attention.map(({ code }) => code)).toEqual([
      'needs-sign-in',
      'indexing',
    ]);
  });

  it('only exposes unsubmitted active assignments in the upcoming projection', () => {
    const active = projectedAssignment('active', null);
    const assignments: TodayProjectedAssignment[] = [
      active,
      { ...projectedAssignment('submitted', null), state: 'submitted' },
      { ...projectedAssignment('inactive', null), state: 'inactive' },
      { ...projectedAssignment('unknown', null), state: 'unknown' },
    ];

    expect(
      projectTodayOverview(emptyProjection({ assignments }), 10).upcoming,
    ).toMatchObject([{ resourceId: 'active' }]);
  });

  it('caps each visible collection without changing its evidence or status', () => {
    const assignments = Array.from({ length: 4 }, (_, index) =>
      projectedAssignment(`assignment-${index}`, null),
    );

    expect(
      projectTodayOverview(emptyProjection({ assignments }), 2).upcoming,
    ).toHaveLength(2);
  });

  it('does not request or invent a profile when no account is selected', async () => {
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: null })),
    );

    expect(todayBridge().getTodayOverview).not.toHaveBeenCalled();
    expect(probe.snapshot).toBeNull();
    expect(probe.loading).toBe(false);
  });

  it('keeps an empty successful overview distinct from a failed nullable read', async () => {
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-a' })),
    );
    expect(probe.snapshot?.upcoming).toEqual([]);
    expect(probe.error).toBeNull();

    vi.mocked(todayBridge().getTodayOverview).mockResolvedValueOnce(null);
    await act(async () => probe.reload());
    expect(probe.snapshot?.revision).toBe(1);
    expect(probe.error).toBeTruthy();
  });

  it('hides a previous account snapshot in the first render after an account switch', async () => {
    vi.mocked(todayBridge().getTodayOverview)
      .mockResolvedValueOnce(snapshot(11))
      .mockResolvedValueOnce(snapshot(12));
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-old' })),
    );
    expect(probe.snapshot?.revision).toBe(11);

    const nextRender = renderedAccounts.length;
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-new' })),
    );

    expect(renderedAccounts[nextRender]).toEqual({
      accountId: 'student-new',
      revision: null,
    });
  });

  it('ignores reload callbacks captured by the previous account', async () => {
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-old' })),
    );
    const previousReload = probe.reload;
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-new' })),
    );
    const requestsAfterSwitch = vi.mocked(todayBridge().getTodayOverview).mock
      .calls.length;

    await act(async () => previousReload());

    expect(todayBridge().getTodayOverview).toHaveBeenCalledTimes(
      requestsAfterSwitch,
    );
  });

  it('ignores a late response after the displayed account changes', async () => {
    let resolveOld!: (value: TodayOverview) => void;
    vi.mocked(todayBridge().getTodayOverview).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-old' })),
    );
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-new' })),
    );
    await act(async () => resolveOld(snapshot(10)));

    expect(probe.snapshot?.revision).toBe(1);
  });

  it('reloads on newer same-account product events and discards the older response', async () => {
    const listeners = new Set<
      (event: {
        version: 1;
        accountId: string;
        revision: number;
        resource: 'memory';
        targetId: null;
      }) => void
    >();
    todayBridge().onProductEvent = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    let resolveInitial!: (value: TodayOverview) => void;
    vi.mocked(todayBridge().getTodayOverview).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
    );
    vi.mocked(todayBridge().getTodayOverview).mockResolvedValueOnce(
      snapshot(2),
    );

    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-a' })),
    );
    await act(async () => {
      for (const listener of listeners)
        listener({
          version: 1,
          accountId: 'student-a',
          revision: 1,
          resource: 'memory',
          targetId: null,
        });
    });
    await act(async () => resolveInitial(snapshot(1)));

    expect(probe.snapshot?.revision).toBe(2);
    expect(todayBridge().getTodayOverview).toHaveBeenCalledTimes(2);
  });

  it('keeps authorized cached data visible when refresh is offline', async () => {
    await act(async () =>
      root.render(createElement(probeComponent, { accountId: 'student-a' })),
    );
    vi.mocked(todayBridge().getTodayOverview).mockRejectedValueOnce(
      new Error('offline'),
    );
    await act(async () => probe.reload());

    expect(probe.snapshot?.revision).toBe(1);
    expect(probe.offline).toBe(true);
    expect(probe.error).toBeTruthy();
  });
});
