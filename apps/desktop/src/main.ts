import './lib/application-paths';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  systemPreferences,
  webContents,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
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
  ipcMain.handle('scholar:native:chooseContextFiles', async (event, input) => {
    const hostWindow = requireTrustedSender(event);
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
  ipcMain.handle(
    'scholar:native:requestMicrophonePermission',
    async (event, input) => {
      requireTrustedSender(event);
      const { sessionId } = requestMicrophonePermissionSchema.parse(input);
      const user = await requireTrustedOnlineServiceUser(event);
      await requireActiveStudySession(event, user, sessionId);
      if (process.platform !== 'darwin') return { state: 'unsupported' };
      requireTrustedSender(event);
      const granted = await systemPreferences.askForMediaAccess('microphone');
      requireTrustedSender(event);
      await requireActiveStudySession(event, user, sessionId);
      return { state: granted ? 'granted' : 'denied' };
    },
  );
  ipcMain.handle(
    'scholar:native:requestNotificationPermission',
    async (event, input) => {
      requireTrustedSender(event);
      requestNotificationPermissionSchema.parse(input);
      await requireTrustedOnlineServiceUser(event);
      return {
        state: Notification.isSupported() ? 'unknown' : 'unsupported',
      };
    },
  );
};

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

if (!started && !serviceMode && !app.commandLine.hasSwitch('migrate-db')) {
  // Better Auth's error bridge targets the globally focused WebContents.
  installTrustedFocusedWebContentsGuard(webContents);
  setupAuthMain({
    getWindow: getTrustedWindow,
    registerActivityScheme: registerActivitySchemeBeforeReady,
  });
  ipcMain.handle('better-auth:requestAuth', async (event) => {
    requireTrustedSender(event);
    await disposeActivityManager();
    requireTrustedSender(event);
    const result = await authClient.requestAuth();
    requireTrustedSender(event);
    return result;
  });
  registerTrustedNativeIpc();
}

const createWindow = () => {
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
    void disposeActivityManager()
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
    void disposeActivityManager().catch(reportActivityTeardownFailure);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
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
      onIdentityChange: disposeActivityManager,
      beforeSessionDelete: async (sessionId) => {
        if (
          pendingActivitySessions.has(sessionId) ||
          [...activityScopes.values()].some(
            (scope) => scope.input.sessionId === sessionId,
          )
        )
          await disposeActivityManager();
      },
      beforeDisconnect: disposeActivityManager,
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
  if (serviceMode || quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    await disposeActivityManager();
    if (keepService) await disconnectAcademicService();
    else await stopAcademicService();
    app.quit();
  })().catch(() => {
    quitting = false;
    reportActivityTeardownFailure();
  });
});

app.on('window-all-closed', () => {
  if (serviceMode || quitting) return;
  void disposeActivityManager()
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
