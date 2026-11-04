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
  cookie: 'test-cookie-a',
  sessionChange: null as (() => void) | null,
}));
vi.mock('../../../lib/auth/client', () => ({
  authClient: {
    getCookie: () => mocks.cookie,
    $store: {
      atoms: {
        session: {
          subscribe: (listener: () => void) => {
            mocks.sessionChange = listener;
            return vi.fn();
          },
        },
      },
    },
  },
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
  mocks.cookie = 'test-cookie-a';
  mocks.sessionChange = null;
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
  await (await import('../client')).disconnectAcademicService();
  unregisterTrustedWindow?.();
  unregisterTrustedWindow = undefined;
});
it('notifies native owners only after settled account authorization and validated account events', async () => {
  const { registerAcademicClient, requestAcademicService } =
    await import('../client');
  const onAccountReady = vi.fn();
  const onServiceEvent = vi.fn();
  let releaseIdentity: (() => void) | undefined;
  const settling = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  await registerAcademicClient({
    onAccountReady,
    onServiceEvent,
    onIdentityChange: () => settling,
  });
  await requestAcademicService('getCurrentUser');
  await vi.waitFor(() =>
    expect(onAccountReady).toHaveBeenCalledWith({ id: 'student' }),
  );
  onAccountReady.mockClear();
  mocks.request.mockResolvedValue({ id: 'student-next' });
  await requestAcademicService('getCurrentUser');
  expect(onAccountReady).not.toHaveBeenCalled();
  releaseIdentity?.();
  await vi.waitFor(() =>
    expect(onAccountReady).toHaveBeenCalledWith({ id: 'student-next' }),
  );
  mocks.receive?.('scholar:academicReconnect', { accountId: 'foreign' });
  expect(onServiceEvent).not.toHaveBeenCalled();
  mocks.receive?.('scholar:academicReconnect', { accountId: 'student-next' });
  expect(onServiceEvent).toHaveBeenCalledWith('scholar:academicReconnect', {
    accountId: 'student-next',
  });
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
      undefined,
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
it('awaits native run teardown before deleting a session or signing out', async () => {
  const client = await import('../client');
  let finish!: () => void;
  const beforeSessionDelete = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const onIdentityChange = vi.fn(async () => undefined);
  await client.registerAcademicClient({
    beforeSessionDelete,
    onIdentityChange,
  });
  const event = {
    sender: appWindow.contents,
    senderFrame: appWindow.mainFrame,
  };
  const deletion = mocks.handlers.get('scholar:deleteStudySession')!(event, {
    sessionId: 'session-a',
  });
  await vi.waitFor(() =>
    expect(beforeSessionDelete).toHaveBeenCalledWith('session-a'),
  );
  expect(mocks.request).not.toHaveBeenCalledWith(
    expect.anything(),
    'deleteStudySession',
    expect.anything(),
  );
  finish();
  await deletion;
  expect(mocks.request).toHaveBeenCalledWith(
    expect.anything(),
    'deleteStudySession',
    { sessionId: 'session-a' },
  );
  await mocks.handlers.get('scholar:signOut')!(event);
  expect(onIdentityChange).toHaveBeenCalledOnce();
  expect(onIdentityChange.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.request.mock.invocationCallOrder[
      mocks.request.mock.calls.findIndex((call) => call[1] === 'signOut')
    ]!,
  );
});
it('fences a cookie switch immediately and awaits disposal at the renderer boundary without blocking internal release', async () => {
  const client = await import('../client');
  let finish!: () => void;
  const onIdentityChange = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await client.registerAcademicClient({ onIdentityChange });
  await client.requestAcademicService('getCurrentUser');
  mocks.cookie = 'test-cookie-b';
  mocks.sessionChange?.();
  expect(onIdentityChange).toHaveBeenCalledOnce();
  const event = {
    sender: appWindow.contents,
    senderFrame: appWindow.mainFrame,
  };
  let replied = false;
  const userReply = Promise.resolve(
    mocks.handlers.get('scholar:getCurrentUser')!(event),
  ).then(() => {
    replied = true;
  });
  await client.requestAcademicService('releaseActivityRun', {
    runId: 'run-a',
    requestId: 'request-a',
  });
  expect(replied).toBe(false);
  finish();
  await userReply;
  expect(replied).toBe(true);
});
it('invalidates an identity-changing internal lookup immediately but lets its mount unwind before awaiting disposal', async () => {
  const client = await import('../client');
  let finish!: () => void;
  const onIdentityChange = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await client.registerAcademicClient({ onIdentityChange });
  await client.requestAcademicService('getCurrentUser');
  mocks.request.mockImplementation(async (_endpoint, method) =>
    method === 'getCurrentUser' ? { id: 'student-b' } : {},
  );
  await expect(
    client.requestAcademicService('getCurrentUser'),
  ).resolves.toEqual({ id: 'student-b' });
  expect(onIdentityChange).toHaveBeenCalledOnce();
  let replied = false;
  const userReply = Promise.resolve(
    mocks.handlers.get('scholar:getCurrentUser')!({
      sender: appWindow.contents,
      senderFrame: appWindow.mainFrame,
    }),
  ).then(() => {
    replied = true;
  });
  await Promise.resolve();
  expect(replied).toBe(false);
  finish();
  await userReply;
});
it('awaits the native disconnect lifecycle before sending service shutdown', async () => {
  const client = await import('../client');
  let finish!: () => void;
  const beforeDisconnect = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  await client.registerAcademicClient({ beforeDisconnect });
  const stopping = client.stopAcademicService();
  await vi.waitFor(() => expect(beforeDisconnect).toHaveBeenCalledOnce());
  expect(mocks.request).not.toHaveBeenCalledWith(expect.anything(), 'shutdown');
  finish();
  await stopping;
  expect(mocks.request).toHaveBeenCalledWith(expect.anything(), 'shutdown');
});
it('does not publish an old-account reconnect after its lookup cookie changes', async () => {
  const client = await import('../client');
  await client.registerAcademicClient();
  await client.requestAcademicService('getCurrentUser');
  mocks.send.mockClear();
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementation(async (_endpoint, method) => {
    if (method === 'health') return { ready: true };
    if (method === 'getCurrentUser')
      return new Promise((resolve) => {
        finish = resolve;
      });
    return {};
  });
  mocks.close!();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  mocks.cookie = 'test-cookie-b';
  mocks.sessionChange?.();
  finish({ id: 'old-account' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(mocks.send).not.toHaveBeenCalledWith('scholar:academicReconnect', {
    accountId: 'old-account',
  });
});
it('rejects a late old-account lookup after a newer account reply was applied', async () => {
  const client = await import('../client');
  await client.registerAcademicClient();
  await client.requestAcademicService('getCurrentUser');
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = client.requestAcademicService('getCurrentUser');
  const rejected = expect(old).rejects.toThrow('session changed');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  mocks.request.mockImplementation(async () => ({ id: 'student-b' }));
  await client.requestAcademicService('getCurrentUser');
  finish({ id: 'student' });
  await rejected;
});
it('does not restore an account from a lookup started before sign-out', async () => {
  const client = await import('../client');
  await client.registerAcademicClient();
  await client.requestAcademicService('getCurrentUser');
  let finish!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = client.requestAcademicService('getCurrentUser');
  const rejected = expect(old).rejects.toThrow('session changed');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await client.requestAcademicService('signOut');
  finish({ id: 'student' });
  await rejected;
});
it.each(['cookie', 'account'])(
  'never deletes local data for a changed %s and releases native admission on failure',
  async (changed) => {
    const client = await import('../client');
    let accountId = 'student';
    mocks.request.mockImplementation(async (_endpoint, method) =>
      method === 'health'
        ? { ready: true }
        : method === 'getCurrentUser'
          ? { id: accountId }
          : undefined,
    );
    const afterLocalDataDelete = vi.fn(async () => undefined);
    await client.registerAcademicClient({
      beforeLocalDataDelete: async () => {
        if (changed === 'cookie') mocks.cookie = 'test-cookie-b';
        else {
          accountId = 'student-b';
          await client.requestAcademicService('getCurrentUser');
        }
      },
      afterLocalDataDelete,
    });
    await client.requestAcademicService('getCurrentUser');
    await expect(
      client.requestAcademicService('deleteLocalAcademicData', {
        requestId: '11111111-1111-4111-8111-111111111111',
        scope: 'account-local',
      }),
    ).rejects.toThrow('session changed');
    expect(afterLocalDataDelete).toHaveBeenCalledOnce();
    expect(
      mocks.request.mock.calls.some(
        (call) => call[1] === 'deleteLocalAcademicData',
      ),
    ).toBe(false);
  },
);
it.each(['cookie', 'account'])(
  'does not delete a session under a changed %s after native teardown awaits',
  async (changed) => {
    const client = await import('../client');
    let accountId = 'student';
    mocks.request.mockImplementation(async (_endpoint, method) =>
      method === 'health'
        ? { ready: true }
        : method === 'getCurrentUser'
          ? { id: accountId }
          : {},
    );
    await client.registerAcademicClient({
      beforeSessionDelete: async () => {
        if (changed === 'cookie') mocks.cookie = 'test-cookie-b';
        else {
          accountId = 'student-b';
          await client.requestAcademicService('getCurrentUser');
        }
      },
    });
    await client.requestAcademicService('getCurrentUser');
    await expect(
      client.requestAcademicService('deleteStudySession', {
        sessionId: 'session-a',
      }),
    ).rejects.toThrow('session changed');
    expect(mocks.request).not.toHaveBeenCalledWith(
      expect.anything(),
      'deleteStudySession',
      expect.anything(),
    );
  },
);
