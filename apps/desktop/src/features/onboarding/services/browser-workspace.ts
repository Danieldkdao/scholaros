import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Stagehand, StagehandBrowser } from '@browserbasehq/stagehand';
import type { ClientLLM } from '@browserbasehq/stagehand';
import { requestIdSchema } from '@scholaros/services/learning/product-contracts';
import type { BrowserId } from '../types';
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

export type WorkspaceReplacementErrorCode =
  | 'provider-failed'
  | 'revision-conflict'
  | 'session-changed';

export type WorkspaceReplacementDTO = {
  operationId: string;
  state:
    | 'staged'
    | 'verifying'
    | 'ready'
    | 'committed'
    | 'cancelled'
    | 'failed'
    | 'needs-sign-in';
  browserId: string;
  errorCode: WorkspaceReplacementErrorCode | null;
  revision: number;
};

type WorkspaceReplacementRecord = WorkspaceReplacementDTO & {
  userId: string;
  requestId: string;
  browser: BrowserId;
  browserName: string;
  executable: string;
  previousWorkspace: typeof BrowserWorkspaceTable.$inferSelect | undefined;
  previousRuntime: ActiveWorkspace | null;
  candidate: ActiveWorkspace | null;
  candidateOwned: boolean;
  profileExisted: boolean;
  attempt: number | null;
};

const replacements = new Map<string, WorkspaceReplacementRecord>();
const replacementRequests = new Map<string, string>();
const replacementByAccount = new Map<string, string>();
const replacementTasks = new Map<string, Promise<WorkspaceReplacementDTO>>();

const tracker = createLaunchTracker();
let active: ActiveWorkspace | null = null;
let starting: Promise<ActiveWorkspace> | null = null;
let launchQueue: Promise<unknown> = Promise.resolve();
let missionStagehandQueue: Promise<unknown> = Promise.resolve();

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
const pendingStops = new Set<Promise<unknown>>();

