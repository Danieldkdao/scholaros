import './lib/application-paths';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  shell,
  systemPreferences,
  webContents,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import {
  dictationAudioChunkSchema,
  dictationEventSchema,
  dictationStartInputSchema,
} from '@scholaros/services/learning/speech-contracts';
import { clientEnv } from './data/env/client';
import {
  safeRouteSchema,
  type SafeRoute,
} from '@scholaros/services/learning/notification-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import {
  createNotificationHostAdapter,
  readExistingNotificationPermission,
  type NotificationHostAdapter,
} from './services/academic/notification-host-adapter';
import {
  createDictationHostAdapter,
  type DictationHostAdapter,
  type DictationHostScope,
} from './services/academic/dictation-host-adapter';
import {
  idSchema,
  jsonValueSchema,
  revisionSchema,
} from '@scholaros/services/learning/product-contracts';
import { authClient } from './lib/auth/client';
import { isAccountSessionCurrent, setupAuthMain } from './lib/auth/main';
import {
  getTrustedWindow,
  getTrustedWindows,
  installTrustedFocusedWebContentsGuard,
  isTrustedWebContents,
  registerTrustedWindow,
  requireTrustedSender,
} from './lib/trusted-windows';
import { protectWindowNavigation } from './lib/window-navigation';
import { openSystemPermissionSettings } from './lib/permission-settings';
import {
  contextFileSelectionResultSchema,
  contextFileSelectionSchema,
  activityRuntimeChangeSchema,
  authorizeActivityRunInputSchema,
  checkpointActivityStateInputSchema,
  releaseActivityRunInputSchema,
  requestMicrophonePermissionSchema,
  requestNotificationPermissionSchema,
} from './services/academic/contracts';
import { sessionSnapshotSchema } from '@scholaros/services/learning/study-contracts';
import {
  activityPresentationValues,
  artifactStateSchema,
} from '@scholaros/services/learning/activity-contracts';
import {
  registerAcademicClient,
  requestAcademicService,
  stopAcademicService,
  disconnectAcademicService,
} from './services/academic/client';
import { loadLearningActionModules } from './services/academic/learning-actions';
import { registerActivitySchemeBeforeReady } from './features/study/services/activity-protocol';
import {
  createActivityManager,
  type ActivityManager,
  type AuthorizedActivityRun as RuntimeAuthorizedActivityRun,
} from './features/study/services/activity-runtime';
import { createActivityContentDigest } from './features/study/services/activity-policy';
import {
  activityMessageLimits,
  isBoundedJsonValue,
} from './features/study/services/activity-mailbox';
import type { ActivityRuntimeChange } from './features/study/hooks/use-activity-host';

const serviceMode = app.commandLine.hasSwitch('academic-service');
const stopServiceMode = app.commandLine.hasSwitch('stop-academic-service');
if (serviceMode) {
  // Separate the Chromium session and singleton lease while preserving existing data paths.
  const userData = app.getPath('userData');
  const runtimeDirectory = path.join(userData, 'academic-service-runtime');
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  app.setPath('userData', runtimeDirectory);
  app.setPath('sessionData', runtimeDirectory);
  const ownsServiceLock = app.requestSingleInstanceLock();
  if (!ownsServiceLock) app.exit(0);
  app.setPath('userData', userData);
}

const getOnlineServiceUser = async () => {
  const user = await requestAcademicService('getCurrentUser');
  if (!user || typeof user !== 'object' || !('id' in user))
    throw new Error('Sign in to use this feature.');
  const candidate = user as { id?: unknown; authMode?: unknown };
  if (typeof candidate.id !== 'string')
    throw new Error('Sign in to use this feature.');
  if (candidate.authMode === 'offline-local')
    throw new Error('Reconnect to use this feature.');
  return { id: candidate.id };
};

type TrustedOnlineServiceUser = { id: string; cookie: string };

const requireTrustedOnlineServiceUser = async (
  event: Electron.IpcMainInvokeEvent,
): Promise<TrustedOnlineServiceUser> => {
  requireTrustedSender(event);
  const cookie = authClient.getCookie();
  const user = await getOnlineServiceUser();
  requireTrustedSender(event);
  if (!isAccountSessionCurrent(cookie))
    throw new Error('Your session changed; sign in again.');
  return { ...user, cookie };
};

const requireSameTrustedOnlineServiceUser = async (
  event: Electron.IpcMainInvokeEvent,
  expectedUser: TrustedOnlineServiceUser,
) => {
  const currentUser = await requireTrustedOnlineServiceUser(event);
  if (
    currentUser.id !== expectedUser.id ||
    currentUser.cookie !== expectedUser.cookie
  )
    throw new Error('Your session changed; sign in again.');
  return currentUser;
};

const requireActiveStudySession = async (
  event: Electron.IpcMainInvokeEvent,
  user: TrustedOnlineServiceUser,
  sessionId: string,
) => {
  await requireSameTrustedOnlineServiceUser(event, user);
  const result = await requestAcademicService('getStudySession', { sessionId });
  requireTrustedSender(event);
  await requireSameTrustedOnlineServiceUser(event, user);
  const snapshot = sessionSnapshotSchema.parse(result);
  if (
    snapshot.session.id !== sessionId ||
    snapshot.session.status !== 'in-progress'
  )
    throw new Error('Open an active study session to use this feature.');
};

let nativeAdmissionBlocks = 0;
const assertNativeAdmission = () => {
  if (nativeAdmissionBlocks > 0)
    throw new Error('Native work is being closed; try again afterward.');
};

type NativeNotificationOwner = {
  cookie: string;
  context: AuthorizedContext;
  controller: AbortController;
  host: NotificationHostAdapter;
  visible: Map<string, Notification>;
  timer?: ReturnType<typeof setInterval>;
};
let notificationEpoch = 0;
let notificationOwner: NativeNotificationOwner | null = null;
let notificationDisposal: Promise<void> = Promise.resolve();

