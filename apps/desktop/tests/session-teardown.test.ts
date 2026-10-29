import { describe, expect, it, vi } from 'vitest';
import { tearDownSession } from '../src/lib/session-teardown';
import { createSessionGuard, runSessionAction } from '../src/lib/session-guard';

describe('session teardown', () => {
  it('invalidates the session and stops missions before awaiting cleanup', async () => {
    const calls: string[] = [];
    const teardown = tearDownSession(
      {
        invalidateSession: () => calls.push('invalidate'),
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

    expect(calls.slice(0, 2)).toEqual(['invalidate', 'missions']);
    await teardown;
    expect(calls).toEqual(['invalidate', 'missions', 'clear', 'browser']);
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
});
