import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  academicEndpointSchema,
  academicMethods,
  type AcademicEndpointSchema,
} from './contracts';
import { academicRequest, subscribeAcademic } from './transport';

let starting: Promise<AcademicEndpointSchema> | null = null;
let stopSubscription: (() => void) | null = null;
let stopping = false;
let connected: AcademicEndpointSchema | null = null;
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
const publish = (channel: string, value: unknown) => {
  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed()) window.webContents.send(channel, value);
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
                if (user && typeof user === 'object' && 'id' in user)
                  publish('scholar:coursesChange', {
                    accountId: user.id,
                    courseId: null,
                  });
              })
              .catch(() => undefined);
        });
        connected = endpoint;
        return endpoint;
      })().finally(() => {
        starting = null;
      }));

export const requestAcademicService = async (method: string, input?: unknown) =>
  academicRequest(await ensureService(), method, input);

export const registerAcademicClient = async () => {
  for (const method of academicMethods) {
    if (method === 'shutdown' || method === 'health' || method === 'subscribe')
      continue;
    ipcMain.handle(`scholar:${method}`, (event, input: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || event.senderFrame !== event.sender.mainFrame)
        throw new Error('Untrusted application frame.');
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
