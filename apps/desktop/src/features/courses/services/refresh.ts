import { accountRequest } from '../../../lib/auth/main';
import { composeAgentNotes } from '../../onboarding/lib/agent-notes';
import { isReadNavigation } from '../../onboarding/lib/browser-policy';
import { outcomeFromError } from '../../onboarding/lib/discovery-outcomes';
import { academicTasks } from '../../onboarding/services/academic-tasks';
import { getWorkspace } from '../../onboarding/services/browser-workspace';
import { scanConnection } from '../../onboarding/services/connection-scan';
import { createMissionNavigator } from '../../onboarding/services/mission-navigation';
import type { ResourceExtractionRequest } from '../../onboarding/services/browser-navigation';
import {
  applyAcademicDiscovery,
  getOnboardingState,
  type AcademicDiscoveryResult,
} from '../../onboarding/services/store';
import { pageHasMorePages } from '../lib/course-content';
import {
  resourceRequest,
  courseFieldsFromExtraction,
} from '../lib/resource-content';
import { validateResourceExtraction } from '@scholaros/services/ai/resources/validation';
import {
  applyCourseRefresh,
  applySingleCourseRefresh,
  getCourseRefreshTarget,
  getCourseDetail,
  getCoursesSnapshot,
} from './store';
import { scanCourseCollection } from '../lib/course-content-scan';
import {
  getNavigationLocations,
  saveNavigationLocation,
} from '../../context/services/navigation-store';
import { refreshCourseMaterials } from '../../context/services/material-refresh';
import {
  getExistingResourceIdentities,
  getNavigationContextForTask,
} from '../../context/services/read-actions';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';
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
  CourseDetail,
} from '../types';

type SourceContent = {
  courses: ObservedCourse[];
  incomplete: boolean;
  materialRefreshStatus: 'complete' | 'partial';
};

const getCourseMemory = (
  userId: string,
  connectionId: string,
  courseId: string,
  kind: 'assignments' | 'announcements',
): NonNullable<AgentRequestSchema['memory']> => {
  const identities = getExistingResourceIdentities({
    userId,
    connectionId,
    courseId,
    kind,
  });
  const navigation = getNavigationContextForTask({
    userId,
    connectionId,
    courseId,
    purpose: kind,
  });
  const serialized = navigation?.serialized ?? '';
  return {
    navigation: serialized.slice(0, 8000),
    resources: (identities ?? [])
      .sort((a, b) => Number(b.active) - Number(a.active))
      .slice(0, 40)
      .map(({ id, title, sourceId, url, active }) => ({
        id,
        title,
        sourceId,
        url,
        active,
      })),
    truncated:
      identities === null ||
      navigation === null ||
      !!navigation.truncated ||
      serialized.length > 8000 ||
      (identities?.length ?? 0) > 40,
  };
};

const requestWithNavigation = (
  context: CourseListContext,
  body: ResourceExtractionRequest,
  signal: AbortSignal,
) => {
  academicTasks.recordMetric(signal, 'modelCalls');
  return context.navigation
    ? context.navigation.extract(body)
    : accountRequest('/api/agent', body, signal);
};

const createScanMetricReporter = (signal: AbortSignal) => {
  let previousCandidates = 0;
  return (scan: CourseChildScan, final = false) => {
    const metrics = scan.metrics;
    if (!metrics) return;
    academicTasks.recordMetric(
      signal,
      'candidatesExtracted',
      Math.max(0, metrics.candidatesExtracted - previousCandidates),
    );
    previousCandidates = metrics.candidatesExtracted;
    if (scan.items.length) academicTasks.markFirstFinding(signal);
    if (!final) return;
    academicTasks.recordMetric(
      signal,
      'duplicatesReconciled',
      metrics.duplicatesReconciled,
    );
    academicTasks.recordMetric(
      signal,
      'ambiguousIdentityConflicts',
      metrics.ambiguousIdentityConflicts,
    );
    academicTasks.recordMetric(
      signal,
      'knownDestinationsReused',
      metrics.knownDestinationsReused,
    );
    academicTasks.recordMetric(
      signal,
      'navigationRepairs',
      metrics.navigationRepairs,
    );
  };
};

const recordStoreMetrics = (
  signal: AbortSignal,
  metrics: {
    recordsCreated: number;
    recordsUpdated: number;
    recordsRetired: number;
  },
) => {
  academicTasks.recordMetric(signal, 'recordsCreated', metrics.recordsCreated);
  academicTasks.recordMetric(signal, 'recordsUpdated', metrics.recordsUpdated);
  academicTasks.recordMetric(signal, 'recordsRetired', metrics.recordsRetired);
};

