import { describe, expect, it, vi } from 'vitest';
import { AcademicTaskDeferredError } from '../services/academic-tasks';
import { createBackgroundSyncController } from '../services/background-sync';
import type { BackgroundSyncState } from '../types';

type SyncRun = { failure: string | null; partial?: boolean };

const setup = () => {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const changes: Array<{ state: BackgroundSyncState; result: SyncRun | null }> =
    [];
  let resolveRun: ((value: SyncRun) => void) | null = null;
  const runDiscovery = vi.fn(
    (
      _userId: string,
      _isCurrent: () => boolean,
      _signal: AbortSignal,
    ): Promise<SyncRun> =>
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
  );
  const controller = createBackgroundSyncController<SyncRun>({
    runDiscovery,
    syncFailure: (result) => result.failure,
    isPartial: (result) => result.partial === true,
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    cancelSchedule: vi.fn(),
    now: () => '2026-10-28T12:00:00.000Z',
    intervalMs: 60_000,
    initialDelayMs: 5_000,
    onChange: (state, result) => changes.push({ state, result }),
  });
  return {
    controller,
    runDiscovery,
    timers,
    changes,
    finishRun: (result: SyncRun = { failure: null }) => resolveRun?.(result),
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

    harness.finishRun();
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
    // Cancellation must still allow the current account to persist its outcome.
    expect(harness.runDiscovery.mock.calls[0]![1]()).toBe(true);
    harness.finishRun();
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
    harness.finishRun();
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
  harness.finishRun();
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

describe('honest sync reporting', () => {
  it('keeps the previous sync time when no resource could be read', async () => {
    const harness = setup();
    enable(harness.controller);
    harness.timers[0]!.callback();
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('syncing'),
    );

    harness.finishRun({
      failure: 'Sign in in your study browser, then refresh the course map.',
    });

    await vi.waitFor(() =>
      expect(harness.controller.getState()).toMatchObject({
        status: 'blocked',
        message: 'Sign in in your study browser, then refresh the course map.',
        lastSyncedAt: null,
      }),
    );
  });

  it('clears a stale failure once a later sync reads the resources', async () => {
    const harness = setup();
    enable(harness.controller);
    harness.timers[0]!.callback();
    harness.finishRun({ failure: 'None of your resources could be read.' });
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('blocked'),
    );

    harness.timers.at(-1)!.callback();
    harness.finishRun();

    await vi.waitFor(() =>
      expect(harness.controller.getState()).toMatchObject({
        status: 'waiting',
        message: 'Waiting for the next scheduled sync.',
        lastSyncedAt: '2026-10-28T12:00:00.000Z',
      }),
    );
  });

  it('publishes the refreshed discovery result when the run finishes', async () => {
    const harness = setup();
    enable(harness.controller);
    harness.timers[0]!.callback();
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('syncing'),
    );

    harness.finishRun();

    await vi.waitFor(() =>
      expect(harness.changes.at(-1)).toMatchObject({
        state: { status: 'waiting' },
        result: { failure: null },
      }),
    );
  });

  it('does not replay a completed result on later status changes', async () => {
    const harness = setup();
    enable(harness.controller);
    harness.timers[0]!.callback();
    harness.finishRun();
    await vi.waitFor(() =>
      expect(harness.changes.at(-1)?.result).not.toBeNull(),
    );

    harness.controller.pause();
    expect(harness.changes.at(-1)?.result).toBeNull();
    harness.controller.resume();
    expect(harness.changes.at(-1)?.result).toBeNull();
    harness.timers.at(-1)!.callback();
    expect(harness.changes.at(-1)?.result).toBeNull();
    harness.finishRun();
  });
});

