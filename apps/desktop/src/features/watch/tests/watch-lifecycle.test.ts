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
    expect(lifecycle.getStatus('student-a')).toBe('watching');
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
    await Promise.resolve();
    const disabling = lifecycle.configure(configuration({ enabled: false }));
    releaseStart();
    await Promise.all([enabling, disabling]);

    expect(stop).toHaveBeenCalledWith('student-a');
    expect(lifecycle.getStatus('student-a')).toBe('off');
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