const notificationRoutePath = (input: SafeRoute) => {
  const route = safeRouteSchema.parse(input);
  switch (route.kind) {
    case 'today':
      return '/dashboard';
    case 'settings':
      return `/dashboard/settings${route.section ? `?section=${encodeURIComponent(route.section)}` : ''}`;
    case 'context':
      return `/dashboard/context${route.itemId ? `?itemId=${encodeURIComponent(route.itemId)}` : ''}`;
    case 'course':
      return `/dashboard/courses/${encodeURIComponent(route.courseId)}`;
    case 'study':
      return `/study/${encodeURIComponent(route.sessionId)}`;
  }
};

const disposeNotificationHost = () => {
  notificationEpoch += 1;
  const owner = notificationOwner;
  notificationOwner = null;
  if (owner) {
    owner.controller.abort();
    clearInterval(owner.timer);
    for (const notification of owner.visible.values()) notification.close();
    owner.visible.clear();
  }
  notificationDisposal = Promise.all([
    notificationDisposal,
    owner?.host.dispose(),
  ]).then(() => undefined);
  return notificationDisposal;
};

const bindNotificationUser = async (input: unknown) => {
  const user = z
    .object({ id: idSchema, authMode: z.string().optional() })
    .safeParse(input);
  if (
    !user.success ||
    user.data.authMode === 'offline-local' ||
    nativeAdmissionBlocks > 0
  )
    return null;
  const cookie = authClient.getCookie();
  if (
    notificationOwner?.context.userId === user.data.id &&
    notificationOwner.cookie === cookie &&
    notificationOwner.context.isCurrent()
  )
    return notificationOwner;
  const startingEpoch = notificationEpoch;
  await notificationDisposal;
  assertNativeAdmission();
  if (startingEpoch !== notificationEpoch || !isAccountSessionCurrent(cookie))
    return null;
  if (
    notificationOwner?.context.userId === user.data.id &&
    notificationOwner.cookie === cookie &&
    notificationOwner.context.isCurrent()
  )
    return notificationOwner;
  if (notificationOwner) {
    const disposal = disposeNotificationHost();
    const disposalEpoch = notificationEpoch;
    await disposal;
    if (disposalEpoch !== notificationEpoch) return null;
  }
  if (!isAccountSessionCurrent(cookie) || nativeAdmissionBlocks > 0)
    return null;
  const epoch = ++notificationEpoch;
  const controller = new AbortController();
  const context: AuthorizedContext = {
    userId: user.data.id,
    epoch,
    signal: controller.signal,
    isCurrent: () =>
      notificationOwner?.context === context &&
      !controller.signal.aborted &&
      nativeAdmissionBlocks === 0 &&
      epoch === notificationEpoch &&
      isAccountSessionCurrent(cookie),
  };
  const visible = new Map<string, Notification>();
  const host = createNotificationHostAdapter({
    permission: async (userId) => {
      const window = getTrustedWindows().find(
        (candidate) =>
          !candidate.isDestroyed() &&
          !candidate.webContents.isDestroyed() &&
          !candidate.webContents.isLoadingMainFrame(),
      );
      return readExistingNotificationPermission({
        isSupported: () => Notification.isSupported(),
        isCurrent: () =>
          userId === context.userId &&
          context.isCurrent() &&
          (!window ||
            (!window.isDestroyed() &&
              !window.webContents.isDestroyed() &&
              !window.webContents.isLoadingMainFrame() &&
              getTrustedWindows().includes(window))),
        readPermission: () =>
          window
            ? window.webContents.executeJavaScript('Notification.permission')
            : null,
      });
    },
    isFocused: () => getTrustedWindows().some((window) => window.isFocused()),
    show: async ({ eventId, title, body, onClick }) => {
      if (!context.isCurrent() || !Notification.isSupported()) return 'failed';
      return new Promise<'shown' | 'failed'>((resolve) => {
        const notification = new Notification({ title, body });
        visible.set(eventId, notification);
        let settled = false;
        const finish = (result: 'shown' | 'failed') => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(result);
        };
        const timeout = setTimeout(() => {
          finish('failed');
          notification.close();
        }, 5_000);
        notification.once('show', () =>
          finish(context.isCurrent() ? 'shown' : 'failed'),
        );
        notification.once('failed', () => {
          visible.delete(eventId);
          finish('failed');
        });
        notification.once('close', () => {
          visible.delete(eventId);
          finish('failed');
        });
        notification.once('click', () => {
          if (context.isCurrent()) onClick();
        });
        try {
          notification.show();
        } catch {
          visible.delete(eventId);
          finish('failed');
        }
      });
    },
    dismiss: async (eventId) => {
      visible.get(eventId)?.close();
      visible.delete(eventId);
    },
    route: async (route) => {
      const routePath = notificationRoutePath(route);
      if (!context.isCurrent()) return;
      let window = getTrustedWindows()[0];
      if (window) {
        const url = new URL(window.webContents.getURL());
        url.hash = routePath;
        await window.loadURL(url.href);
      } else window = createWindow(routePath);
      if (context.isCurrent() && !window.isDestroyed()) {
        window.show();
        window.focus();
      }
    },
    validateTarget: async (userId, event) => {
      if (userId !== context.userId || !context.isCurrent()) return false;
      const currentUser = await getOnlineServiceUser();
      if (currentUser.id !== userId || !context.isCurrent()) return false;
      const route = safeRouteSchema.parse(event.safeRoute);
      let exists: unknown = true;
      switch (route.kind) {
        case 'study':
          exists = await requestAcademicService('getStudySession', {
            sessionId: route.sessionId,
          });
          break;
        case 'course':
          exists = await requestAcademicService('getCourse', route.courseId);
          break;
        case 'context':
          if (route.itemId)
            exists = await requestAcademicService('getContextItem', {
              itemId: route.itemId,
            });
          break;
        case 'today':
        case 'settings':
          break;
      }
      return Boolean(exists) && context.isCurrent();
    },
  });
  const owner: NativeNotificationOwner = {
    cookie,
    context,
    controller,
    host,
    visible,
  };
  notificationOwner = owner;
  await owner.host.setFocus(
    owner.context,
    getTrustedWindows().some((window) => window.isFocused()),
  );
  await owner.host.deliverDueNotifications(owner.context);
  if (!owner.context.isCurrent()) return null;
  owner.timer = setInterval(() => {
    if (owner.context.isCurrent())
      void owner.host
        .deliverDueNotifications(owner.context)
        .catch(() => undefined);
  }, 30_000);
  owner.timer.unref();
  return owner;
};

