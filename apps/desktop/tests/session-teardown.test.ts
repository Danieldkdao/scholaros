import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { tearDownSession } from '../src/lib/session-teardown';
import { createSessionGuard, runSessionAction } from '../src/lib/session-guard';
import {
  getTrustedWindows,
  installTrustedFocusedWebContentsGuard,
  isTrustedWebContents,
  registerTrustedWindow,
  requireTrustedSender,
} from '../src/lib/trusted-windows';
import {
  createLearningLifecycle,
  registerLearningActions,
} from '../src/services/academic/learning-actions';

const focusedContents: {
  current: ReturnType<typeof createTestWindow>['webContents'] | null;
} = { current: null };
const getFocusedWebContents = vi.fn(() => focusedContents.current);
const focusedWebContentsApi = {
  getFocusedWebContents,
};

const createTestWindow = (id: number, initialUrl = 'about:blank') => {
  let currentUrl = initialUrl;
  let destroyed = false;
  const webContentsEvents = new EventEmitter();
  const webContents = Object.assign(webContentsEvents, {
    id,
    getURL: () => currentUrl,
    isDestroyed: () => destroyed,
    mainFrame: { url: initialUrl },
    send: vi.fn(),
  });
  const windowEvents = new EventEmitter();
  const window = Object.assign(windowEvents, {
    isDestroyed: () => destroyed,
    webContents,
  });
  const setDocument = (url: string, frame = { url }) => {
    currentUrl = url;
    frame.url = url;
    webContents.mainFrame = frame;
  };
  const commitDocument = (url: string, frame = { url }) => {
    setDocument(url, frame);
    webContentsEvents.emit('did-navigate', {}, url, 200, 'OK');
  };
  const startNavigation = (
    url: string,
    { isMainFrame = true, isSameDocument = false } = {},
  ) =>
    webContentsEvents.emit('did-start-navigation', {
      isMainFrame,
      isSameDocument,
      url,
    });
  const destroy = () => {
    destroyed = true;
    webContentsEvents.emit('destroyed');
    windowEvents.emit('closed');
  };

  return {
    commitDocument,
    destroy,
    setDocument,
    startNavigation,
    webContents,
    window,
    webContentsEvents,
  };
};

const senderEvent = (
  webContents: ReturnType<typeof createTestWindow>['webContents'],
  senderFrame = webContents.mainFrame,
) => ({ sender: webContents, senderFrame }) as never;

