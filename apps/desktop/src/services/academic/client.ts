import { app, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { productEventV1Schema } from '@scholaros/services/learning/product-contracts';
import {
  academicEndpointFileSchema,
  rendererAcademicMethods,
  type AcademicEndpointSchema,
  type AcademicEventChannel,
  type AcademicMethod,
} from './contracts';
import {
  getTrustedWindows,
  isTrustedWebContents,
  requireTrustedSender,
} from '../../lib/trusted-windows';
import { academicRequest, subscribeAcademic } from './transport';

let starting: Promise<AcademicEndpointSchema> | null = null;
let stopSubscription: (() => void) | null = null;
let stopping = false;
let connected: AcademicEndpointSchema | null = null;
let authIdentity: string | null | undefined;
let currentAccountId: string | null = null;
const directory = () => path.join(app.getPath('userData'), 'academic-service');
const findService = async () => {
  const endpointFile = academicEndpointFileSchema.parse(
    JSON.parse(await readFile(path.join(directory(), 'endpoint.json'), 'utf8')),
  );
  const endpoint = {
    version: endpointFile.version,
    address: endpointFile.address,
    token: endpointFile.token,
  };
  const state = await academicRequest(endpoint, 'health', undefined, 1000);
  if (!(state as { ready?: boolean })?.ready)
    throw new Error('The academic service is starting.');
  return endpoint;
};
const deliverToTrustedWindows = (channel: string, value: unknown) => {
  for (const window of getTrustedWindows()) {
    if (
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      isTrustedWebContents(window.webContents)
    )
      window.webContents.send(channel, value);
  }
};
const getUserId = (user: unknown) => {
  if (!user || typeof user !== 'object' || !('id' in user)) return null;
  return typeof user.id === 'string' ? user.id : null;
};
const getAuthIdentity = (user: unknown) => {
  const id = getUserId(user);
  if (!user || typeof user !== 'object' || id === null) return null;
  const candidate = user as {
    hasCompletedOnboarding?: unknown;
    authMode?: unknown;
  };
  return [
    id,
    candidate.hasCompletedOnboarding === true,
    candidate.authMode === 'offline-local',
  ].join(':');
};
const publishAuthIdentity = (user: unknown) => {
  const nextIdentity = getAuthIdentity(user);
  if (nextIdentity === authIdentity) return;
  authIdentity = nextIdentity;
  deliverToTrustedWindows('better-auth:user-updated', null);
};
const publish = (channel: AcademicEventChannel, value: unknown) => {
  if (channel === 'scholar:productEvent') {
    const parsedEvent = productEventV1Schema.safeParse(value);
    if (!parsedEvent.success || parsedEvent.data.accountId !== currentAccountId)
      return;
    deliverToTrustedWindows(channel, parsedEvent.data);
    return;
  }

  const eventAccountId =
    value &&
    typeof value === 'object' &&
    'accountId' in value &&
    (typeof value.accountId === 'string' || value.accountId === null)
      ? value.accountId
      : undefined;
  if (eventAccountId === undefined || eventAccountId !== currentAccountId)
    return;
  deliverToTrustedWindows(channel, value);
};
const publishReconnect = (user: unknown) => {
  currentAccountId = getUserId(user);
  publishAuthIdentity(user);
  deliverToTrustedWindows('scholar:coursesChange', {
    accountId: currentAccountId,
    courseId: null,
  });
  deliverToTrustedWindows('scholar:academicReconnect', {
    accountId: currentAccountId,
  });
};
const ensureService = (): Promise<AcademicEndpointSchema> =>
  connected
    ? Promise.resolve(connected)
    : (starting ??= (async () => {
        let endpoint = await findService().catch(() => null);
        if (!endpoint) {
          const child = spawn(
            process.execPath,
            [
              ...(app.isPackaged ? [] : [app.getAppPath()]),
              '--academic-service',
              `--user-data-dir=${app.getPath('userData')}`,
            ],
            { detached: true, stdio: 'ignore' },
          );
          child.on('error', () => undefined);
          child.unref();
          const deadline = Date.now() + 20_000;
          while (!endpoint && Date.now() < deadline) {
            await delay(150);
            endpoint = await findService().catch(() => null);
          }
          if (!endpoint)
            throw new Error(
              'The academic service could not start; quit and reopen ScholarOS to try again.',
            );
        }
        stopSubscription?.();
        stopSubscription = await subscribeAcademic(endpoint, publish, () => {
          stopSubscription = null;
          connected = null;
          if (!stopping)
            void ensureService()
              .then(async (endpoint) => {
                const user = await academicRequest(endpoint, 'getCurrentUser');
                publishReconnect(user);
              })
              .catch(() => undefined);
        });
        connected = endpoint;
        return endpoint;
      })().finally(() => {
        starting = null;
      }));

export const requestAcademicService = async (
  method: AcademicMethod,
  input?: unknown,
) => {
  if (method === 'getCurrentUser' || method === 'signOut')
    currentAccountId = null;
  const result = await academicRequest(await ensureService(), method, input);
  if (method === 'getCurrentUser') {
    currentAccountId = getUserId(result);
    publishAuthIdentity(result);
  }
  if (method === 'signOut') {
    currentAccountId = null;
    publishAuthIdentity(null);
  }
  return result;
};

export const registerAcademicClient = async () => {
  for (const method of rendererAcademicMethods) {
    ipcMain.handle(`scholar:${method}`, async (event, input: unknown) => {
      requireTrustedSender(event);
      const result = await requestAcademicService(method, input);
      requireTrustedSender(event);
      return result;
    });
  }
  await ensureService();
};

export const disconnectAcademicService = () => {
  stopping = true;
  currentAccountId = null;
  stopSubscription?.();
  stopSubscription = null;
};
export const stopAcademicService = async () => {
  disconnectAcademicService();
  const endpoint = await findService().catch(() => null);
  if (endpoint) await academicRequest(endpoint, 'shutdown');
};
