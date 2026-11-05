import { app, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { productEventV1Schema } from '@scholaros/services/learning/product-contracts';
import { idSchema } from '@scholaros/services/learning/product-contracts';
import { authClient } from '../../lib/auth/client';
import {
  academicEndpointFileSchema,
  deleteLocalAcademicDataInputSchema,
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
export type AcademicClientLifecycle = {
  onIdentityChange?: () => Promise<void>;
  onAccountReady?: (user: unknown) => void | Promise<void>;
  onServiceEvent?: (channel: AcademicEventChannel, value: unknown) => void;
  beforeSessionDelete?: (sessionId: string) => Promise<void>;
  beforeLocalDataDelete?: () => Promise<void>;
  afterLocalDataDelete?: () => Promise<void>;
  beforeDisconnect?: () => Promise<void>;
};

let lifecycle: AcademicClientLifecycle = {};
let identityBarrier: Promise<void> = Promise.resolve();
let identityEpoch = 0;
let settledIdentityEpoch = 0;
let observedCookie: string | undefined;
let stopAuthSubscription: (() => void) | undefined;
let userLookup = 0;
let appliedUserLookup = 0;

const invalidateIdentity = () => {
  currentAccountId = null;
  const epoch = ++identityEpoch;
  // Invalidate synchronously, but let an internal account read unwind a pending mount.
  const disposal = lifecycle.onIdentityChange?.();
  identityBarrier = Promise.all([identityBarrier, disposal]).then(() => {
    if (epoch === identityEpoch) settledIdentityEpoch = epoch;
  });
  void identityBarrier.catch(() => undefined);
};

const observeCookie = () => {
  const cookie = authClient.getCookie();
  if (observedCookie !== undefined && observedCookie !== cookie) {
    observedCookie = cookie;
    authIdentity = undefined;
    invalidateIdentity();
  }
  observedCookie = cookie;
  return cookie;
};
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
  if (authIdentity !== undefined) invalidateIdentity();
  authIdentity = nextIdentity;
  const epoch = identityEpoch;
  void identityBarrier
    .then(() => {
      if (epoch === identityEpoch)
        deliverToTrustedWindows('better-auth:user-updated', null);
    })
    .catch(() => undefined);
};
const publish = (channel: AcademicEventChannel, value: unknown) => {
  observeCookie();
  if (identityEpoch !== settledIdentityEpoch) return;
  if (channel === 'scholar:productEvent') {
    const parsedEvent = productEventV1Schema.safeParse(value);
    if (!parsedEvent.success || parsedEvent.data.accountId !== currentAccountId)
      return;
    deliverToTrustedWindows(channel, parsedEvent.data);
    lifecycle.onServiceEvent?.(channel, parsedEvent.data);
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
  lifecycle.onServiceEvent?.(channel, value);
};
const publishReconnect = (user: unknown) => {
  publishAuthIdentity(user);
  currentAccountId = getUserId(user);
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
          if (app.commandLine?.hasSwitch('session-only'))
            throw new Error(
              'The temporary session service is unavailable. Quit and reopen ScholarOS in session-only mode.',
            );
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
              .then(async () => {
                const user = await requestAcademicService('getCurrentUser');
                const epoch = identityEpoch;
                await identityBarrier;
                if (
                  epoch !== identityEpoch ||
                  getUserId(user) !== currentAccountId
                )
                  return;
                publishReconnect(user);
              })
              .catch(() => undefined);
        });
        connected = endpoint;
        return endpoint;
      })().finally(() => {
        starting = null;
      }));

