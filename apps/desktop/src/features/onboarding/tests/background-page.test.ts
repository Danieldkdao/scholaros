import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openBackgroundPage } from '../services/background-page';
import type { ActiveWorkspace } from '../services/browser-workspace';

const mocks = vi.hoisted(() => ({
  addresses: [] as string[],
  commands: [] as Array<{
    id: number;
    method: string;
    params?: Record<string, unknown>;
  }>,
  closeCalls: 0,
  errorOnConnect: false,
  openOnConnect: true,
  malformedResponse: false,
  pageAvailable: true,
  pageLookups: 0,
}));

vi.mock('ws', () => ({
  default: class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;

    constructor(address: URL) {
      super();
      mocks.addresses.push(address.toString());
      queueMicrotask(() => {
        if (mocks.errorOnConnect) {
          this.emit('error', new Error('Connection failed'));
          return;
        }
        if (mocks.openOnConnect) {
          this.readyState = MockWebSocket.OPEN;
          this.emit('open');
        }
      });
    }

    close = () => {
      mocks.closeCalls += 1;
      this.readyState = 3;
      queueMicrotask(() => this.emit('close', 1000, Buffer.alloc(0)));
    };

    send = (payload: string) => {
      const command = JSON.parse(payload) as { id: number; method: string };
      mocks.commands.push(command);
      if (command.id !== 1) return;
      queueMicrotask(() =>
        this.emit(
          'message',
          mocks.malformedResponse
            ? Buffer.from('{')
            : Buffer.from(
                JSON.stringify({
                  id: 1,
                  result: { targetId: 'course-tab' },
                }),
              ),
          false,
        ),
      );
    };
  },
}));

const workspaceFor = (page: { pageId: string } | null) =>
  ({
    cdpUrl: 'http://127.0.0.1:9222',
    browser: {
      context: {
        pages: async () => {
          mocks.pageLookups += 1;
          return mocks.pageAvailable && page ? [page] : [];
        },
      },
    },
  }) as unknown as ActiveWorkspace;

const installFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      json: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
      }),
    })),
  );

beforeEach(() => {
  mocks.addresses.length = 0;
  mocks.commands.length = 0;
  mocks.closeCalls = 0;
  mocks.errorOnConnect = false;
  mocks.openOnConnect = true;
  mocks.malformedResponse = false;
  mocks.pageAvailable = true;
  mocks.pageLookups = 0;
  installFetch();
});

afterEach(() => vi.unstubAllGlobals());

it('creates an inactive tab and returns its Stagehand page without activating it', async () => {
  const page = { pageId: 'course-tab' };
  expect(
    await openBackgroundPage(workspaceFor(page), new AbortController().signal),
  ).toBe(page);
  expect(mocks.addresses).toEqual([
    'ws://127.0.0.1:9222/devtools/browser/test',
  ]);
  expect(mocks.commands).toEqual([
    {
      id: 1,
      method: 'Target.createTarget',
      params: { url: 'about:blank', background: true },
    },
  ]);
  expect(mocks.closeCalls).toBeGreaterThan(0);
});

it('rejects a connection failure and closes the socket', async () => {
  mocks.errorOnConnect = true;

  await expect(
    openBackgroundPage(workspaceFor(null), new AbortController().signal),
  ).rejects.toThrow('The background study tab could not be opened.');
  expect(mocks.closeCalls).toBeGreaterThan(0);
});

it('rejects malformed CDP messages without leaking the parsing exception', async () => {
  mocks.malformedResponse = true;

  await expect(
    openBackgroundPage(workspaceFor(null), new AbortController().signal),
  ).rejects.toThrow('The background study tab could not be opened.');
  expect(mocks.closeCalls).toBeGreaterThan(0);
});

it('cancels a connection before the socket opens', async () => {
  mocks.openOnConnect = false;
  const controller = new AbortController();
  const opening = openBackgroundPage(workspaceFor(null), controller.signal);
  await vi.waitFor(() => expect(mocks.addresses).toHaveLength(1));
  controller.abort();

  await expect(opening).rejects.toThrow(
    'The background study tab could not be opened.',
  );
  expect(mocks.closeCalls).toBeGreaterThan(0);
});

it('closes a created target when cancellation interrupts page discovery', async () => {
  mocks.pageAvailable = false;
  const controller = new AbortController();
  const opening = openBackgroundPage(workspaceFor(null), controller.signal);
  await vi.waitFor(() => expect(mocks.pageLookups).toBeGreaterThan(0));
  controller.abort();

  await expect(opening).rejects.toThrow();
  expect(mocks.commands).toContainEqual(
    expect.objectContaining({
      id: 2,
      method: 'Target.closeTarget',
    }),
  );
});
