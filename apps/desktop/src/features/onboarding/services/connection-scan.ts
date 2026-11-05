import { scanDiagnosticMessages } from '../lib/scan-diagnostics';
import { openBackgroundPage } from './background-page';
import { composeAgentNotes } from '../lib/agent-notes';
import { exploreForCourses } from '../lib/course-exploration';
import {
  academicPageIdentity,
  isCourseNavigationTarget,
  isReadNavigation,
} from '../lib/browser-policy';
import { navigationLocationRowSchema } from '../../context/schemas';
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
import {
  downloadPdfFromObservedLink,
  type PdfDownloadResult,
} from '../../context/services/material-download';
import { waitForMissionPage } from './page-readiness';
import { missionTraffic } from './mission-traffic';
import {
  createAccountContinuation,
  type AccountContinuation,
} from './account-continuation';
import {
  protectMissionPage,
  type MissionProtection,
} from './mission-request-guard';
import type { Page, Stagehand } from '@browserbasehq/stagehand';
import type { BrowserNavigationMode } from '@scholaros/env/browser-navigation';
import { createBrowserNavigationAdapter } from './browser-navigation';
import type { BrowserNavigationAdapter } from './browser-navigation';
import { getBrowserNavigationMode } from './browser-mode';
import { withMissionStagehand } from './browser-workspace';
import type { AcademicContextEntryDraft, AcademicConnection } from '../types';
import type { ActiveWorkspace } from './browser-workspace';
import type { ConnectionOutcome } from '../lib/discovery-outcomes';
import type { ObservedPage } from '../lib/academic-discovery';
import type { NavigationLocationSelectData } from '../../../db/schema';

