import { describe, expect, it, vi } from 'vitest';
import { createWatchLifecycle } from '../services/lifecycle';
import type { WatchLifecycleConfiguration } from '../services/lifecycle';

const configuration = (
  overrides: Partial<WatchLifecycleConfiguration> = {},
): WatchLifecycleConfiguration => ({
  userId: 'student-a',
  enabled: true,
  setupComplete: true,
  consent: true,
  workspaceReady: true,
  hasCourseResource: true,
  needsSignIn: false,
  isCurrent: () => true,
  ...overrides,
});

describe('watch lifecycle', () => {
  it('starts only when setup, consent, browser, connection, and session are eligible', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const onStatus = vi.fn();
    const lifecycle = createWatchLifecycle({ start, stop, onStatus });

    await lifecycle.configure(configuration({ consent: false }));
    expect(start).not.toHaveBeenCalled();
    expect(lifecycle.getStatus('student-a')).toBe('paused');

    await lifecycle.configure(configuration({ needsSignIn: true }));
    expect(start).not.toHaveBeenCalled();
    expect(lifecycle.getStatus('student-a')).toBe('needs-sign-in');

    await lifecycle.configure(configuration());
    expect(start).toHaveBeenCalledOnce();
    expect(lifecycle.getStatus('student-a')).toBe('watching');
  });

  it('stops the prior account before starting a newly active account', async () => {
    const events: string[] = [];
    const lifecycle = createWatchLifecycle({
      start: async (userId) => {
        events.push(`start:${userId}`);
      },
      stop: async (userId) => {
        events.push(`stop:${userId}`);
      },
      onStatus: vi.fn(),
    });

    await lifecycle.configure(configuration());
    await lifecycle.configure(configuration({ userId: 'student-b' }));

    expect(events).toEqual([
      'start:student-a',
      'stop:student-a',
      'start:student-b',
    ]);
    expect(lifecycle.getStatus('student-a')).toBe('off');
    expect(lifecycle.getStatus('student-b')).toBe('watching');
  });

  it('does not restart an unchanged watcher during routine state reads', async () => {
    const start = vi.fn(async () => undefined);
    const lifecycle = createWatchLifecycle({
      start,
      stop: vi.fn(async () => undefined),
      onStatus: vi.fn(),
    });
    await lifecycle.configure(configuration({ key: 'enabled:urls-a' }));
    await lifecycle.configure(configuration({ key: 'enabled:urls-a' }));

    expect(start).toHaveBeenCalledOnce();
  });

  it('closes old target ownership before applying changed watch settings', async () => {
    const events: string[] = [];
    const lifecycle = createWatchLifecycle({
      start: async (_userId, _isCurrent) => {
        events.push('start');
      },
      stop: async () => {
        events.push('stop');
      },
      onStatus: vi.fn(),
    });
    await lifecycle.configure(configuration({ key: 'url-a' }));
    await lifecycle.configure(configuration({ key: 'url-b' }));

    expect(events).toEqual(['start', 'stop', 'start']);
  });

  it('cancels an in-flight start when the setting is switched off', async () => {
    let releaseStart!: () => void;
    const stop = vi.fn(async () => undefined);
    const lifecycle = createWatchLifecycle({
      start: () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
      stop,
      onStatus: vi.fn(),
    });

    const enabling = lifecycle.configure(configuration());
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'));
    const disabling = lifecycle.configure(configuration({ enabled: false }));
    releaseStart();
    await Promise.all([enabling, disabling]);

    expect(stop).toHaveBeenCalledWith('student-a');
    expect(lifecycle.getStatus('student-a')).toBe('off');
  });

  it('aborts startup before waiting for the first check to settle', async () => {
    let releaseStart!: () => void;
    let startSignal: AbortSignal | undefined;
    const start = vi.fn(
      (_userId: string, _isCurrent: () => boolean, signal?: AbortSignal) => {
        startSignal = signal;
        return new Promise<void>((resolve) => {
          releaseStart = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );
    const stop = vi.fn(async () => undefined);
    const lifecycle = createWatchLifecycle({ start, stop, onStatus: vi.fn() });

    const starting = lifecycle.configure(configuration());
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const disabling = lifecycle.configure(configuration({ enabled: false }));
    const abortedBeforeRelease = startSignal?.aborted === true;
    releaseStart();
    await Promise.all([starting, disabling]);

    expect(abortedBeforeRelease).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(lifecycle.getStatus('student-a')).toBe('off');
  });

  it('waits for startup settlement when stop reports a cleanup error', async () => {
    let finishStart!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        }),
    );
    let stopCalls = 0;
    const stop = vi.fn(async () => {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error('Page cleanup failed.');
    });
    const lifecycle = createWatchLifecycle({ start, stop, onStatus: vi.fn() });

    const starting = lifecycle
      .configure(configuration())
      .catch(() => undefined);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    let disablingSettled = false;
    const disabling = lifecycle
      .configure(configuration({ enabled: false }))
      .catch(() => undefined)
      .finally(() => {
        disablingSettled = true;
      });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(disablingSettled).toBe(false);

    finishStart();
    await Promise.all([starting, disabling]);
    expect(disablingSettled).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(lifecycle.getStatus('student-a')).toBe('off');
  });

  it('awaits unresolved startup work after signalling abort before cleanup returns', async () => {
    let finishStart!: () => void;
    let startSignal: AbortSignal | undefined;
    const start = vi.fn(
      (_userId: string, _isCurrent: () => boolean, signal?: AbortSignal) => {
        startSignal = signal;
        return new Promise<void>((resolve) => {
          finishStart = resolve;
        });
      },
    );
    const lifecycle = createWatchLifecycle({
      start,
      stop: vi.fn(async () => undefined),
      onStatus: vi.fn(),
    });

    const starting = lifecycle.configure(configuration());
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    let disablingSettled = false;
    const disabling = lifecycle
      .configure(configuration({ enabled: false }))
      .then(() => {
        disablingSettled = true;
      });
    await vi.waitFor(() => expect(startSignal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(disablingSettled).toBe(false);

    finishStart();
    await Promise.all([starting, disabling]);
    expect(disablingSettled).toBe(true);
  });

  it('coalesces equivalent configuration while startup is pending', async () => {
    let releaseStart!: () => void;
    let startSignal: AbortSignal | undefined;
    const start = vi.fn(
      (_userId: string, _isCurrent: () => boolean, signal?: AbortSignal) => {
        startSignal = signal;
        return new Promise<void>((resolve) => {
          releaseStart = resolve;
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    );
    const stop = vi.fn(async () => undefined);
    const lifecycle = createWatchLifecycle({ start, stop, onStatus: vi.fn() });

    const firstStart = lifecycle.configure(
      configuration({ key: 'enabled:urls-a' }),
    );
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const repeatedStart = lifecycle.configure(
      configuration({ key: 'enabled:urls-a' }),
    );
    await Promise.resolve();
    const remainedHealthy = startSignal?.aborted === false;
    releaseStart();
    await Promise.all([firstStart, repeatedStart]);

    expect(remainedHealthy).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it('pauses on system suspend, resumes one current session, and stops on quit', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const lifecycle = createWatchLifecycle({
      start,
      stop,
      onStatus: vi.fn(),
    });
    await lifecycle.configure(configuration());

    await lifecycle.pause();
    expect(lifecycle.getStatus('student-a')).toBe('paused');
    await lifecycle.resume();
    expect(start).toHaveBeenCalledTimes(2);
    await lifecycle.stop();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('keeps the watcher stopped until every foreground browser owner releases it', async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const lifecycle = createWatchLifecycle({ start, stop, onStatus: vi.fn() });
    await lifecycle.configure(configuration());

    const releaseFirst = await lifecycle.suspend();
    const releaseSecond = await lifecycle.suspend();
    await releaseFirst();
    expect(start).toHaveBeenCalledOnce();
    await releaseSecond();

    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
    expect(lifecycle.getStatus('student-a')).toBe('watching');
  });

  it('makes concurrent foreground suspensions share the awaited stop barrier', async () => {
    let finishStop!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const lifecycle = createWatchLifecycle({
      start: vi.fn(async () => undefined),
      stop,
      onStatus: vi.fn(),
    });
    await lifecycle.configure(configuration());

    let firstSuspensionSettled = false;
    let secondSuspensionSettled = false;
    const firstSuspension = lifecycle.suspend().then((release) => {
      firstSuspensionSettled = true;
      return release;
    });
    const secondSuspension = lifecycle.suspend().then((release) => {
      secondSuspensionSettled = true;
      return release;
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(firstSuspensionSettled).toBe(false);
    expect(secondSuspensionSettled).toBe(false);
    finishStop();
    const releases = await Promise.all([firstSuspension, secondSuspension]);

    expect(stop).toHaveBeenCalledOnce();
    await releases[0]!();
    expect(lifecycle.getStatus('student-a')).toBe('paused');
    await releases[1]!();
    expect(lifecycle.getStatus('student-a')).toBe('watching');
  });

  it('keeps a system suspend active after foreground browser work releases', async () => {
    const start = vi.fn(async () => undefined);
    const lifecycle = createWatchLifecycle({
      start,
      stop: vi.fn(async () => undefined),
      onStatus: vi.fn(),
    });
    await lifecycle.configure(configuration());

    const releaseForeground = await lifecycle.suspend();
    await lifecycle.pause();
    await releaseForeground();
    expect(start).toHaveBeenCalledOnce();
    expect(lifecycle.getStatus('student-a')).toBe('paused');

    await lifecycle.resume();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not start for a stale session and reports a browser startup failure', async () => {
    const start = vi.fn(async () => {
      throw new Error('browser failed');
    });
    const stop = vi.fn(async () => undefined);
    const lifecycle = createWatchLifecycle({
      start,
      stop,
      onStatus: vi.fn(),
    });

    await lifecycle.configure(configuration({ isCurrent: () => false }));
    expect(start).not.toHaveBeenCalled();
    await lifecycle.configure(configuration());
    expect(lifecycle.getStatus('student-a')).toBe('blocked');
    expect(stop).toHaveBeenCalledWith('student-a');
  });
});
