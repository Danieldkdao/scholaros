import { accountRequest } from '../../../lib/auth/main';
import { composeAgentNotes } from '../../onboarding/lib/agent-notes';
import { isReadNavigation } from '../../onboarding/lib/browser-policy';
import { outcomeFromError } from '../../onboarding/lib/discovery-outcomes';
import { academicTasks } from '../../onboarding/services/academic-tasks';
import { getWorkspace } from '../../onboarding/services/browser-workspace';
import { scanConnection } from '../../onboarding/services/connection-scan';
import { createMissionNavigator } from '../../onboarding/services/mission-navigation';
import {
  applyAcademicDiscovery,
  getOnboardingState,
  type AcademicDiscoveryResult,
} from '../../onboarding/services/store';
import { courseFieldsFrom, pageHasMorePages } from '../lib/course-content';
import { applyCourseRefresh } from './store';
import { scanCourseCollection } from '../lib/course-content-scan';
import type { CourseListContext } from '../../onboarding/services/connection-scan';
import type { ConnectionOutcome } from '../../onboarding/lib/discovery-outcomes';
import type {
  AcademicConnection,
  OnboardingState,
} from '../../onboarding/types';
import type {
  CoursesSnapshot,
  CourseChildScan,
  CourseScanStatus,
  CourseSourceScan,
  ObservedCourse,
} from '../types';

type SourceContent = { courses: ObservedCourse[]; incomplete: boolean };

export type CourseRefreshResult = {
  state: OnboardingState;
  snapshot: CoursesSnapshot;
};

const pendingScan = (): CourseChildScan => ({ status: 'pending', items: [] });

const sourceStatusFrom = (
  outcome: ConnectionOutcome,
  listComplete: boolean,
): { outcome: CourseScanStatus; message: string | null } => {
  switch (outcome) {
    case 'courses':
    case 'empty':
      return {
        outcome: listComplete ? 'complete' : 'partial',
        message: listComplete ? null : 'Only part of the course list was read.',
      };
    case 'inconclusive':
      return {
        outcome: 'partial',
        message: 'No course list could be identified yet.',
      };
    case 'skipped':
    case 'blocked':
      return {
        outcome: 'blocked',
        message: 'ScholarOS could not read this resource safely.',
      };
    case 'needs-sign-in':
      return {
        outcome: 'needs-sign-in',
        message: 'Sign in in your study browser, then refresh your courses.',
      };
  }
};

