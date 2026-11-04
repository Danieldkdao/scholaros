import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionCleanup,
  AuthorizedContext,
} from '@scholaros/services/learning/product-contracts';
import type { LearningActionRegistrar } from '../src/services/academic/contracts';
import * as schema from '../src/db/schema';
import * as artifactStores from '../src/features/study/services/artifact-store';
import * as activityAdapters from '../src/services/academic/activity-adapter';
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
  loadLearningActionModules,
  registerLearningActions,
} from '../src/services/academic/learning-actions';

const storage = vi.hoisted(() => ({
  directory: '',
  db: null as ReturnType<typeof drizzle<typeof schema>> | null,
}));

vi.mock('../src/db', () => ({
  get db() {
    if (!storage.db) throw new Error('The test database is not initialized.');
    return storage.db;
  },
}));

vi.mock('electron', () => ({
  app: { getPath: () => storage.directory },
  session: {},
  protocol: {},
  WebContentsView: vi.fn(),
}));

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
      handleInternal: vi.fn(),
      publish: vi.fn(),
      lifecycle: createLearningLifecycle(),
    };
    const cleanup = await registerLearningActions(registrar, [
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

  it('aborts registered work and waits for settlement and cleanup before opening a new epoch', async () => {
    const lifecycle = createLearningLifecycle();
    const epoch = lifecycle.epoch;
    const operation = new AbortController();
    const unregisterOperation = lifecycle.registerOperation(
      'study:session-a',
      'turn-a',
      operation,
    );
    unregisterOperation();
    const activeOperation = new AbortController();
    const unregisterActiveOperation = lifecycle.registerOperation(
      'study:session-a',
      'turn-b',
      activeOperation,
    );
    let finishCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    lifecycle.onTeardown(cleanup);

    let invalidationSettled = false;
    const invalidation = lifecycle.invalidate().then(() => {
      invalidationSettled = true;
    });
    expect(lifecycle.epoch).toBe(epoch + 1);
    expect(lifecycle.isCurrent(epoch)).toBe(false);
    expect(operation.signal.aborted).toBe(false);
    expect(activeOperation.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();

    finishCleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invalidationSettled).toBe(false);

    unregisterActiveOperation();
    await invalidation;
    expect(invalidationSettled).toBe(true);
    expect(lifecycle.signal.aborted).toBe(false);
    expect(lifecycle.isCurrent(lifecycle.epoch)).toBe(true);
  });
});

