import { app, dialog } from 'electron';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { BrowserId, BrowserInstallation } from '../types';

const execute = promisify(execFile);
type LocatedBrowser = BrowserInstallation & { executable: string };
const installations = new Map<string, LocatedBrowser>();
const describeBrowser = (
  file: string,
): { browser: BrowserId; name: string } | null => {
  if (/Google Chrome(?:\.app)?(?:[/\\]|$)|chrome(?:\.exe)?$/i.test(file))
    return { browser: 'chrome', name: 'Google Chrome' };
  if (/Microsoft Edge(?:\.app)?(?:[/\\]|$)|msedge(?:\.exe)?$/i.test(file))
    return { browser: 'edge', name: 'Microsoft Edge' };
  if (
    /Brave Browser(?:\.app)?(?:[/\\]|$)|brave(?:-browser)?(?:\.exe)?$/i.test(
      file,
    )
  )
    return { browser: 'brave', name: 'Brave' };
  return null;
};

const inspectBrowser = async (
  candidate: string,
): Promise<BrowserInstallation | null> => {
  try {
    const description = describeBrowser(candidate);
    if (!description) return null;
    let executable = candidate;
    if (candidate.endsWith('.app'))
      executable = path.join(
        candidate,
        'Contents/MacOS',
        path.basename(candidate, '.app'),
      );
    executable = await realpath(executable);
    await access(executable, constants.X_OK);
    const existingBrowser = [...installations.values()].find(
      (browser) => browser.executable === executable,
    );
    if (existingBrowser) {
      const { executable: _executable, ...view } = existingBrowser;
      return view;
    }
    let version = 'Installed';
    try {
      if (candidate.endsWith('.app')) {
        const plist = await readFile(
          path.join(candidate, 'Contents/Info.plist'),
          'utf8',
        );
        version =
          plist.match(
            /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
          )?.[1] ?? version;
      } else
        version = (
          await execute(executable, ['--version'], { timeout: 3000 })
        ).stdout
          .trim()
          .slice(0, 100);
    } catch {
      /* Compatibility is checked when the workspace launches. */
    }
    // The large icon size is unsupported on macOS and can crash Electron natively.
    const icon = await app
      .getFileIcon(candidate, {
        size: process.platform === 'darwin' ? 'normal' : 'large',
      })
      .then((image) => image.toDataURL())
      .catch(() => null);
    const id = randomUUID();
    installations.set(id, { id, ...description, version, icon, executable });
    return { id, ...description, version, icon };
  } catch {
    return null;
  }
};

export const findBrowsers = async (): Promise<BrowserInstallation[]> => {
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications', path.join(homedir(), 'Applications')].flatMap(
          (directory) =>
            [
              'Google Chrome.app',
              'Microsoft Edge.app',
              'Brave Browser.app',
            ].map((name) => path.join(directory, name)),
        )
      : process.platform === 'win32'
        ? [
            'C:\\Program Files',
            'C:\\Program Files (x86)',
            path.join(app.getPath('appData'), '..', 'Local'),
          ].flatMap((directory) =>
            [
              'Google/Chrome/Application/chrome.exe',
              'Microsoft/Edge/Application/msedge.exe',
              'BraveSoftware/Brave-Browser/Application/brave.exe',
            ].map((name) => path.join(directory, name)),
          )
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/microsoft-edge',
            '/usr/bin/brave-browser',
          ];
  const results = await Promise.all(candidates.map(inspectBrowser));
  return results.filter(
    (browser): browser is BrowserInstallation => browser !== null,
  );
};

export const chooseBrowser = async () => {
  const selection = await dialog.showOpenDialog({
    title: 'Choose Chrome, Edge, or Brave',
    properties: ['openFile'],
    filters:
      process.platform === 'darwin'
        ? [{ name: 'Browser application', extensions: ['app'] }]
        : process.platform === 'win32'
          ? [{ name: 'Browser application', extensions: ['exe'] }]
          : undefined,
  });
  if (selection.canceled || !selection.filePaths[0]) return null;
  const browser = await inspectBrowser(selection.filePaths[0]);
  if (!browser)
    throw new Error('Choose a supported Chrome, Edge, or Brave application.');
  return browser;
};

export const getBrowserInstallation = (id: string) => {
  const browser = installations.get(id);
  if (!browser)
    throw new Error('Refresh the browser list and select your browser again.');
  return browser;
};
