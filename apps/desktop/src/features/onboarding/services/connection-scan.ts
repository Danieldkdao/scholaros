import { openBackgroundPage } from './background-page';
import { composeAgentNotes } from '../lib/agent-notes';
import { courseDiscoverySchema } from '@scholaros/services/ai/schemas';
import { accountRequest } from '../../../lib/auth/main';
import { exploreForCourses } from '../lib/course-exploration';
import { isReadNavigation } from '../lib/browser-policy';
import {
  assertMissionNavigation,
  isStaleNavigation,
  resolveMissionEntry,
} from '../lib/mission-policy';
import {
  outcomeFromError,
  outcomeFromExploration,
} from '../lib/discovery-outcomes';
import { readPage, revealCourseNavigation } from './page-content';
import { waitForMissionPage } from './page-readiness';
import { missionTraffic } from './mission-traffic';
import {
  AccountContinuationError,
  createAccountContinuation,
  type AccountContinuation,
} from './account-continuation';
import {
  protectMissionPage,
  type MissionProtection,
} from './mission-request-guard';
import type { Page } from '@browserbasehq/stagehand';
import type { AcademicContextEntryDraft, AcademicConnection } from '../types';
import type { ActiveWorkspace } from './browser-workspace';
import type { ConnectionOutcome } from '../lib/discovery-outcomes';
import type { ObservedPage } from '../lib/academic-discovery';

export type CourseListContext = {
  withCoursePage: (
    url: string,
    run: (context: CourseListContext) => Promise<void>,
  ) => Promise<void>;
  observed: ObservedPage | null;
  pages?: ObservedPage[];
  revealContent?: (from: ObservedPage) => Promise<ObservedPage | null>;
  entries: AcademicContextEntryDraft[];
  assertReadable: () => void;
  // Opens a destination a given observed page exposed, under the same guards.
  openFrom: (from: ObservedPage, url: string) => Promise<ObservedPage>;
};

export type ConnectionScan<TFollowed = never> = {
  outcome: ConnectionOutcome;
  entries: AcademicContextEntryDraft[];
  observed: ObservedPage | null;
  notesOmitted: boolean;
  followed: TFollowed | null;
  truncated: boolean;
  message: string | null;
};

const skipped = <TFollowed>(
  outcome: ConnectionOutcome,
): ConnectionScan<TFollowed> => ({
  outcome,
  entries: [],
  observed: null,
  notesOmitted: false,
  followed: null,
  truncated: false,
  message: null,
});