export type CourseRefreshResult = {
  state: OnboardingState;
  snapshot: CoursesSnapshot;
  attemptedConnectionIds: string[];
  materialRefreshStatus: 'complete' | 'partial';
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
  userId,
  connection,
  hosts,
  context,
  notes,
  isCurrent,
  signal,
  save,
}: {
  userId: string;
  connection: AcademicConnection;
  hosts: string[];
  context: CourseListContext;
  notes: string;
  isCurrent: () => boolean;
  signal: AbortSignal;
  save: (course: ObservedCourse) => void;
}): Promise<SourceContent> => {
  const listPage = context.observed;
  const wanted = context.entries.filter((entry) => entry.role === 'course');
  if (!listPage || !wanted.length)
    return {
      courses: [],
      incomplete: wanted.length > 0,
      materialRefreshStatus: wanted.length ? 'partial' : 'complete',
    };
  let materialRefreshStatus: 'complete' | 'partial' = 'complete';
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
    code: null,
    term: null,
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
  for (const course of courses) persist(course);
  const metadata = (async () => {
    for (const page of listPages) {
      const links = page.links.filter((link) =>
        courseEntries.some((entry) => entry.url === link.url),
      );
      for (let offset = 0; offset < links.length; offset += 30) {
        signal.throwIfAborted();
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        const body = resourceRequest({
          page: { ...page, links: links.slice(offset, offset + 30) },
          kind: 'courses',
          goal: 'Extract explicit course metadata for the offered enrolled course links.',
          notes: composeAgentNotes(connection.host, connection.notes, notes)
            .notes,
          host: connection.host,
          courseUrl: null,
          courseName: null,
        });
        try {
          const result = validateResourceExtraction(
            body,
            'courses',
            await requestWithNavigation(
              context,
              body as ResourceExtractionRequest,
              signal,
            ),
          );
          signal.throwIfAborted();
          if (!isCurrent())
            throw new Error('Your session changed; sign in again.');
          for (const content of result.courses) {
            const course = courses.find((course) => course.url === content.url);
            if (!course) continue;
            Object.assign(course, courseFieldsFromExtraction(content));
            persist(course);
          }
        } catch (error) {
          if (error === persistenceError || signal.aborted || !isCurrent())
            throw error;
        }
      }
    }
  })();
  const tasks = courses.flatMap((course) => {
    const origin = listPages.find((page) =>
      page.links.some((link) => link.url === course.url),
    )!;
    const collectionTasks = (['assignments', 'announcements'] as const).map(
      (kind) => () =>
        context
          .withCoursePage(course.url, async (courseContext) => {
            signal.throwIfAborted();
            if (!isCurrent())
              throw new Error('Your session changed; sign in again.');
            persist(course);
            const localCourse = getCoursesSnapshot(userId).courses.find(
              (item) =>
                item.connectionId === connection.id && item.url === course.url,
            );
            if (!localCourse)
              throw new Error('The course could not be saved locally.');
            const knownNavigationLocations =
              getNavigationLocations({
                userId,
                connectionId: connection.id,
                courseId: localCourse.id,
                purpose: kind,
              }) ?? [];
            const coursePage =
              courseContext.observed ??
              (await courseContext.openFrom(origin, course.url));
            if (kind === 'assignments') {
              const materialRefresh = await refreshCourseMaterials({
                userId,
                connectionId: connection.id,
                courseId: localCourse.id,
                courseUrl: course.url,
                courseName: course.name,
                host: connection.host,
                allowedHosts: hosts,
                notes: composeAgentNotes(
                  connection.host,
                  connection.notes,
                  notes,
                ).notes,
                from: coursePage,
                context: courseContext,
                runOnCoursePage: (run) =>
                  context.withCoursePage(course.url, async (freshContext) => {
                    const freshCoursePage =
                      freshContext.observed ??
                      (await freshContext.openFrom(origin, course.url));
                    await run({ ...freshContext, observed: freshCoursePage });
                  }),
                request: (body) => {
                  academicTasks.recordMetric(signal, 'modelCalls');
                  return accountRequest('/api/agent', body, signal);
                },
                signal,
                isCurrent,
              });
              if (materialRefresh.status === 'partial')
                materialRefreshStatus = 'partial';
              academicTasks.report(
                signal,
                `Read ${materialRefresh.materialsSaved} materials for ${course.name}`,
                materialRefresh.status === 'partial',
              );
            }
            course.overview = 'complete';
            academicTasks.report(signal, `Reading ${kind} for ${course.name}`);
            const reportMetrics = createScanMetricReporter(signal);
            const childScan = await scanCourseCollection({
              from: coursePage,
              kind,
              host: connection.host,
              identityScope: {
                accountId: userId,
                connectionId: connection.id,
                courseId: course.url,
              },
              knownNavigationLocations: knownNavigationLocations.map(
                ({ destinationUrl, destinationKind, status }) => ({
                  purpose: kind,
                  destinationUrl,
                  destinationKind,
                  status,
                }),
              ),
              memory: getCourseMemory(
                userId,
                connection.id,
                localCourse.id,
                kind,
              ),
              onNavigationVerified: (location) => {
                saveNavigationLocation(userId, connection.id, {
                  ...location,
                  courseId: localCourse.id,
                });
              },
              onModelCall: () =>
                academicTasks.recordMetric(signal, 'modelCalls'),
              onError: (message) => academicTasks.report(signal, message, true),
              allowedHosts: hosts,
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
              request: (body) =>
                requestWithNavigation(
                  courseContext,
                  body as ResourceExtractionRequest,
                  signal,
                ),
              onProgress: (scan) => {
                reportMetrics(scan);
                course[kind] = scan;
                academicTasks.report(
                  signal,
                  `Saved ${scan.items.length} ${kind} for ${course.name}`,
                );
                persist(course);
              },
            });
            reportMetrics(childScan, true);
            course[kind] = childScan;
            persist(course);
          })
          .catch((error) => {
            if (error === persistenceError || signal.aborted || !isCurrent())
              throw error;
            const failed = outcomeFromError(error);
            if (kind === 'assignments') materialRefreshStatus = 'partial';
            if (course.overview !== 'complete') course.overview = failed;
            course[kind] = { status: failed, items: [] };
            persist(course);
          }),
    );
    return collectionTasks;
  });
  let next = 0;
  const workers = await Promise.allSettled([
    metadata,
    ...Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (next < tasks.length) {
        signal.throwIfAborted();
        if (persistenceError) throw persistenceError;
        await tasks[next++]();
      }
    }),
  ]);
  const failed = workers.find((worker) => worker.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return {
    courses,
    incomplete: courseEntries.length !== wanted.length,
    materialRefreshStatus,
  };
};

