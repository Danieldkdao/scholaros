import { academicTasks } from './academic-tasks';
import { app, BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { authClient } from '../../../lib/auth/client';
import {
  accountRequest,
  getCurrentUser,
  markLocalSignOut,
} from '../../../lib/auth/main';
import {
  createSessionGuard,
  runSessionAction,
} from '../../../lib/session-guard';
import { tearDownSession } from '../../../lib/session-teardown';
import { db } from '../../../db';
import { AcademicConnectionTable, SettingTable } from '../../../db/schema';
import { academicResources } from '../constants';
import { previewPromptSchema, settingsUpdateSchema } from '../schemas';
import {
  getOnboardingState,
  removeAcademicConnection,
  saveOnboardingSettings,
  settleLocalSetup,
} from './store';
import { chooseBrowser, findBrowsers } from './browser-discovery';
import {
  closeWorkspace,
  createWorkspace,
  openAcademicPage,
  waitForWorkspaceStops,
} from './browser-workspace';
import { captureResource, confirmResource, setPrimaryLms } from './connections';
import {
  cancelPreview,
  getPreview,
  resetPreview,
  startPreview,
  subscribePreview,
} from './preview';
import { isAcademicUrl, isReadNavigation } from '../lib/browser-policy';
import { syncFailureMessage } from '../lib/discovery-outcomes';
import { applyLaunchAtLogin, getLaunchAtLoginState } from './preferences';
import { completeOnboarding } from './completion';
import { discoverAcademicContext } from './discovery';
import { createBackgroundSyncController } from './background-sync';
import type { LaunchAtLoginPreference, OnboardingState } from '../types';

const idSchema = z.string().min(1).max(300);
const sessionGuard = createSessionGuard();
let broadcastingPreview = false;
let boundAccountId: string | null = null;
let boundOnboardingComplete = false;

type IpcContext = { userId: string; isCurrent: () => boolean };

let backgroundSyncAccountId: string | null = null;
const backgroundSync = createBackgroundSyncController<OnboardingState>({
  runDiscovery: async (userId, isCurrent, signal) => {
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const user = await getCurrentUser();
    if (!isCurrent() || user?.id !== userId)
      throw new Error('Please sign in again to resume background sync.');
    return discoverAcademicContext(userId, isCurrent, signal);
  },
  syncFailure: (discovered) => syncFailureMessage(discovered.discovery),
  onChange: (syncState, discovered) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed())
        window.webContents.send('scholar:backgroundSyncChange', {
          accountId: backgroundSyncAccountId,
          state: syncState,
          discovery: discovered?.discovery ?? null,
        });
  },
});

const requireConsent = (userId: string) => {
  if (!getOnboardingState(userId).settings.consent)
    throw new Error('Approve academic access first.');
};

const prepareState = (
  state: OnboardingState,
  launchAtLogin?: LaunchAtLoginPreference,
  isCurrent: () => boolean = () => true,
) => {
  const settled = settleLocalSetup(state, {
    accountCompleted: boundOnboardingComplete,
  });
  backgroundSyncAccountId = settled.accountId;
  backgroundSync.configure({
    userId: settled.accountId,
    enabled:
      boundOnboardingComplete &&
      !!settled.settings.localSetupCompletedAt &&
      settled.settings.backgroundSync &&
      settled.settings.consent &&
      settled.workspace?.ready === true &&
      settled.connections.some(
        (connection) => connection.status !== 'needs-sign-in',
      ),
    isCurrent,
  });
  const backgroundState =
    (!boundOnboardingComplete || !settled.settings.localSetupCompletedAt) &&
    settled.settings.backgroundSync
      ? {
          status: 'waiting' as const,
          message: 'Background sync starts after setup.',
          lastSyncedAt: null,
        }
      : backgroundSync.getState();
  return {
    ...settled,
    preferences: {
      launchAtLogin:
        launchAtLogin ?? getLaunchAtLoginState(settled.settings.launchAtLogin),
      backgroundSync: {
        ...backgroundState,
        lastSyncedAt:
          backgroundState.lastSyncedAt ?? settled.discovery.discoveredAt,
      },
    },
  };
};