const requestAcademicServiceOperation = async (
  method: AcademicMethod,
  input?: unknown,
) => {
  const cookie = observeCookie();
  if (method === 'signOut') {
    invalidateIdentity();
    authIdentity = null;
  }
  const epoch = identityEpoch;
  if (method === 'signOut' || method === 'deleteStudySession')
    await identityBarrier;
  if (method === 'deleteStudySession') {
    const sessionId = idSchema.parse(
      input && typeof input === 'object' && 'sessionId' in input
        ? input.sessionId
        : undefined,
    );
    await lifecycle.beforeSessionDelete?.(sessionId);
  }
  if (method === 'getCurrentUser' || method === 'signOut')
    currentAccountId = null;
  const lookup = method === 'getCurrentUser' ? ++userLookup : 0;
  const endpoint = await ensureService();
  if (
    method !== 'releaseActivityRun' &&
    (cookie !== observeCookie() ||
      (method !== 'getCurrentUser' && epoch !== identityEpoch))
  )
    throw new Error('Your session changed; sign in again.');
  const result = await academicRequest(endpoint, method, input);
  if (cookie !== observeCookie() && method !== 'releaseActivityRun')
    throw new Error('Your session changed; sign in again.');
  if (method === 'getCurrentUser') {
    if (
      (lookup < appliedUserLookup || epoch !== identityEpoch) &&
      getAuthIdentity(result) !== authIdentity
    )
      throw new Error('Your session changed; sign in again.');
    appliedUserLookup = Math.max(appliedUserLookup, lookup);
    publishAuthIdentity(result);
    currentAccountId = getUserId(result);
    const readyEpoch = identityEpoch;
    void identityBarrier
      .then(async () => {
        if (
          cookie === observeCookie() &&
          readyEpoch === identityEpoch &&
          currentAccountId === getUserId(result)
        )
          await lifecycle.onAccountReady?.(result);
      })
      .catch(() => undefined);
  }
  if (method === 'signOut') {
    currentAccountId = null;
    publishAuthIdentity(null);
  }
  return result;
};

export const requestAcademicService = async (
  method: AcademicMethod,
  input?: unknown,
) => {
  if (method !== 'deleteLocalAcademicData')
    return requestAcademicServiceOperation(method, input);
  const parsed = deleteLocalAcademicDataInputSchema.parse(input);
  const cookie = observeCookie();
  const epoch = identityEpoch;
  await identityBarrier;
  try {
    await lifecycle.beforeLocalDataDelete?.();
    if (cookie !== observeCookie() || epoch !== identityEpoch)
      throw new Error('Your session changed; sign in again.');
    return await requestAcademicServiceOperation(method, parsed);
  } finally {
    await lifecycle.afterLocalDataDelete?.();
  }
};

export const registerAcademicClient = async (
  options: AcademicClientLifecycle = {},
) => {
  lifecycle = options;
  observeCookie();
  stopAuthSubscription?.();
  stopAuthSubscription = authClient.$store.atoms.session.subscribe(() => {
    observeCookie();
  });
  for (const method of rendererAcademicMethods) {
    ipcMain.handle(`scholar:${method}`, async (event, input: unknown) => {
      requireTrustedSender(event);
      const cookie = observeCookie();
      const epoch = identityEpoch;
      if (method !== 'getCurrentUser') await identityBarrier;
      requireTrustedSender(event);
      if (
        cookie !== observeCookie() ||
        (method !== 'getCurrentUser' && epoch !== identityEpoch)
      )
        throw new Error('Your session changed; sign in again.');
      const result = await requestAcademicService(method, input);
      await identityBarrier;
      requireTrustedSender(event);
      if (
        cookie !== observeCookie() ||
        (method !== 'getCurrentUser' &&
          method !== 'signOut' &&
          epoch !== identityEpoch)
      )
        throw new Error('Your session changed; sign in again.');
      return result;
    });
  }
  await ensureService();
};

export const disconnectAcademicService = async () => {
  await lifecycle.beforeDisconnect?.();
  await identityBarrier;
  stopping = true;
  currentAccountId = null;
  stopSubscription?.();
  stopSubscription = null;
  stopAuthSubscription?.();
  stopAuthSubscription = undefined;
};
export const stopAcademicService = async () => {
  await disconnectAcademicService();
  const endpoint = await findService().catch(() => null);
  if (endpoint) await academicRequest(endpoint, 'shutdown');
};

/** Stops only the existing service for this profile, without reading auth state. */
export const stopExistingAcademicService = async () => {
  const endpoint = await findService().catch(() => null);
  if (!endpoint) return;
  await academicRequest(endpoint, 'shutdown', undefined, 3_000);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = await findService().catch(() => null);
    if (!current) return;
    if (
      current.address !== endpoint.address ||
      current.token !== endpoint.token
    )
      throw new Error(
        'The academic service changed while temporary mode was starting. Quit and try again.',
      );
    await delay(50);
  }
  throw new Error(
    'The existing academic service has not stopped yet. Quit ScholarOS and try again.',
  );
};
