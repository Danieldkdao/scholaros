import { app, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { productEventV1Schema } from '@scholaros/services/learning/product-contracts';
import {
  academicEndpointSchema,
  rendererAcademicMethods,
  type AcademicEndpointSchema,
  type AcademicEventChannel,
  type AcademicMethod,
} from './contracts';
import {
  getTrustedWindows,
  requireTrustedSender,
} from '../../lib/trusted-windows';
import { academicRequest, subscribeAcademic } from './transport';

let starting: Promise<AcademicEndpointSchema> | null = null;
let stopSubscription: (() => void) | null = null;
let stopping = false;
let connected: AcademicEndpointSchema | null = null;
let authIdentity: string | null | undefined;
const directory = () => path.join(app.getPath('userData'), 'academic-service');
const findService = async () => {
  const endpoint = academicEndpointSchema.parse(
    JSON.parse(await readFile(path.join(directory(), 'endpoint.json'), 'utf8')),
  );
  const state = await academicRequest(endpoint, 'health', undefined, 1000);
  if (!(state as { ready?: boolean })?.ready)
    throw new Error('The academic service is starting.');
  return endpoint;
};
const broadcastToTrustedWindows = (channel: string, value: unknown) => {
  for (const window of getTrustedWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, value);
  }
};
const getAuthIdentity = (user: unknown) => {
  if (!user || typeof user !== 'object' || !('id' in user)) return null;
  const candidate = user as {
    id?: unknown;
    hasCompletedOnboarding?: unknown;
    authMode?: unknown;
  };
  if (typeof candidate.id !== 'string') return null;
  return [
    candidate.id,
    candidate.hasCompletedOnboarding === true,
    candidate.authMode === 'offline-local',
  ].join(':');
};
const publishAuthIdentity = (user: unknown) => {
  const nextIdentity = getAuthIdentity(user);
  if (nextIdentity === authIdentity) return;
  authIdentity = nextIdentity;
  broadcastToTrustedWindows('better-auth:user-updated', null);
};
const publish = (channel: AcademicEventChannel, value: unknown) => {
  if (
    channel === 'scholar:productEvent' &&
    !productEventV1Schema.safeParse(value).success
  )
    return;

  broadcastToTrustedWindows(channel, value);
};
const publishReconnect = (user: unknown) => {
  publishAuthIdentity(user);
  const accountId =
    user &&
    typeof user === 'object' &&
    'id' in user &&
    typeof user.id === 'string'
      ? user.id
      : null;
  broadcastToTrustedWindows('scholar:coursesChange', {
    accountId,
    courseId: null,
  });
  broadcastToTrustedWindows('scholar:academicReconnect', { accountId });
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
  const result = await academicRequest(await ensureService(), method, input);
  if (method === 'getCurrentUser') publishAuthIdentity(result);
  if (method === 'signOut') publishAuthIdentity(null);
  return result;
};

export const registerAcademicClient = async () => {
  for (const method of rendererAcademicMethods) {
    ipcMain.handle(`scholar:${method}`, (event, input: unknown) => {
      requireTrustedSender(event);
      return requestAcademicService(method, input);
    });
  }
  await ensureService();
};

export const disconnectAcademicService = () => {
  stopping = true;
  stopSubscription?.();
  stopSubscription = null;
};
export const stopAcademicService = async () => {
  disconnectAcademicService();
  const endpoint = await findService().catch(() => null);
  if (endpoint) await academicRequest(endpoint, 'shutdown');
};
