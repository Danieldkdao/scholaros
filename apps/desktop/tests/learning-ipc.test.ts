// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { ScholarBridge } from '../src/features/onboarding/types';
import {
  internalAcademicMethods,
  rendererAcademicMethods,
} from '../src/services/academic/contracts';
import {
  getTrustedWindow,
  installTrustedFocusedWebContentsGuard,
  isTrustedWebContents,
  registerTrustedWindow,
  requireTrustedSender,
} from '../src/lib/trusted-windows';

const preloadMocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  listeners: new Map<string, (event: unknown, value: unknown) => void>(),
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => undefined,
  ),
  removeListener: vi.fn(),
  setupRenderer: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) =>
      preloadMocks.exposed.set(name, value),
  },
  ipcRenderer: {
    invoke: preloadMocks.invoke,
    on: (channel: string, listener: (event: unknown, value: unknown) => void) =>
      preloadMocks.listeners.set(channel, listener),
    removeListener: preloadMocks.removeListener,
  },
}));
vi.mock('@better-auth/electron/preload', () => ({
  setupRenderer: preloadMocks.setupRenderer,
}));

type FakeFrame = { url: string };
type FakeContents = {
  id: number;
  mainFrame: FakeFrame;
  getURL: () => string;
  isDestroyed: () => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};
type FakeWindow = {
  webContents: FakeContents;
  isDestroyed: () => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};

const makeWindow = (id: number, documentUrl: string) => {
  const contentsListeners = new Map<string, (...args: unknown[]) => void>();
  const windowListeners = new Map<string, (...args: unknown[]) => void>();
  const contents: FakeContents = {
    id,
    mainFrame: { url: documentUrl },
    getURL: () => contents.mainFrame.url,
    isDestroyed: () => false,
    on: (event, listener) => contentsListeners.set(event, listener),
    once: (event, listener) => contentsListeners.set(event, listener),
    removeListener: (event) => contentsListeners.delete(event),
  };
  const window: FakeWindow = {
    webContents: contents,
    isDestroyed: () => false,
    on: (event, listener) => windowListeners.set(event, listener),
    once: (event, listener) => windowListeners.set(event, listener),
    removeListener: (event) => windowListeners.delete(event),
  };
  return { window, contents, contentsListeners, windowListeners };
};

const routeMocks = vi.hoisted(() => ({
  user: { id: 'student-a', authMode: 'online' as 'online' | 'offline-local' },
  subscriptions: new Map<string, () => void>(),
  search: {} as { itemId?: string },
  reload: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  retryContextIngestion: vi.fn(async () => undefined),
  preview: null as null | { readOnly?: boolean; onRetry: () => void },
  mounts: 0,
}));
const RouteDraftProbe = (props: {
  readOnly?: boolean;
  refreshEpoch?: number;
}) => {
  const [draft, setDraft] = useState(() => `draft-${++routeMocks.mounts}`);
  return createElement(
    'button',
    {
      'data-read-only': String(props.readOnly),
      'data-refresh-epoch': String(props.refreshEpoch),
      onClick: () => setDraft('unsaved draft'),
    },
    draft,
  );
};
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useSearch: () => routeMocks.search,
    useNavigate: () => routeMocks.navigate,
    useParams: () => ({ sessionId: 'session-a' }),
  }),
}));
vi.mock('../src/features/dashboard/hooks/use-current-user', () => ({
  useCurrentUser: () => ({
    user: routeMocks.user,
    loading: false,
    reload: routeMocks.reload,
  }),
}));
vi.mock('../src/features/courses/hooks/use-courses', () => ({
  useCourses: () => ({ snapshot: { courses: [] } }),
}));
vi.mock('../src/features/context/components/context-library', () => ({
  ContextLibrary: (props: { readOnly?: boolean; refreshEpoch?: number }) =>
    createElement(RouteDraftProbe, props),
}));
vi.mock('../src/features/context/components/context-preview', () => ({
  ContextPreview: (props: { readOnly?: boolean; onRetry: () => void }) => {
    routeMocks.preview = props;
    return null;
  },
}));
vi.mock('../src/features/study/components/study-document', () => ({
  StudyDocument: (props: { readOnly?: boolean; refreshEpoch?: number }) =>
    createElement(RouteDraftProbe, props),
  StudyDocumentRenderersProvider: (props: { children: React.ReactNode }) =>
    props.children,
}));
vi.mock('../src/features/study/components/activity-host', () => ({
  ActivityHost: () => null,
}));
vi.mock('../src/features/speech/components/dictation-control', () => ({
  DictationControl: () => null,
}));
vi.mock('../src/features/practice/components/practice-view', () => ({
  PracticeView: () => null,
}));
vi.mock('../src/features/memory/components/progress-summary', () => ({
  ProgressSummary: () => null,
}));