type NativeDictationScope = {
  event: Electron.IpcMainInvokeEvent;
  window: BrowserWindow;
  frame: Electron.WebFrameMain | null;
  user: TrustedOnlineServiceUser;
  sessionId: string;
  composerRevision: number;
  sessionEpoch: number;
  epoch: number;
  host: DictationHostAdapter;
  operationId?: string;
  ended: boolean;
};
let dictationEpoch = 0;
let dictationStarting = false;
let dictationScope: NativeDictationScope | null = null;
let dictationDisposal: Promise<void> = Promise.resolve();

const assertDictationDocument = (scope: NativeDictationScope) => {
  if (
    dictationScope !== scope ||
    scope.epoch !== dictationEpoch ||
    requireTrustedSender(scope.event) !== scope.window ||
    scope.event.sender !== scope.window.webContents ||
    scope.event.senderFrame !== scope.frame ||
    scope.window.webContents.mainFrame !== scope.frame ||
    closingActivityWindows.has(scope.window) ||
    !isTrustedWebContents(scope.event.sender) ||
    !isAccountSessionCurrent(scope.user.cookie) ||
    (process.platform === 'darwin' &&
      systemPreferences.getMediaAccessStatus('microphone') !== 'granted')
  )
    throw new Error('Your dictation session changed; start again.');
};

const isDictationCurrent = async (
  scope: NativeDictationScope,
  claimed: DictationHostScope,
) => {
  try {
    assertDictationDocument(scope);
    if (
      claimed.accountId !== scope.user.id ||
      claimed.senderId !== scope.event.sender.id ||
      claimed.sessionId !== scope.sessionId ||
      claimed.composerRevision !== scope.composerRevision ||
      (scope.operationId !== undefined &&
        claimed.operationId !== scope.operationId)
    )
      return false;
    await requireSameTrustedOnlineServiceUser(scope.event, scope.user);
    const snapshot = sessionSnapshotSchema.parse(
      await requestAcademicService('getStudySession', {
        sessionId: scope.sessionId,
      }),
    );
    assertDictationDocument(scope);
    await requireSameTrustedOnlineServiceUser(scope.event, scope.user);
    assertDictationDocument(scope);
    return (
      snapshot.session.id === scope.sessionId &&
      snapshot.session.status === 'in-progress' &&
      snapshot.session.generationEpoch === scope.sessionEpoch
    );
  } catch {
    return false;
  }
};

const disposeDictationHost = () => {
  dictationEpoch += 1;
  const scope = dictationScope;
  dictationScope = null;
  if (scope)
    dictationDisposal = Promise.all([
      dictationDisposal,
      scope.host.dispose(),
    ]).then(() => undefined);
  return dictationDisposal;
};

const dictationOperationSchema = z.strictObject({ operationId: idSchema });
export type DictationOperationSchema = z.infer<typeof dictationOperationSchema>;

const requireDictationScope = async (
  event: Electron.IpcMainInvokeEvent,
  operationId: string,
) => {
  const window = requireTrustedSender(event);
  const scope = dictationScope;
  if (
    !scope ||
    scope.ended ||
    scope.operationId !== operationId ||
    scope.window !== window ||
    scope.event.sender !== event.sender ||
    scope.frame !== event.senderFrame
  )
    throw new Error('This dictation is unavailable.');
  if (
    !(await isDictationCurrent(scope, {
      accountId: scope.user.id,
      senderId: event.sender.id,
      sessionId: scope.sessionId,
      composerRevision: scope.composerRevision,
      operationId,
    }))
  )
    throw new Error('Your dictation session changed; start again.');
  return scope;
};

