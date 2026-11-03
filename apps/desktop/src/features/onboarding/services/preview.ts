import { isReadNavigation } from '../lib/browser-policy';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
import { composeAgentNotes } from '../lib/agent-notes';
import { createMissionNavigator } from './mission-navigation';
import {
  protectMissionPage,
  type MissionProtection,
} from './mission-request-guard';
import { academicTasks } from './academic-tasks';
import type { Page, Stagehand } from '@browserbasehq/stagehand';
import type { BrowserNavigationMode } from '@scholaros/env/browser-navigation';
import { getWorkspace, withMissionStagehand } from './browser-workspace';
import { getOnboardingState } from './store';
import { resolveMissionEntry } from '../lib/mission-policy';
import { validatePreviewCards } from '../lib/preview-validation';
import { runReadOnlyMission } from './mission';
import { createBrowserNavigationAdapter } from './browser-navigation';
import type { ResourceExtractionRequest } from './browser-navigation';
import { getBrowserNavigationMode } from './browser-mode';
import { readPage, revealCourseNavigation } from './page-content';
import { waitForMissionPage } from './page-readiness';
import type { AgentActivity, PreviewPrompt, PreviewState } from '../types';

const emptyPreview = (accountId: string | null = null): PreviewState => ({
  accountId,
  status: 'idle',
  events: [],
  cards: [],
  message: null,
});

let preview: PreviewState = emptyPreview();
let controller: AbortController | null = null;
let owner: string | null = null;
let finishing: Promise<void> | null = null;
let activeRun = 0;
const listeners = new Set<(state: PreviewState) => void>();

const notify = () => {
  const snapshot: PreviewState = {
    ...preview,
    events: [...preview.events],
    cards: [...preview.cards],
  };
  for (const listener of listeners) listener(snapshot);
};

export const subscribePreview = (listener: (state: PreviewState) => void) => {
  listeners.add(listener);
  listener({
    ...preview,
    events: [...preview.events],
    cards: [...preview.cards],
  });
  return () => {
    listeners.delete(listener);
  };
};

const goalForPrompt = (prompt: PreviewPrompt) => {
  switch (prompt) {
    case 'courses':
      return 'Find the student’s current courses.';
    case 'assignments':
      return 'Find upcoming assignments and explicitly stated due dates.';
    case 'announcements':
      return 'Find recent announcements from the student’s courses.';
  }
};

export const getPreview = (userId: string): PreviewState =>
  owner === userId ? preview : emptyPreview(userId);

