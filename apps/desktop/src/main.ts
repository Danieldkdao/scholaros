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
import { authClient } from './lib/auth/client';
import {
  getTrustedWindow,
  installTrustedFocusedWebContentsGuard,
  registerTrustedWindow,
  requireTrustedSender,
} from './lib/trusted-windows';
import { protectWindowNavigation } from './lib/window-navigation';
import {
  contextFileSelectionResultSchema,
  contextFileSelectionSchema,
  requestMicrophonePermissionSchema,
  requestNotificationPermissionSchema,
} from './services/academic/contracts';
import { sessionSnapshotSchema } from '@scholaros/services/learning/study-contracts';
import {
  registerAcademicClient,
  requestAcademicService,
  stopAcademicService,
  disconnectAcademicService,
} from './services/academic/client';

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

const requireActiveStudySession = async (sessionId: string) => {
  const snapshot = sessionSnapshotSchema.parse(
    await requestAcademicService('getStudySession', { sessionId }),
  );
  if (
    snapshot.session.id !== sessionId ||
    snapshot.session.status !== 'in-progress'
  )
    throw new Error('Open an active study session to use this feature.');
};

const registerTrustedNativeIpc = () => {
  ipcMain.handle('scholar:native:chooseContextFiles', async (event, input) => {
    const hostWindow = requireTrustedSender(event);
    const selection = contextFileSelectionSchema.parse(input);
    const user = await getOnlineServiceUser();
    const selected = await dialog.showOpenDialog(hostWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Choose study materials',
    });
    if (selected.canceled || selected.filePaths.length === 0)
      return { items: [], cancelled: true };
    if (selected.filePaths.length > 8)
      throw new Error('Choose no more than eight files.');
    const currentUser = await getOnlineServiceUser();
    if (currentUser.id !== user.id)
      throw new Error('Your session changed; sign in again.');
    const result = await requestAcademicService(
      'registerSelectedContextFiles',
      {
        ...selection,
        filePaths: selected.filePaths,
      },
    );
    return contextFileSelectionResultSchema.parse(result);
  });
  ipcMain.handle(
    'scholar:native:requestMicrophonePermission',
    async (event, input) => {
      requireTrustedSender(event);
      const { sessionId } = requestMicrophonePermissionSchema.parse(input);
      const user = await getOnlineServiceUser();
      await requireActiveStudySession(sessionId);
      if (process.platform !== 'darwin') return { state: 'unsupported' };
      const granted = await systemPreferences.askForMediaAccess('microphone');
      const currentUser = await getOnlineServiceUser();
      if (currentUser.id !== user.id)
        throw new Error('Your session changed; sign in again.');
      await requireActiveStudySession(sessionId);
      return { state: granted ? 'granted' : 'denied' };
    },
  );
  ipcMain.handle(
    'scholar:native:requestNotificationPermission',
    async (event, input) => {
      requireTrustedSender(event);
      requestNotificationPermissionSchema.parse(input);
      await getOnlineServiceUser();
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
  authClient.setupMain({
    csp: true,
    scheme: true,
    bridges: false,
    getWindow: getTrustedWindow,
  });
  ipcMain.handle('better-auth:requestAuth', (event) => {
    requireTrustedSender(event);
    return authClient.requestAuth();
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
      await runAcademicService();
      return;
    }

    if (app.commandLine.hasSwitch('migrate-db')) {
      await registerAcademicClient();
      await stopAcademicService();
      console.log('Local database migrations applied.');
      app.quit();
      return;
    }
    await registerAcademicClient();
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
    if (keepService) disconnectAcademicService();
    else await stopAcademicService();
  })()
    .catch(() => undefined)
    .finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (serviceMode || quitting) return;
  void requestAcademicService('getState')
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
