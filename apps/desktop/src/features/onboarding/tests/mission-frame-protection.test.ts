import { afterEach, expect, it, vi } from 'vitest';
import { protectMissionPage } from '../services/mission-request-guard';

class ProtocolSocket extends EventTarget {
  static active: ProtocolSocket;
  commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  constructor(_url: string) {
    super();
    ProtocolSocket.active = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(data: string) {
    const command = JSON.parse(data);
    this.commands.push(command);
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            id: command.id,
            result:
              command.method === 'Page.getFrameTree'
                ? { frameTree: { frame: { id: 'main-frame' } } }
                : {},
          }),
        }),
      ),
    );
  }
  close() {
    this.dispatchEvent(new Event('close'));
  }
  blockedDocument(frameId: string, url = 'https://unconnected.example/embed') {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          method: 'Fetch.requestPaused',
          params: {
            requestId: 'blocked',
            frameId,
            resourceType: 'Document',
            request: { url, method: 'GET' },
          },
        }),
      }),
    );
  }
}
afterEach(() => vi.unstubAllGlobals());
const setup = async () => {
  vi.stubGlobal('WebSocket', ProtocolSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json([
        { id: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/page' },
      ]),
    ),
  );
  const page = { pageId: 'page', close: vi.fn(async () => undefined) };
  const blocked = vi.fn();
  const release = await protectMissionPage(
    page as unknown as Parameters<typeof protectMissionPage>[0],
    'http://127.0.0.1:9222',
    ['school.example'],
    blocked,
  );
  return { page, blocked, release, socket: ProtocolSocket.active };
};
it('blocks an unconnected iframe without closing the academic page', async () => {
  const { page, release, socket } = await setup();
  try {
    socket.blockedDocument('child-frame');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.commands).toContainEqual(
      expect.objectContaining({ method: 'Fetch.failRequest' }),
    );
    expect(page.close).not.toHaveBeenCalled();
  } finally {
    await release();
  }
});
it('still closes the mission when its main frame leaves the authorized site', async () => {
  const { page, release, socket } = await setup();
  try {
    socket.blockedDocument('main-frame');
    await vi.waitFor(() => expect(page.close).toHaveBeenCalled());
    expect(() => release.assertReadable()).toThrow('blocked');
  } finally {
    await release();
  }
});

it('keeps an embedded sign-in wall separate from the main academic session', async () => {
  const { page, release, socket, blocked } = await setup();
  try {
    socket.blockedDocument('child-frame', 'https://accounts.google.com/login');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.close).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith(
      expect.objectContaining({ signInWall: false }),
    );
    expect(() => release.assertReadable()).not.toThrow();
  } finally {
    await release();
  }
});

it('stops on a rate-limited academic data response and preserves Retry-After', async () => {
  const { release, socket } = await setup();
  try {
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          method: 'Network.responseReceived',
          params: {
            type: 'XHR',
            response: {
              url: 'https://school.example/iapi/course/active',
              status: 429,
              headers: { 'Retry-After': '120' },
            },
          },
        }),
      }),
    );
    expect(() => release.assertReadable()).toThrow('120 seconds');
  } finally {
    await release();
  }
});