// Keep discovery and course content inside the same protected browser walk.
export const scanConnection = async <TFollowed = never>({
  connection,
  workspace,
  hosts,
  notes,
  navigatePage,
  isCurrent,
  signal,
  maxPages,
  reserveModelCall,
  withCourseList,
  courseUrl,
}: {
  connection: AcademicConnection;
  workspace: ActiveWorkspace;
  hosts: string[];
  notes: string;
  navigatePage: (
    page: Page,
    url: string,
    continuation?: AccountContinuation,
  ) => Promise<void>;
  isCurrent: () => boolean;
  signal: AbortSignal;
  courseUrl?: string;
  maxPages?: number;
  reserveModelCall?: () => boolean;
  withCourseList?: (context: CourseListContext) => Promise<TFollowed>;
}): Promise<ConnectionScan<TFollowed>> => {
  const entry = resolveMissionEntry(connection, hosts);
  if (entry.kind === 'unsupported') return skipped('skipped');
  let page: Page | null = null;
  let releaseProtection: MissionProtection | null = null;
  const blockedHosts = new Set<string>();
  let sawSignInWall = false;
  let notesOmitted = false;
  let truncated = false;
  let following = false;
  const continuation = createAccountContinuation(
    connection.host,
    connection.notes,
    notes,
  );
  const closeOnAbort = () => {
    void page?.close().catch(() => undefined);
  };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    page = await openBackgroundPage(workspace, signal);
    signal.throwIfAborted();
    const openedPage = page;
    releaseProtection = await protectMissionPage(
      openedPage,
      workspace.cdpUrl,
      hosts,
      (event) => {
        if (
          event.signInWall &&
          event.resourceType === 'Document' &&
          event.mainFrame
        )
          sawSignInWall = true;
        else void blockedHosts.add(event.host);
      },
      continuation,
    );
    await navigatePage(openedPage, courseUrl ?? entry.url, continuation);
    let observed: ObservedPage | null = null;
    const observedPages: ObservedPage[] = [];
    const readSnapshot = async (): Promise<ObservedPage> => {
      await continuation.resume(openedPage, signal, isCurrent);
      await waitForMissionPage(openedPage, connection.kind, signal, {
        assertReadable: () => releaseProtection?.assertReadable?.(),
      });
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      await continuation.resume(openedPage, signal, isCurrent);
      // Schoology loads upcoming work after the course shell is readable.
      await openedPage
        .waitForLoadState('networkidle', 6000)
        .catch(() => undefined);
      signal.throwIfAborted();
      releaseProtection?.assertReadable?.();
      assertMissionNavigation(await openedPage.url(), hosts);
      const snapshot = await readPage(openedPage, true);
      if (snapshot.password)
        throw new Error('This resource needs you to sign in again.');
      if (snapshot.error) throw new Error('The page could not be loaded.');
      assertMissionNavigation(snapshot.url, hosts);
      observed = snapshot;
      observedPages.push(snapshot);
      return snapshot;
    };
    const assertObserved = async (url: string) => {
      const fresh = await readPage(openedPage, true);
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      const target = observed?.links.find((link) => link.url === url);
      if (
        !observed ||
        !target ||
        isStaleNavigation(observed.url, fresh, target)
      )
        throw new Error('The page changed; refresh your courses again.');
      assertMissionNavigation(url, hosts);
      await navigatePage(openedPage, url, continuation);
    };
    const openFrom = async (
      from: ObservedPage,
      url: string,
    ): Promise<ObservedPage> => {
      // A destination counts as observed only if the page we read exposed it.
      if (!from.links.some((link) => link.url === url))
        throw new Error('That link is no longer on the page.');
      releaseProtection?.assertReadable?.();
      assertMissionNavigation(url, hosts);
      await navigatePage(openedPage, url, continuation);
      return readSnapshot();
    };
    const exploration = courseUrl
      ? {
          status: 'courses' as const,
          entries: [],
          visited: [(await readSnapshot()).url],
          disclosed: false,
        }
      : await exploreForCourses({
          connection,
          classify: async (snapshot) => {
            releaseProtection?.assertReadable?.();
            const eligible = snapshot.links.filter((link) =>
              isReadNavigation(link.url, [connection.host]),
            );
            truncated ||= !!snapshot.linksTruncated;
            const selectedUrls: string[] = [];
            for (let offset = 0; offset < eligible.length; offset += 30) {
              const targets = eligible
                .slice(offset, offset + 30)
                .map((link, index) => ({
                  id: String(index + 1),
                  label: link.label,
                  url: link.url,
                  ...(link.context ? { context: link.context } : {}),
                }));
              if (!targets.length) return [];
              if (reserveModelCall && !reserveModelCall())
                throw new Error(
                  'The refresh reached its reading limit; refresh again to continue.',
                );
              const composedNotes = composeAgentNotes(
                connection.host,
                connection.notes,
                notes,
              );
              notesOmitted ||= composedNotes.omitted;
              const result = courseDiscoverySchema.parse(
                await accountRequest(
                  '/api/agent',
                  {
                    kind: 'discover',
                    goal: 'Find my current enrolled courses',
                    notes: composedNotes.notes,
                    pages: [
                      {
                        url: snapshot.url,
                        title: snapshot.title,
                        text: (snapshot.text ?? '').slice(0, 16000),
                      },
                    ],
                    targets,
                  },
                  signal,
                ),
              );
              signal.throwIfAborted();
              releaseProtection?.assertReadable?.();
              selectedUrls.push(
                ...targets
                  .filter((target) =>
                    result.courseTargetIds.includes(target.id),
                  )
                  .map((target) => target.url),
              );
            }
            return selectedUrls;
          },
          read: readSnapshot,
          navigate: assertObserved,
          disclose: () => revealCourseNavigation(openedPage),
          isCurrent,
          signal,
          maxPages,
        });
    // Reading course content moves the page on, so the list page is kept
    // separately: it is the evidence the course list and its bounds came from.
    const listPage = observed;
    const outcome = outcomeFromExploration(
      exploration.status,
      sawSignInWall,
      blockedHosts.size,
    );
    following = true;
    const followed = withCourseList
      ? await withCourseList({
          withCoursePage: async (url, run) => {
            if (
              !observedPages.some((snapshot) =>
                snapshot.links.some((link) => link.url === url),
              )
            )
              throw new Error('The course was not exposed by the course list.');
            const worker = await scanConnection({
              connection,
              workspace,
              hosts,
              notes,
              navigatePage,
              isCurrent,
              signal,
              courseUrl: url,
              withCourseList: async (context) => {
                await run(context);
                return true;
              },
            });
            if (!worker.followed)
              throw new Error(
                worker.message ?? 'The course page could not be read.',
              );
          },
          observed: listPage,
          pages: [...observedPages],
          entries: exploration.entries,
          assertReadable: () => releaseProtection?.assertReadable?.(),
          openFrom,
          revealContent: async (from) => {
            signal.throwIfAborted();
            releaseProtection?.assertReadable?.();
            if ((await openedPage.url()) !== from.url)
              await navigatePage(openedPage, from.url, continuation);
            await missionTraffic.waitForTurn(from.url, signal);
            if (!isCurrent())
              throw new Error('Your session changed; sign in again.');
            const outcome = await revealCourseNavigation(openedPage, 'content');
            if (outcome === 'refused')
              throw new Error(
                'This content control could not be opened safely.',
              );
            return outcome === 'opened' ? readSnapshot() : null;
          },
        })
      : null;
    return {
      outcome,
      entries: exploration.entries,
      observed: listPage,
      notesOmitted,
      followed,
      truncated,
      message: null,
    };
  } catch (error) {
    if (following || signal.aborted || !isCurrent()) throw error;
    return {
      outcome: sawSignInWall ? 'needs-sign-in' : outcomeFromError(error),
      entries: [],
      observed: null,
      notesOmitted,
      followed: null,
      truncated,
      message: error instanceof AccountContinuationError ? error.message : null,
    };
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    if (releaseProtection) await releaseProtection().catch(() => undefined);
    else if (page) await page.close().catch(() => undefined);
  }
};