const registerDictationIpc = () => {
  ipcMain.handle(
    'scholar:native:startDictation',
    async (event, input: unknown) => {
      const window = requireTrustedSender(event);
      assertNativeAdmission();
      const parsed = dictationStartInputSchema.parse(input);
      if (dictationStarting) throw new Error('A dictation is already active.');
      dictationStarting = true;
      try {
        let epoch = dictationEpoch;
        const frame = event.senderFrame;
        const user = await requireTrustedOnlineServiceUser(event);
        await dictationDisposal;
        assertNativeAdmission();
        if (epoch !== dictationEpoch || frame !== event.sender.mainFrame)
          throw new Error('Your dictation session changed; start again.');
        if (dictationScope && !dictationScope.ended)
          throw new Error('A dictation is already active.');
        if (dictationScope) {
          await disposeDictationHost();
          epoch = dictationEpoch;
        }
        await requireActiveStudySession(event, user, parsed.sessionId);
        const snapshot = sessionSnapshotSchema.parse(
          await requestAcademicService('getStudySession', {
            sessionId: parsed.sessionId,
          }),
        );
        assertNativeAdmission();
        await requireSameTrustedOnlineServiceUser(event, user);
        if (
          epoch !== dictationEpoch ||
          frame !== event.sender.mainFrame ||
          snapshot.session.status !== 'in-progress'
        )
          throw new Error('Your dictation session changed; start again.');
        if (
          process.platform === 'darwin' &&
          systemPreferences.getMediaAccessStatus('microphone') !== 'granted'
        )
          throw new Error('Allow microphone access before starting dictation.');
        const scope: NativeDictationScope = {
          event,
          window,
          frame,
          user,
          sessionId: parsed.sessionId,
          composerRevision: parsed.composerRevision,
          sessionEpoch: snapshot.session.generationEpoch,
          epoch: dictationEpoch,
          host: null!,
          ended: false,
        };
        scope.host = createDictationHostAdapter({
          isCurrent: (claimed) => isDictationCurrent(scope, claimed),
          authorizedFetch: async (requestPath, init) => {
            const base = new URL(clientEnv.VITE_API_URL);
            const url = new URL(requestPath, base);
            const method = init.method ?? 'GET';
            const operationId = url.searchParams.get('operationId');
            const valid =
              url.origin === base.origin &&
              !url.hash &&
              !url.username &&
              !url.password &&
              ((requestPath === '/api/dictation' && method === 'POST') ||
                (requestPath === '/api/dictation/control' &&
                  method === 'POST') ||
                ([
                  '/api/dictation/audio',
                  '/api/dictation/events',
                  '/api/dictation/control',
                ].includes(url.pathname) &&
                  operationId !== null &&
                  [...url.searchParams.keys()].length === 1 &&
                  operationId === scope.operationId &&
                  ((url.pathname.endsWith('/audio') && method === 'PUT') ||
                    (url.pathname.endsWith('/events') && method === 'GET') ||
                    (url.pathname.endsWith('/control') &&
                      method === 'DELETE'))));
            if (!valid) throw new Error('The dictation route is invalid.');
            // Teardown can cancel only this captured account, never the new account's cookie.
            const cancelling = url.pathname === '/api/dictation/control';
            if (!cancelling) assertDictationDocument(scope);
            const headers = new Headers(init.headers);
            headers.set('cookie', user.cookie);
            headers.set('origin', base.origin);
            const response = await net.fetch(url.href, {
              ...init,
              headers,
              redirect: 'error',
              credentials: 'omit',
              cache: 'no-store',
            });
            if (response.redirected) {
              await response.body?.cancel().catch(() => undefined);
              throw new Error('The dictation route redirected.');
            }
            if (!cancelling) {
              try {
                assertDictationDocument(scope);
              } catch (error) {
                await response.body?.cancel().catch(() => undefined);
                throw error;
              }
            }
            return response;
          },
          publishEvent: (senderId, value) => {
            try {
              assertDictationDocument(scope);
              const change = dictationEventSchema.parse(value);
              if (
                senderId !== event.sender.id ||
                change.operationId !== scope.operationId ||
                change.sessionId !== scope.sessionId ||
                change.composerRevision !== scope.composerRevision
              )
                return;
              event.sender.send('scholar:native:dictationEvent', change);
              if (change.kind === 'ended') scope.ended = true;
            } catch {
              // Navigation or identity changes cannot receive a transcript.
            }
          },
        });
        dictationScope = scope;
        try {
          const started = await scope.host.startDictation(parsed, {
            accountId: user.id,
            senderId: event.sender.id,
          });
          assertNativeAdmission();
          assertDictationDocument(scope);
          scope.operationId = idSchema.parse(started.operationId);
          return { operationId: scope.operationId };
        } catch (error) {
          if (dictationScope === scope) await disposeDictationHost();
          throw error;
        }
      } finally {
        dictationStarting = false;
      }
    },
  );
  ipcMain.handle(
    'scholar:native:appendDictationAudio',
    async (event, input: unknown) => {
      requireTrustedSender(event);
      assertNativeAdmission();
      const parsed = dictationAudioChunkSchema.parse(input);
      const scope = await requireDictationScope(event, parsed.operationId);
      return scope.host.appendDictationAudio(parsed, {
        accountId: scope.user.id,
        senderId: event.sender.id,
      });
    },
  );
  ipcMain.handle(
    'scholar:native:stopDictation',
    async (event, input: unknown) => {
      requireTrustedSender(event);
      const parsed = dictationOperationSchema.parse(input);
      const scope = await requireDictationScope(event, parsed.operationId);
      await scope.host.stopDictation(parsed, {
        accountId: scope.user.id,
        senderId: event.sender.id,
      });
    },
  );
  ipcMain.handle(
    'scholar:native:cancelDictation',
    async (event, input: unknown) => {
      requireTrustedSender(event);
      const parsed = dictationOperationSchema.parse(input);
      const scope = await requireDictationScope(event, parsed.operationId);
      await disposeDictationHost();
      scope.ended = true;
    },
  );
};

const activityBoundsSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type ActivityBoundsSchema = z.infer<typeof activityBoundsSchema>;

const mountActivitySchema = z.strictObject({
  sessionId: idSchema,
  artifactId: idSchema,
  versionId: idSchema,
  attemptId: idSchema,
  presentation: z.enum(activityPresentationValues),
  readOnly: z.boolean().optional(),
  bounds: activityBoundsSchema,
});
export type MountActivitySchema = z.infer<typeof mountActivitySchema>;

const activityRunSchema = z.strictObject({ runId: idSchema });
export type ActivityRunSchema = z.infer<typeof activityRunSchema>;

const updateActivityBoundsSchema = activityRunSchema.extend({
  bounds: activityBoundsSchema,
  visible: z.boolean(),
});
export type UpdateActivityBoundsSchema = z.infer<
  typeof updateActivityBoundsSchema
>;

const runtimeActivityAuthorizationSchema = z
  .strictObject({
    sessionId: idSchema,
    artifactId: idSchema,
    versionId: idSchema,
    attemptId: idSchema,
    runId: idSchema,
    runtimeVersion: z.literal('activity-runtime-v1'),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    html: z.string(),
    css: z.string(),
    sdk: z.string(),
    javascript: z.string(),
    initialState: jsonValueSchema.refine((value) =>
      isBoundedJsonValue(value, activityMessageLimits.stateBytes),
    ),
    stateRevision: revisionSchema,
  })
  .refine(
    (run) =>
      Buffer.byteLength(
        JSON.stringify({
          html: run.html,
          css: run.css,
          sdk: run.sdk,
          javascript: run.javascript,
        }),
        'utf8',
      ) <=
      512 * 1024,
    'Activity bundle exceeds the byte limit.',
  );
