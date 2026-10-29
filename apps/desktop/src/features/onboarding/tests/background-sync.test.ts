import { describe, expect, it, vi } from 'vitest';
import { createBackgroundSyncController } from '../services/background-sync';

const setup = () => {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  let resolveRun: (() => void) | null = null;
  const runDiscovery = vi.fn(
    (
      _userId: string,
      _isCurrent: () => boolean,
      _signal: AbortSignal,
    ): Promise<unknown> =>
      new Promise((resolve) => {
        resolveRun = () => resolve(undefined);
      }),
  );
  const controller = createBackgroundSyncController({
    runDiscovery,
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    cancelSchedule: vi.fn(),
    now: () => '2026-10-28T12:00:00.000Z',
    intervalMs: 60_000,
    initialDelayMs: 5_000,
  });
  return {
    controller,
    runDiscovery,
    timers,
    release: () => resolveRun?.(),
  };
};

const enable = (controller: ReturnType<typeof setup>['controller']) =>
  controller.configure({
    userId: 'student-a',
    enabled: true,
    isCurrent: () => true,
  });

describe('background sync controller', () => {
  it('stays off until every prerequisite is met', () => {
    const { controller, runDiscovery } = setup();
    controller.configure({
      userId: 'student-a',
      enabled: false,
      isCurrent: () => true,
    });
    expect(controller.getState().status).toBe('off');
    expect(runDiscovery).not.toHaveBeenCalled();
  });

  it('runs discovery on schedule and reports the last successful sync', async () => {
    const harness = setup();
    enable(harness.controller);
    expect(harness.controller.getState().status).toBe('waiting');
    expect(harness.timers[0]?.delayMs).toBe(5_000);

    harness.timers[0]!.callback();
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('syncing'),
    );
    expect(harness.runDiscovery).toHaveBeenCalledOnce();
    expect(harness.runDiscovery.mock.calls[0]![0]).toBe('student-a');

    harness.release();
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('waiting'),
    );
    expect(harness.controller.getState().lastSyncedAt).toBe(
      '2026-10-28T12:00:00.000Z',
    );
  });

  it('pauses and aborts a running sync', async () => {
    const harness = setup();
    enable(harness.controller);
    harness.timers[0]!.callback();
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('syncing'),
    );
    const signal = harness.runDiscovery.mock.calls[0]![2];

    const paused = harness.controller.pause();
    expect(paused.status).toBe('paused');
    expect(signal.aborted).toBe(true);
    harness.release();
    await Promise.resolve();
    expect(harness.controller.getState().status).toBe('paused');

    expect(harness.controller.resume().status).toBe('waiting');
  });

  it('stops on sign-out and ignores a result from the previous account', async () => {
    const harness = setup();
    enable(harness.controller);
    harness.timers[0]!.callback();
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('syncing'),
    );

    harness.controller.configure({
      userId: 'student-b',
      enabled: true,
      isCurrent: () => true,
    });
    harness.release();
    await Promise.resolve();

    expect(harness.controller.getState().status).toBe('waiting');
    expect(harness.controller.getState().lastSyncedAt).toBeNull();
  });

  it('reports a failure instead of claiming a completed sync', async () => {
    const harness = setup();
    harness.runDiscovery.mockRejectedValueOnce(new Error('Canvas timed out'));
    enable(harness.controller);
    harness.timers[0]!.callback();

    await vi.waitFor(() =>
      expect(harness.controller.getState()).toMatchObject({
        status: 'blocked',
        message: 'Canvas timed out',
        lastSyncedAt: null,
      }),
    );
  });

  it('turns off when consent or connections are withdrawn', () => {
    const harness = setup();
    enable(harness.controller);
    expect(harness.controller.getState().status).toBe('waiting');

    harness.controller.configure({
      userId: 'student-a',
      enabled: false,
      isCurrent: () => true,
    });
    expect(harness.controller.getState().status).toBe('off');
  });
});

it('does not reuse the previous account’s completed sync timestamp', async () => {
  const harness = setup();
  enable(harness.controller);
  harness.timers[0]!.callback();
  harness.release();
  await vi.waitFor(() =>
    expect(harness.controller.getState().lastSyncedAt).not.toBeNull(),
  );
  harness.controller.configure({
    userId: 'student-b',
    enabled: true,
    isCurrent: () => true,
  });
  expect(harness.controller.getState().lastSyncedAt).toBeNull();
});
it('does not start a scheduled job after its session has been invalidated', async () => {
  const harness = setup();
  harness.controller.configure({
    userId: 'student-a',
    enabled: true,
    isCurrent: () => false,
  });
  harness.timers[0]!.callback();
  expect(harness.runDiscovery).not.toHaveBeenCalled();
});
