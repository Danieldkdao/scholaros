import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
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
  let targetCloseSent = false;
  const closeTarget = () => {
    if (!targetId || targetCloseSent || socket.readyState !== WebSocket.OPEN)
      return;
    targetCloseSent = true;
    socket.send(
      JSON.stringify({
        id: 2,
        method: 'Target.closeTarget',
        params: { targetId },
      }),
    );
  };
  const abort = () => {
    closeTarget();
    socket.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    targetId = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new Error('The background study tab could not be opened.'));
      };
      socket.once('error', fail);
      socket.once('close', fail);
      socket.once('open', () => {
        if (signal.aborted) {
          socket.close();
          fail();
          return;
        }
        try {
          // Stagehand newPage activates its target, so create an inactive target directly.
          socket.send(
            JSON.stringify({
              id: 1,
              method: 'Target.createTarget',
              params: { url: 'about:blank', background: true },
            }),
          );
        } catch {
          fail();
        }
      });
      socket.on('message', (data) => {
        try {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString('utf8')
              : data.toString('utf8');
          const message: unknown = JSON.parse(text);
          if (
            typeof message !== 'object' ||
            message === null ||
            !('id' in message) ||
            message.id !== 1
          )
            return;
          if (
            'result' in message &&
            typeof message.result === 'object' &&
            message.result !== null &&
            'targetId' in message.result &&
            typeof message.result.targetId === 'string'
          ) {
            settled = true;
            resolve(message.result.targetId);
          } else fail();
        } catch {
          fail();
        }
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
    closeTarget();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    socket.close();
  }
};