const cancelBrowserWork = async () => {
  academicTasks.cancel();
  await cancelPreview();
  await academicTasks.cancelAndWait();
};

// Foreground browser work owns the study browser, so scheduled sync waits for it
// and picks up again afterwards instead of staying paused for the session.
const withBrowserWorkStopped = async <TResult>(
  action: () => Promise<TResult>,
): Promise<TResult> => {
  const release = backgroundSync.suspend();
  try {
    await cancelBrowserWork();
    return await action();
  } finally {
    release();
  }
};

const stopBrowserWork = () => withBrowserWorkStopped(async () => undefined);

const registerQuitCleanup = () => {
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      sessionGuard.invalidate();
      backgroundSyncAccountId = null;
      backgroundSync.stop();
      resetPreview();
      academicTasks.cancel();
      await closeWorkspace();
      await waitForWorkspaceStops();
      app.quit();
    })();
  });
};

export const registerOnboardingIpc = () => {
  const handle = (
    method: string,
    action: (context: IpcContext, input: unknown) => unknown,
    options: { requiresUser?: boolean } = {},
  ) => {
    ipcMain.handle(`scholar:${method}`, async (event, input: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || event.senderFrame !== event.sender.mainFrame)
        throw new Error('Untrusted application frame.');
      if (options.requiresUser === false)
        return action({ userId: '', isCurrent: () => true }, input);
      return runSessionAction(sessionGuard, async (isCurrent) => {
        const user = await getCurrentUser();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        if (!user) throw new Error('Please sign in to ScholarOS.');
        boundAccountId = user.id;
        boundOnboardingComplete = user.hasCompletedOnboarding === true;
        return action({ userId: user.id, isCurrent }, input);
      });
    });
  };
  if (!broadcastingPreview) {
    broadcastingPreview = true;
    subscribePreview((state) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed())
          window.webContents.send('scholar:previewChange', state);
    });
  }
  handle(
    'getCurrentUser',
    () =>
      runSessionAction(sessionGuard, async (isCurrent) => {
        const user = await getCurrentUser();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        boundAccountId = user?.id ?? null;
        boundOnboardingComplete = user?.hasCompletedOnboarding === true;
        return user;
      }),
    { requiresUser: false },
  );
  handle(
    'signOut',
    async () => {
      boundAccountId = null;
      boundOnboardingComplete = false;
      markLocalSignOut();
      await tearDownSession({
        invalidateSession: sessionGuard.invalidate,
        stopMissions: () => {
          backgroundSyncAccountId = null;
          backgroundSync.stop();
          resetPreview();
          academicTasks.cancel();
        },
        // The electron client clears its stored cookie before the request.
        clearLocalSession: () =>
          authClient
            .signOut({
              fetchOptions: { signal: AbortSignal.timeout(1500) },
            })
            .catch(() => undefined)
            .then(() => undefined),
        closeBrowser: closeWorkspace,
      });
      applyLaunchAtLogin(false);
    },
    { requiresUser: false },
  );
  handle('getState', ({ userId, isCurrent }) => {
    const state = getOnboardingState(userId);
    const launchAtLogin = applyLaunchAtLogin(state.settings.launchAtLogin);
    return prepareState(state, launchAtLogin, isCurrent);
  });
  handle('saveSettings', async ({ userId, isCurrent }, input) => {
    const changes = settingsUpdateSchema.parse(input);
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const launchAtLogin =
      changes.launchAtLogin !== undefined
        ? applyLaunchAtLogin(changes.launchAtLogin)
        : undefined;
    if (changes.consent === false) {
      backgroundSync.stop();
      await cancelBrowserWork();
    } else if (
      changes.backgroundSync === false &&
      backgroundSync.getState().status === 'syncing'
    ) {
      backgroundSync.pause();
      await academicTasks.cancelAndWait();
    }
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return prepareState(
      saveOnboardingSettings(userId, changes),
      launchAtLogin,
      isCurrent,
    );
  });
  handle('findBrowsers', () => findBrowsers());
  handle('chooseBrowser', () => chooseBrowser());
  handle('createWorkspace', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const installationId = idSchema.parse(input);
    await withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      await createWorkspace(userId, installationId, isCurrent);
    });
    return prepareState(getOnboardingState(userId), undefined, isCurrent);
  });
  handle('openResource', ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const resource = academicResources.find(
      (item) => item.id === idSchema.parse(input),
    );
    if (!resource) throw new Error('Choose a listed resource.');
    return withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      await openAcademicPage(userId, resource.url, isCurrent);
    });
  });
  handle('captureResource', ({ userId, isCurrent }) => {
    requireConsent(userId);
    return withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      return captureResource(userId, isCurrent);
    });
  });
  handle('confirmResource', ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    return prepareState(
      confirmResource(userId, idSchema.parse(input)),
      undefined,
      isCurrent,
    );
  });
  handle('removeResource', async ({ userId, isCurrent }, input) => {
    const connectionId = idSchema.parse(input);
    const state = await withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      return removeAcademicConnection(userId, connectionId);
    });
    return prepareState(state, undefined, isCurrent);
  });
  handle('setPrimaryLms', ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    return prepareState(
      setPrimaryLms(userId, idSchema.parse(input)),
      undefined,
      isCurrent,
    );
  });
  handle('discoverContext', async ({ userId, isCurrent }) => {
    if (
      !boundOnboardingComplete ||
      !getOnboardingState(userId).settings.localSetupCompletedAt
    )
      throw new Error(
        'Course discovery is available from your dashboard after setup.',
      );
    requireConsent(userId);
    const state = await withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      return discoverAcademicContext(userId, isCurrent);
    });
    return prepareState(state, undefined, isCurrent);
  });
  handle('pauseBackgroundSync', async ({ userId, isCurrent }) => {
    const wasSyncing = backgroundSync.getState().status === 'syncing';
    backgroundSync.pause();
    if (wasSyncing) await academicTasks.cancelAndWait();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return prepareState(getOnboardingState(userId), undefined, isCurrent);
  });
  handle('resumeBackgroundSync', ({ userId, isCurrent }) => {
    backgroundSync.resume();
    return prepareState(getOnboardingState(userId), undefined, isCurrent);
  });
  handle('startPreview', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const prompt = previewPromptSchema.parse(input);
    const release = backgroundSync.suspend();
    try {
      await cancelBrowserWork();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      // Starting acknowledges immediately; cleanup releases the browser later.
      await startPreview(userId, prompt, release);
    } catch (cause) {
      release();
      throw cause;
    }
  });
  handle(
    'getPreview',
    (_context, input) => {
      const accountId = idSchema.parse(input);
      if (!boundAccountId || accountId !== boundAccountId)
        throw new Error('Your session changed; sign in again.');
      return getPreview(boundAccountId);
    },
    {
      requiresUser: false,
    },
  );
  handle(
    'cancelPreview',
    (_context, input) => cancelPreview(idSchema.optional().parse(input)),
    { requiresUser: false },
  );
  handle('openSource', async ({ userId, isCurrent }, input) => {
    requireConsent(userId);
    const url = idSchema.parse(input);
    if (!isAcademicUrl(url)) throw new Error('Invalid source.');
    const host = new URL(url).hostname;
    const existingConnection = db
      .select()
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.host, host),
        ),
      )
      .get();
    if (!existingConnection) throw new Error('Connect this resource first.');
    if (!isReadNavigation(url, [host]))
      throw new Error('This source is not a permitted read-only page.');
    return withBrowserWorkStopped(async () => {
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      await openAcademicPage(userId, url, isCurrent);
    });
  });
  handle('completeOnboarding', ({ userId, isCurrent }) =>
    completeOnboarding(userId, {
      getState: getOnboardingState,
      cancelPreview: stopBrowserWork,
      markLocalComplete: (id) => {
        db.update(SettingTable)
          .set({
            step: 'review',
            localSetupCompletedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(SettingTable.userId, id))
          .run();
      },
      updateCloud: () => accountRequest('/api/onboarding', {}),
      isCurrent,
    }),
  );
  registerQuitCleanup();
};