describe('real learning module activity composition', () => {
  let sqlite: Database.Database;
  let dispose: ActionCleanup | undefined;

  beforeEach(() => {
    storage.directory = mkdtempSync(
      join(tmpdir(), 'scholaros-activity-composition-'),
    );
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    storage.db = drizzle({ client: sqlite, schema });
    migrate(storage.db, {
      migrationsFolder: join(process.cwd(), 'src/db/migrations'),
    });
    const timestamp = '2026-11-03T00:00:00.000Z';
    storage.db
      .insert(schema.CourseTable)
      .values({
        id: 'course-a',
        userId: 'student-a',
        connectionId: null,
        sourceKey: 'manual:course-a',
        sourceName: 'Manual',
        sourceHost: '',
        name: 'Physics',
        url: '',
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      })
      .run();
    storage.db
      .insert(schema.StudySessionTable)
      .values({
        id: 'session-a',
        userId: 'student-a',
        courseId: 'course-a',
        title: 'Wave study',
        activity: 'understand-topic',
        status: 'in-progress',
        revision: 0,
        generationEpoch: 0,
        draftText: '',
        draftRevision: 0,
        deadlineAt: null,
        timerRevision: 0,
        expiredRevision: null,
        resolvedExpiredRevision: null,
        finishedAt: null,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      })
      .run();
    storage.db
      .insert(schema.StudyTurnTable)
      .values({
        id: 'turn-a',
        userId: 'student-a',
        sessionId: 'session-a',
        requestId: randomUUID(),
        payloadHash: 'test-turn-digest',
        generationEpoch: 0,
        status: 'checking',
        attemptNumber: 1,
        policyRevision: 1,
        contextRevision: 0,
        errorCode: null,
        startedAt: timestamp,
        settledAt: null,
      })
      .run();
  });

  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
    vi.restoreAllMocks();
    storage.db = null;
    sqlite.close();
    rmSync(storage.directory, { recursive: true, force: true });
  });

  const registerRealModules = async () => {
    const handlers = new Map<
      string,
      (context: AuthorizedContext, input: never) => Promise<unknown>
    >();
    const lifecycle = createLearningLifecycle();
    const registrar: LearningActionRegistrar = {
      handle: (method, action) => {
        handlers.set(method, action);
      },
      handleInternal: (method, action) => {
        handlers.set(method, action);
      },
      lifecycle,
      publish: vi.fn(),
    };
    const storeFactory = vi.spyOn(artifactStores, 'createArtifactStore');
    const adapterFactory = vi.spyOn(
      activityAdapters,
      'createAcademicActivityAdapter',
    );
    const modules = await loadLearningActionModules();
    dispose = await registerLearningActions(registrar, modules);
    const store = storeFactory.mock.results.at(-1)!
      .value as artifactStores.ArtifactStore;
    const adapter = adapterFactory.mock.results.at(-1)?.value as
      | activityAdapters.AcademicActivityAdapter
      | undefined;
    const epoch = lifecycle.epoch;
    const context: AuthorizedContext = {
      userId: 'student-a',
      epoch,
      signal: lifecycle.signal,
      isCurrent: () => lifecycle.isCurrent(epoch),
    };
    const invokeAction = (
      method: string,
      input: unknown,
      current = context,
    ) => {
      const handler = handlers.get(method);
      if (!handler)
        throw new Error(`The real loader did not register ${method}.`);
      return handler(current, input as never);
    };
    return {
      handlers,
      lifecycle,
      store,
      adapter,
      adapterFactory,
      context,
      invokeAction,
    };
  };

  const createActivity = (
    store: artifactStores.ArtifactStore,
    context: AuthorizedContext,
  ) =>
    store.createArtifactVersion(context, {
      sessionId: 'session-a',
      turnId: 'turn-a',
      requestId: randomUUID(),
      policyDecision: { allowed: true, reasonCode: 'allowed', revision: 1 },
      candidate: {
        title: 'Explore a wave',
        objective: 'Observe a wave.',
        html: '<label for="frequency">Frequency</label><input id="frequency" type="range"><output aria-live="polite"></output>',
        css: '',
        javascript:
          "const input = document.querySelector('#frequency'); const output = document.querySelector('output'); input.addEventListener('input', () => { output.textContent = input.value; });",
        accessibleExplanation: 'A test-owned wave activity.',
        sourceReferences: [],
        runtimeVersion: 1,
      },
    });

  it('loads actual registrars and shares one store for authorization, checkpoint, cache reads and release', async () => {
    const { handlers, store, adapterFactory, context, invokeAction } =
      await registerRealModules();
    for (const method of [
      'listContextItems',
      'getGradeSettings',
      'getStudySession',
      'getArtifactVersion',
      'listMemories',
      'getTodayOverview',
      'getNotificationSettings',
      'authorizeActivityRun',
      'checkpointArtifactState',
      'releaseActivityRun',
    ])
      expect(handlers.has(method), method).toBe(true);
    expect(adapterFactory).toHaveBeenCalledWith({ store });
    const created = await createActivity(store, context);
    const request = {
      sessionId: 'session-a',
      artifactId: created.version.artifactId,
      versionId: created.version.versionId,
      attemptId: created.attemptId,
      requestId: randomUUID(),
    };
    const readVersion = vi.spyOn(store, 'getArtifactVersion');
    await expect(
      invokeAction('getArtifactVersion', {
        artifactId: request.artifactId,
        versionId: request.versionId,
      }),
    ).resolves.toEqual(created.version);
    expect(readVersion).toHaveBeenCalledOnce();
    const authorization = (await invokeAction(
      'authorizeActivityRun',
      request,
    )) as Awaited<
      ReturnType<
        activityAdapters.AcademicActivityAdapter['authorizeActivityRun']
      >
    >;
    expect(authorization).toMatchObject({
      runtimeVersion: 'activity-runtime-v1',
      contentDigest: created.version.contentDigest,
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      versionId: request.versionId,
      attemptId: request.attemptId,
      stateRevision: 0,
    });
    expect(authorization.runId).not.toBe(request.requestId);
    expect(authorization.runtimeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(authorization.sdk).toContain('postMessage');
    expect(authorization).not.toHaveProperty('bundle');
    const proposal = {
      sessionId: request.sessionId,
      artifactId: request.artifactId,
      versionId: request.versionId,
      attemptId: request.attemptId,
      runId: authorization.runId,
      sequence: 1,
      baseStateRevision: 0,
      state: { frequency: 2 },
    };
    await expect(
      invokeAction('checkpointArtifactState', proposal),
    ).resolves.toMatchObject({
      artifactId: request.artifactId,
      versionId: request.versionId,
      attemptId: request.attemptId,
      stateRevision: 1,
      state: proposal.state,
    });
    await expect(
      invokeAction('getArtifactState', {
        artifactId: request.artifactId,
        versionId: request.versionId,
        attemptId: request.attemptId,
      }),
    ).resolves.toMatchObject({
      stateRevision: 1,
      state: proposal.state,
    });
    await expect(
      invokeAction('checkpointArtifactState', proposal, {
        ...context,
        userId: 'student-b',
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    await expect(
      invokeAction('checkpointArtifactState', proposal, {
        ...context,
        epoch: context.epoch + 1,
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    const release = vi.spyOn(store, 'releaseActivityRun');
    const releaseInput = {
      runId: authorization.runId,
      requestId: request.requestId,
    };
    await expect(
      invokeAction('releaseActivityRun', releaseInput),
    ).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledWith(releaseInput);
    await expect(
      invokeAction('checkpointArtifactState', proposal),
    ).rejects.toMatchObject({
      code: 'scope-denied',
    });
    const nextRequest = { ...request, requestId: randomUUID() };
    const nextRun = (await invokeAction(
      'authorizeActivityRun',
      nextRequest,
    )) as Awaited<
      ReturnType<
        activityAdapters.AcademicActivityAdapter['authorizeActivityRun']
      >
    >;
    expect(nextRun.initialState).toEqual(proposal.state);
    expect(nextRun.stateRevision).toBe(1);
    await dispose!();
    expect(release).toHaveBeenCalledWith({
      runId: nextRun.runId,
      requestId: nextRequest.requestId,
    });
  });

  it('awaits adapter disposal before artifact-store cleanup and completes lifecycle invalidation only once', async () => {
    const { lifecycle, adapter, store } = await registerRealModules();
    expect(adapter).toBeDefined();
    const disposeAdapter = adapter!.dispose;
    let finishRelease!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const releasing = vi
      .spyOn(adapter!, 'dispose')
      .mockImplementation(async () => {
        await mayRelease;
        await disposeAdapter();
      });
    const disposeStore = vi.spyOn(store, 'dispose');
    let settled = false;
    const invalidation = lifecycle.invalidate().then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(releasing).toHaveBeenCalledOnce());
      expect(lifecycle.signal.aborted).toBe(true);
      expect(disposeStore).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally {
      finishRelease();
      await invalidation;
    }
    expect(disposeStore).toHaveBeenCalledOnce();
    await dispose!();
    expect(releasing).toHaveBeenCalledOnce();
    expect(disposeStore).toHaveBeenCalledOnce();
  });
});