const readCourseContent = async ({
  connection,
  context,
  notes,
  isCurrent,
  signal,
  save,
}: {
  connection: AcademicConnection;
  context: CourseListContext;
  notes: string;
  isCurrent: () => boolean;
  signal: AbortSignal;
  save: (course: ObservedCourse) => void;
}): Promise<SourceContent> => {
  const listPage = context.observed;
  const wanted = context.entries.filter((entry) => entry.role === 'course');
  if (!listPage || !wanted.length)
    return { courses: [], incomplete: wanted.length > 0 };
  const listPages = context.pages ?? [listPage];
  const exposed = new Set(
    listPages.flatMap((page) => page.links.map((link) => link.url)),
  );
  // A course is only catalogued from a link this page really exposed.
  const courseEntries = wanted.filter(
    (entry) =>
      exposed.has(entry.url) && isReadNavigation(entry.url, [connection.host]),
  );

  const courses: ObservedCourse[] = courseEntries.map((entry) => ({
    externalId: null,
    name: entry.label,
    ...courseFieldsFrom(entry.label),
    instructor: null,
    description: null,
    url: entry.url,
    overview: 'pending',
    announcements: pendingScan(),
    assignments: pendingScan(),
  }));
  let persistenceError: unknown;
  const persist = (course: ObservedCourse) => {
    try {
      save(course);
    } catch (error) {
      persistenceError = error;
      throw error;
    }
  };
  const workers = await Promise.allSettled(
    courses.flatMap((course) =>
      (['assignments', 'announcements'] as const).map((kind) =>
        context
          .withCoursePage(course.url, async (courseContext) => {
            signal.throwIfAborted();
            if (!isCurrent())
              throw new Error('Your session changed; sign in again.');
            const origin = listPages.find((page) =>
              page.links.some((link) => link.url === course.url),
            )!;
            const coursePage =
              courseContext.observed ??
              (await courseContext.openFrom(origin, course.url));
            course.overview = 'complete';
            course[kind] = await scanCourseCollection({
              from: coursePage,
              kind,
              host: connection.host,
              courseName: course.name,
              excludedUrls: [
                ...listPages.map((page) => page.url),
                ...courseEntries
                  .filter((entry) => entry.url !== course.url)
                  .map((entry) => entry.url),
              ],
              notes: composeAgentNotes(connection.host, connection.notes, notes)
                .notes,
              context: courseContext,
              signal,
              isCurrent,
              request: (body) => accountRequest('/api/agent', body, signal),
              onProgress: (scan) => {
                course[kind] = scan;
                persist(course);
              },
            });
            persist(course);
          })
          .catch((error) => {
            if (error === persistenceError || signal.aborted || !isCurrent())
              throw error;
            const failed = outcomeFromError(error);
            if (course.overview !== 'complete') course.overview = failed;
            course[kind] = { status: failed, items: [] };
            persist(course);
          }),
      ),
    ),
  );
  const failed = workers.find((worker) => worker.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return { courses, incomplete: courseEntries.length !== wanted.length };
};

const performCourseRefresh = async (
  userId: string,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
): Promise<CourseRefreshResult> => {
  const state = getOnboardingState(userId);
  if (!state.settings.consent)
    throw new Error('Approve academic access first.');
  if (!state.workspace?.ready)
    throw new Error('Set up and verify your study browser first.');
  const marked = state.connections.filter(
    (connection) => connection.isCourseResource,
  );
  if (!marked.length)
    throw new Error('Choose which connections hold your courses first.');
  const hosts = state.connections.map((connection) => connection.host);
  const signal = externalSignal ?? new AbortController().signal;
  const discoveryResults: AcademicDiscoveryResult[] = [];
  const scans: CourseSourceScan[] = [];
  let persisted = false;
  try {
    const workspace = await getWorkspace(
      userId,
      () => isCurrent() && !signal.aborted,
    );
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
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
      for (const connection of marked) {
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        signal.throwIfAborted();
        const scan = await scanConnection<SourceContent>({
          connection,
          workspace,
          hosts,
          notes: state.settings.notes,
          navigatePage,
          isCurrent,
          signal,
          maxPages: Infinity,
          withCourseList: (context) =>
            readCourseContent({
              connection,
              context,
              notes: state.settings.notes,
              isCurrent,
              signal,
              save: (course) => {
                if (!isCurrent())
                  throw new Error('Your session changed; sign in again.');
                applyCourseRefresh(userId, [
                  {
                    connectionId: connection.id,
                    outcome: 'partial',
                    message: null,
                    courses: [course],
                  },
                ]);
              },
            }),
        });
        signal.throwIfAborted();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        discoveryResults.push({
          connectionId: connection.id,
          outcome: scan.outcome,
          entries: scan.entries,
        });
        // Retirement needs a list we are sure is whole: no pagination, and no
        // course entry we had to refuse.
        const listComplete =
          !!scan.observed &&
          !scan.truncated &&
          !pageHasMorePages(scan.observed) &&
          !(scan.followed?.incomplete ?? false);
        scans.push({
          connectionId: connection.id,
          ...sourceStatusFrom(scan.outcome, listComplete),
          ...(scan.message ? { message: scan.message } : {}),
          courses: scan.followed?.courses ?? [],
        });
      }
    } finally {
      await workspace.browser.context
        .setDomainPolicy(null)
        .catch(() => undefined);
    }
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    const snapshot = applyCourseRefresh(userId, scans);
    persisted = true;
    return {
      state: applyAcademicDiscovery(userId, discoveryResults),
      snapshot,
    };
  } catch (error) {
    // A stopped or failed run still records the attempt, but nothing it could
    // not verify is retired or replaced.
    const cancelled = signal.aborted;
    if (isCurrent() && !persisted) {
      applyAcademicDiscovery(
        userId,
        discoveryResults.length
          ? discoveryResults
          : marked.map((connection) => ({
              connectionId: connection.id,
              outcome: 'blocked' as ConnectionOutcome,
              entries: [],
            })),
        { cancelled },
      );
      const unfinished = marked.filter(
        (connection) =>
          !scans.some((scan) => scan.connectionId === connection.id),
      );
      applyCourseRefresh(userId, [
        ...scans,
        ...unfinished.map((connection) => ({
          connectionId: connection.id,
          outcome: (cancelled ? 'cancelled' : 'blocked') as CourseScanStatus,
          message: null,
          courses: [],
        })),
      ]);
    }
    throw error;
  }
};

export const startCourseRefresh = (
  userId: string,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) =>
  academicTasks.run(
    userId,
    (taskSignal) => performCourseRefresh(userId, isCurrent, taskSignal),
    signal,
  );

export const cancelCourseRefresh = () => academicTasks.cancel();
