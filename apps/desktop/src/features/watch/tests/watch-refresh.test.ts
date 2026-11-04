import { describe, expect, it, vi } from 'vitest';
import { createAcademicTaskRunner } from '../../onboarding/services/academic-tasks';
import { createWatchRefreshProcessor } from '../services/refresh';
import type { WatchTargetSelectData } from '../../../db/schema';
import type { InternalWatchExecutionCoverageReceipt } from '../types';

const target = (courseId: string | null): WatchTargetSelectData => ({
  id: 'target-a',
  userId: 'student-a',
  connectionId: 'connection-a',
  courseId,
  requestedUrl: 'https://canvas.school.edu/courses/1/assignments',
  verifiedUrl: null,
  urlIdentity: 'https://canvas.school.edu/courses/1/assignments',
  lastAttemptAt: null,
  lastSuccessfulCheckAt: null,
  detectedFingerprint: 'a'.repeat(64),
  processedFingerprint: null,
  pendingChange: true,
  pendingSince: '2026-11-01T12:00:00.000Z',
  pendingSinceEstimated: false,
  lastFailureCategory: null,
  nextCheckAt: null,
  status: 'active',
  failureCount: 0,
  retryAt: null,
  recipeVersion: 1,
  createdAt: '2026-11-01T12:00:00.000Z',
  updatedAt: '2026-11-01T12:00:00.000Z',
});

const coverageReceipt = (
  fingerprint: string,
  materialStatus: 'complete' | 'partial' = 'complete',
): InternalWatchExecutionCoverageReceipt => ({
  runId: 'run-a',
  sessionEpoch: 4,
  coveredRevisions: [{ targetId: 'target-a', fingerprint }],
  collectionCoverage: [
    { courseId: 'course-a', collectionKind: 'assignments', status: 'complete' },
    {
      courseId: 'course-a',
      collectionKind: 'announcements',
      status: 'complete',
    },
    {
      courseId: 'course-a',
      collectionKind: 'materials',
      status: materialStatus,
    },
  ],
});

