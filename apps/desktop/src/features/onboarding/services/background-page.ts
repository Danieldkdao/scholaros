import { setTimeout as delay } from 'node:timers/promises';
import type { ActiveWorkspace } from './browser-workspace';

export const openBackgroundPage = async (
  workspace: ActiveWorkspace,
  cancellation: AbortSignal,
) => {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(10_000)]);
  const endpoint = new URL(workspace.cdpUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
    throw new Error('Invalid study browser connection.');
  const response = await fetch(new URL('/json/version', endpoint), {
    signal,
    redirect: 'error',
  });
  const { webSocketDebuggerUrl } = await response.json();
  const address = new URL(webSocketDebuggerUrl);
  if (
    address.protocol !== 'ws:' ||
    address.hostname !== endpoint.hostname ||
    address.port !== endpoint.port
  )
    throw new Error('Invalid study browser connection.');
  const socket = new WebSocket(address);
  let targetId: string | undefined;
  const abort = () => socket.close();
  signal.addEventListener('abort', abort, { once: true });
  try {
    targetId = await new Promise<string>((resolve, reject) => {
      const fail = () =>
        reject(new Error('The background study tab could not be opened.'));
      socket.addEventListener('error', fail, { once: true });
      socket.addEventListener('close', fail, { once: true });
      socket.addEventListener(
        'open',
        () => {
          if (signal.aborted) {
            socket.close();
            fail();
            return;
          }
          // Stagehand newPage activates its target, so create an inactive target directly.
          socket.send(
            JSON.stringify({
              id: 1,
              method: 'Target.createTarget',
              params: { url: 'about:blank', background: true },
            }),
          );
        },
        { once: true },
      );
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (typeof message.result?.targetId === 'string')
          resolve(message.result.targetId);
        else fail();
      });
    });
    while (true) {
      signal.throwIfAborted();
      const page = (await workspace.browser.context.pages()).find(
        (candidate) => candidate.pageId === targetId,
      );
      if (page) return page;
      await delay(50, undefined, { signal });
    }
  } catch (error) {
    if (targetId && socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          id: 2,
          method: 'Target.closeTarget',
          params: { targetId },
        }),
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    socket.close();
  }
};
