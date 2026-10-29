import { createMissionNavigator } from './mission-navigation';
import { courseDiscoverySchema } from '@scholaros/services/ai/schemas';
import { accountRequest } from '../../../lib/auth/main';
import { isReadNavigation } from '../lib/browser-policy';
import type { Page } from '@browserbasehq/stagehand';
import { errorMessage } from '../../../lib/error-message';
import { exploreForCourses } from '../lib/course-exploration';
import { outcomeFromExploration } from '../lib/discovery-outcomes';
import { waitForMissionPage } from './page-readiness';
import {
  assertMissionNavigation,
  isStaleNavigation,
  resolveMissionEntry,
} from '../lib/mission-policy';
import { getWorkspace } from './browser-workspace';
import { academicTasks } from './academic-tasks';
import { readPage, revealCourseNavigation } from './page-content';
import {
  protectMissionPage,
  type MissionProtection,
} from './mission-request-guard';
import {
  applyAcademicDiscovery,
  getOnboardingState,
  markAcademicDiscoveryRunning,
  type AcademicDiscoveryResult,
} from './store';
import type { ConnectionOutcome } from '../lib/discovery-outcomes';
import type { OnboardingState } from '../types';

const discoveryTimeoutMs = 45_000;
const discoveryMaxPages = 4;

const outcomeFromError = (error: unknown): ConnectionOutcome =>
  /sign in|password/i.test(errorMessage(error, ''))
    ? 'needs-sign-in'
    : 'blocked';

const performAcademicDiscovery = async (
  userId: string,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
): Promise<OnboardingState> => {
  const state = getOnboardingState(userId);
  if (!state.settings.consent)
    throw new Error('Approve academic access first.');
  if (!state.workspace?.ready)
    throw new Error('Set up and verify your study browser first.');
  const connections = state.connections;
  if (!connections.length)
    throw new Error('Confirm a connected resource first.');
  const hosts = connections.map((connection) => connection.host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), discoveryTimeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  const results: AcademicDiscoveryResult[] = [];
  try {
    const workspace = await getWorkspace(
      userId,
      () => isCurrent() && !signal.aborted,
    );
    signal.throwIfAborted();
    markAcademicDiscoveryRunning(userId);
    await workspace.browser.context.setDomainPolicy({
      allowedDomains: hosts,
      blockedDomains: [],
    });
    const navigatePage = createMissionNavigator(
      workspace.browser.context,
      hosts,
      signal,
      isCurrent,
      { scopeId: userId },
    );
    try {
      for (const connection of connections) {
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        signal.throwIfAborted();
        if (connection.status === 'needs-sign-in') {
          results.push({
            connectionId: connection.id,
            outcome: 'needs-sign-in',
            entries: [],
          });
          continue;
        }
        const entry = resolveMissionEntry(connection, hosts);
        if (entry.kind === 'unsupported') {
          results.push({
            connectionId: connection.id,
            outcome: 'skipped',
            entries: [],
          });
          continue;
        }
        let page: Page | null = null;
        let releaseProtection: MissionProtection | null = null;
        const blockedHosts = new Set<string>();
        let sawSignInWall = false;
        const closeOnAbort = () => {
          void page?.close().catch(() => undefined);
        };
        signal.addEventListener('abort', closeOnAbort, { once: true });
        try {
          page = await workspace.browser.context.newPage();
          signal.throwIfAborted();
          releaseProtection = await protectMissionPage(
            page,
            workspace.cdpUrl,
            hosts,
            (event) => {
              if (event.signInWall) sawSignInWall = true;
              else void blockedHosts.add(event.host);
            },
          );
          await navigatePage(page, entry.url);
          let observed: Awaited<ReturnType<typeof readPage>> | null = null;
          const exploration = await exploreForCourses({
            connection,
            classify: async (snapshot) => {
              releaseProtection?.assertReadable?.();
              const targets = snapshot.links
                .filter((link) => isReadNavigation(link.url, [connection.host]))
                .slice(0, 80)
                .map((link, index) => ({
                  id: String(index + 1),
                  label: link.label,
                  url: link.url,
                  ...(link.context ? { context: link.context } : {}),
                }));
              if (!targets.length) return [];
              const result = courseDiscoverySchema.parse(
                await accountRequest(
                  '/api/agent',
                  {
                    kind: 'discover',
                    goal: 'Find my current enrolled courses',
                    notes: state.settings.notes,
                    pages: [
                      {
                        url: snapshot.url,
                        title: snapshot.title,
                        text: snapshot.text ?? '',
                      },
                    ],
                    targets,
                  },
                  signal,
                ),
              );
              signal.throwIfAborted();
              releaseProtection?.assertReadable?.();
              return targets
                .filter((target) => result.courseTargetIds.includes(target.id))
                .map((target) => target.url);
            },
            read: async () => {
              await waitForMissionPage(page!, connection.kind, signal, {
                assertReadable: () => releaseProtection?.assertReadable?.(),
              });
              signal.throwIfAborted();
              if (!isCurrent())
                throw new Error('Your session changed; sign in again.');
              assertMissionNavigation(await page!.url(), hosts);
              const snapshot = await readPage(page!);
              if (snapshot.password)
                throw new Error('This resource needs you to sign in again.');
              if (snapshot.error)
                throw new Error('The page could not be loaded.');
              assertMissionNavigation(snapshot.url, hosts);
              observed = snapshot;
              return snapshot;
            },
            navigate: async (url) => {
              const fresh = await readPage(page!);
              signal.throwIfAborted();
              if (!isCurrent())
                throw new Error('Your session changed; sign in again.');
              const target = observed?.links.find((link) => link.url === url);
              if (
                !observed ||
                !target ||
                isStaleNavigation(observed.url, fresh, target)
              )
                throw new Error(
                  'The page changed; refresh the course map again.',
                );
              assertMissionNavigation(url, hosts);
              await navigatePage(page!, url);
            },
            disclose: () => revealCourseNavigation(page!),
            isCurrent,
            signal,
            maxPages: discoveryMaxPages,
          });
          results.push({
            connectionId: connection.id,
            outcome: outcomeFromExploration(
              exploration.status,
              sawSignInWall,
              blockedHosts.size,
            ),
            entries: exploration.entries,
          });
        } catch (error) {
          if (signal.aborted || !isCurrent()) throw error;
          results.push({
            connectionId: connection.id,
            outcome: sawSignInWall ? 'needs-sign-in' : outcomeFromError(error),
            entries: [],
          });
        } finally {
          signal.removeEventListener('abort', closeOnAbort);
          if (releaseProtection)
            await releaseProtection().catch(() => undefined);
          else if (page) await page.close().catch(() => undefined);
        }
      }
    } finally {
      await workspace.browser.context
        .setDomainPolicy(null)
        .catch(() => undefined);
    }
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return applyAcademicDiscovery(userId, results);
  } catch (error) {
    // A stopped or failed run still records what could not be read.
    if (isCurrent())
      applyAcademicDiscovery(
        userId,
        results.length
          ? results
          : connections.map((connection) => ({
              connectionId: connection.id,
              outcome: 'blocked' as ConnectionOutcome,
              entries: [],
            })),
        { cancelled: signal.aborted },
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const discoverAcademicContext = (
  userId: string,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) =>
  academicTasks.run(
    userId,
    (taskSignal) => performAcademicDiscovery(userId, isCurrent, taskSignal),
    signal,
  );