export type CourseListContext = {
  withCoursePage: (
    url: string,
    run: (context: CourseListContext) => Promise<void>,
    locationScope?: { userId: string; courseId: string },
  ) => Promise<void>;
  observed: ObservedPage | null;
  pages?: ObservedPage[];
  revealContent?: (from: ObservedPage) => Promise<ObservedPage | null>;
  entries: AcademicContextEntryDraft[];
  assertReadable: () => void;
  // Opens a destination a given observed page exposed, under the same guards.
  openFrom: (from: ObservedPage, url: string) => Promise<ObservedPage>;
  downloadPdf: (from: ObservedPage, url: string) => Promise<PdfDownloadResult>;
  navigation?: BrowserNavigationAdapter;
  readCurrent?: () => Promise<ObservedPage>;
  hasBlockedRequiredData?: () => boolean;
  visitKnownLocation?: (
    scopedRecord: NavigationLocationSelectData,
    target?: 'destination' | 'parent',
  ) => Promise<ObservedPage>;
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
type ScanConnectionInput<TFollowed> = {
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
  locationScope?: { userId: string; courseId: string };
  maxPages?: number;
  reserveModelCall?: () => boolean;
  withCourseList?: (context: CourseListContext) => Promise<TFollowed>;
  browserMode?: BrowserNavigationMode;
  stagehand?: Stagehand;
};

export const scanConnection = async <TFollowed = never>(
  input: ScanConnectionInput<TFollowed>,
): Promise<ConnectionScan<TFollowed>> => {
  const {
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
  } = input;
  const browserMode =
    input.browserMode ??
    (await getBrowserNavigationMode({ signal, isCurrent }));
  if (browserMode === 'inout' && !input.stagehand)
    return withMissionStagehand(workspace, { signal, isCurrent }, (stagehand) =>
      scanConnection({ ...input, browserMode, stagehand }),
    );
  const entry = resolveMissionEntry(connection, hosts);
  if (entry.kind === 'unsupported') return skipped('skipped');
  let page: Page | null = null;
  let releaseProtection: MissionProtection | null = null;
  const blockedHosts = new Set<string>();
  let sawSignInWall = false;
  let blockedRequiredData = false;
  let notesOmitted = false;
  let truncated = false;
  let following = false;
  const observedResourceRelationships = new Map<
    string,
    { parentUrl: string; targetUrl: string }
  >();
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
        else {
          blockedHosts.add(event.host);
          if ('requiredData' in event && event.requiredData === true)
            blockedRequiredData = true;
        }
      },
      continuation,
    );
    const navigation = createBrowserNavigationAdapter(browserMode, {
      page: openedPage,
      stagehand: input.stagehand,
      hosts,
      signal,
      isCurrent,
      assertReadable: () => releaseProtection?.assertReadable?.(),
      courseScope: courseUrl
        ? { courseUrl, observedResourceRelationships: [] }
        : null,
    });
    const updateCourseNavigationScope = (snapshot: ObservedPage) => {
      if (!courseUrl) return;
      const currentScope = {
        courseUrl,
        observedResourceRelationships: [
          ...observedResourceRelationships.values(),
        ],
      };
      if (!isCourseNavigationTarget(snapshot.url, currentScope, hosts)) return;
      const parentUrl = academicPageIdentity(snapshot.url) ?? snapshot.url;
      for (const link of snapshot.links) {
        if (!isReadNavigation(link.url, hosts)) continue;
        const targetUrl = academicPageIdentity(link.url) ?? link.url;
        observedResourceRelationships.set(`${parentUrl}\n${targetUrl}`, {
          parentUrl,
          targetUrl,
        });
      }
      navigation.setCourseScope({
        courseUrl,
        observedResourceRelationships: [
          ...observedResourceRelationships.values(),
        ],
      });
    };
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
      updateCourseNavigationScope(snapshot);
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
    const visitKnownLocation = async (
      inputLocation: NavigationLocationSelectData,
      target: 'destination' | 'parent' = 'destination',
    ): Promise<ObservedPage> => {
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      releaseProtection?.assertReadable?.();
      const parsedLocation =
        navigationLocationRowSchema.safeParse(inputLocation);
      const location = parsedLocation.success ? parsedLocation.data : null;
      if (
        !courseUrl ||
        !input.locationScope ||
        !location ||
        location.userId !== input.locationScope.userId ||
        location.connectionId !== connection.id ||
        location.courseId !== input.locationScope.courseId ||
        location.status !== 'verified' ||
        location.destinationKind !== 'collection' ||
        !location.parentUrl ||
        location.parentUrl !== location.evidence.sourceUrl
      ) {
        throw Object.assign(
          new Error('The saved destination is not verified for this course.'),
          { failureClass: 'wrong-course' as const },
        );
      }
      const targetUrl =
        target === 'parent' ? location.parentUrl : location.destinationUrl;
      const courseIdentity = academicPageIdentity(courseUrl);
      const targetIdentity = academicPageIdentity(targetUrl);
      if (
        !courseIdentity ||
        !targetIdentity ||
        (targetIdentity !== courseIdentity &&
          !targetIdentity.startsWith(`${courseIdentity}/`))
      )
        throw Object.assign(
          new Error('The saved destination is not inside the active course.'),
          { failureClass: 'wrong-course' as const },
        );
      if (!isReadNavigation(targetUrl, [connection.host]))
        throw Object.assign(
          new Error('The saved destination is not safe to open.'),
          { failureClass: 'unknown' as const },
        );
      assertMissionNavigation(targetUrl, hosts);
      await navigatePage(openedPage, targetUrl, continuation);
      const snapshot = await readSnapshot();
      if (
        (academicPageIdentity(snapshot.url) ?? snapshot.url) !==
        (academicPageIdentity(targetUrl) ?? targetUrl)
      )
        throw Object.assign(
          new Error('The saved destination changed during navigation.'),
          { failureClass: 'wrong-course' as const },
        );
      return snapshot;
    };
    const readCourseTarget = async () => {
      let snapshot = await readSnapshot();
      const target = academicPageIdentity(courseUrl!)!;
      const matches = (url: string) => {
        const identity = academicPageIdentity(url);
        return identity === target || identity?.startsWith(`${target}/`);
      };
      if (!matches(snapshot.url)) {
        // SSO can return to the LMS home instead of the originally requested course.
        await navigatePage(openedPage, courseUrl!, continuation);
        snapshot = await readSnapshot();
      }
      if (!matches(snapshot.url))
        throw new Error(
          'The requested course could not be verified after sign-in.',
        );
      return snapshot;
    };
    const exploration = courseUrl
      ? {
          status: 'courses' as const,
          entries: [],
          visited: [(await readCourseTarget()).url],
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
              const courseTargetIds = await navigation.discoverCourses({
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
              });
              signal.throwIfAborted();
              releaseProtection?.assertReadable?.();
              selectedUrls.push(
                ...targets
                  .filter((target) => courseTargetIds.includes(target.id))
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
    let courseListContext: CourseListContext;
    courseListContext = {
      withCoursePage: async (url, run, locationScope = input.locationScope) => {
        if (
          courseUrl &&
          (academicPageIdentity(url) ?? url) ===
            (academicPageIdentity(courseUrl) ?? courseUrl)
        ) {
          signal.throwIfAborted();
          if (!isCurrent())
            throw new Error('Your session changed; sign in again.');
          releaseProtection?.assertReadable?.();
          await continuation.resume(openedPage, signal, isCurrent);
          await navigatePage(openedPage, url, continuation);
          const courseRoot = await readSnapshot();
          if (
            (academicPageIdentity(courseRoot.url) ?? courseRoot.url) !==
            (academicPageIdentity(url) ?? url)
          )
            throw new Error('The selected course changed during refresh.');
          await run({
            ...courseListContext,
            observed: courseRoot,
            pages: observedPages,
          });
          return;
        }
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
          ...(locationScope ? { locationScope } : {}),
          browserMode,
          stagehand: input.stagehand,
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
      pages: observedPages,
      entries: exploration.entries,
      assertReadable: () => releaseProtection?.assertReadable?.(),
      hasBlockedRequiredData: () => blockedRequiredData,
      openFrom,
      visitKnownLocation,
      navigation,
      readCurrent: readSnapshot,
      downloadPdf: async (from, url) => {
        signal.throwIfAborted();
        releaseProtection?.assertReadable?.();
        const result = await downloadPdfFromObservedLink({
          page: openedPage,
          observedPage: from,
          targetUrl: url,
          allowedHosts: hosts,
          signal,
          beforeFetch: (targetUrl) =>
            missionTraffic.waitForTurn(targetUrl, signal),
        });
        signal.throwIfAborted();
        releaseProtection?.assertReadable?.();
        return result;
      },
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
          throw new Error('This content control could not be opened safely.');
        return outcome === 'opened' ? readSnapshot() : null;
      },
    };
    const followed = withCourseList
      ? await withCourseList(courseListContext)
      : null;
    return {
      outcome,
      entries: exploration.entries,
      observed: listPage,
      notesOmitted,
      followed,
      truncated,
      message:
        outcome === 'inconclusive'
          ? blockedRequiredData
            ? scanDiagnosticMessages.blockedRequiredData
            : !observedPages.some((snapshot) =>
                  snapshot.links.some((link) =>
                    isReadNavigation(link.url, [connection.host]),
                  ),
                )
              ? scanDiagnosticMessages.noCourseLinks
              : scanDiagnosticMessages.unrecognizedCourses
          : null,
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
      message:
        error instanceof Error
          ? error.message.split('\n')[0]!.slice(0, 300)
          : null,
    };
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    if (releaseProtection) await releaseProtection().catch(() => undefined);
    else if (page) await page.close().catch(() => undefined);
  }
};