// A close that reports failure is not a close that finished: the browser can
// still be alive holding the profile lock, so callers must stop what we own.
const settledWithin = async (task: Promise<unknown>, milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = task.then(
    () => true,
    () => false,
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

const closeEvery = (tasks: readonly unknown[]) =>
  Promise.allSettled(tasks).then((results) => {
    const failed = results.find((result) => result.status === 'rejected');
    if (failed && failed.status === 'rejected') throw failed.reason;
  });

const closeResources = (workspace: ActiveWorkspace) =>
  closeEvery([workspace.stagehand.close(), workspace.browser.close()]);

const stopWorkspace = (workspace: ActiveWorkspace) => {
  const task = closeResources(workspace);
  pendingStops.add(task);
  const forget = () => pendingStops.delete(task);
  void task.then(forget, forget);
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

const closeCandidateWorkspace = async (workspace: ActiveWorkspace) => {
  if (active === workspace) return;
  if (await settledWithin(stopWorkspace(workspace), closeBoundMs)) return;
  await stopOwnedBrowserProcesses(
    workspace.profileDirectory,
    workspace.executable,
  );
};

const closeStagedCandidates = async () => {
  const candidates = [...replacements.values()].filter(
    (replacement) =>
      replacement.state === 'ready' &&
      replacement.candidateOwned &&
      replacement.candidate,
  );
  await Promise.all(
    candidates.map(async (replacement) => {
      await closeCandidateWorkspace(replacement.candidate!);
      replacement.candidateOwned = false;
      replacement.state = 'cancelled';
      replacement.revision += 1;
      replacementByAccount.delete(replacement.userId);
    }),
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
  await Promise.all(
    [...replacementTasks.values()].map((task) => task.catch(() => undefined)),
  );
  await closeStagedCandidates();
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

type WorkspaceLaunchOptions = {
  directory?: string;
  preserveActive?: boolean;
  activate?: boolean;
  demoteConnectionsOnNewProfile?: boolean;
};

const launchWorkspace = async (
  userId: string,
  executable: string,
  attempt: number,
  options: WorkspaceLaunchOptions = {},
): Promise<ActiveWorkspace> => {
  if (!options.preserveActive) await closeActiveWorkspace();
  const directory = options.directory ?? profileDirectory(userId, executable);
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
    if (!profileExisted && options.demoteConnectionsOnNewProfile !== false)
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
    if (options.activate !== false) active = workspace;
    return workspace;
  } catch (error) {
    const closing = closeEvery([stagehand?.close(), browser?.close()]);
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

const replacementRequestKey = (userId: string, requestId: string) =>
  `${userId}:${requestId}`;

const toReplacementDto = (
  replacement: WorkspaceReplacementRecord,
): WorkspaceReplacementDTO => ({
  operationId: replacement.operationId,
  state: replacement.state,
  browserId: replacement.browserId,
  errorCode: replacement.errorCode,
  revision: replacement.revision,
});

const workspaceSelectionMatches = (
  left: typeof BrowserWorkspaceTable.$inferSelect | undefined,
  right: typeof BrowserWorkspaceTable.$inferSelect | undefined,
) =>
  left === undefined || right === undefined
    ? left === right
    : left.browser === right.browser &&
      left.browserName === right.browserName &&
      left.executable === right.executable &&
      left.verifiedAt === right.verifiedAt;

const getWorkspaceReplacement = (userId: string, operationId: string) => {
  const replacement = replacements.get(operationId);
  if (!replacement || replacement.userId !== userId)
    throw new Error('Browser replacement was not found.');
  return replacement;
};

const releaseWorkspaceReplacement = (
  replacement: WorkspaceReplacementRecord,
) => {
  if (replacementByAccount.get(replacement.userId) === replacement.operationId)
    replacementByAccount.delete(replacement.userId);
};

export const stageWorkspaceReplacement = (
  userId: string,
  input: { requestId: string; browserId: string },
  isCurrent: () => boolean = () => true,
): Promise<WorkspaceReplacementDTO> => {
  if (!requestIdSchema.safeParse(input.requestId).success)
    throw new Error('A valid UUID replacement request ID is required.');
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  const requestKey = replacementRequestKey(userId, input.requestId);
  const existingOperationId = replacementRequests.get(requestKey);
  if (existingOperationId) {
    const existingTask = replacementTasks.get(existingOperationId);
    if (existingTask) return existingTask;
    const existingReplacement = replacements.get(existingOperationId);
    if (existingReplacement)
      return Promise.resolve(toReplacementDto(existingReplacement));
  }
  if (replacementByAccount.has(userId))
    throw new Error('A browser replacement is already in progress.');

  const selected = getBrowserInstallation(input.browserId);
  const operationId = randomUUID();
  const replacement: WorkspaceReplacementRecord = {
    operationId,
    state: 'staged',
    browserId: input.browserId,
    errorCode: null,
    revision: 0,
    userId,
    requestId: input.requestId,
    browser: selected.browser,
    browserName: selected.name,
    executable: selected.executable,
    previousWorkspace: undefined,
    previousRuntime: null,
    candidate: null,
    candidateOwned: false,
    profileExisted: false,
    attempt: null,
  };
  replacements.set(operationId, replacement);
  replacementRequests.set(requestKey, operationId);
  replacementByAccount.set(userId, operationId);

  const staging = enqueue(async () => {
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    replacement.previousWorkspace = db
      .select()
      .from(BrowserWorkspaceTable)
      .where(eq(BrowserWorkspaceTable.userId, userId))
      .get();
    replacement.previousRuntime = active?.userId === userId ? active : null;
    replacement.profileExisted = existsSync(
      profileDirectory(userId, selected.executable),
    );
    replacement.state = 'verifying';
    replacement.revision = 1;

    const existingRuntime =
      replacement.previousRuntime?.executable === selected.executable
        ? replacement.previousRuntime
        : null;
    const candidate =
      existingRuntime ??
      (await launchWorkspace(
        userId,
        selected.executable,
        (replacement.attempt = tracker.begin()),
        {
          preserveActive: true,
          activate: false,
          demoteConnectionsOnNewProfile: false,
        },
      ));
    replacement.candidate = candidate;
    replacement.candidateOwned = !existingRuntime;
    await candidate.browser.context.pages();
    if (
      !isCurrent() ||
      (replacement.attempt !== null && !tracker.isCurrent(replacement.attempt))
    )
      throw new Error('Your session changed; sign in again.');
    if (
      candidate.browser.closed ||
      candidate.userId !== userId ||
      candidate.executable !== selected.executable ||
      (replacement.previousRuntime && active !== replacement.previousRuntime)
    )
      throw new Error('The selected study browser did not start.');

    replacement.state = 'ready';
    return toReplacementDto(replacement);
  });
  const task = staging.catch(async () => {
    if (replacement.candidateOwned && replacement.candidate)
      await closeCandidateWorkspace(replacement.candidate).catch(
        () => undefined,
      );
    replacement.candidate = null;
    replacement.candidateOwned = false;
    replacement.state = 'failed';
    replacement.errorCode = isCurrent() ? 'provider-failed' : 'session-changed';
    replacement.revision = Math.max(1, replacement.revision);
    releaseWorkspaceReplacement(replacement);
    return toReplacementDto(replacement);
  });
  replacementTasks.set(operationId, task);
  void task
    .finally(() => {
      if (replacementTasks.get(operationId) === task)
        replacementTasks.delete(operationId);
    })
    .catch(() => undefined);
  return task;
};

export const cancelWorkspaceReplacement = (
  userId: string,
  input: { operationId: string },
): Promise<WorkspaceReplacementDTO> =>
  enqueue(async () => {
    const replacement = getWorkspaceReplacement(userId, input.operationId);
    if (replacement.state !== 'ready') return toReplacementDto(replacement);
    if (replacement.candidateOwned && replacement.candidate)
      await closeCandidateWorkspace(replacement.candidate);
    replacement.candidate = null;
    replacement.candidateOwned = false;
    replacement.state = 'cancelled';
    replacement.revision += 1;
    releaseWorkspaceReplacement(replacement);
    return toReplacementDto(replacement);
  });

export const commitWorkspaceReplacement = (
  userId: string,
  input: { operationId: string; expectedRevision: number },
  isCurrent: () => boolean = () => true,
): Promise<WorkspaceReplacementDTO> =>
  enqueue(async () => {
    const replacement = getWorkspaceReplacement(userId, input.operationId);
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    if (
      replacement.state === 'committed' ||
      replacement.state === 'needs-sign-in' ||
      replacement.state === 'failed' ||
      replacement.state === 'cancelled'
    )
      return toReplacementDto(replacement);
    if (
      replacement.state !== 'ready' ||
      replacement.revision !== input.expectedRevision
    )
      throw new Error('The browser replacement changed; review it and retry.');
    const candidate = replacement.candidate;
    if (!candidate || candidate.browser.closed)
      throw new Error('The selected study browser is no longer ready.');
    try {
      await candidate.browser.context.pages();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      const currentWorkspace = db
        .select()
        .from(BrowserWorkspaceTable)
        .where(eq(BrowserWorkspaceTable.userId, userId))
        .get();
      if (
        !workspaceSelectionMatches(
          replacement.previousWorkspace,
          currentWorkspace,
        )
      )
        throw new Error(
          'The configured study browser changed; review it and retry.',
        );

      const needsSignIn =
        !replacement.previousWorkspace ||
        replacement.previousWorkspace.executable !== replacement.executable ||
        !replacement.profileExisted;
      if (active !== candidate) await closeActiveWorkspace();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');

      const verifiedAt = new Date().toISOString();
      db.transaction((tx) => {
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        const latestWorkspace = tx
          .select()
          .from(BrowserWorkspaceTable)
          .where(eq(BrowserWorkspaceTable.userId, userId))
          .get();
        if (
          !workspaceSelectionMatches(
            replacement.previousWorkspace,
            latestWorkspace,
          )
        )
          throw new Error(
            'The configured study browser changed; review it and retry.',
          );
        tx.insert(BrowserWorkspaceTable)
          .values({
            userId,
            browser: replacement.browser,
            browserName: replacement.browserName,
            executable: replacement.executable,
            verifiedAt,
          })
          .onConflictDoUpdate({
            target: BrowserWorkspaceTable.userId,
            set: {
              browser: replacement.browser,
              browserName: replacement.browserName,
              executable: replacement.executable,
              verifiedAt,
            },
          })
          .run();
        if (needsSignIn)
          tx.update(AcademicConnectionTable)
            .set({ status: 'needs-sign-in', verifiedAt: null })
            .where(eq(AcademicConnectionTable.userId, userId))
            .run();
      });

      active = candidate;
      replacement.candidateOwned = false;
      replacement.state = needsSignIn ? 'needs-sign-in' : 'committed';
      replacement.errorCode = null;
      replacement.revision += 1;
      releaseWorkspaceReplacement(replacement);
      return toReplacementDto(replacement);
    } catch (error) {
      if (replacement.candidateOwned && replacement.candidate)
        await closeCandidateWorkspace(replacement.candidate).catch(
          () => undefined,
        );
      replacement.candidate = null;
      replacement.candidateOwned = false;
      replacement.state = 'failed';
      replacement.errorCode = isCurrent()
        ? error instanceof Error && error.message.includes('changed')
          ? 'revision-conflict'
          : 'provider-failed'
        : 'session-changed';
      replacement.revision += 1;
      releaseWorkspaceReplacement(replacement);
      const previousRuntime = replacement.previousRuntime;
      if (
        isCurrent() &&
        replacement.previousWorkspace &&
        previousRuntime &&
        (active === null ||
          (active === previousRuntime && previousRuntime.browser.closed))
      ) {
        try {
          await launchWorkspace(
            userId,
            previousRuntime.executable,
            tracker.begin(),
            { preserveActive: true },
          );
        } catch {
          // Keep the saved configuration authoritative if runtime recovery fails.
        }
      }
      return toReplacementDto(replacement);
    }
  });

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

const runWithMissionStagehand = async <T>(
  workspace: ActiveWorkspace,
  options: { signal: AbortSignal; isCurrent: () => boolean },
  run: (stagehand: Stagehand) => Promise<T>,
) => {
  options.signal.throwIfAborted();
  if (active !== workspace || workspace.browser.closed || !options.isCurrent())
    throw new Error('Your study browser session changed.');
  const { Stagehand } = await import('@browserbasehq/stagehand');
  await workspace.stagehand.close();
  let missionStagehand: Stagehand | null = null;
  try {
    options.signal.throwIfAborted();
    const { createBrowserModel } = await import('./browser-model');
    missionStagehand = await Stagehand.create({
      browser: workspace.browser,
      model: { generate: createBrowserModel(options) as ClientLLM['generate'] },
      selfHeal: false,
      logging: { level: 'off' },
    });
    if (active !== workspace || !options.isCurrent())
      throw new Error('Your study browser session changed.');
    workspace.stagehand = missionStagehand;
    return await run(missionStagehand);
  } finally {
    await missionStagehand?.close().catch(() => undefined);
    if (active === workspace && !workspace.browser.closed) {
      workspace.stagehand = await Stagehand.create({
        browser: workspace.browser,
      });
    }
  }
};

export const withMissionStagehand = <T>(
  workspace: ActiveWorkspace,
  options: { signal: AbortSignal; isCurrent: () => boolean },
  run: (stagehand: Stagehand) => Promise<T>,
): Promise<T> => {
  const result = missionStagehandQueue.then(() =>
    runWithMissionStagehand(workspace, options, run),
  );
  missionStagehandQueue = result.catch(() => undefined);
  return result;
};

export const openStudyBrowser = async (
  userId: string,
  isCurrent: () => boolean = () => true,
) => {
  const workspace = await getWorkspace(userId, isCurrent);
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  await workspace.browser.context.setDomainPolicy(null);
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  const page = await workspace.browser.context.newPage('about:blank');
  if (!isCurrent()) {
    await page.close();
    throw new Error('Your session changed; sign in again.');
  }
  await workspace.browser.context.setActivePage(page);
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