describe('trusted application windows', () => {
  const expectedDocument = 'scholaros://app/index.html?mode=desktop';

  it('accepts only a registered exact-document main frame', () => {
    const appWindow = createTestWindow(401);
    const unrelatedWindow = createTestWindow(402, expectedDocument);
    const activityContents = createTestWindow(403, expectedDocument);
    const cleanup = registerTrustedWindow(
      appWindow.window as never,
      expectedDocument,
    );

    try {
      expect(getTrustedWindows()).toEqual([]);
      appWindow.commitDocument(expectedDocument);
      expect(requireTrustedSender(senderEvent(appWindow.webContents))).toBe(
        appWindow.window,
      );
      expect(isTrustedWebContents(appWindow.webContents as never)).toBe(true);

      unrelatedWindow.commitDocument(expectedDocument);
      activityContents.commitDocument(expectedDocument);
      expect(() =>
        requireTrustedSender(senderEvent(unrelatedWindow.webContents)),
      ).toThrow('Untrusted application frame');
      expect(() =>
        requireTrustedSender(senderEvent(activityContents.webContents)),
      ).toThrow('Untrusted application frame');
      expect(() =>
        requireTrustedSender(
          senderEvent(appWindow.webContents, { url: expectedDocument }),
        ),
      ).toThrow('Untrusted application frame');

      const wrongDocument = 'scholaros://app/index.html?mode=other';
      appWindow.commitDocument(wrongDocument);
      expect(isTrustedWebContents(appWindow.webContents as never)).toBe(false);
      expect(() =>
        requireTrustedSender(senderEvent(appWindow.webContents)),
      ).toThrow('Untrusted application frame');
    } finally {
      cleanup();
    }
  });

  it('keeps same-document hash navigation but fences reloads and remote commits', () => {
    const appWindow = createTestWindow(404);
    const cleanup = registerTrustedWindow(
      appWindow.window as never,
      expectedDocument,
    );

    try {
      appWindow.commitDocument(`${expectedDocument}#today`);
      const originalFrame = appWindow.webContents.mainFrame;
      appWindow.setDocument(`${expectedDocument}#study`, originalFrame);
      expect(requireTrustedSender(senderEvent(appWindow.webContents))).toBe(
        appWindow.window,
      );

      appWindow.startNavigation(expectedDocument);
      expect(isTrustedWebContents(appWindow.webContents as never)).toBe(false);
      expect(getTrustedWindows()).toEqual([]);
      expect(() =>
        requireTrustedSender(senderEvent(appWindow.webContents, originalFrame)),
      ).toThrow('Untrusted application frame');

      const reloadedFrame = { url: expectedDocument };
      appWindow.commitDocument(expectedDocument, reloadedFrame);
      expect(isTrustedWebContents(appWindow.webContents as never)).toBe(true);
      expect(() =>
        requireTrustedSender(senderEvent(appWindow.webContents, originalFrame)),
      ).toThrow('Untrusted application frame');
      expect(requireTrustedSender(senderEvent(appWindow.webContents))).toBe(
        appWindow.window,
      );

      const preventDefault = vi.fn();
      appWindow.webContentsEvents.emit('will-navigate', {
        preventDefault,
        url: 'https://remote.example/document',
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(isTrustedWebContents(appWindow.webContents as never)).toBe(true);

      appWindow.startNavigation('https://remote.example/document');
      appWindow.commitDocument('https://remote.example/document');
      expect(isTrustedWebContents(appWindow.webContents as never)).toBe(false);
      expect(getTrustedWindows()).toEqual([]);
      expect(() =>
        requireTrustedSender(senderEvent(appWindow.webContents)),
      ).toThrow('Untrusted application frame');
    } finally {
      cleanup();
    }
  });

  it('does not let stale cleanup revoke a replacement registration', () => {
    const appWindow = createTestWindow(405);
    const firstCleanup = registerTrustedWindow(
      appWindow.window as never,
      expectedDocument,
    );
    appWindow.commitDocument(expectedDocument);
    const replacementDocument = 'scholaros://app/recovered.html';
    const replacementCleanup = registerTrustedWindow(
      appWindow.window as never,
      replacementDocument,
    );

    try {
      appWindow.commitDocument(replacementDocument);
      firstCleanup();
      expect(requireTrustedSender(senderEvent(appWindow.webContents))).toBe(
        appWindow.window,
      );
      expect(getTrustedWindows()).toEqual([appWindow.window]);
    } finally {
      replacementCleanup();
      replacementCleanup();
    }
    expect(getTrustedWindows()).toEqual([]);
  });

  it('revokes a destroyed window and removes its registry listeners', () => {
    const appWindow = createTestWindow(408);
    const cleanup = registerTrustedWindow(
      appWindow.window as never,
      expectedDocument,
    );
    appWindow.commitDocument(expectedDocument);
    expect(getTrustedWindows()).toEqual([appWindow.window]);

    appWindow.destroy();

    expect(getTrustedWindows()).toEqual([]);
    expect(appWindow.webContentsEvents.listenerCount('did-navigate')).toBe(0);
    expect(() =>
      requireTrustedSender(senderEvent(appWindow.webContents)),
    ).toThrow('Untrusted application frame');
    cleanup();
  });

  it('filters Better Auth focused-window callback recipients', () => {
    const appWindow = createTestWindow(406);
    const unrelatedWindow = createTestWindow(407, expectedDocument);
    const cleanupWindow = registerTrustedWindow(
      appWindow.window as never,
      expectedDocument,
    );
    const cleanupFocus = installTrustedFocusedWebContentsGuard(
      focusedWebContentsApi as never,
    );

    try {
      appWindow.commitDocument(expectedDocument);
      unrelatedWindow.commitDocument(expectedDocument);
      focusedContents.current = unrelatedWindow.webContents;
      expect(focusedWebContentsApi.getFocusedWebContents()).toBeNull();

      focusedContents.current = appWindow.webContents;
      expect(focusedWebContentsApi.getFocusedWebContents()).toBe(
        appWindow.webContents,
      );
    } finally {
      focusedContents.current = null;
      cleanupFocus();
      cleanupWindow();
    }
  });
});

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

  it('keeps pending work stale across same-account teardown and sign-in', async () => {
    const guard = createSessionGuard();
    let release!: () => void;
    const pending = runSessionAction(guard, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { accountId: 'same-account' };
    });
    await Promise.resolve();

    await tearDownSession({
      invalidateSession: () => guard.invalidate(),
      stopMissions: () => undefined,
      clearLocalSession: async () => undefined,
      closeBrowser: async () => undefined,
    });
    const newSession = guard.begin();
    release();

    await expect(pending).rejects.toThrow('Your session changed');
    expect(guard.isCurrent(newSession)).toBe(true);
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
