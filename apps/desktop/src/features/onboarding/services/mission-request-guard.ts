import { missionTraffic } from './mission-traffic';
import type { Page } from '@browserbasehq/stagehand';
import {
  academicPageIdentity,
  isAcademicUrl,
  isReadNavigation,
  isReadOnlyEmbed,
} from '../lib/browser-policy';
import { isSignInPage } from '../lib/connection-policy';
import type { AccountContinuation } from './account-continuation';

export type MissionProtection = (() => Promise<void>) & {
  assertReadable: () => void;
};

type SendCommand = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;
type PausedRequest = {
  requestId: string;
  resourceType: string;
  request: { url: string; method: string };
  mainFrame?: boolean;
};
export type BlockedRequest = {
  host: string;
  resourceType: string;
  signInWall: boolean;
  mainFrame?: boolean;
};

const passiveResourceTypes = ['Script', 'Stylesheet', 'Image', 'Font', 'Media'];
const readMethods = ['GET', 'HEAD', 'OPTIONS'];

export const handleMissionRequest = async (
  send: SendCommand,
  hosts: string[],
  event: PausedRequest,
  onBlocked?: (blocked: BlockedRequest) => void,
  continuation?: AccountContinuation,
) => {
  const { url, method } = event.request;
  let allowed = false;
  if (readMethods.includes(method) && isAcademicUrl(url)) {
    const parsed = new URL(url);
    if (event.resourceType === 'Document')
      allowed =
        isReadNavigation(url, hosts) ||
        (event.mainFrame === false && isReadOnlyEmbed(url));
    else if (passiveResourceTypes.includes(event.resourceType)) {
      // Script and stylesheet filenames describe assets, not navigation actions.
      if (
        (event.resourceType === 'Stylesheet' &&
          /\.css$/i.test(parsed.pathname)) ||
        (event.resourceType === 'Script' && /\.m?js$/i.test(parsed.pathname))
      )
        parsed.pathname = parsed.pathname.slice(
          0,
          parsed.pathname.lastIndexOf('/') + 1,
        );
      allowed = isReadNavigation(academicPageIdentity(parsed.href) ?? '', [
        parsed.hostname,
      ]);
    } else if (hosts.includes(parsed.hostname)) {
      // These Schoology sidebar reads list assignments; they do not submit work.
      if (
        ['XHR', 'Fetch'].includes(event.resourceType) &&
        parsed.hostname.endsWith('.schoology.com') &&
        /^\/home\/(?:upcoming|overdue)_submissions_ajax$/.test(parsed.pathname)
      )
        parsed.pathname = '/';
      allowed = isReadNavigation(parsed.href, hosts);
    }
  }
  if (!allowed && isAcademicUrl(url))
    allowed = continuation?.allowRequest(event, !!event.mainFrame) ?? false;
  if (!allowed) {
    const parsed = new URL(url);
    onBlocked?.({
      host: parsed.hostname,
      resourceType: event.resourceType,
      // A wall the student can clear is different from a page we refuse to read.
      signInWall: isSignInPage(parsed.hostname, parsed.pathname),
    });
  }
  await send(
    allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
    allowed
      ? { requestId: event.requestId }
      : { requestId: event.requestId, errorReason: 'BlockedByClient' },
  );
  return allowed;
};