const performCourseRefresh = async (
  userId: string,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
  connectionId?: string,
): Promise<CourseRefreshResult> => {
  const state = getOnboardingState(userId);
  if (!state.settings.consent)
    throw new Error('Approve academic access first.');
  if (!state.workspace?.ready)
    throw new Error('Set up and verify your study browser first.');
  const marked = state.connections.filter(
    (connection) =>
      connection.isCourseResource &&
      (!connectionId || connection.id === connectionId),
  );
  if (!marked.length)
    throw new Error(
      connectionId
        ? 'This course resource connection is no longer available.'
        : 'Choose which connections hold your courses first.',
    );
  const hosts = state.connections.map((connection) => connection.host);
  const signal = externalSignal ?? new AbortController().signal;
  const discoveryResults: AcademicDiscoveryResult[] = [];
  const scans: CourseSourceScan[] = [];
  const attemptedConnectionIds: string[] = [];
  let persisted = false;
  let materialRefreshStatus: 'complete' | 'partial' = 'complete';
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
      () => workspace.browser.context,
      hosts,
      signal,
      isCurrent,
      {
        scopeId: userId,
        onPageOpened: () => academicTasks.recordMetric(signal, 'pagesOpened'),
        onNavigate: (url) => {
          academicTasks.report(
            signal,
            `Opening ${new URL(url).hostname}${new URL(url).pathname}`,
          );
        },
        onWait: () =>
          academicTasks.report(signal, 'Waiting before the next page'),
      },
    );
    try {
      for (const connection of marked) {
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        signal.throwIfAborted();
        attemptedConnectionIds.push(connection.id);
        academicTasks.report(signal, `Finding courses on ${connection.name}`);
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
              userId,
              connection,
              hosts,
              context,
              notes: state.settings.notes,
              isCurrent,
              signal,
              save: (course) => {
                if (!isCurrent())
                  throw new Error('Your session changed; sign in again.');
                applyCourseRefresh(
                  userId,
                  [
                    {
                      connectionId: connection.id,
                      outcome: 'partial',
                      message: null,
                      courses: [course],
                    },
                  ],
                  {
                    onMetrics: (metrics) => recordStoreMetrics(signal, metrics),
                  },
                );
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
        if (!scan.followed || scan.followed.materialRefreshStatus === 'partial')
          materialRefreshStatus = 'partial';
        if (scan.message) academicTasks.report(signal, scan.message, true);
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
    if (
      scans.some(
        (scan) =>
          ['blocked', 'needs-sign-in'].includes(scan.outcome) ||
          scan.courses.some(
            (course) =>
              ['blocked', 'needs-sign-in'].includes(
                course.assignments.status,
              ) ||
              ['blocked', 'needs-sign-in'].includes(
                course.announcements.status,
              ),
          ),
      )
    )
      academicTasks.report(
        signal,
        'A source could not be accessed; check its connection and try again.',
        true,
      );
    const snapshot = applyCourseRefresh(userId, scans, {
      onMetrics: (metrics) => recordStoreMetrics(signal, metrics),
    });
    persisted = true;
    return {
      state: applyAcademicDiscovery(userId, discoveryResults),
      snapshot,
      attemptedConnectionIds,
      materialRefreshStatus,
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
      applyCourseRefresh(
        userId,
        [
          ...scans,
          ...unfinished.map((connection) => ({
            connectionId: connection.id,
            outcome: (cancelled ? 'cancelled' : 'blocked') as CourseScanStatus,
            message: null,
            courses: [],
          })),
        ],
        {
          onMetrics: (metrics) => recordStoreMetrics(signal, metrics),
        },
      );
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
    'courses',
  );

export const startConnectionRefresh = (
  userId: string,
  connectionId: string,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) =>
  academicTasks.run(
    userId,
    (taskSignal) =>
      performCourseRefresh(userId, isCurrent, taskSignal, connectionId),
    signal,
    `connection:${connectionId}`,
    { exclusive: true },
  );

export const cancelCourseRefresh = (userId?: string, courseId?: string) =>
  academicTasks.cancel(userId, courseId);

export const refreshSingleCourse = (
  userId: string,
  courseId: string,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
): Promise<
  (CourseDetail & { materialRefreshStatus: 'complete' | 'partial' }) | null
> =>
  academicTasks.run(
    userId,
    async (signal) => {
      const state = getOnboardingState(userId);
      if (!state.settings.consent)
        throw new Error('Approve academic access first.');
      if (!state.workspace?.ready)
        throw new Error('Set up and verify your study browser first.');
      const existingCourse = getCourseRefreshTarget(userId, courseId);
      const connection = state.connections.find(
        (item) =>
          item.id === existingCourse?.connectionId && item.isCourseResource,
      );
      if (
        !existingCourse ||
        !connection ||
        !isReadNavigation(existingCourse.url, [connection.host])
      )
        throw new Error('This course source is no longer available.');
      const hosts = state.connections.map((item) => item.host);
      const workspace = await getWorkspace(
        userId,
        () => isCurrent() && !signal.aborted,
      );
      const navigatePage = createMissionNavigator(
        () => workspace.browser.context,
        hosts,
        signal,
        isCurrent,
        {
          scopeId: userId,
          onPageOpened: () => academicTasks.recordMetric(signal, 'pagesOpened'),
          onNavigate: (url) => {
            academicTasks.report(
              signal,
              `Opening ${new URL(url).hostname}${new URL(url).pathname}`,
            );
          },
          onWait: () =>
            academicTasks.report(signal, 'Waiting before the next page'),
        },
      );
      const course: ObservedCourse = {
        ...existingCourse,
        overview: 'pending',
        assignments: pendingScan(),
        announcements: pendingScan(),
      };
      let persistenceError: unknown;
      let materialRefreshStatus: 'complete' | 'partial' = 'partial';
      const save = () => {
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        try {
          applySingleCourseRefresh(userId, courseId, course);
        } catch (error) {
          persistenceError = error;
          throw error;
        }
      };
      // Reuse one authenticated tab so collection scans cannot race through SSO.
      try {
        const scan = await scanConnection({
          connection,
          workspace,
          hosts,
          notes: state.settings.notes,
          navigatePage,
          isCurrent,
          signal,
          courseUrl: existingCourse.url,
          withCourseList: async (context) => {
            if (!context.observed)
              throw new Error('The course page could not be read.');
            course.overview = 'complete';
            const body = resourceRequest({
              page: context.observed,
              kind: 'courses',
              goal: 'Read explicit metadata for this course only.',
              notes: composeAgentNotes(
                connection.host,
                connection.notes,
                state.settings.notes,
              ).notes,
              host: connection.host,
              courseUrl: course.url,
              courseName: course.name,
            });
            try {
              const result = validateResourceExtraction(
                body,
                'courses',
                await requestWithNavigation(
                  context,
                  body as ResourceExtractionRequest,
                  signal,
                ),
              );
              signal.throwIfAborted();
              if (!isCurrent())
                throw new Error('Your session changed; sign in again.');
              const content = result.courses.find(
                (item) => item.url === course.url,
              );
              if (content)
                Object.assign(course, courseFieldsFromExtraction(content));
            } catch (error) {
              if (signal.aborted || !isCurrent()) throw error;
            }
            const materialRefresh = await refreshCourseMaterials({
              userId,
              connectionId: connection.id,
              courseId,
              courseUrl: course.url,
              courseName: course.name,
              host: connection.host,
              allowedHosts: hosts,
              notes: composeAgentNotes(
                connection.host,
                connection.notes,
                state.settings.notes,
              ).notes,
              from: context.observed,
              context,
              runOnCoursePage: (run) => context.withCoursePage(course.url, run),
              request: (request) => {
                academicTasks.recordMetric(signal, 'modelCalls');
                return accountRequest('/api/agent', request, signal);
              },
              signal,
              isCurrent,
            });
            materialRefreshStatus = materialRefresh.status;
            academicTasks.report(
              signal,
              `Read ${materialRefresh.materialsSaved} materials for ${course.name}`,
              materialRefreshStatus === 'partial',
            );
            for (const kind of ['assignments', 'announcements'] as const) {
              academicTasks.report(
                signal,
                `Reading ${kind} for ${course.name}`,
              );
              const reportMetrics = createScanMetricReporter(signal);
              const knownNavigationLocations =
                getNavigationLocations({
                  userId,
                  connectionId: connection.id,
                  courseId,
                  purpose: kind,
                }) ?? [];
              const childScan = await scanCourseCollection({
                from: context.observed,
                kind,
                onError: (message) =>
                  academicTasks.report(signal, message, true),
                host: connection.host,
                identityScope: {
                  accountId: userId,
                  connectionId: connection.id,
                  courseId,
                },
                knownNavigationLocations: knownNavigationLocations.map(
                  ({ destinationUrl, destinationKind, status }) => ({
                    purpose: kind,
                    destinationUrl,
                    destinationKind,
                    status,
                  }),
                ),
                memory: getCourseMemory(userId, connection.id, courseId, kind),
                onNavigationVerified: (location) => {
                  saveNavigationLocation(userId, connection.id, {
                    ...location,
                    courseId,
                  });
                },
                onModelCall: () =>
                  academicTasks.recordMetric(signal, 'modelCalls'),
                allowedHosts: hosts,
                courseName: course.name,
                excludedUrls: getCoursesSnapshot(userId)
                  .courses.filter((item) => item.id !== courseId)
                  .map((item) => item.url),
                notes: composeAgentNotes(
                  connection.host,
                  connection.notes,
                  state.settings.notes,
                ).notes,
                context,
                signal,
                isCurrent,
                request: (body) =>
                  requestWithNavigation(
                    context,
                    body as ResourceExtractionRequest,
                    signal,
                  ),
                onProgress: (progress) => {
                  reportMetrics(progress);
                  course[kind] = progress;
                  academicTasks.report(
                    signal,
                    `Saved ${progress.items.length} ${kind} for ${course.name}`,
                  );
                  save();
                },
              });
              reportMetrics(childScan, true);
              course[kind] = childScan;
              save();
            }
            return true;
          },
        });
        if (!scan.followed) {
          if (scan.outcome === 'needs-sign-in')
            academicTasks.reportSignInRequired(
              signal,
              scan.message ?? 'Sign in again.',
            );
          else if (scan.message)
            academicTasks.report(signal, scan.message, true);
          const status = outcomeFromError(
            new Error(
              scan.message ??
                (scan.outcome === 'needs-sign-in'
                  ? 'Sign in again.'
                  : 'The course page could not be read.'),
            ),
          );
          course.assignments = { status, items: [] };
          course.announcements = { status, items: [] };
          if (course.overview !== 'complete') course.overview = status;
        }
      } catch (error) {
        if (error === persistenceError || signal.aborted || !isCurrent())
          throw error;
        if (error instanceof Error)
          academicTasks.report(
            signal,
            error.message.split('\n')[0]!.slice(0, 300),
            true,
          );
        for (const kind of ['assignments', 'announcements'] as const) {
          if (course[kind].status === 'pending')
            course[kind] = { status: outcomeFromError(error), items: [] };
        }
      }
      if (
        ['blocked', 'needs-sign-in'].includes(course.assignments.status) ||
        ['blocked', 'needs-sign-in'].includes(course.announcements.status)
      )
        academicTasks.report(
          signal,
          'A source could not be accessed; check its connection and try again.',
          true,
        );
      save();
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      const detail = getCourseDetail(userId, courseId);
      return detail ? { ...detail, materialRefreshStatus } : null;
    },
    externalSignal,
    courseId,
  );
