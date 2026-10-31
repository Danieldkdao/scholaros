import { afterEach, expect, it, vi } from 'vitest';
import { openBackgroundPage } from '../services/background-page';
import type { ActiveWorkspace } from '../services/browser-workspace';

afterEach(() => vi.unstubAllGlobals());

it('creates an inactive tab and returns its Stagehand page without activating it', async () => {
  const commands: unknown[] = [];
  const close = vi.fn();
  class Socket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    close = close;
    send = (message: string) => {
      commands.push(JSON.parse(message));
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ id: 1, result: { targetId: 'course-tab' } }),
          }),
        ),
      );
    };
  }
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      json: async () => ({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
      }),
    })),
  );
  const page = { pageId: 'course-tab' };
  const workspace = {
    cdpUrl: 'http://127.0.0.1:9222',
    browser: { context: { pages: async () => [page] } },
  } as unknown as ActiveWorkspace;
  expect(
    await openBackgroundPage(workspace, new AbortController().signal),
  ).toBe(page);
  expect(commands).toEqual([
    {
      id: 1,
      method: 'Target.createTarget',
      params: { url: 'about:blank', background: true },
    },
  ]);
  expect(close).toHaveBeenCalled();
});
