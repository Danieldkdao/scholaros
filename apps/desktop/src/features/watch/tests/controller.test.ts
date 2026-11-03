import { describe, expect, it, vi } from 'vitest';
import type { WatchTargetSelectData } from '../../../db/schema';
import { createWatchController } from '../services/controller';
import { createPageFingerprint } from '../lib/page-fingerprint';
import type { WatchPageSnapshot } from '../types';

const makeTarget = (id: string): WatchTargetSelectData => ({
  id,
  userId: 'student-a',
  connectionId: 'connection-a',
  courseId: 'course-a',
  requestedUrl: `https://canvas.school.edu/courses/1/assignments/${id}`,
  verifiedUrl: null,
  urlIdentity: `https://canvas.school.edu/courses/1/assignments/${id}`,
  lastAttemptAt: null,
  lastSuccessfulCheckAt: null,
  detectedFingerprint: null,
  processedFingerprint: null,
  pendingChange: false,
  pendingSince: null,
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

const makeSnapshot = (text: string): WatchPageSnapshot => ({
  url: 'https://canvas.school.edu/courses/1/assignments',
  title: 'Assignments',
  text,
  links: [],
  statuses: [],
  complete: true,
  recipeVersion: 1,
});

const fingerprint = (value: string) => value.padStart(64, '0').slice(-64);

const enabledSettings = { watchEnabled: true, watchUrls: [] };

describe('watch controller', () => {
  it('cancels daily reconciliation without committing a successful timestamp', async () => {
    const markSuccessful = vi.fn();
    const run = vi.fn(
      (_userId: string, signal: AbortSignal) =>
        new Promise<boolean>((resolve) =>
          signal.addEventListener('abort', () => resolve(true), { once: true }),
        ),
    );
    const controller = createWatchController({
      getSettings: () => enabledSettings,
      getTargets: () => [],
      checkTarget: vi.fn(),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(),
      reconcileCourses: { lastSuccessfulAt: () => null, run, markSuccessful },
    });
    await controller.start('student-a');
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await controller.stop('student-a');

    expect(markSuccessful).not.toHaveBeenCalled();
  });

  it('reconciles unchanged courses daily and reuses the persisted completion time after restart', async () => {
    let clock = Date.parse('2026-11-01T12:00:00.000Z');
    let lastSuccessfulAt: string | null = null;
    const run = vi.fn(async () => true);
    const dependencies = {
      now: () => clock,
      getSettings: () => enabledSettings,
      getTargets: () => [],
      checkTarget: vi.fn(),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(),
      reconcileCourses: {
        lastSuccessfulAt: () => lastSuccessfulAt,
        run,
        markSuccessful: (_userId: string, at: string) => {
          lastSuccessfulAt = at;
        },
      },
    };
    let controller = createWatchController(dependencies);
    await controller.start('student-a');
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(lastSuccessfulAt).not.toBeNull());
    await controller.stop('student-a');
    expect(lastSuccessfulAt).toBe(new Date(clock).toISOString());

    controller = createWatchController(dependencies);
    await controller.start('student-a');
    expect(run).toHaveBeenCalledOnce();
    clock += 24 * 60 * 60_000;
    await controller.tick('student-a');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await controller.stop('student-a');
  });

  it('keeps busy and incomplete daily reconciliation pending without a retry loop', async () => {
    let clock = Date.parse('2026-11-01T12:00:00.000Z');
    let capacityChanged!: () => void;
    const run = vi
      .fn<() => Promise<boolean | 'busy'>>()
      .mockResolvedValueOnce('busy')
      .mockImplementationOnce(async () => {
        capacityChanged();
        return false;
      })
      .mockResolvedValue(true);
    const markSuccessful = vi.fn();
    const controller = createWatchController({
      now: () => clock,
      getSettings: () => enabledSettings,
      getTargets: () => [],
      checkTarget: vi.fn(),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(),
      subscribeCapacity: (_userId, listener) => {
        capacityChanged = listener;
        return () => undefined;
      },
      reconcileCourses: { lastSuccessfulAt: () => null, run, markSuccessful },
    });
    await controller.start('student-a');
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    capacityChanged();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    for (let iteration = 0; iteration < 20; iteration += 1)
      await Promise.resolve();
    expect(markSuccessful).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
    clock += 5 * 60_000;
    await controller.tick('student-a');
    await vi.waitFor(() => expect(markSuccessful).toHaveBeenCalledOnce());
    await controller.stop('student-a');
  });

  it('does not immediately retry incomplete refreshes on their own capacity notifications', async () => {
    const target = {
      ...makeTarget('1'),
      pendingChange: true,
      detectedFingerprint: fingerprint('pending'),
      nextCheckAt: '2026-11-01T12:05:00.000Z',
    };
    let capacityChanged!: () => void;
    const processChange = vi.fn(async () => {
      capacityChanged();
      return false;
    });
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: vi.fn(),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange,
      subscribeCapacity: (_userId, listener) => {
        capacityChanged = listener;
        return () => undefined;
      },
    });

    await controller.start('student-a');
    for (let iteration = 0; iteration < 20; iteration += 1)
      await Promise.resolve();
    await controller.stop('student-a');

    expect(processChange).toHaveBeenCalledOnce();
    expect(target.pendingChange).toBe(true);
  });

  it('does not refresh pending changes for blocked or suspended targets', async () => {
    const targets = ['blocked', 'suspended'].map((status, index) => ({
      ...makeTarget(String(index)),
      status: status as 'blocked' | 'suspended',
      pendingChange: true,
      detectedFingerprint: fingerprint('pending'),
    }));
    const processChange = vi.fn(async () => true);
    const controller = createWatchController({
      getSettings: () => enabledSettings,
      getTargets: () => targets,
      checkTarget: vi.fn(),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange,
    });

    await controller.start('student-a');
    await controller.stop('student-a');

    expect(processChange).not.toHaveBeenCalled();
  });

  it('honors retry cooldowns for pending refreshes and mutation notifications', async () => {
    const target = {
      ...makeTarget('1'),
      pendingChange: true,
      detectedFingerprint: fingerprint('pending'),
      retryAt: '2026-11-01T12:01:00.000Z',
      nextCheckAt: '2026-11-01T12:01:00.000Z',
    };
    const processChange = vi.fn(async () => true);
    const checkTarget = vi.fn(async () => makeSnapshot('changed'));
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget,
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange,
    });

    await controller.start('student-a');
    await controller.requestCheck('student-a', target.id);
    await controller.stop('student-a');

    expect(processChange).not.toHaveBeenCalled();
    expect(checkTarget).not.toHaveBeenCalled();
  });

  it('makes no page requests while watching is off', async () => {
    const checkTarget = vi.fn(async () => makeSnapshot('Assignments'));
    const controller = createWatchController({
      getSettings: () => ({ watchEnabled: false, watchUrls: [] }),
      getTargets: () => [makeTarget('1')],
      checkTarget,
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(async () => true),
    });

    await controller.start('student-a');

    expect(checkTarget).not.toHaveBeenCalled();
    expect(controller.getStatus('student-a')).toBe('off');
  });

  it('reports blocked when every configured target has reached its failure limit', async () => {
    const target = { ...makeTarget('1'), status: 'blocked' as const };
    const checkTarget = vi.fn(async () => makeSnapshot('Assignments'));
    const controller = createWatchController({
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget,
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(async () => true),
    });

    await controller.start('student-a');

    expect(checkTarget).not.toHaveBeenCalled();
    expect(controller.getStatus('student-a')).toBe('blocked');
  });

  it('checks at most two due targets at once and rotates fairly', async () => {
    const targets = [makeTarget('1'), makeTarget('2'), makeTarget('3')];
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const recordObservation = vi.fn((input) => {
      const target = targets.find((item) => item.id === input.targetId)!;
      target.nextCheckAt = '2026-11-01T12:05:00.000Z';
      target.detectedFingerprint = input.fingerprint;
      target.processedFingerprint = input.fingerprint;
      return target;
    });
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => targets,
      checkTarget: async (target) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        order.push(target.id);
        await Promise.resolve();
        active -= 1;
        return makeSnapshot(target.id);
      },
      recordObservation,
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(async () => true),
    });

    await controller.start('student-a');
    await controller.tick('student-a');

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(order).toEqual(['1', '2', '3']);
    expect(recordObservation).toHaveBeenCalledTimes(3);
  });

  it('spreads overdue targets after one bounded catch-up batch', async () => {
    const targets = ['1', '2', '3', '4', '5'].map((id) => ({
      ...makeTarget(id),
      nextCheckAt: '2026-10-31T12:00:00.000Z',
    }));
    const checked: string[] = [];
    const deferred: Array<{
      targetId: string;
      nextCheckAt: string;
      attempted?: boolean;
    }> = [];
    const scheduleCheck = vi.fn((input) => {
      deferred.push(input);
      const target = targets.find((item) => item.id === input.targetId)!;
      target.nextCheckAt = input.nextCheckAt;
      return target;
    });
    const recordObservation = vi.fn((input) => {
      const target = targets.find((item) => item.id === input.targetId)!;
      target.nextCheckAt = input.nextCheckAt;
      target.detectedFingerprint = input.fingerprint;
      target.processedFingerprint = input.fingerprint;
      return target;
    });
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => targets,
      checkTarget: async (target) => {
        checked.push(target.id);
        return makeSnapshot(target.id);
      },
      recordObservation,
      recordFailure: vi.fn(),
      scheduleCheck,
      processChange: vi.fn(async () => true),
    });

    await controller.start('student-a');
    await controller.stop('student-a');

    expect(checked).toHaveLength(2);
    expect(deferred).toHaveLength(3);
    expect(deferred.every((item) => item.attempted === false)).toBe(true);
    const deferredTimes = deferred.map((item) => Date.parse(item.nextCheckAt));
    expect(deferredTimes).toEqual(
      [...deferredTimes].sort((left, right) => left - right),
    );
    expect(
      deferredTimes.every(
        (time) => time > Date.parse('2026-11-01T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('persists a detected revision before queueing its refresh', async () => {
    const target = makeTarget('1');
    const events: string[] = [];
    const nextTarget = { ...target };
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: async () => makeSnapshot('Quiz 2 due November 3'),
      recordObservation: vi.fn((input) => {
        events.push('saved');
        nextTarget.detectedFingerprint = input.fingerprint;
        nextTarget.pendingChange = true;
        nextTarget.nextCheckAt = input.nextCheckAt;
        return nextTarget;
      }),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(async () => {
        events.push('refresh');
        return true;
      }),
    });

    await controller.start('student-a');

    expect(events).toEqual(['saved', 'refresh']);
  });

  it('tracks detected and processed changes with pending age and no page content', async () => {
    const target = makeTarget('1');
    let currentTime = Date.parse('2026-11-01T12:00:00.000Z');
    let processingSucceeds = false;
    const processChange = vi.fn(async () => {
      if (processingSucceeds) {
        target.pendingChange = false;
        target.processedFingerprint = target.detectedFingerprint;
      }
      return processingSucceeds;
    });
    const controller = createWatchController({
      now: () => currentTime,
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: async () => makeSnapshot('Lab report due November 3'),
      recordObservation: vi.fn((input) => {
        target.detectedFingerprint = input.fingerprint;
        target.pendingChange =
          target.processedFingerprint !== input.fingerprint;
        target.lastSuccessfulCheckAt = input.checkedAt;
        target.updatedAt = input.checkedAt;
        target.nextCheckAt = input.nextCheckAt;
        return target;
      }),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange,
    });

    await controller.start('student-a');
    await vi.waitFor(() => expect(processChange).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getMetrics('student-a')).toEqual({
      changesDetected: 1,
      changesProcessed: 0,
      pendingChangeAgeMs: 0,
    });

    currentTime += 5 * 60_000;
    expect(controller.getMetrics('student-a')?.pendingChangeAgeMs).toBe(
      5 * 60_000,
    );
    processingSucceeds = true;
    await controller.tick('student-a');
    await vi.waitFor(() =>
      expect(controller.getMetrics('student-a')).toMatchObject({
        changesProcessed: 1,
      }),
    );

    expect(controller.getMetrics('student-a')).toEqual({
      changesDetected: 1,
      changesProcessed: 1,
      pendingChangeAgeMs: null,
    });
    expect(JSON.stringify(controller.getMetrics('student-a'))).not.toContain(
      'Lab report',
    );
    await controller.stop('student-a');
  });

  it('checks a notified mutation immediately without navigating away from the loaded page', async () => {
    const target = makeTarget('1');
    target.nextCheckAt = '2026-11-01T12:05:00.000Z';
    const checkTarget = vi.fn(async () => makeSnapshot('Changed assignment'));
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget,
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(async () => true),
    });

    await controller.start('student-a');
    await controller.requestCheck('student-a', target.id);

    expect(checkTarget).toHaveBeenCalledWith(target, expect.any(AbortSignal), {
      reload: false,
    });
  });

  it('keeps incomplete observations pending and retries them when capacity opens', async () => {
    const target = makeTarget('1');
    const pending = { ...target, pendingChange: true };
    pending.detectedFingerprint = fingerprint('revision-a');
    let available = false;
    let retryForCapacity!: () => void;
    const subscribeCapacity = vi.fn((_userId: string, listener: () => void) => {
      retryForCapacity = listener;
      return () => undefined;
    });
    const processChange = vi.fn(async () =>
      available ? true : ('busy' as const),
    );
    const controller = createWatchController({
      getSettings: () => enabledSettings,
      getTargets: () => [pending],
      checkTarget: vi.fn(async () => makeSnapshot('unchanged')),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange,
      subscribeCapacity,
    });

    await controller.start('student-a');
    expect(processChange).toHaveBeenCalledTimes(1);

    available = true;
    retryForCapacity();
    await vi.waitFor(() => expect(processChange).toHaveBeenCalledTimes(2));

    expect(subscribeCapacity).toHaveBeenCalledOnce();
  });

  it('does not replace a saved baseline with an unchanged incomplete snapshot', async () => {
    const target = makeTarget('1');
    target.detectedFingerprint = createPageFingerprint(makeSnapshot('partial'));
    target.processedFingerprint = target.detectedFingerprint;
    target.nextCheckAt = null;
    const recordObservation = vi.fn();
    const scheduleCheck = vi.fn();
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: async () => ({
        ...makeSnapshot('partial'),
        complete: false,
      }),
      recordObservation,
      recordFailure: vi.fn(),
      scheduleCheck,
      processChange: vi.fn(async () => true),
    });

    await controller.start('student-a');

    expect(recordObservation).not.toHaveBeenCalled();
    expect(scheduleCheck).toHaveBeenCalledOnce();
    expect(scheduleCheck).toHaveBeenCalledWith(
      expect.objectContaining({ attempted: false }),
    );
    expect(target.processedFingerprint).toBe(
      createPageFingerprint(makeSnapshot('partial')),
    );
  });

  it('retries incomplete source coverage after one and five minutes, then blocks', async () => {
    let currentTime = Date.parse('2026-11-01T12:00:00.000Z');
    const baseline = makeSnapshot('assignment revision');
    const target = {
      ...makeTarget('1'),
      pendingChange: true,
      detectedFingerprint: createPageFingerprint(baseline),
      pendingSince: '2026-11-01T12:00:00.000Z',
      nextCheckAt: '2026-11-01T12:05:00.000Z',
    };
    const failures: Array<{
      category: string;
      retryAt: string | null;
      blocked: boolean;
    }> = [];
    const recordFailure = vi.fn((failure) => {
      failures.push({
        category: failure.category,
        retryAt: failure.retryAt,
        blocked: failure.blocked,
      });
      target.failureCount += 1;
      target.lastFailureCategory = failure.category;
      target.retryAt = failure.retryAt;
      target.nextCheckAt = failure.retryAt;
      target.status = failure.blocked ? 'blocked' : 'active';
      return target;
    });
    const controller = createWatchController({
      now: () => currentTime,
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: vi.fn(async () => baseline),
      recordObservation: vi.fn((observation) => {
        target.lastAttemptAt = observation.checkedAt;
        target.lastSuccessfulCheckAt = observation.checkedAt;
        target.nextCheckAt = observation.nextCheckAt;
        target.updatedAt = observation.checkedAt;
        return target;
      }),
      recordFailure,
      scheduleCheck: vi.fn(),
      processChange: vi.fn(async () => 'source-failed' as const),
      schedule: vi.fn(
        () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>,
      ),
      cancelSchedule: vi.fn(),
    });

    await controller.start('student-a');
    await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledTimes(1));
    currentTime += 60_000;
    await controller.tick('student-a');
    await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledTimes(2));
    currentTime += 5 * 60_000;
    await controller.tick('student-a');
    await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledTimes(3));

    expect(failures).toEqual([
      {
        category: 'unknown',
        retryAt: '2026-11-01T12:01:00.000Z',
        blocked: false,
      },
      {
        category: 'unknown',
        retryAt: '2026-11-01T12:06:00.000Z',
        blocked: false,
      },
      { category: 'unknown', retryAt: null, blocked: true },
    ]);
    expect(target).toMatchObject({ pendingChange: true, status: 'blocked' });
    await controller.stop('student-a');
  });

  it('suspends a needs-sign-in target without spending its transient retry budget', async () => {
    const target = {
      ...makeTarget('1'),
      pendingChange: true,
      detectedFingerprint: fingerprint('pending'),
      nextCheckAt: '2026-11-01T12:05:00.000Z',
    };
    const recordFailure = vi.fn((failure) => {
      target.status = 'suspended';
      target.lastFailureCategory = failure.category;
      target.retryAt = failure.retryAt;
      return target;
    });
    const processChange = vi.fn(async () => 'needs-sign-in' as const);
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: vi.fn(),
      recordObservation: vi.fn(),
      recordFailure,
      scheduleCheck: vi.fn(),
      processChange,
      schedule: vi.fn(
        () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setTimeout>,
      ),
      cancelSchedule: vi.fn(),
    });

    await controller.start('student-a');
    await vi.waitFor(() => expect(recordFailure).toHaveBeenCalledOnce());

    expect(recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'needs-sign-in',
        retryAt: null,
        blocked: false,
      }),
    );
    expect(target.failureCount).toBe(0);
    expect(target.status).toBe('suspended');
    await controller.tick('student-a');
    expect(processChange).toHaveBeenCalledOnce();
    await controller.stop('student-a');
  });

  it('restores pending age from the durable revision timestamp after restart', async () => {
    const target = {
      ...makeTarget('1'),
      pendingChange: true,
      detectedFingerprint: fingerprint('pending'),
      pendingSince: '2026-10-31T12:00:00.000Z',
      nextCheckAt: '2026-11-01T12:05:00.000Z',
    };
    const processChange = vi.fn(async () => 'busy' as const);
    const dependencies = {
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: vi.fn(),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange,
    };
    let controller = createWatchController(dependencies);

    await controller.start('student-a');
    await vi.waitFor(() => expect(processChange).toHaveBeenCalledOnce());
    expect(controller.getMetrics('student-a')?.pendingChangeAgeMs).toBe(
      24 * 60 * 60_000,
    );
    await controller.stop('student-a');

    controller = createWatchController(dependencies);
    await controller.start('student-a');
    await vi.waitFor(() => expect(processChange).toHaveBeenCalledTimes(2));
    expect(controller.getMetrics('student-a')?.pendingChangeAgeMs).toBe(
      24 * 60 * 60_000,
    );
    await controller.stop('student-a');
  });

  it('runs one serialized follow-up when a newer revision arrives during processing', async () => {
    const revisionA = fingerprint('revision-a');
    const revisionB = fingerprint('revision-b');
    const target = {
      ...makeTarget('1'),
      pendingChange: true,
      detectedFingerprint: revisionA,
      pendingSince: '2026-11-01T12:00:00.000Z',
      nextCheckAt: '2026-11-01T12:05:00.000Z',
    };
    let releaseRevisionA!: () => void;
    let activeJobs = 0;
    let maximumActiveJobs = 0;
    const processChange = vi.fn(async (_target, revision) => {
      activeJobs += 1;
      maximumActiveJobs = Math.max(maximumActiveJobs, activeJobs);
      if (revision === revisionA)
        await new Promise<void>((resolve) => {
          releaseRevisionA = resolve;
        });
      else target.pendingChange = false;
      activeJobs -= 1;
      return true;
    });
    const controller = createWatchController({
      now: () => Date.parse('2026-11-01T12:00:00.000Z'),
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: vi.fn(),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange,
    });

    await controller.start('student-a');
    await vi.waitFor(() => expect(processChange).toHaveBeenCalledOnce());
    target.detectedFingerprint = revisionB;
    target.pendingSince = '2026-11-01T12:01:00.000Z';
    await controller.tick('student-a');
    releaseRevisionA();
    await vi.waitFor(() => expect(processChange).toHaveBeenCalledTimes(2));

    expect(processChange.mock.calls.map((call) => call[1])).toEqual([
      revisionA,
      revisionB,
    ]);
    expect(maximumActiveJobs).toBe(1);
    expect(target.pendingChange).toBe(false);
    await controller.stop('student-a');
  });

  it('aborts an active page check when stopped', async () => {
    const target = makeTarget('1');
    let checkSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const checkTarget = vi.fn(
      (_target: WatchTargetSelectData, signal: AbortSignal) => {
        checkSignal = signal;
        entered();
        return new Promise<WatchPageSnapshot>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    );
    const controller = createWatchController({
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget,
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: vi.fn(async () => true),
    });

    const starting = controller.start('student-a');
    await started;
    await controller.stop('student-a');
    await starting;

    expect(checkSignal?.aborted).toBe(true);
    expect(controller.getStatus('student-a')).toBe('off');
  });

  it('waits for watcher-owned refresh work to observe cancellation', async () => {
    const target = makeTarget('1');
    target.pendingChange = true;
    target.detectedFingerprint = fingerprint('pending');
    target.nextCheckAt = '2026-11-01T12:05:00.000Z';
    let entered!: () => void;
    let settled = false;
    const processingStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const controller = createWatchController({
      getSettings: () => enabledSettings,
      getTargets: () => [target],
      checkTarget: vi.fn(async () => makeSnapshot('Assignments')),
      recordObservation: vi.fn(),
      recordFailure: vi.fn(),
      scheduleCheck: vi.fn(),
      processChange: (_target, _fingerprint, signal) =>
        new Promise<boolean>((resolve) => {
          entered();
          signal.addEventListener(
            'abort',
            () => {
              settled = true;
              resolve(false);
            },
            { once: true },
          );
        }),
    });

    await controller.start('student-a');
    await processingStarted;
    await controller.stop('student-a');

    expect(settled).toBe(true);
  });
});
