import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  internalAcademicMethods,
  learningMethods,
  serviceControlMethods,
} from '../contracts';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => unknown>(),
  trustedWindows: [] as {
    isDestroyed: () => boolean;
    webContents: { send: (...args: unknown[]) => void };
  }[],
  request: vi.fn(),
  subscribe: vi.fn(),
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
    }),
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../transport', () => ({
  academicRequest: mocks.request,
  subscribeAcademic: mocks.subscribe,
}));
vi.mock('../../../lib/trusted-windows', () => ({
  getTrustedWindows: () => mocks.trustedWindows,
  requireTrustedSender: (event: { sender?: { trusted?: boolean } }) => {
    if (!event.sender?.trusted) throw new Error('Untrusted application frame.');
    return event.sender;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  mocks.handlers.clear();
  mocks.trustedWindows = [
    { isDestroyed: () => false, webContents: { send: mocks.send } },
  ];
  mocks.request.mockImplementation(async (_endpoint, method) =>
    method === 'health'
      ? { ready: true }
      : method === 'getCurrentUser'
        ? { id: 'student' }
        : { courses: [] },
  );
  mocks.subscribe.mockImplementation(async (_endpoint, _listener, onClose) => {
    mocks.close = onClose;
    return vi.fn();
  });
});
afterEach(async () => {
  (await import('../client')).disconnectAcademicService();
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
  const frame = {};
  await expect(
    mocks.handlers.get('scholar:getCourses')!({
      sender: { trusted: true, mainFrame: frame },
      senderFrame: frame,
    }),
  ).resolves.toEqual({ courses: [] });
  expect(() =>
    mocks.handlers.get('scholar:getCourses')!({
      sender: { trusted: false, mainFrame: frame },
      senderFrame: frame,
    }),
  ).toThrow('Untrusted');
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