export const cancelPreview = async (userId?: string) => {
  if (userId && owner !== userId) return;
  if (preview.status === 'running') {
    preview.status = 'cancelled';
    preview.events.push({ type: 'cancelled' });
    notify();
  }
  controller?.abort();
  if (finishing)
    await Promise.race([
      finishing,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
};

export const resetPreview = () => {
  activeRun += 1;
  controller?.abort();
  preview = emptyPreview();
  controller = null;
  finishing = null;
  owner = null;
  notify();
};

const runPreview = async (
  userId: string,
  prompt: PreviewPrompt,
  signal: AbortSignal,
  run: number,
  browserMode?: BrowserNavigationMode,
  stagehand?: Stagehand,
): Promise<void> => {
  const isActive = () => activeRun === run;
  const addActivity = (event: AgentActivity) => {
    if (!isActive()) return;
    preview.events.push(event);
    notify();
  };
  if (!isActive()) return;
  const state = getOnboardingState(userId);
  if (!state.settings.consent)
    throw new Error('Review and approve academic access first.');
  const connections = state.connections.filter(
    (connection) => connection.status !== 'needs-sign-in',
  );
  const connection =
    connections.find((item) => item.id === state.primaryLms) ?? connections[0];
  if (!connection)
    throw new Error('Connect and verify an academic resource first.');
  const effectiveBrowserMode =
    browserMode ??
    (await getBrowserNavigationMode({ signal, isCurrent: isActive }));
  const composedNotes = composeAgentNotes(
    connection.host,
    connection.notes,
    state.settings.notes,
  );
  if (composedNotes.omitted)
    addActivity({
      type: 'checking',
      detail: 'Some general notes were omitted because they were too long.',
    });
  const hosts = connections.map((item) => item.host);
  const missionEntry = resolveMissionEntry(connection, hosts);
  if (missionEntry.kind === 'unsupported')
    throw new Error(missionEntry.message);
  const workspace = await getWorkspace(
    userId,
    () => isActive() && !signal.aborted,
  );
  if (effectiveBrowserMode === 'inout' && !stagehand)
    return withMissionStagehand(
      workspace,
      { signal, isCurrent: isActive },
      (missionStagehand) =>
        runPreview(
          userId,
          prompt,
          signal,
          run,
          effectiveBrowserMode,
          missionStagehand,
        ),
    );
  signal.throwIfAborted();
  const goal = goalForPrompt(prompt);
  await workspace.browser.context.setDomainPolicy({
    allowedDomains: hosts,
    blockedDomains: [],
  });
  const navigatePage = createMissionNavigator(
    () => workspace.browser.context,
    hosts,
    signal,
    () => isActive(),
    { scopeId: userId, onWait: () => addActivity({ type: 'waiting' }) },
  );
  let page: Page | null = null;
  let releaseProtection: MissionProtection | null = null;
  const closeMissionPage = () => {
    void page?.close().catch(() => undefined);
  };
  signal.addEventListener('abort', closeMissionPage, { once: true });
  try {
    // A dedicated mission tab avoids operating the student's sign-in tab.
    page = await workspace.browser.context.newPage();
    signal.throwIfAborted();
    releaseProtection = await protectMissionPage(page, workspace.cdpUrl, hosts);
    signal.throwIfAborted();
    const navigation = createBrowserNavigationAdapter(effectiveBrowserMode, {
      page,
      stagehand,
      hosts,
      signal,
      isCurrent: isActive,
      assertReadable: () => releaseProtection?.assertReadable?.(),
      onWait: () => addActivity({ type: 'waiting' }),
    });
    addActivity({ type: 'opening', detail: connection.name });
    const mission = await runReadOnlyMission({
      connection,
      hosts,
      page: {
        goto: (url) => navigatePage(page!, url),
        url: () => page!.url(),
      },
      read: () => readPage(page!),
      disclose: () => revealCourseNavigation(page!),
      waitForReady: (missionSignal) =>
        waitForMissionPage(page!, connection.kind, missionSignal, {
          assertReadable: () => releaseProtection?.assertReadable?.(),
        }),
      choose: async (pages, targets) => {
        releaseProtection?.assertReadable?.();
        return navigation.choose({
          goal,
          notes: composedNotes.notes,
          pages,
          targets,
        });
      },
      addActivity,
      signal,
    });
    signal.throwIfAborted();
    releaseProtection?.assertReadable?.();
    addActivity({ type: 'checking' });
    const links = mission.snapshots
      .flatMap((snapshot) => snapshot.links)
      .filter((link) => isReadNavigation(link.url, hosts));
    const request: AgentRequestSchema = {
      kind: prompt,
      goal,
      notes: composedNotes.notes,
      pages: mission.evidence,
      context: {
        retrievedAt:
          mission.evidence.at(-1)?.retrievedAt ?? new Date().toISOString(),
        observedTimezone: null,
        locale: mission.evidence.at(-1)?.locale ?? null,
        courseUrl: null,
        courseName: null,
        truncated: links.length > 80 || mission.outcome === 'budget',
      },
      targets: links.slice(0, 80).map((link, index) => ({
        id: String(index + 1),
        label: link.label.slice(0, 300),
        url: link.url,
      })),
    };
    const extracted = await navigation.extract(
      request as ResourceExtractionRequest,
    );
    signal.throwIfAborted();
    releaseProtection?.assertReadable?.();
    const cards = validatePreviewCards(extracted, request);
    if (!cards.length) {
      if (mission.outcome === 'empty')
        throw new Error(
          'No course information was found on this page. Sign in again or connect a course page, or skip for now.',
        );
      if (mission.outcome === 'budget')
        throw new Error(
          'The agent reached its page limit before finding matching information; try again or skip for now.',
        );
      if (mission.outcome === 'blocked')
        throw new Error(
          'The agent couldn’t find a safe next page; try another prompt or skip for now.',
        );
      throw new Error(
        'No matching information was verified; try another prompt or skip for now.',
      );
    }
    if (!isActive()) return;
    preview.cards = cards;
    preview.status = 'complete';
    preview.message =
      mission.outcome === 'budget'
        ? 'The agent reached its page limit; these results cover the pages it checked.'
        : null;
    notify();
    addActivity({ type: 'complete', detail: String(cards.length) });
  } catch (error) {
    if (!isActive() || preview.status === 'cancelled') return;
    releaseProtection?.assertReadable?.();
    throw error;
  } finally {
    signal.removeEventListener('abort', closeMissionPage);
    if (releaseProtection) await releaseProtection().catch(() => undefined);
    else if (page) await page.close().catch(() => undefined);
    await workspace.browser.context
      .setDomainPolicy(null)
      .catch(() => undefined);
  }
};

export const startPreview = async (
  userId: string,
  prompt: PreviewPrompt,
  onSettled?: () => void,
) => {
  if (finishing) throw new Error('A preview is already running.');
  const run = ++activeRun;
  owner = userId;
  preview = {
    accountId: userId,
    status: 'running',
    events: [],
    cards: [],
    message: null,
  };
  notify();
  controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(75_000),
  ]);
  finishing = academicTasks
    .run(
      userId,
      (taskSignal) => runPreview(userId, prompt, taskSignal, run),
      signal,
    )
    .catch((error: unknown) => {
      if (activeRun !== run || preview.status === 'cancelled') return;
      preview.status = 'blocked';
      preview.message =
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
          ? 'The preview took too long. Try again or skip for now.'
          : error instanceof Error
            ? error.message
            : 'The preview could not finish.';
      preview.events.push({ type: 'blocked' });
      notify();
    })
    .finally(() => {
      if (activeRun === run) {
        finishing = null;
        controller = null;
      }
      onSettled?.();
    });
};
