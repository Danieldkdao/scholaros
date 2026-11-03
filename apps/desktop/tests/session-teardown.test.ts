import { describe, expect, it, vi } from 'vitest';
import { tearDownSession } from '../src/lib/session-teardown';
import { createSessionGuard, runSessionAction } from '../src/lib/session-guard';
import {
  createLearningLifecycle,
  registerLearningActions,
} from '../src/services/academic/learning-actions';

describe('session teardown', () => {
  it('invalidates the session and stops missions before awaiting cleanup', async () => {
    const calls: string[] = [];
    const teardown = tearDownSession(
      {
        invalidateSession: () => {
          calls.push('invalidate');
        },
        stopMissions: () => calls.push('missions'),
        clearLocalSession: async () => {
          calls.push('clear');
        },
        closeBrowser: async () => {
          calls.push('browser');
        },
      },
      { clearBoundMs: 20 },
    );

    expect(calls).toEqual(['invalidate']);
    await teardown;
    expect(calls).toEqual(['invalidate', 'missions', 'clear', 'browser']);
  });

  it('waits for lifecycle invalidation before stopping the remaining work', async () => {
    const calls: string[] = [];
    let finishInvalidation!: () => void;
    const invalidation = new Promise<void>((resolve) => {
      finishInvalidation = resolve;
    });
    const teardown = tearDownSession({
      invalidateSession: async () => {
        calls.push('invalidate-start');
        await invalidation;
        calls.push('invalidate-finish');
      },
      stopMissions: () => {
        calls.push('missions');
      },
      clearLocalSession: async () => {
        calls.push('clear');
      },
      closeBrowser: async () => {
        calls.push('browser');
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(['invalidate-start']);
    finishInvalidation();
    await teardown;
    expect(calls).toEqual([
      'invalidate-start',
      'invalidate-finish',
      'missions',
      'clear',
      'browser',
    ]);
  });

  it('returns without waiting for an unavailable account service', async () => {
    const closeBrowser = vi.fn(async () => undefined);
    const started = Date.now();
    await tearDownSession(
      {
        invalidateSession: vi.fn(),
        stopMissions: vi.fn(),
        clearLocalSession: () => new Promise(() => undefined),
        closeBrowser,
      },
      { clearBoundMs: 30 },
    );

    expect(Date.now() - started).toBeLessThan(500);
    expect(closeBrowser).toHaveBeenCalledOnce();
  });

  it('waits for watcher cancellation before clearing the signed-in session', async () => {
    const calls: string[] = [];
    let finishStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const teardown = tearDownSession({
      invalidateSession: () => {
        calls.push('invalidate');
      },
      stopMissions: async () => {
        calls.push('stop-start');
        await stopped;
        calls.push('stop-finish');
      },
      clearLocalSession: async () => {
        calls.push('clear');
      },
      closeBrowser: async () => {
        calls.push('browser');
      },
    });

    await Promise.resolve();
    expect(calls).toEqual(['invalidate', 'stop-start']);
    finishStop();
    await teardown;
    expect(calls).toEqual([
      'invalidate',
      'stop-start',
      'stop-finish',
      'clear',
      'browser',
    ]);
  });

  it('returns without waiting for a stalled browser close', async () => {
    const started = Date.now();
    await tearDownSession(
      {
        invalidateSession: vi.fn(),
        stopMissions: vi.fn(),
        clearLocalSession: async () => undefined,
        closeBrowser: () => new Promise(() => undefined),
      },
      { clearBoundMs: 30 },
    );

    expect(Date.now() - started).toBeLessThan(500);
  });

  it('blocks a pending action from resolving into the next account', async () => {
    const guard = createSessionGuard();
    let release: (value: string) => void = () => undefined;
    const pending = runSessionAction(guard, async () => {
      await new Promise<void>((resolve) => {
        release = (value) => {
          void value;
          resolve();
        };
      });
      return { step: 'review' };
    });

    guard.invalidate();
    release('saved');

    await expect(pending).rejects.toThrow('Your session changed');
    expect(guard.isCurrent(guard.begin())).toBe(true);
  });

  it('gives a running action a session check that sees invalidation', async () => {
    const guard = createSessionGuard();
    let staleDuringAction: boolean | null = null;
    const pending = runSessionAction(guard, async (isCurrent) => {
      guard.invalidate();
      staleDuringAction = isCurrent();
      return 'saved';
    });

    await expect(pending).rejects.toThrow('Your session changed');
    expect(staleDuringAction).toBe(false);
  });

  it('cancels only operations registered to the requested scope', () => {
    const lifecycle = createLearningLifecycle();
    const first = new AbortController();
    const second = new AbortController();
    lifecycle.registerOperation('session-a', 'turn-a', first);
    lifecycle.registerOperation('session-b', 'turn-b', second);

    lifecycle.cancelOperations('session-a');

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('cleans up registered feature actions in reverse order', async () => {
    const calls: string[] = [];
    const registrar = {
      handle: vi.fn(),
      publish: vi.fn(),
      lifecycle: createLearningLifecycle(),
    };
    const cleanup = registerLearningActions(registrar as never, [
      () => {
        calls.push('register-a');
        return async () => {
          calls.push('cleanup-a');
        };
      },
      () => {
        calls.push('register-b');
        return async () => {
          calls.push('cleanup-b');
        };
      },
    ]);

    expect(calls).toEqual(['register-a', 'register-b']);
    await cleanup();
    expect(calls).toEqual([
      'register-a',
      'register-b',
      'cleanup-b',
      'cleanup-a',
    ]);
  });

  it('aborts registered work and awaits lifecycle cleanup before opening a new epoch', async () => {
    const lifecycle = createLearningLifecycle();
    const epoch = lifecycle.epoch;
    const operation = new AbortController();
    const unregister = lifecycle.registerOperation(
      'study:session-a',
      'turn-a',
      operation,
    );
    unregister();
    const activeOperation = new AbortController();
    lifecycle.registerOperation('study:session-a', 'turn-b', activeOperation);
    let finishCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    lifecycle.onTeardown(cleanup);

    const invalidation = lifecycle.invalidate();
    expect(lifecycle.epoch).toBe(epoch + 1);
    expect(lifecycle.isCurrent(epoch)).toBe(false);
    expect(operation.signal.aborted).toBe(false);
    expect(activeOperation.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    finishCleanup();
    await invalidation;
    expect(lifecycle.signal.aborted).toBe(false);
    expect(lifecycle.isCurrent(lifecycle.epoch)).toBe(true);
  });
});
