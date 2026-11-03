import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  internalAcademicMethods,
  learningMethods,
  rendererAcademicMethods,
  serviceControlMethods,
} from '../contracts';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  request: vi.fn(),
  subscribe: vi.fn(),
  receive: null as ((channel: string, value: unknown) => void) | null,
  send: vi.fn(),
  untrustedSend: vi.fn(),
  spawn: vi.fn(),
  close: null as (() => void) | null,
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/academic-client', isPackaged: true },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mocks.untrustedSend } },
    ],
    fromWebContents: () => ({}),
  },
  ipcMain: {
    handle: (
      method: string,
      callback: (event: unknown, input?: unknown) => unknown,
    ) => mocks.handlers.set(method, callback),
  },
}));
vi.mock('node:fs/promises', () => ({
  readFile: async () =>
    JSON.stringify({
      version: 1,
      address: '/tmp/test.sock',
      token: 'a'.repeat(64),
      instanceId: '11111111-1111-4111-8111-111111111111',
    }),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../transport', () => ({
  academicRequest: mocks.request,
  subscribeAcademic: mocks.subscribe,
}));
type FakeFrame = { url: string };
type FakeContents = {
  id: number;
  mainFrame: FakeFrame;
  getURL: () => string;
  isDestroyed: () => boolean;
  send: (...args: unknown[]) => void;
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
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};
const makeWindow = (id: number, send: (...args: unknown[]) => void) => {
  const contentsListeners = new Map<string, (...args: unknown[]) => void>();
  const windowListeners = new Map<string, (...args: unknown[]) => void>();
  const mainFrame = { url: 'https://app.local/index.html' };
  const contents: FakeContents = {
    id,
    mainFrame,
    getURL: () => mainFrame.url,
    isDestroyed: () => false,
    send,
    on: (event, listener) => contentsListeners.set(event, listener),
    once: (event, listener) => contentsListeners.set(event, listener),
    removeListener: (event) => contentsListeners.delete(event),
  };
  const window: FakeWindow = {
    webContents: contents,
    isDestroyed: () => false,
    once: (event, listener) => windowListeners.set(event, listener),
    removeListener: (event) => windowListeners.delete(event),
  };
  return { window, contents, mainFrame };
};

let appWindow: ReturnType<typeof makeWindow>;
let unregisterTrustedWindow: (() => void) | undefined;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.handlers.clear();
  mocks.receive = null;
  const trustedWindows = await import('../../../lib/trusted-windows');
  appWindow = makeWindow(1, mocks.send);
  unregisterTrustedWindow = trustedWindows.registerTrustedWindow(
    appWindow.window as never,
    'https://app.local/index.html',
  );
  mocks.request.mockImplementation(async (_endpoint, method) =>
    method === 'health'
      ? { ready: true }
      : method === 'getCurrentUser'
        ? { id: 'student' }
        : { courses: [] },
  );
  mocks.subscribe.mockImplementation(async (_endpoint, listener, onClose) => {
    mocks.receive = listener;
    mocks.close = onClose;
    return vi.fn();
  });
});
afterEach(async () => {
  (await import('../client')).disconnectAcademicService();
  unregisterTrustedWindow?.();
  unregisterTrustedWindow = undefined;
});
it('reuses the service and exposes only named academic commands to trusted application frames', async () => {
  const client = await import('../client');
  await client.registerAcademicClient();
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.handlers.has('scholar:shutdown')).toBe(false);
  expect(mocks.handlers.has('scholar:health')).toBe(false);
  expect(mocks.handlers.has('scholar:subscribe')).toBe(false);
  expect(mocks.handlers.has('scholar:execute')).toBe(false);
  expect(mocks.handlers.has('scholar:registerSelectedContextFiles')).toBe(
    false,
  );
  expect(mocks.handlers.has('scholar:authorizeActivityRun')).toBe(false);
  expect(
    rendererAcademicMethods.some((method) =>
      (internalAcademicMethods as readonly string[]).includes(method),
    ),
  ).toBe(false);
  for (const method of serviceControlMethods)
    expect(mocks.handlers.has(`scholar:${method}`)).toBe(false);
  for (const method of internalAcademicMethods)
    expect(mocks.handlers.has(`scholar:${method}`)).toBe(false);
  for (const method of learningMethods)
    expect(mocks.handlers.has(`scholar:${method}`)).toBe(true);
  expect(mocks.handlers.has('scholar:listContextItems')).toBe(true);
  expect(mocks.handlers.has('scholar:getTodayOverview')).toBe(true);
  expect(mocks.handlers.has('scholar:listCourseRecordSuppressions')).toBe(true);
  expect(mocks.handlers.has('scholar:restoreCourseRecordSuppression')).toBe(
    true,
  );
  const frame = appWindow.mainFrame;
  await expect(
    mocks.handlers.get('scholar:getCourses')!({
      sender: appWindow.contents,
      senderFrame: frame,
    }),
  ).resolves.toEqual({ courses: [] });
  await expect(
    mocks.handlers.get('scholar:getCourses')!({
      sender: { id: 2, mainFrame: frame, getURL: () => frame.url } as never,
      senderFrame: frame,
    }),
  ).rejects.toThrow('Untrusted');
});