export type RuntimeActivityAuthorizationSchema = z.infer<
  typeof runtimeActivityAuthorizationSchema
>;

export const activityAuthModeValues = ['online', 'offline-local'] as const;
export type ActivityAuthMode = (typeof activityAuthModeValues)[number];

const activityUserSchema = z.object({
  id: idSchema,
  authMode: z.enum(activityAuthModeValues).optional(),
});
export type ActivityUserSchema = z.infer<typeof activityUserSchema>;

type ActivityScope = {
  event: Electron.IpcMainInvokeEvent;
  hostWindow: BrowserWindow;
  frame: Electron.WebFrameMain | null;
  cookie: string;
  accountId: string;
  readOnly: boolean;
  input: MountActivitySchema;
  epoch: number;
  sessionEpoch?: number;
  manager: ActivityManager;
  authorization?: RuntimeAuthorizedActivityRun;
  stateRevision: number;
  closed?: boolean;
  eventQueue: Promise<void>;
};

let activityManager: ActivityManager | null = null;
let activityEpoch = 0;
let authorizingActivityScope: ActivityScope | null = null;
let activityMountQueue: Promise<void> = Promise.resolve();
let activityDisposal: Promise<void> = Promise.resolve();
const activityScopes = new Map<string, ActivityScope>();
const pendingActivitySessions = new Map<string, number>();
const closingActivityWindows = new WeakSet<BrowserWindow>();

const disposeActivityManager = () => {
  activityEpoch += 1;
  activityScopes.clear();
  const manager = activityManager;
  activityManager = null;
  if (manager)
    activityDisposal = Promise.all([activityDisposal, manager.dispose()]).then(
      () => undefined,
    );
  return activityDisposal;
};

