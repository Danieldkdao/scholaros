import { describe, expect, it, vi } from 'vitest';
import { createAcademicTaskRunner } from '../../onboarding/services/academic-tasks';
import { createWatchRefreshProcessor } from '../services/refresh';
import type { WatchTargetSelectData } from '../../../db/schema';

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

describe('watch refresh processor', () => {
  it('uses the course task key and processes a revision only after complete refresh', async () => {
    const runner = createAcademicTaskRunner();
    const refreshTarget = vi.fn(async () => ({ complete: true }));
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
    });
  });

  it('joins an equivalent active course refresh instead of starting another', async () => {
    const runner = createAcademicTaskRunner();
    let finish!: () => void;
    const manualRefresh = runner.run(
      'student-a',
      async () =>
        new Promise<{ complete: boolean }>((resolve) => {
          finish = () => resolve({ complete: true });
        }),
      undefined,
      'course-a',
    );
    const refreshTarget = vi.fn(async () => ({ complete: true }));
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

  it('leaves a revision pending when refresh coverage is incomplete or capacity is busy', async () => {
    const runner = createAcademicTaskRunner();
    const incomplete = createWatchRefreshProcessor({
      runTask: runner.run,
      refreshTarget: async () => ({ complete: false }),
      markProcessed: vi.fn(),
    });
    await expect(
      incomplete(
        target('course-a'),
        'a'.repeat(64),
        new AbortController().signal,
      ),
    ).resolves.toBe(false);

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
      refreshTarget: vi.fn(async () => ({ complete: true })),
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
      refreshTarget: async () => ({ complete: true }),
      markProcessed: vi.fn(() => ({ pendingChange: false })),
    });

    await process(target(null), 'a'.repeat(64), new AbortController().signal);

    expect(runner.getActivity('student-a')[0]?.key).toBe('courses');
  });
});
