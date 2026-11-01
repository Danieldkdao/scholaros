import { afterEach, expect, it, vi } from 'vitest';
import { protectMissionPage } from '../services/mission-request-guard';
import { createAccountContinuation } from '../services/account-continuation';

class ProtocolSocket extends EventTarget {
  static active: ProtocolSocket;
  commands: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }> = [];
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
const setup = async (
  continuation?: ReturnType<typeof createAccountContinuation>,
) => {
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
    continuation,
  );
  return { page, blocked, release, socket: ProtocolSocket.active };
};
it.each([
  'https://accounts.google.com/v3/signin/accountchooser',
  'https://accounts.google.com/InteractiveLogin',
])('keeps the authentication redirect %s protected and open', async (url) => {
  const { page, release, socket, blocked } = await setup(
    createAccountContinuation(
      'school.example',
      'Choose student@example.edu.',
      '',
    ),
  );
  try {
    socket.blockedDocument('main-frame', url);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.commands).toContainEqual(
      expect.objectContaining({ method: 'Fetch.continueRequest' }),
    );
    expect(page.close).not.toHaveBeenCalled();
    expect(blocked).not.toHaveBeenCalled();
    expect(() => release.assertReadable()).not.toThrow();
  } finally {
    await release();
  }
});
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

it('protects cross-origin frame requests before resuming the frame', async () => {
  const { page, release, socket } = await setup();
  try {
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: 'slides-session',
            targetInfo: { type: 'iframe' },
          },
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(socket.commands).toContainEqual(
        expect.objectContaining({
          method: 'Runtime.runIfWaitingForDebugger',
          sessionId: 'slides-session',
        }),
      ),
    );
    const commands = socket.commands.filter(
      (command) => command.sessionId === 'slides-session',
    );
    expect(commands.map((command) => command.method)).toEqual([
      'Network.enable',
      'Network.setBypassServiceWorker',
      'Fetch.enable',
      'Target.setAutoAttach',
      'Runtime.runIfWaitingForDebugger',
    ]);
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          sessionId: 'slides-session',
          method: 'Fetch.requestPaused',
          params: {
            requestId: 'frame-write',
            frameId: 'slides-frame',
            resourceType: 'XHR',
            request: {
              url: 'https://docs.google.com/presentation/d/deck/delete',
              method: 'POST',
            },
          },
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(socket.commands).toContainEqual(
        expect.objectContaining({
          method: 'Fetch.failRequest',
          sessionId: 'slides-session',
          params: { requestId: 'frame-write', errorReason: 'BlockedByClient' },
        }),
      ),
    );
    expect(page.close).not.toHaveBeenCalled();
  } finally {
    await release();
  }
});

it('closes the page if a cross-origin frame cannot be protected', async () => {
  const { page, release, socket } = await setup();
  const send = socket.send.bind(socket);
  vi.spyOn(socket, 'send').mockImplementation((data) => {
    const command = JSON.parse(data);
    if (command.sessionId && command.method === 'Fetch.enable')
      queueMicrotask(() =>
        socket.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({
              id: command.id,
              error: { message: 'Frame protection failed' },
            }),
          }),
        ),
      );
    else send(data);
  });
  try {
    socket.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          method: 'Target.attachedToTarget',
          params: { sessionId: 'slides-session' },
        }),
      }),
    );
    await vi.waitFor(() => expect(page.close).toHaveBeenCalled());
    expect(() => release.assertReadable()).toThrow('connection closed');
    expect(
      socket.commands.some(
        (command) => command.method === 'Runtime.runIfWaitingForDebugger',
      ),
    ).toBe(false);
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
