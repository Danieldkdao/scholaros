import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { eq } from 'drizzle-orm';
import type { Stagehand, StagehandBrowser } from '@browserbasehq/stagehand';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  BrowserWorkspaceTable,
} from '../../../db/schema';
import { getBrowserInstallation } from './browser-discovery';
import { stopOwnedBrowserProcesses } from './browser-process';
import { isAcademicUrl } from '../lib/browser-policy';
import { createLaunchTracker } from '../lib/launch-tracker';
import { profileDirectoryFor } from '../lib/profile-directory';

export type ActiveWorkspace = {
  userId: string;
  cdpUrl: string;
  executable: string;
  profileDirectory: string;
  stagehand: Stagehand;
  browser: StagehandBrowser;
};

const tracker = createLaunchTracker();
let active: ActiveWorkspace | null = null;
let starting: Promise<ActiveWorkspace> | null = null;
let launchQueue: Promise<unknown> = Promise.resolve();

const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
  const result = launchQueue.then(action, action);
  launchQueue = result.catch(() => undefined);
  return result;
};

const profileDirectory = (userId: string, executable: string) =>
  profileDirectoryFor(app.getPath('userData'), userId, executable);

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const closeBoundMs = 1500;
const pendingStops = new Set<Promise<void>>();

const settledWithin = async (task: Promise<unknown>, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = task.then(
    () => true,
    () => true,
  );
  const result = await Promise.race([
    settled,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), milliseconds);
    }),
  ]);
  clearTimeout(timer);
  return result;
};

const closeResources = (workspace: ActiveWorkspace) =>
  Promise.allSettled([
    workspace.stagehand.close(),
    workspace.browser.close(),
  ]).then(() => undefined);

const stopWorkspace = (workspace: ActiveWorkspace) => {
  const task = closeResources(workspace);
  pendingStops.add(task);
  void task.then(() => pendingStops.delete(task));
  return task;
};

const closeActiveWorkspace = async () => {
  const previous = active;
  active = null;
  if (!previous) return;
  // Never let an unresponsive extension block sign-out or browser switching.
  if (await settledWithin(stopWorkspace(previous), closeBoundMs)) return;
  await stopOwnedBrowserProcesses(
    previous.profileDirectory,
    previous.executable,
  );
};

export const waitForWorkspaceStops = async (milliseconds = 3000) => {
  if (!pendingStops.size) return;
  await Promise.race([Promise.allSettled(pendingStops), wait(milliseconds)]);
};

export const closeWorkspace = async () => {
  tracker.cancel();
  starting = null;
  await closeActiveWorkspace();
  // Any launch still in flight observes the cancelled tracker and closes itself.
};

const availablePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No study browser port available.'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const launchWorkspace = async (
  userId: string,
  executable: string,
  attempt: number,
): Promise<ActiveWorkspace> => {
  await closeActiveWorkspace();
  const directory = profileDirectory(userId, executable);
  const profileExisted = existsSync(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Disable password saving in the automation workspace; students sign in on the real sites.
  const preferencesPath = path.join(directory, 'Default', 'Preferences');
  await mkdir(path.dirname(preferencesPath), { recursive: true });
  const preferences = await readFile(preferencesPath, 'utf8')
    .then(JSON.parse)
    .catch(() => ({}));
  await writeFile(
    preferencesPath,
    JSON.stringify({
      ...preferences,
      credentials_enable_service: false,
      profile: { ...preferences.profile, password_manager_enabled: false },
    }),
    { mode: 0o600 },
  );
  let browser: StagehandBrowser | null = null;
  let stagehand: Stagehand | null = null;
  try {
    const { localBrowser, Stagehand } =
      await import('@browserbasehq/stagehand');
    if (!tracker.isCurrent(attempt))
      throw new Error('Study browser setup was cancelled.');
    const port = await availablePort();
    if (!tracker.isCurrent(attempt))
      throw new Error('Study browser setup was cancelled.');
    browser = await localBrowser.launch({
      port,
      executablePath: executable,
      userDataDir: directory,
      headless: false,
      keepAlive: false,
      // Missions read pages; they never write files to the student's machine.
      acceptDownloads: false,
    });
    if (!tracker.isCurrent(attempt))
      throw new Error('Study browser setup was cancelled.');
    stagehand = await Stagehand.create({ browser });
    if (!tracker.isCurrent(attempt))
      throw new Error('Study browser setup was cancelled.');
    if (!profileExisted)
      // A recreated profile holds no academic cookies, so past checks are void.
      db.update(AcademicConnectionTable)
        .set({ status: 'needs-sign-in', verifiedAt: null })
        .where(eq(AcademicConnectionTable.userId, userId))
        .run();
    const workspace: ActiveWorkspace = {
      userId,
      cdpUrl: `http://127.0.0.1:${port}`,
      executable,
      profileDirectory: directory,
      stagehand,
      browser,
    };
    active = workspace;
    return workspace;
  } catch (error) {
    const closing = Promise.allSettled([stagehand?.close(), browser?.close()]);
    if (!(await settledWithin(closing, closeBoundMs)))
      await stopOwnedBrowserProcesses(directory, executable);
    if (!tracker.isCurrent(attempt))
      throw new Error('Study browser setup was cancelled.');
    console.error('Study browser launch failed:', error);
    throw new Error(
      'The study browser could not start; try another browser or check your school’s browser restrictions.',
      { cause: error },
    );
  }
};

const startWorkspace = (
  userId: string,
  executable: string,
  isCurrent: () => boolean,
) => {
  const promise = enqueue(async () => {
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    if (
      active?.userId === userId &&
      active.executable === executable &&
      !active.browser.closed
    ) {
      try {
        await active.browser.context.pages();
        return active;
      } catch {
        await closeActiveWorkspace();
      }
    }
    const attempt = tracker.begin();
    return launchWorkspace(userId, executable, attempt);
  });
  starting = promise;
  void promise
    .finally(() => {
      if (starting === promise) starting = null;
    })
    .catch(() => undefined);
  return promise;
};

export const createWorkspace = async (
  userId: string,
  installationId: string,
  isCurrent: () => boolean = () => true,
) => {
  const selected = getBrowserInstallation(installationId);
  if (starting) throw new Error('Your study browser is already starting.');
  const previousWorkspace = db
    .select()
    .from(BrowserWorkspaceTable)
    .where(eq(BrowserWorkspaceTable.userId, userId))
    .get();
  const workspace = await startWorkspace(
    userId,
    selected.executable,
    isCurrent,
  );
  if (!isCurrent()) {
    await closeWorkspace();
    throw new Error('Your session changed; sign in again.');
  }
  if (
    workspace.userId !== userId ||
    workspace.executable !== selected.executable
  )
    throw new Error('The selected study browser did not start.');
  const verifiedAt = new Date().toISOString();
  db.transaction((tx) => {
    tx.insert(BrowserWorkspaceTable)
      .values({
        userId,
        browser: selected.browser,
        browserName: selected.name,
        executable: selected.executable,
        verifiedAt,
      })
      .onConflictDoUpdate({
        target: BrowserWorkspaceTable.userId,
        set: {
          browser: selected.browser,
          browserName: selected.name,
          executable: selected.executable,
          verifiedAt,
        },
      })
      .run();
    if (
      previousWorkspace?.executable &&
      previousWorkspace.executable !== selected.executable
    )
      // Each browser keeps its own cookie jar, so verification never carries over.
      tx.update(AcademicConnectionTable)
        .set({ status: 'needs-sign-in', verifiedAt: null })
        .where(eq(AcademicConnectionTable.userId, userId))
        .run();
  });
};

export const getWorkspace = async (
  userId: string,
  isCurrent: () => boolean = () => true,
): Promise<ActiveWorkspace> => {
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  if (starting) await starting.catch(() => undefined);
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  const existingWorkspace = db
    .select()
    .from(BrowserWorkspaceTable)
    .where(eq(BrowserWorkspaceTable.userId, userId))
    .get();
  if (!existingWorkspace) throw new Error('Choose a study browser first.');
  if (
    active?.userId === userId &&
    active.executable === existingWorkspace.executable &&
    !active.browser.closed
  ) {
    try {
      await active.browser.context.pages();
      return active;
    } catch {
      await closeActiveWorkspace();
    }
  }
  const started = await startWorkspace(
    userId,
    existingWorkspace.executable,
    isCurrent,
  );
  if (!existingWorkspace.verifiedAt)
    db.update(BrowserWorkspaceTable)
      .set({ verifiedAt: new Date().toISOString() })
      .where(eq(BrowserWorkspaceTable.userId, userId))
      .run();
  return started;
};

export const openAcademicPage = async (
  userId: string,
  url: string,
  isCurrent: () => boolean = () => true,
) => {
  if (!isAcademicUrl(url)) throw new Error('Choose a secure academic website.');
  const workspace = await getWorkspace(userId, isCurrent);
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  await workspace.browser.context.setDomainPolicy(null);
  const page = await workspace.browser.context.newPage();
  await workspace.browser.context.setActivePage(page);
  await page.goto(url, { timeout: 20_000 });
};

export const getAcademicPage = async (
  userId: string,
  isCurrent: () => boolean = () => true,
) => {
  const workspace = await getWorkspace(userId, isCurrent);
  const page = await workspace.browser.context.activePage();
  if (!page)
    throw new Error('Open your academic resource in the study browser first.');
  const url = await page.url();
  if (!isAcademicUrl(url))
    throw new Error('Open a secure academic website in the study browser.');
  return page;
};

// Read-only look at the tab the student is on. Unlike getAcademicPage this never
// starts the study browser, so previewing a connection cannot launch Chrome.
export const peekAcademicPage = async (userId: string) => {
  const workspace = active;
  if (!workspace || workspace.userId !== userId) return null;
  const page = await workspace.browser.context.activePage();
  if (!page) return null;
  return isAcademicUrl(await page.url()) ? page : null;
};