describe('temporary browser work', () => {
  it('waits for every foreground action before resuming sync', () => {
    const harness = setup();
    enable(harness.controller);
    const releaseFirst = harness.controller.suspend();
    const releaseSecond = harness.controller.suspend();
    const scheduled = harness.timers.length;

    releaseFirst();
    expect(harness.controller.getState().status).toBe('paused');
    expect(harness.timers.length).toBe(scheduled);
    releaseFirst();
    expect(harness.controller.getState().status).toBe('paused');
    releaseSecond();
    expect(harness.controller.getState().status).toBe('waiting');
    expect(harness.timers.length).toBe(scheduled + 1);
  });

  it('keeps foreground ownership when sync is enabled during the action', () => {
    const harness = setup();
    harness.controller.configure({
      userId: 'student-a',
      enabled: false,
      isCurrent: () => true,
    });
    const release = harness.controller.suspend();
    enable(harness.controller);
    expect(harness.controller.getState().status).toBe('paused');
    expect(harness.timers).toHaveLength(0);
    release();
    expect(harness.controller.getState().status).toBe('waiting');
    expect(harness.timers).toHaveLength(1);
  });

  it('does not let an old account release the new account’s browser action', () => {
    const harness = setup();
    enable(harness.controller);
    const releaseOld = harness.controller.suspend();
    harness.controller.configure({
      userId: 'student-b',
      enabled: true,
      isCurrent: () => true,
    });
    const releaseCurrent = harness.controller.suspend();
    releaseOld();
    expect(harness.controller.getState().status).toBe('paused');
    releaseCurrent();
    expect(harness.controller.getState().status).toBe('waiting');
  });
  it('reschedules syncs after a foreground browser action finishes', async () => {
    const harness = setup();
    enable(harness.controller);
    const release = harness.controller.suspend();
    expect(harness.controller.getState().status).toBe('paused');

    const scheduled = harness.timers.length;
    expect(release().status).toBe('waiting');
    expect(harness.timers.length).toBe(scheduled + 1);

    harness.timers.at(-1)!.callback();
    await vi.waitFor(() => expect(harness.runDiscovery).toHaveBeenCalledOnce());
  });

  it('reschedules after configuration is reapplied during the action', () => {
    const harness = setup();
    enable(harness.controller);
    const release = harness.controller.suspend();

    const scheduled = harness.timers.length;
    harness.controller.configure({
      userId: 'student-a',
      enabled: true,
      isCurrent: () => true,
    });
    expect(harness.timers.length).toBe(scheduled);

    expect(release().status).toBe('waiting');
    expect(harness.timers.length).toBe(scheduled + 1);
  });

  it('aborts a running sync and waits for the action to finish', async () => {
    const harness = setup();
    enable(harness.controller);
    harness.timers[0]!.callback();
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('syncing'),
    );
    const signal = harness.runDiscovery.mock.calls[0]![2];

    const release = harness.controller.suspend();
    expect(signal.aborted).toBe(true);
    harness.finishRun();
    await Promise.resolve();
    expect(harness.controller.getState().status).toBe('paused');

    expect(release().status).toBe('waiting');
  });

  it('keeps an explicit user pause after the action finishes', () => {
    const harness = setup();
    enable(harness.controller);
    harness.controller.pause();
    const release = harness.controller.suspend();

    const scheduled = harness.timers.length;
    expect(release().status).toBe('paused');
    expect(harness.timers.length).toBe(scheduled);
    expect(harness.controller.resume().status).toBe('waiting');
  });

  it('explains why sync is briefly unavailable during an action', () => {
    const harness = setup();
    enable(harness.controller);
    harness.controller.suspend();
    expect(harness.controller.getState().message).not.toContain(
      'resume whenever you want',
    );
  });
});

it('waits for verified reconnection after authentication expires', async () => {
  const harness = setup();
  enable(harness.controller);
  harness.timers[0].callback();
  harness.finishRun({ failure: 'Please sign in again.' });
  await vi.waitFor(() =>
    expect(harness.controller.getState().status).toBe('blocked'),
  );
  expect(harness.timers).toHaveLength(1);
  enable(harness.controller);
  expect(harness.timers).toHaveLength(1);
  harness.controller.resume();
  expect(harness.timers).toHaveLength(1);
  harness.controller.connectionRestored('student-a');
  expect(harness.timers).toHaveLength(2);
});