const disposeNativeOwners = async () => {
  nativeAdmissionBlocks += 1;
  try {
    const results = await Promise.allSettled([
      disposeDictationHost(),
      disposeActivityManager(),
      disposeNotificationHost(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0)
      throw new AggregateError(failures, 'Native work could not close.');
  } finally {
    nativeAdmissionBlocks -= 1;
  }
};

const reportActivityTeardownFailure = () =>
  dialog.showErrorBox(
    'ScholarOS could not close safely',
    'Activity progress could not be released; keep the app open to preserve unconfirmed progress.',
  );

const assertActivityDocument = (scope: ActivityScope) => {
  // P21 treats this exact cancellation as an expected pending-mount teardown.
  if (scope.epoch !== activityEpoch)
    throw new Error('The activity mount authorization became stale.');
  if (
    requireTrustedSender(scope.event) !== scope.hostWindow ||
    scope.event.sender !== scope.hostWindow.webContents ||
    scope.event.senderFrame !== scope.frame ||
    scope.hostWindow.webContents.mainFrame !== scope.frame ||
    !isTrustedWebContents(scope.event.sender) ||
    closingActivityWindows.has(scope.hostWindow) ||
    !isAccountSessionCurrent(scope.cookie)
  )
    throw new Error('Your activity session changed; reopen the activity.');
};

const getActivityUser = async (event: Electron.IpcMainInvokeEvent) => {
  requireTrustedSender(event);
  const cookie = authClient.getCookie();
  const user = await requestAcademicService('getCurrentUser');
  requireTrustedSender(event);
  if (!isAccountSessionCurrent(cookie))
    throw new Error('Your session changed; sign in again.');
  const parsed = activityUserSchema.parse(user);
  return {
    accountId: parsed.id,
    readOnly: parsed.authMode === 'offline-local',
    cookie,
  };
};

const assertActivityScope = async (scope: ActivityScope) => {
  assertActivityDocument(scope);
  const user = await getActivityUser(scope.event);
  assertActivityDocument(scope);
  if (
    user.accountId !== scope.accountId ||
    user.cookie !== scope.cookie ||
    user.readOnly !== scope.readOnly
  )
    throw new Error('Your session changed; reopen the activity.');
  const snapshot = sessionSnapshotSchema.parse(
    await requestAcademicService('getStudySession', {
      sessionId: scope.input.sessionId,
    }),
  );
  assertActivityDocument(scope);
  if (
    snapshot.session.id !== scope.input.sessionId ||
    (!scope.readOnly && snapshot.session.status !== 'in-progress') ||
    (scope.sessionEpoch !== undefined &&
      scope.sessionEpoch !== snapshot.session.generationEpoch)
  )
    throw new Error('Your study session changed; reopen the activity.');
  scope.sessionEpoch = snapshot.session.generationEpoch;
  const currentUser = await getActivityUser(scope.event);
  assertActivityDocument(scope);
  if (
    currentUser.accountId !== scope.accountId ||
    currentUser.cookie !== scope.cookie ||
    currentUser.readOnly !== scope.readOnly
  )
    throw new Error('Your session changed; reopen the activity.');
};

const sendActivityChange = (runId: string, change: ActivityRuntimeChange) => {
  const scope = activityScopes.get(runId);
  if (!scope) return Promise.resolve();
  scope.eventQueue = scope.eventQueue
    .then(async () => {
      await assertActivityScope(scope);
      if (
        activityScopes.get(runId) !== scope ||
        (scope.closed && change.kind !== 'closed')
      )
        return;
      assertActivityDocument(scope);
      scope.event.sender.send(
        'scholar:native:activityChange',
        activityRuntimeChangeSchema.parse(change),
      );
    })
    .catch(() => undefined);
  return scope.eventQueue;
};

const activityChangeBinding = (scope: ActivityScope, runId: string) => ({
  runId,
  sessionId: scope.input.sessionId,
  artifactId: scope.input.artifactId,
  versionId: scope.input.versionId,
  attemptId: scope.input.attemptId,
});

const getActivityManager = () =>
  (activityManager ??= createActivityManager({
    requireTrustedSender: isTrustedWebContents,
    getTrustedRenderers: () =>
      getTrustedWindows().map((window) => window.webContents),
    authorizeRun: async (request) => {
      const scope = authorizingActivityScope;
      if (
        !scope ||
        request.sessionId !== scope.input.sessionId ||
        request.artifactId !== scope.input.artifactId ||
        request.versionId !== scope.input.versionId ||
        request.attemptId !== scope.input.attemptId
      )
        throw new Error('The activity authorization is out of scope.');
      try {
        await assertActivityScope(scope);
        const authorization = runtimeActivityAuthorizationSchema.parse(
          await requestAcademicService(
            'authorizeActivityRun',
            authorizeActivityRunInputSchema.parse(request),
          ),
        );
        if (
          authorization.sessionId !== request.sessionId ||
          authorization.artifactId !== request.artifactId ||
          authorization.versionId !== request.versionId ||
          authorization.attemptId !== request.attemptId ||
          authorization.runtimeDigest !==
            createActivityContentDigest(authorization)
        )
          throw new Error('The activity authorization failed validation.');
        await assertActivityScope(scope);
        scope.authorization = authorization;
        scope.stateRevision = authorization.stateRevision;
        activityScopes.set(authorization.runId, scope);
        return authorization;
      } catch (error) {
        if (scope.epoch !== activityEpoch)
          throw new Error('The activity mount authorization became stale.');
        throw error;
      }
    },
    persistState: async (proposal) => {
      const scope = activityScopes.get(proposal.runId);
      if (
        !scope ||
        scope.closed ||
        scope.readOnly ||
        proposal.sessionId !== scope.input.sessionId ||
        proposal.artifactId !== scope.input.artifactId ||
        proposal.versionId !== scope.input.versionId ||
        proposal.attemptId !== scope.input.attemptId
      )
        throw new Error('The activity checkpoint is out of scope.');
      await assertActivityScope(scope);
      void sendActivityChange(proposal.runId, {
        ...activityChangeBinding(scope, proposal.runId),
        kind: 'checkpoint-pending',
        stateRevision: scope.stateRevision,
      });
      const checkpoint = artifactStateSchema.parse(
        await requestAcademicService(
          'checkpointArtifactState',
          checkpointActivityStateInputSchema.parse(proposal),
        ),
      );
      await assertActivityScope(scope);
      if (
        checkpoint.artifactId !== proposal.artifactId ||
        checkpoint.versionId !== proposal.versionId ||
        checkpoint.attemptId !== proposal.attemptId ||
        checkpoint.stateRevision <= proposal.baseStateRevision
      )
        throw new Error('The activity checkpoint response is out of scope.');
      return { revision: checkpoint.stateRevision };
    },
    releaseRun: async (release) => {
      await requestAcademicService(
        'releaseActivityRun',
        releaseActivityRunInputSchema.parse(release),
      );
    },
    onRuntimeReady: (runId) => {
      const scope = activityScopes.get(runId);
      const run = scope?.authorization;
      if (run)
        sendActivityChange(runId, {
          kind: 'ready',
          runId,
          sessionId: run.sessionId,
          artifactId: run.artifactId,
          versionId: run.versionId,
          attemptId: run.attemptId,
          stateRevision: run.stateRevision,
          runtimeVersion: run.runtimeVersion,
          contentDigest: run.contentDigest,
        });
    },
    onStateAcknowledged: (runId, revision) => {
      const scope = activityScopes.get(runId);
      if (
        !scope ||
        !Number.isSafeInteger(revision) ||
        revision < scope.stateRevision
      )
        return;
      scope.stateRevision = revision;
      void sendActivityChange(runId, {
        ...activityChangeBinding(scope, runId),
        kind: 'checkpoint-acknowledged',
        stateRevision: revision,
      });
    },
    onStateFailure: (runId) => {
      const scope = activityScopes.get(runId);
      if (scope)
        void sendActivityChange(runId, {
          ...activityChangeBinding(scope, runId),
          kind: 'checkpoint-failed',
          stateRevision: scope.stateRevision,
          errorCode: 'storage-failed',
        });
    },
    onInteraction: async ({ runId }) => {
      const scope = activityScopes.get(runId);
      if (!scope || scope.closed || scope.readOnly)
        throw new Error('The activity interaction is out of scope.');
      await assertActivityScope(scope);
    },
    onClosed: ({ runId, reason }) => {
      const scope = activityScopes.get(runId);
      if (!scope) return;
      scope.closed = true;
      void sendActivityChange(runId, {
        ...activityChangeBinding(scope, runId),
        kind: 'closed',
        errorCode:
          reason === 'activity-resource-watchdog'
            ? 'limit-exceeded'
            : 'cancelled',
      }).finally(() => {
        if (activityScopes.get(runId) === scope) activityScopes.delete(runId);
      });
    },
  }));

const requireActivityRun = async (
  event: Electron.IpcMainInvokeEvent,
  runId: string,
) => {
  const hostWindow = requireTrustedSender(event);
  const scope = activityScopes.get(runId);
  if (
    !scope ||
    scope.closed ||
    scope.hostWindow !== hostWindow ||
    scope.event.sender !== event.sender ||
    scope.frame !== event.senderFrame
  )
    throw new Error('The activity run is out of scope.');
  await assertActivityScope(scope);
  if (scope.closed || activityScopes.get(runId) !== scope)
    throw new Error('The activity run is out of scope.');
  return scope;
};

const registerActivityIpc = () => {
  ipcMain.handle(
    'scholar:native:mountActivity',
    async (event, input: unknown) => {
      const hostWindow = requireTrustedSender(event);
      assertNativeAdmission();
      const selection = mountActivitySchema.parse(input);
      const epoch = activityEpoch;
      const frame = event.senderFrame;
      const cookie = authClient.getCookie();
      pendingActivitySessions.set(
        selection.sessionId,
        (pendingActivitySessions.get(selection.sessionId) ?? 0) + 1,
      );
      const operation = activityMountQueue.then(async () => {
        await activityDisposal;
        assertNativeAdmission();
        const user = await getActivityUser(event);
        if (user.cookie !== cookie)
          throw new Error('Your session changed; reopen the activity.');
        const manager = getActivityManager();
        const scope: ActivityScope = {
          event,
          hostWindow,
          frame,
          ...user,
          input: selection,
          epoch,
          manager,
          stateRevision: 0,
          eventQueue: Promise.resolve(),
        };
        await assertActivityScope(scope);
        authorizingActivityScope = scope;
        let mounted: { runId: string } | undefined;
        try {
          mounted = await manager.mount({
            hostWindow,
            sessionId: selection.sessionId,
            artifactId: selection.artifactId,
            versionId: selection.versionId,
            attemptId: selection.attemptId,
            bounds: selection.bounds,
            readOnly: user.readOnly,
          });
          await assertActivityScope(scope);
          if (scope.closed || scope.authorization?.runId !== mounted.runId)
            throw new Error('The activity run changed during mount.');
          return mounted;
        } catch (error) {
          if (mounted) await manager.close(mounted.runId);
          if (scope.authorization)
            activityScopes.delete(scope.authorization.runId);
          throw error;
        } finally {
          authorizingActivityScope = null;
        }
      });
      activityMountQueue = operation.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await operation;
      } finally {
        const remaining =
          (pendingActivitySessions.get(selection.sessionId) ?? 1) - 1;
        if (remaining === 0)
          pendingActivitySessions.delete(selection.sessionId);
        else pendingActivitySessions.set(selection.sessionId, remaining);
      }
    },
  );
  ipcMain.handle(
    'scholar:native:updateActivityBounds',
    async (event, input: unknown) => {
      requireTrustedSender(event);
      const { runId, bounds, visible } =
        updateActivityBoundsSchema.parse(input);
      const scope = await requireActivityRun(event, runId);
      if (visible) scope.manager.updateBounds(runId, bounds, true);
      else scope.manager.hide(runId);
    },
  );
  ipcMain.handle(
    'scholar:native:retryActivityCheckpoint',
    async (event, input: unknown) => {
      requireTrustedSender(event);
      const { runId } = activityRunSchema.parse(input);
      const scope = await requireActivityRun(event, runId);
      if (scope.readOnly)
        throw new Error('Reconnect to save activity progress.');
      await scope.manager.retryCheckpoint({ runId });
      await assertActivityScope(scope);
    },
  );
  ipcMain.handle(
    'scholar:native:closeActivity',
    async (event, input: unknown) => {
      requireTrustedSender(event);
      const { runId } = activityRunSchema.parse(input);
      const scope = await requireActivityRun(event, runId);
      await scope.manager.close(runId);
      await scope.eventQueue;
      await assertActivityScope(scope);
      activityScopes.delete(runId);
    },
  );
};

const registerTrustedNativeIpc = () => {
  registerActivityIpc();
  registerDictationIpc();
  ipcMain.handle('scholar:native:chooseContextFiles', async (event, input) => {
    const hostWindow = requireTrustedSender(event);
    assertNativeAdmission();
    const selection = contextFileSelectionSchema.parse(input);
    const user = await requireTrustedOnlineServiceUser(event);
    if (selection.sessionId)
      await requireActiveStudySession(event, user, selection.sessionId);
    const selected = await dialog.showOpenDialog(hostWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Choose study materials',
    });
    requireTrustedSender(event);
    await requireSameTrustedOnlineServiceUser(event, user);
    if (selection.sessionId)
      await requireActiveStudySession(event, user, selection.sessionId);
    if (selected.canceled || selected.filePaths.length === 0)
      return { items: [], cancelled: true };
    assertNativeAdmission();
    if (selected.filePaths.length > 8)
      throw new Error('Choose no more than eight files.');
    const result = await requestAcademicService(
      'registerSelectedContextFiles',
      {
        ...selection,
        filePaths: selected.filePaths,
      },
    );
    requireTrustedSender(event);
    await requireSameTrustedOnlineServiceUser(event, user);
    if (selection.sessionId)
      await requireActiveStudySession(event, user, selection.sessionId);
    return contextFileSelectionResultSchema.parse(result);
  });
  ipcMain.handle('scholar:native:openMicrophoneSettings', async (event) => {
    requireTrustedSender(event);
    assertNativeAdmission();
    // Opening a fixed settings pane does not start capture and must remain
    // available after a study timer expires or the service disconnects.
    await openSystemPermissionSettings('microphone', process.platform, (url) =>
      shell.openExternal(url),
    );
    requireTrustedSender(event);
  });
  ipcMain.handle(
    'scholar:native:requestMicrophonePermission',
    async (event, input) => {
      requireTrustedSender(event);
      assertNativeAdmission();
      const { sessionId } = requestMicrophonePermissionSchema.parse(input);
      const user = await requireTrustedOnlineServiceUser(event);
      await requireActiveStudySession(event, user, sessionId);
      if (process.platform !== 'darwin') return { state: 'unsupported' };
      requireTrustedSender(event);
      const granted = await systemPreferences.askForMediaAccess('microphone');
      requireTrustedSender(event);
      await requireActiveStudySession(event, user, sessionId);
      if (!granted)
        await openSystemPermissionSettings(
          'microphone',
          process.platform,
          (url) => shell.openExternal(url),
        );
      return { state: granted ? 'granted' : 'denied' };
    },
  );
  ipcMain.handle(
    'scholar:native:requestNotificationPermission',
    async (event, input) => {
      requireTrustedSender(event);
      requestNotificationPermissionSchema.parse(input);
      assertNativeAdmission();
      const user = await requireTrustedOnlineServiceUser(event);
      if (!Notification.isSupported()) return { state: 'unsupported' };
      const window = requireTrustedSender(event);
      const decision = await window.webContents.executeJavaScript(
        'Notification.requestPermission()',
        true,
      );
      await requireSameTrustedOnlineServiceUser(event, user);
      assertNativeAdmission();
      const state =
        decision === 'granted' || decision === 'denied' ? decision : 'unknown';
      const owner = await bindNotificationUser({
        id: user.id,
        authMode: 'online',
      });
      await requireSameTrustedOnlineServiceUser(event, user);
      if (!owner?.context.isCurrent())
        throw new Error('Your session changed; sign in again.');
      await owner.host.setPermission(owner.context, state);
      // Chromium's permission result does not confirm the separate macOS alert setting.
      await openSystemPermissionSettings(
        'notifications',
        process.platform,
        (url) => shell.openExternal(url),
      );
      return { state };
    },
  );
};

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

