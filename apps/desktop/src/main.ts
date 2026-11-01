import './lib/application-paths';
import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { mkdirSync } from 'node:fs';
import { authClient } from './lib/auth/client';
import { protectWindowNavigation } from './lib/window-navigation';
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
  if (!app.requestSingleInstanceLock()) app.exit(0);
  app.setPath('userData', userData);
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

if (!started && !serviceMode && !app.commandLine.hasSwitch('migrate-db')) {
  // Explicit flags retain plugin behavior when supplying a window resolver.
  authClient.setupMain({
    csp: true,
    scheme: true,
    bridges: true,
    getWindow: () =>
      BrowserWindow.getAllWindows()[0] ??
      (app.isReady() ? createWindow() : null),
  });
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

  protectWindowNavigation(mainWindow.webContents);

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
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
      keepService =
        (state as { settings?: { backgroundSync?: boolean } })?.settings
          ?.backgroundSync === true;
    })
    .catch(() => undefined)
    .finally(() => app.quit());
});