describe('route host refresh and read-only boundaries', () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    routeMocks.user = { id: 'student-a', authMode: 'online' };
    routeMocks.subscriptions.clear();
    routeMocks.search = {};
    routeMocks.mounts = 0;
    routeMocks.preview = null;
    routeMocks.retryContextIngestion.mockClear();
    const subscribe = (name: string) => (callback: () => void) => {
      routeMocks.subscriptions.set(name, callback);
      return () => routeMocks.subscriptions.delete(name);
    };
    Object.assign(window, {
      onAuthenticated: subscribe('authenticated'),
      onUserUpdated: subscribe('user-updated'),
      scholar: {
        onAcademicReconnect: subscribe('reconnect'),
        retryContextIngestion: routeMocks.retryContextIngestion,
        getContextItem: async () => ({
          item: { currentVersionId: null },
          versions: [],
          preview: null,
        }),
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const loadRouteComponent = async (kind: 'context' | 'study') => {
    const module =
      kind === 'context'
        ? await import('../src/routes/dashboard/context')
        : await import('../src/routes/study/$sessionId');
    return module.Route.options.component as ComponentType;
  };

  it.each(['context', 'study'] as const)(
    'refreshes %s without remounting an unsaved draft',
    async (kind) => {
      const Component = await loadRouteComponent(kind);
      await act(async () => root.render(createElement(Component)));
      await act(async () => container.querySelector('button')!.click());
      const original = container.querySelector('button');
      await act(async () => {
        routeMocks.subscriptions.get('reconnect')!();
      });
      expect(container.querySelector('button')).toBe(original);
      expect(container.textContent).toBe('unsaved draft');
      expect(original?.getAttribute('data-refresh-epoch')).toBe('1');
    },
  );

  it.each(['context', 'study'] as const)(
    'derives %s read-only mode from the host and resets only on an account change',
    async (kind) => {
      const Component = await loadRouteComponent(kind);
      await act(async () => root.render(createElement(Component)));
      await act(async () => container.querySelector('button')!.click());
      routeMocks.user = { ...routeMocks.user, authMode: 'offline-local' };
      await act(async () => root.render(createElement(Component)));
      expect(
        container.querySelector('button')?.getAttribute('data-read-only'),
      ).toBe('true');
      expect(container.textContent).toBe('unsaved draft');
      routeMocks.user = { id: 'student-b', authMode: 'online' };
      await act(async () => root.render(createElement(Component)));
      expect(container.textContent).not.toBe('unsaved draft');
      expect(
        container.querySelector('button')?.getAttribute('data-read-only'),
      ).toBe('false');
    },
  );

  it('guards the separate Context preview retry callback in offline-local mode', async () => {
    routeMocks.user.authMode = 'offline-local';
    routeMocks.search = { itemId: 'context-item-a' };
    const Component = await loadRouteComponent('context');
    await act(async () => root.render(createElement(Component)));
    expect(routeMocks.preview?.readOnly).toBe(true);
    routeMocks.preview?.onRetry();
    expect(routeMocks.retryContextIngestion).not.toHaveBeenCalled();
  });
});

const trustedWindows: (() => void)[] = [];
afterEach(() => {
  for (const unregister of trustedWindows.splice(0)) unregister();
});

describe('trusted application windows', () => {
  it('accepts only the registered main frame and exact app document', () => {
    const { window, contents } = makeWindow(
      11,
      'file:///Applications/ScholarOS/renderer/index.html#/dashboard',
    );
    trustedWindows.push(
      registerTrustedWindow(
        window as never,
        'file:///Applications/ScholarOS/renderer/index.html',
      ),
    );

    expect(
      requireTrustedSender({
        sender: contents as never,
        senderFrame: contents.mainFrame as never,
      }),
    ).toBe(window);
    expect(getTrustedWindow()).toBe(window);
  });

  it('rejects subframes, remote documents, and unregistered BrowserWindows', () => {
    const registered = makeWindow(21, 'https://app.local/index.html#/');
    trustedWindows.push(
      registerTrustedWindow(
        registered.window as never,
        'https://app.local/index.html',
      ),
    );
    const remote = makeWindow(22, 'https://school.example/course');

    expect(() =>
      requireTrustedSender({
        sender: registered.contents as never,
        senderFrame: { url: 'https://app.local/index.html#/child' } as never,
      }),
    ).toThrow('Untrusted application frame.');
    expect(() =>
      requireTrustedSender({
        sender: remote.contents as never,
        senderFrame: remote.contents.mainFrame as never,
      }),
    ).toThrow('Untrusted application frame.');
    expect(() =>
      requireTrustedSender({
        sender: registered.contents as never,
        senderFrame: { url: 'https://app.local/other.html' } as never,
      }),
    ).toThrow('Untrusted application frame.');
  });

  it('blocks unexpected main-frame navigation and revokes trust on destruction', () => {
    const { window, contents, contentsListeners } = makeWindow(
      31,
      'https://app.local/index.html',
    );
    trustedWindows.push(
      registerTrustedWindow(window as never, 'https://app.local/index.html'),
    );
    const preventDefault = vi.fn();

    contentsListeners.get('will-frame-navigate')?.({
      isMainFrame: true,
      url: 'https://outside.example/',
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();

    contentsListeners.get('destroyed')?.();
    expect(() =>
      requireTrustedSender({
        sender: contents as never,
        senderFrame: contents.mainFrame as never,
      }),
    ).toThrow('Untrusted application frame.');
    expect(getTrustedWindow()).toBeNull();
  });

  it('only forwards focused-window errors to a currently trusted renderer', () => {
    const trusted = makeWindow(41, 'https://app.local/index.html');
    const remote = makeWindow(42, 'https://outside.example/');
    trustedWindows.push(
      registerTrustedWindow(
        trusted.window as never,
        'https://app.local/index.html',
      ),
    );
    let focusedContents = trusted.contents;
    const focusApi = { getFocusedWebContents: () => focusedContents as never };
    const restore = installTrustedFocusedWebContentsGuard(focusApi as never);

    expect(isTrustedWebContents(trusted.contents as never)).toBe(true);
    expect(focusApi.getFocusedWebContents()).toBe(trusted.contents);
    focusedContents = remote.contents;
    expect(focusApi.getFocusedWebContents()).toBeNull();
    trusted.contents.mainFrame.url = 'https://outside.example/';
    focusedContents = trusted.contents;
    expect(focusApi.getFocusedWebContents()).toBeNull();
    restore();
  });
});

it('exposes only named learning and native capabilities to the renderer', async () => {
  preloadMocks.exposed.clear();
  preloadMocks.listeners.clear();
  preloadMocks.invoke.mockClear();
  preloadMocks.setupRenderer.mockClear();
  vi.resetModules();
  await import('../src/preload');

  const bridge = preloadMocks.exposed.get('scholar') as {
    listContextItems: (input: unknown) => Promise<unknown>;
    getTodayOverview: (input: unknown) => Promise<unknown>;
    chooseContextFiles: (input: unknown) => Promise<unknown>;
    listCourseRecordSuppressions: (input: unknown) => Promise<unknown>;
    restoreCourseRecordSuppression: (input: unknown) => Promise<unknown>;
    registerSelectedContextFiles?: unknown;
    [method: string]: unknown;
  };
  expect(preloadMocks.setupRenderer).toHaveBeenCalledOnce();
  expect(bridge.registerSelectedContextFiles).toBeUndefined();
  expect(
    rendererAcademicMethods.every(
      (method) => typeof bridge[method] === 'function',
    ),
  ).toBe(true);
  for (const method of internalAcademicMethods)
    expect(bridge).not.toHaveProperty(method);
  for (const method of [
    'registerSelectedContextFiles',
    'authorizeActivityRun',
    'checkpointArtifactState',
    'releaseActivityRun',
    'claimDueNotifications',
    'purgeGradeDerivedStudyContent',
    'createNotificationDelivery',
  ])
    expect(bridge).not.toHaveProperty(method);

  await bridge.listContextItems({ limit: 10 });
  expect(preloadMocks.invoke).toHaveBeenCalledWith('scholar:listContextItems', {
    limit: 10,
  });
  await bridge.getTodayOverview({ limit: 5 });
  expect(preloadMocks.invoke).toHaveBeenCalledWith('scholar:getTodayOverview', {
    limit: 5,
  });
  await bridge.chooseContextFiles({ saveToLibrary: true });
  expect(preloadMocks.invoke).toHaveBeenCalledWith(
    'scholar:native:chooseContextFiles',
    { saveToLibrary: true },
  );
  await bridge.listCourseRecordSuppressions({ courseId: 'course-a' });
  expect(preloadMocks.invoke).toHaveBeenCalledWith(
    'scholar:listCourseRecordSuppressions',
    { courseId: 'course-a' },
  );
  await bridge.restoreCourseRecordSuppression({
    scope: 'group',
    suppressionId: 'suppression-a',
  });
  expect(preloadMocks.invoke).toHaveBeenCalledWith(
    'scholar:restoreCourseRecordSuppression',
    { scope: 'group', suppressionId: 'suppression-a' },
  );
});

it('forwards only schema-valid product events and supports explicit unsubscribe', async () => {
  preloadMocks.exposed.clear();
  preloadMocks.listeners.clear();
  vi.resetModules();
  await import('../src/preload');
  const bridge = preloadMocks.exposed.get('scholar') as {
    onProductEvent: (listener: (event: unknown) => void) => () => void;
  };
  const listener = vi.fn();
  const unsubscribe = bridge.onProductEvent(listener);
  const onProductEvent = preloadMocks.listeners.get('scholar:productEvent');
  expect(onProductEvent).toBeTypeOf('function');
  onProductEvent?.(
    {},
    {
      version: 1,
      accountId: 'student-a',
      revision: 2,
      resource: 'study',
      targetId: 'session-a',
    },
  );
  onProductEvent?.({}, { version: 2, accountId: 'student-a' });
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  expect(preloadMocks.removeListener).toHaveBeenCalledWith(
    'scholar:productEvent',
    onProductEvent,
  );
});
const readyActivityChange = () => ({
  runId: 'run-a',
  sessionId: 'session-a',
  artifactId: 'artifact-a',
  versionId: 'version-a',
  attemptId: 'attempt-a',
  kind: 'ready',
  stateRevision: 3,
  runtimeVersion: 'activity-runtime-v1',
  contentDigest: 'a'.repeat(64),
});
it('filters activity events by schema and exact run and removes only its own listener', async () => {
  preloadMocks.exposed.clear();
  preloadMocks.listeners.clear();
  preloadMocks.removeListener.mockClear();
  vi.resetModules();
  await import('../src/preload');
  const bridge = preloadMocks.exposed.get('scholar') as ScholarBridge;
  expect(bridge.onActivityChange).toBeTypeOf('function');
  const listener = vi.fn();
  const unsubscribe = bridge.onActivityChange('run-a', listener);
  const onChange = preloadMocks.listeners.get('scholar:native:activityChange')!;
  onChange({}, readyActivityChange());
  onChange({}, { ...readyActivityChange(), runId: 'other-run' });
  onChange({}, { ...readyActivityChange(), stateRevision: -1 });
  onChange(
    {},
    { ...readyActivityChange(), kind: 'interaction', value: 'private' },
  );
  onChange(
    {},
    {
      ...readyActivityChange(),
      kind: 'checkpoint-failed',
      errorCode: 'invented-code',
    },
  );
  expect(listener).toHaveBeenCalledExactlyOnceWith(readyActivityChange());
  unsubscribe();
  onChange({}, readyActivityChange());
  expect(listener).toHaveBeenCalledOnce();
  expect(preloadMocks.removeListener).toHaveBeenCalledWith(
    'scholar:native:activityChange',
    onChange,
  );
  await bridge.retryActivityCheckpoint({ runId: 'run-a' });
  expect(preloadMocks.invoke).toHaveBeenCalledWith(
    'scholar:native:retryActivityCheckpoint',
    { runId: 'run-a' },
  );
});
it('retains an initial ready that arrives before native mount resolves and replays it only for the returned run', async () => {
  preloadMocks.exposed.clear();
  preloadMocks.listeners.clear();
  vi.resetModules();
  await import('../src/preload');
  const bridge = preloadMocks.exposed.get('scholar') as ScholarBridge;
  preloadMocks.invoke.mockImplementationOnce(async () => {
    const receive = preloadMocks.listeners.get('scholar:native:activityChange');
    receive?.({}, { ...readyActivityChange(), runId: 'other-run' });
    receive?.({}, { ...readyActivityChange(), versionId: 'other-version' });
    receive?.({}, readyActivityChange());
    return { runId: 'run-a' };
  });
  await expect(
    bridge.mountActivity({
      sessionId: 'session-a',
      artifactId: 'artifact-a',
      versionId: 'version-a',
      attemptId: 'attempt-a',
      presentation: 'inline',
      readOnly: false,
      bounds: { x: 1, y: 1, width: 400, height: 300 },
    }),
  ).resolves.toEqual({ runId: 'run-a' });
  const otherListener = vi.fn();
  bridge.onActivityChange('other-run', otherListener);
  const listener = vi.fn();
  const unsubscribe = bridge.onActivityChange('run-a', listener);
  expect(listener).toHaveBeenCalledExactlyOnceWith(readyActivityChange());
  expect(otherListener).not.toHaveBeenCalled();
  unsubscribe();
  const lateListener = vi.fn();
  bridge.onActivityChange('run-a', lateListener);
  expect(lateListener).not.toHaveBeenCalled();
});