// This connection is private to an app-owned mission tab and never reaches the renderer.
export const protectMissionPage = async (
  page: Page,
  cdpUrl: string,
  hosts: string[],
  onBlocked?: (blocked: BlockedRequest) => void,
  continuation?: AccountContinuation,
) => {
  const endpoint = new URL(cdpUrl);
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:')
    throw new Error('Invalid study browser connection.');
  const response = await fetch(new URL('/json/list', endpoint), {
    signal: AbortSignal.timeout(4000),
    redirect: 'error',
  });
  const targets = (await response.json()) as Array<{
    id: string;
    webSocketDebuggerUrl: string;
  }>;
  const target = targets.find((item) => item.id === page.pageId);
  if (!target) throw new Error('The mission tab could not be protected.');
  const socketUrl = new URL(target.webSocketDebuggerUrl);
  if (
    socketUrl.protocol !== 'ws:' ||
    socketUrl.hostname !== '127.0.0.1' ||
    socketUrl.port !== endpoint.port
  )
    throw new Error('Invalid mission tab connection.');
  const socket = new WebSocket(socketUrl);
  let sequence = 0;
  let mainFrameId: string | null = null;
  let protectionFailure: Error | null = null;
  let disposing = false;
  let closing: Promise<void> | null = null;
  const closeProtectedPage = () =>
    (closing ??= page.close().catch(() => undefined));
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    if (!disposing)
      protectionFailure ??= new Error(
        'The study page connection closed; try again.',
      );
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The protected browser connection closed.'));
    }
    pending.clear();
    if (!disposing) void closeProtectedPage();
  };
  const send: SendCommand = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The browser protection request timed out.'));
        if (!disposing) {
          protectionFailure ??= new Error(
            'The browser protection connection timed out; try again.',
          );
          socket.close();
          void closeProtectedPage();
        }
      }, 4000);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('The browser protection connection is unavailable.'));
      }
    });
  const enableProtection = async (sessionId?: string) => {
    await send('Network.enable', {}, sessionId);
    await send('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await send(
      'Fetch.enable',
      {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      },
      sessionId,
    );
    // Cross-origin frames have separate CDP sessions and need the same guard.
    await send(
      'Target.setAutoAttach',
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'iframe' }, { exclude: true }],
      },
      sessionId,
    );
  };
  socket.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === 'number') {
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error)
          entry.reject(
            new Error('The browser could not apply mission protection.'),
          );
        else entry.resolve(message.result);
      } else if (message.method === 'Target.attachedToTarget') {
        const { sessionId } = message.params;
        void enableProtection(sessionId)
          .then(() => send('Runtime.runIfWaitingForDebugger', {}, sessionId))
          .catch(() => {
            socket.close();
            fail();
          });
      } else if (message.method === 'Network.responseReceived') {
        const response = message.params.response;
        if (hosts.includes(new URL(response.url).hostname)) {
          const retryAfter = Object.entries(response.headers ?? {}).find(
            ([name]) => name.toLowerCase() === 'retry-after',
          )?.[1];
          if (
            response.status === 429 ||
            (response.status === 503 && retryAfter)
          )
            protectionFailure ??= missionTraffic.recordRateLimit(
              response.url,
              typeof retryAfter === 'string' ? retryAfter : null,
            );
        }
      } else if (message.method === 'Fetch.requestPaused') {
        const sendForRequest: SendCommand = (method, params) =>
          send(method, params, message.sessionId);
        if (protectionFailure) {
          void sendForRequest('Fetch.failRequest', {
            requestId: message.params.requestId,
            errorReason: 'BlockedByClient',
          }).catch(fail);
          return;
        }
        void handleMissionRequest(
          sendForRequest,
          hosts,
          {
            ...message.params,
            mainFrame: message.params.frameId === mainFrameId,
          },
          (blocked) => {
            onBlocked?.({
              ...blocked,
              mainFrame: message.params.frameId === mainFrameId,
              signInWall:
                blocked.signInWall && message.params.frameId === mainFrameId,
            });
          },
          continuation,
        )
          .then((allowed) => {
            if (
              !allowed &&
              message.params.resourceType === 'Document' &&
              (!mainFrameId ||
                !message.params.frameId ||
                message.params.frameId === mainFrameId)
            ) {
              let signIn = false;
              try {
                const url = new URL(message.params.request.url);
                signIn = isSignInPage(url.hostname, url.pathname);
              } catch {
                /* Invalid destinations remain blocked. */
              }
              protectionFailure ??= new Error(
                signIn
                  ? 'This resource needs you to sign in again.'
                  : 'The page tried to leave your connected resources and was blocked.',
              );
              void closeProtectedPage();
            }
          })
          .catch(() => {
            socket.close();
            fail();
          });
      }
    } catch {
      socket.close();
      fail();
    }
  });
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('The protected browser connection timed out.'));
      }, 4000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('The mission tab could not be protected.'));
        },
        { once: true },
      );
    });
    const frameTree = (await send('Page.getFrameTree', {})) as {
      frameTree?: { frame?: { id?: string } };
    };
    mainFrameId = frameTree.frameTree?.frame?.id ?? null;
    if (!mainFrameId)
      throw new Error('The mission page frame could not be identified.');
    await enableProtection();
  } catch (error) {
    disposing = true;
    socket.close();
    fail();
    throw error;
  }
  // Closing the protected tab disposes interception without an unguarded interval.
  const release = async () => {
    disposing = true;
    try {
      await closeProtectedPage();
    } finally {
      socket.close();
      fail();
    }
  };
  return Object.assign(release, {
    assertReadable: () => {
      if (protectionFailure) throw protectionFailure;
    },
  }) satisfies MissionProtection;
};