if (
  !started &&
  !serviceMode &&
  !stopServiceMode &&
  !app.commandLine.hasSwitch('migrate-db')
) {
  // Better Auth's error bridge targets the globally focused WebContents.
  installTrustedFocusedWebContentsGuard(webContents);
  setupAuthMain({
    getWindow: getTrustedWindow,
    registerActivityScheme: registerActivitySchemeBeforeReady,
  });
  ipcMain.handle('better-auth:requestAuth', async (event) => {
    requireTrustedSender(event);
    await disposeNativeOwners();
    requireTrustedSender(event);
    const result = await authClient.requestAuth();
    requireTrustedSender(event);
    return result;
  });
  registerTrustedNativeIpc();
}

const createWindow = (routePath?: string) => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: 'ScholarOS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const rendererFile = path.join(
    __dirname,
    `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
  );
  const expectedDocument = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? MAIN_WINDOW_VITE_DEV_SERVER_URL
    : pathToFileURL(rendererFile).href;

  registerTrustedWindow(mainWindow, expectedDocument);
  protectWindowNavigation(mainWindow.webContents);
  let allowClose = false;
  let closing = false;
  mainWindow.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    closingActivityWindows.add(mainWindow);
    void disposeNativeOwners()
      .then(() => {
        allowClose = true;
        if (!mainWindow.isDestroyed()) mainWindow.close();
      })
      .catch(() => {
        closing = false;
        closingActivityWindows.delete(mainWindow);
        reportActivityTeardownFailure();
      });
  });
  mainWindow.once('closed', () => {
    closingActivityWindows.add(mainWindow);
    void disposeNativeOwners().catch(reportActivityTeardownFailure);
  });

  const updateNotificationFocus = () => {
    const owner = notificationOwner;
    if (owner?.context.isCurrent())
      void owner.host
        .setFocus(
          owner.context,
          getTrustedWindows().some((window) => window.isFocused()),
        )
        .catch(() => undefined);
  };
  mainWindow.webContents.on('did-finish-load', () => {
    const owner = notificationOwner;
    if (owner?.context.isCurrent())
      void owner.host
        .deliverDueNotifications(owner.context)
        .catch(() => undefined);
  });
  mainWindow.on('focus', updateNotificationFocus);
  mainWindow.on('blur', updateNotificationFocus);

  if (routePath) {
    const url = new URL(expectedDocument);
    url.hash = routePath;
    mainWindow.loadURL(url.href);
  } else if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(rendererFile);
  }

  // Keep developer tools out of the packaged consumer application.
  if (!app.isPackaged) mainWindow.webContents.openDevTools();
  return mainWindow;
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app
  .whenReady()
  .then(async () => {
    if (stopServiceMode) {
      await stopAcademicService();
      console.log('Academic service stopped safely.');
      app.quit();
      return;
    }
    if (serviceMode) {
      const { runAcademicService } =
        await import('./services/academic/runtime');
      const learningModules = await loadLearningActionModules();
      await runAcademicService({ learningModules });
      return;
    }

    if (app.commandLine.hasSwitch('migrate-db')) {
      await registerAcademicClient();
      await stopAcademicService();
      console.log('Local database migrations applied.');
      app.quit();
      return;
    }
    await registerAcademicClient({
      onIdentityChange: disposeNativeOwners,
      onAccountReady: async (user) => {
        await bindNotificationUser(user);
      },
      onServiceEvent: () => {
        const owner = notificationOwner;
        if (owner?.context.isCurrent())
          void owner.host
            .deliverDueNotifications(owner.context)
            .catch(() => undefined);
      },
      beforeSessionDelete: async (sessionId) => {
        if (dictationScope?.sessionId === sessionId)
          await disposeDictationHost();
        if (
          pendingActivitySessions.has(sessionId) ||
          [...activityScopes.values()].some(
            (scope) => scope.input.sessionId === sessionId,
          )
        )
          await disposeActivityManager();
      },
      beforeDisconnect: disposeNativeOwners,
      beforeLocalDataDelete: async () => {
        nativeAdmissionBlocks += 1;
        await disposeNativeOwners();
      },
      afterLocalDataDelete: async () => {
        nativeAdmissionBlocks = Math.max(0, nativeAdmissionBlocks - 1);
      },
    });
    createWindow();

    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  })
  .catch((error: unknown) => {
    console.error('Unable to start the academic service:', error);
    if (!serviceMode)
      dialog.showErrorBox(
        'ScholarOS could not start',
        error instanceof Error
          ? error.message
          : 'The academic service is unavailable.',
      );
    app.exit(1);
  });

let quitting = false;
let keepService = false;
app.on('before-quit', (event) => {
  if (serviceMode || stopServiceMode || quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    await disposeNativeOwners();
    if (keepService) await disconnectAcademicService();
    else await stopAcademicService();
    app.quit();
  })().catch(() => {
    quitting = false;
    reportActivityTeardownFailure();
  });
});

app.on('window-all-closed', () => {
  if (serviceMode || stopServiceMode || quitting) return;
  void disposeNativeOwners()
    .then(() => requestAcademicService('getState'))
    .then((state) => {
      const currentState = state as {
        settings?: { backgroundSync?: boolean };
        watch?: { enabled?: boolean };
      };
      keepService =
        currentState.settings?.backgroundSync === true ||
        currentState.watch?.enabled === true;
    })
    .catch(() => undefined)
    .finally(() => app.quit());
});
