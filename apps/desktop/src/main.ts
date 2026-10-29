import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { authClient } from './lib/auth/client';
import { protectWindowNavigation } from './lib/window-navigation';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

if (!started && !app.commandLine.hasSwitch('migrate-db')) {
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
    await import('./db');

    if (app.commandLine.hasSwitch('migrate-db')) {
      console.log('Local database migrations applied.');
      app.quit();
      return;
    }
    const { registerOnboardingIpc } =
      await import('./features/onboarding/services/ipc');
    registerOnboardingIpc();
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
    console.error('Unable to initialize the local database:', error);
    app.exit(1);
  });

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