describe('watch refresh processor', () => {
  it('uses the course task key and processes a revision only after complete refresh', async () => {
    const runner = createAcademicTaskRunner();
    const refreshTarget = vi.fn(async () => ({
      complete: true,
      receipt: coverageReceipt('a'.repeat(64)),
    }));
    const markProcessed = vi.fn(() => ({ pendingChange: false }));
    const process = createWatchRefreshProcessor({
      runTask: runner.run,
      refreshTarget,
      markProcessed,
      now: () => new Date('2026-11-01T12:01:00.000Z'),
    });

    await expect(
      process(target('course-a'), 'a'.repeat(64), new AbortController().signal),
    ).resolves.toBe(true);

    expect(runner.getActivity('student-a')[0]).toMatchObject({
      key: 'course-a',
      status: 'complete',
    });
    expect(markProcessed).toHaveBeenCalledWith({
      userId: 'student-a',
      targetId: 'target-a',
      fingerprint: 'a'.repeat(64),
      processedAt: '2026-11-01T12:01:00.000Z',
      sessionEpoch: 4,
    });
  });

  it('joins an equivalent active course refresh instead of starting another', async () => {
    const runner = createAcademicTaskRunner();
    let finish!: () => void;
    const manualRefresh = runner.run(
      'student-a',
      async () =>
        new Promise<{
          complete: boolean;
          receipt: InternalWatchExecutionCoverageReceipt;
        }>((resolve) => {
          finish = () =>
            resolve({
              complete: true,
              receipt: coverageReceipt('a'.repeat(64)),
            });
        }),
      undefined,
      'course-a',
    );
    const refreshTarget = vi.fn(async () => ({
      complete: true,
      receipt: coverageReceipt('a'.repeat(64)),
    }));
    const process = createWatchRefreshProcessor({
      runTask: runner.run,
      refreshTarget,
      markProcessed: vi.fn(() => ({ pendingChange: false })),
    });

    const processing = process(
      target('course-a'),
      'a'.repeat(64),
      new AbortController().signal,
    );
    await Promise.resolve();
    finish();

    await expect(processing).resolves.toBe(true);
    await manualRefresh;
    expect(refreshTarget).not.toHaveBeenCalled();
    expect(runner.getActivity('student-a')).toHaveLength(1);
  });

  it('does not let a watcher cancel an unrelated manual course refresh it joined', async () => {
    const runner = createAcademicTaskRunner();
    let finishManual!: () => void;
    let manualSignal: AbortSignal | undefined;
    const manualRefresh = runner.run(
      'student-a',
      (signal) => {
        manualSignal = signal;
        return new Promise((resolve) => {
          finishManual = () =>
            resolve({
              complete: true,
              receipt: coverageReceipt('a'.repeat(64)),
            });
        });
      },
      undefined,
      'course-a',
    );
    await vi.waitFor(() => expect(manualSignal).toBeDefined());
    const watcherSignal = new AbortController();
    const markProcessed = vi.fn();
    const process = createWatchRefreshProcessor({
      runTask: runner.run,
      refreshTarget: vi.fn(),
      markProcessed,
    });
    const watchedRefresh = process(
      target('course-a'),
      'a'.repeat(64),
      watcherSignal.signal,
    );
    watcherSignal.abort();
    expect(manualSignal?.aborted).toBe(false);
    finishManual();
    await manualRefresh;

    await expect(watchedRefresh).rejects.toMatchObject({ name: 'AbortError' });
    expect(manualSignal?.aborted).toBe(false);
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('leaves a revision pending when refresh coverage is incomplete or capacity is busy', async () => {
    const runner = createAcademicTaskRunner();
    const incomplete = createWatchRefreshProcessor({
      runTask: runner.run,
      refreshTarget: async () => ({
        complete: false,
        receipt: coverageReceipt('a'.repeat(64), 'partial'),
      }),
      markProcessed: vi.fn(),
    });
    await expect(
      incomplete(
        target('course-a'),
        'a'.repeat(64),
        new AbortController().signal,
      ),
    ).resolves.toBe('source-failed');

    let release!: () => void;
    const occupied = runner.run(
      'student-a',
      async () => new Promise<void>((resolve) => (release = resolve)),
      undefined,
      'courses',
    );
    await Promise.resolve();
    const busy = createWatchRefreshProcessor({
      runTask: runner.run,
      refreshTarget: vi.fn(async () => ({
        complete: true,
        receipt: coverageReceipt('a'.repeat(64)),
      })),
      markProcessed: vi.fn(),
    });
    await expect(
      busy(target('course-a'), 'a'.repeat(64), new AbortController().signal),
    ).resolves.toBe('busy');
    release();
    await occupied;
  });

  it('uses the exclusive course-list task for connection-level targets', async () => {
    const runner = createAcademicTaskRunner();
    const process = createWatchRefreshProcessor({
      runTask: runner.run,
      refreshTarget: async () => ({
        complete: true,
        receipt: coverageReceipt('a'.repeat(64)),
      }),
      markProcessed: vi.fn(() => ({ pendingChange: false })),
    });

    await process(target(null), 'a'.repeat(64), new AbortController().signal);

    expect(runner.getActivity('student-a')[0]?.key).toBe('courses');
  });

  it('does not acknowledge a newer fingerprint absent from the admitted refresh receipt', async () => {
    const markProcessed = vi.fn();
    const process = createWatchRefreshProcessor({
      startRefresh: vi.fn(async () => ({
        complete: true,
        receipt: coverageReceipt('b'.repeat(64)),
      })),
      markProcessed,
    });

    await expect(
      process(target('course-a'), 'a'.repeat(64), new AbortController().signal),
    ).resolves.toBe('superseded');
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('reports partial source coverage as a retryable failure without acknowledging it', async () => {
    const markProcessed = vi.fn();
    const process = createWatchRefreshProcessor({
      startRefresh: async () => ({
        complete: false,
        failureCategory: 'unknown' as const,
        receipt: coverageReceipt('a'.repeat(64), 'partial'),
      }),
      markProcessed,
    });

    await expect(
      process(target('course-a'), 'a'.repeat(64), new AbortController().signal),
    ).resolves.toBe('source-failed');
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('reports sign-in-required coverage separately from transient failures', async () => {
    const markProcessed = vi.fn();
    const process = createWatchRefreshProcessor({
      startRefresh: async () => ({
        complete: false,
        failureCategory: 'needs-sign-in' as const,
        receipt: coverageReceipt('a'.repeat(64)),
      }),
      markProcessed,
    });

    await expect(
      process(target('course-a'), 'a'.repeat(64), new AbortController().signal),
    ).resolves.toBe('needs-sign-in');
    expect(markProcessed).not.toHaveBeenCalled();
  });
});