it('backs off transient failures and stops after three failed scheduled attempts', async () => {
  const harness = setup();
  enable(harness.controller);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    harness.timers.at(-1)!.callback();
    harness.finishRun({ failure: 'The resource is unavailable.' });
    await vi.waitFor(() =>
      expect(harness.controller.getState().status).toBe('blocked'),
    );
  }
  expect(harness.timers.map((timer) => timer.delayMs)).toEqual([
    5000, 60000, 300000,
  ]);
});

it('defers busy work without spending the transient failure budget', async () => {
  const harness = setup();
  harness.runDiscovery.mockRejectedValueOnce(
    new AcademicTaskDeferredError('Another academic task is running.'),
  );
  enable(harness.controller);
  harness.timers[0]!.callback();

  await vi.waitFor(() =>
    expect(harness.controller.getState()).toMatchObject({
      status: 'waiting',
      message: 'Background sync is waiting for other academic work.',
      lastSyncedAt: null,
    }),
  );
  expect(harness.timers.map((timer) => timer.delayMs)).toEqual([5000, 60000]);

  harness.runDiscovery.mockRejectedValueOnce(
    new Error('The resource is unavailable.'),
  );
  harness.timers.at(-1)!.callback();
  await vi.waitFor(() =>
    expect(harness.controller.getState().status).toBe('blocked'),
  );
  expect(harness.timers.map((timer) => timer.delayMs)).toEqual([
    5000, 60000, 60000,
  ]);
});

it('does not advance the successful timestamp for partial source coverage', async () => {
  const harness = setup();
  enable(harness.controller);
  harness.timers[0]!.callback();
  harness.finishRun({ failure: null, partial: true });

  await vi.waitFor(() =>
    expect(harness.controller.getState()).toMatchObject({
      status: 'waiting',
      message: 'The last background sync had incomplete source coverage.',
      lastSyncedAt: null,
    }),
  );
});

it('recognizes a partial settlement from the internal refresh result', async () => {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  let finishRun!: (result: { status: 'partial' }) => void;
  const controller = createBackgroundSyncController<{
    status: 'partial';
  }>({
    runDiscovery: () =>
      new Promise((resolve) => {
        finishRun = resolve;
      }),
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    cancelSchedule: vi.fn(),
    now: () => '2026-10-28T12:00:00.000Z',
  });
  enable(controller);
  timers[0]!.callback();
  await vi.waitFor(() => expect(controller.getState().status).toBe('syncing'));

  finishRun({ status: 'partial' });

  await vi.waitFor(() =>
    expect(controller.getState()).toMatchObject({
      status: 'waiting',
      message: 'The last background sync had incomplete source coverage.',
      lastSyncedAt: null,
    }),
  );
});

it('waits for explicit reconnection after a sign-in-required result', async () => {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  let finishRun!: (result: { status: 'sign-in-required' }) => void;
  const controller = createBackgroundSyncController<{
    status: 'sign-in-required';
  }>({
    runDiscovery: () =>
      new Promise((resolve) => {
        finishRun = resolve;
      }),
    schedule: (callback, delayMs) => {
      timers.push({ callback, delayMs });
      return timers.length;
    },
    cancelSchedule: vi.fn(),
  });
  enable(controller);
  timers[0]!.callback();
  await vi.waitFor(() => expect(controller.getState().status).toBe('syncing'));

  finishRun({ status: 'sign-in-required' });

  await vi.waitFor(() =>
    expect(controller.getState()).toMatchObject({
      status: 'blocked',
      message: 'Sign in in your study browser, then resume background sync.',
    }),
  );
  expect(timers).toHaveLength(1);
  expect(controller.resume().status).toBe('blocked');
  expect(timers).toHaveLength(1);
  controller.connectionRestored('student-a');
  expect(timers).toHaveLength(2);
});