it('reuses the endpoint file with service ownership metadata', async () => {
  const client = await import('../client');
  mocks.spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() } as never);
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValue(25_000);

  try {
    await expect(client.registerAcademicClient()).resolves.toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith(
      {
        version: 1,
        address: '/tmp/test.sock',
        token: 'a'.repeat(64),
      },
      'health',
      undefined,
      1000,
    );
  } finally {
    clock.mockRestore();
  }
});

it('revalidates the trusted frame before returning an async service reply', async () => {
  const client = await import('../client');
  await client.registerAcademicClient();
  let resolveRequest!: (value: unknown) => void;
  mocks.request.mockImplementation((_endpoint, method) =>
    method === 'getCourses'
      ? new Promise((resolve) => (resolveRequest = resolve))
      : { courses: [] },
  );
  const reply = mocks.handlers.get('scholar:getCourses')!({
    sender: appWindow.contents,
    senderFrame: appWindow.mainFrame,
  });
  await vi.waitFor(() => expect(resolveRequest).toBeTypeOf('function'));
  appWindow.mainFrame.url = 'https://outside.example/';
  resolveRequest({ courses: [] });

  await expect(reply).rejects.toThrow('Untrusted application frame.');
});

it('delivers only current-account events through the trusted-window selector', async () => {
  const client = await import('../client');
  await client.registerAcademicClient();
  await client.requestAcademicService('getCurrentUser');
  mocks.send.mockClear();

  const event = {
    version: 1,
    accountId: 'student',
    revision: 2,
    resource: 'study',
    targetId: 'session-a',
  };
  mocks.receive?.('scholar:productEvent', event);
  mocks.receive?.('scholar:productEvent', { ...event, accountId: 'other' });

  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.send).toHaveBeenCalledWith('scholar:productEvent', event);
  expect(mocks.untrustedSend).not.toHaveBeenCalled();
});

it('fences old-account events while a new authenticated session is resolving', async () => {
  const client = await import('../client');
  await client.registerAcademicClient();
  await client.requestAcademicService('getCurrentUser');
  mocks.send.mockClear();
  let resolveUser!: (user: unknown) => void;
  mocks.request.mockImplementationOnce(
    () => new Promise((resolve) => (resolveUser = resolve)),
  );

  const accountSwitch = client.requestAcademicService('getCurrentUser');
  await vi.waitFor(() => expect(resolveUser).toBeTypeOf('function'));
  mocks.receive?.('scholar:productEvent', {
    version: 1,
    accountId: 'student',
    revision: 3,
    resource: 'study',
    targetId: 'session-a',
  });

  expect(mocks.send).not.toHaveBeenCalled();
  resolveUser({ id: 'student-b' });
  await accountSwitch;
});

it('reconnects a missed subscription and requests a fresh account-scoped snapshot', async () => {
  const client = await import('../client');
  await client.registerAcademicClient();
  mocks.close!();
  await vi.waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      expect.anything(),
      'getCurrentUser',
    ),
  );
  await vi.waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith('scholar:coursesChange', {
      accountId: 'student',
      courseId: null,
    }),
  );
  expect(mocks.send).toHaveBeenCalledWith('scholar:academicReconnect', {
    accountId: 'student',
  });
  expect(mocks.untrustedSend).not.toHaveBeenCalled();
  expect(mocks.subscribe).toHaveBeenCalledTimes(2);
});
