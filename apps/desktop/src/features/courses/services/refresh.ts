import {
  collectionScanDiagnostic,
  safeScanDiagnostic,
} from '../../onboarding/lib/scan-diagnostics';
import { accountRequest } from '../../../lib/auth/main';
import { composeAgentNotes } from '../../onboarding/lib/agent-notes';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import { outcomeFromError } from '../../onboarding/lib/discovery-outcomes';
import {
  academicTasks,
  type AcademicTaskExecutionContext,
} from '../../onboarding/services/academic-tasks';
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

export type CourseRefreshCollectionOutcome = {
  connectionId: string;
  courseId: string | null;
  kind: 'courses' | 'assignments' | 'announcements' | 'materials';
  status: CourseScanStatus;
};

export type CourseRefreshExecutionReceipt = {
  runId: string;
  sessionEpoch: number;
  coveredRevisions: Readonly<Record<string, string>>;
  status: 'complete' | 'partial' | 'sign-in-required';
  collections: CourseRefreshCollectionOutcome[];
};

export type CourseRefreshExecution<TResult> = {
  result: TResult;
  receipt: CourseRefreshExecutionReceipt;
};

export type CourseRefreshExecutionScope = {
  sessionEpoch: number;
  coveredRevisions: Readonly<Record<string, string>>;
};

type CaptureRefreshScope = () => CourseRefreshExecutionScope;

type BrowserCapabilityChangedError = Error & {
  name: 'BrowserCapabilityChangedError';
};

const isBrowserCapabilityChangedError = (
  error: unknown,
): error is BrowserCapabilityChangedError =>
  error instanceof Error && error.name === 'BrowserCapabilityChangedError';

// Source/provider errors may contain private academic text or session details.
// Report only an allowlisted explanation, never the original message.
const refreshReadFailureMessage = (error: unknown) => {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : '';
  const diagnostic = safeScanDiagnostic(message);
  if (diagnostic) return diagnostic;
  if (
    /Cannot find (?:execution )?context|Execution context (?:was )?destroyed/i.test(
      message,
    )
  )
    return 'The study browser changed while reading this page. Retry the refresh.';
  if (/didn.t finish loading|did not finish loading/i.test(message))
    return 'The course page did not finish loading. Open it in your study browser, then retry.';
  if (/your school asked us to slow down/i.test(message))
    return 'Your school asked us to slow down. Wait briefly before refreshing again.';
  if (/the browser model request is unsupported/i.test(message))
    return 'Course reading could not start because the browser request was invalid. Update the app and retry.';
  if (/\b429\b|rate.?limit|quota|usage limit/i.test(message))
    return 'The AI provider usage limit was reached. Retry after the limit resets.';
  if (/timed? ?out|timeout/i.test(message))
    return 'Reading the course source timed out. Retry the refresh.';
  if (/provider credentials were rejected/i.test(message))
    return 'The AI provider credentials were rejected. Check the server Meta API configuration.';
  if (/sign in|password/i.test(message))
    return 'Sign in to this resource in your study browser, then refresh.';
  if (
    /unsupported.*(?:model|capabil)|model.*unavailable|configured model cannot/i.test(
      message,
    )
  )
    return 'Course reading is unavailable with the configured Meta model.';
  if (
    /no (?:object|output) generated|unreadable course data|invalid.*(?:response|schema)|(?:response|extraction).*(?:invalid|parse)/i.test(
      message,
    )
  )
    return 'The AI service returned unreadable course data. Retry the refresh.';
  if (
    /outside.*(?:scope|approved|connected academic resources)|navigation.*not allowed/i.test(
      message,
    )
  )
    return 'A page was outside the approved course access. Review the connection settings.';
  return 'Some course data could not be read.';
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
  status: CourseRefreshExecutionReceipt['status'];
};

const pendingScan = (): CourseChildScan => ({ status: 'pending', items: [] });

const createExecutionReceipt = (
  execution: AcademicTaskExecutionContext,
  collections: CourseRefreshCollectionOutcome[],
): CourseRefreshExecutionReceipt => ({
  ...execution,
  collections,
  status: collections.some(
    (collection) => collection.status === 'needs-sign-in',
  )
    ? 'sign-in-required'
    : collections.length > 0 &&
        collections.every((collection) => collection.status === 'complete')
      ? 'complete'
      : 'partial',
});

const collectionsFromFullSnapshot = (
  snapshot: CoursesSnapshot,
  attemptedConnectionIds: string[],
  scans: CourseSourceScan[],
  materialStatuses: Map<string, CourseScanStatus>,
  materialStatusesByConnection: Map<string, 'complete' | 'partial'>,
): CourseRefreshCollectionOutcome[] => {
  const attempted = new Set(attemptedConnectionIds);
  const collections: CourseRefreshCollectionOutcome[] = snapshot.sources
    .filter((source) => attempted.has(source.connectionId))
    .map((source) => ({
      connectionId: source.connectionId,
      courseId: null,
      kind: 'courses',
      status: source.outcome,
    }));
  for (const scan of scans)
    for (const observedCourse of scan.courses) {
      const course = snapshot.courses.find(
        (item) =>
          item.connectionId === scan.connectionId &&
          item.url === observedCourse.url,
      );
      if (!course) continue;
      if (observedCourse.assignments.status !== 'pending')
        collections.push({
          connectionId: scan.connectionId,
          courseId: course.id,
          kind: 'assignments',
          status: course.assignmentsStatus,
        });
      if (observedCourse.announcements.status !== 'pending')
        collections.push({
          connectionId: scan.connectionId,
          courseId: course.id,
          kind: 'announcements',
          status: course.announcementsStatus,
        });
      const materialStatus = materialStatuses.get(course.id);
      if (materialStatus)
        collections.push({
          connectionId: scan.connectionId,
          courseId: course.id,
          kind: 'materials',
          status: materialStatus,
        });
    }
  for (const [connectionId, status] of materialStatusesByConnection)
    if (
      status === 'partial' &&
      !collections.some(
        (collection) =>
          collection.connectionId === connectionId &&
          collection.kind === 'materials' &&
          collection.status !== 'complete',
      )
    )
      collections.push({
        connectionId,
        courseId: null,
        kind: 'materials',
        status: 'partial',
      });
  return collections;
};

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
  materialStatuses,
}: {
  userId: string;
  connection: AcademicConnection;
  hosts: string[];
  context: CourseListContext;
  notes: string;
  isCurrent: () => boolean;
  signal: AbortSignal;
  save: (course: ObservedCourse) => void;
  materialStatuses: Map<string, CourseScanStatus>;
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
          if (
            error === persistenceError ||
            signal.aborted ||
            !isCurrent() ||
            isBrowserCapabilityChangedError(error)
          )
            throw error;
          academicTasks.report(
            signal,
            `Course overview: ${refreshReadFailureMessage(error)}`,
            true,
          );
        }
      }
    }
  })();
  const tasks = courses.flatMap((course) => {
    const origin = listPages.find((page) =>
      page.links.some((link) => link.url === course.url),
    )!;
    const existingCourse = getCoursesSnapshot(userId).courses.find(
      (item) => item.connectionId === connection.id && item.url === course.url,
    );
    const locationScope = existingCourse
      ? { userId, courseId: existingCourse.id }
      : undefined;
    const collectionTasks = (['assignments', 'announcements'] as const).map(
      (kind) => () =>
        context
          .withCoursePage(
            course.url,
            async (courseContext) => {
              signal.throwIfAborted();
              if (!isCurrent())
                throw new Error('Your session changed; sign in again.');
              persist(course);
              if (!existingCourse)
                throw new Error('The course could not be saved locally.');
              const localCourse = existingCourse;
              materialStatuses.set(localCourse.id, 'partial');
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
                materialStatuses.set(
                  localCourse.id,
                  materialRefresh.status === 'complete'
                    ? 'complete'
                    : 'partial',
                );
                academicTasks.report(
                  signal,
                  `Read ${materialRefresh.materialsSaved} course materials`,
                  materialRefresh.status === 'partial',
                );
              }
              course.overview = 'complete';
              academicTasks.report(signal, `Reading ${kind}`);
              const reportMetrics = createScanMetricReporter(signal);
              const childScan = await scanCourseCollection({
                from: coursePage,
                kind,
                host: connection.host,
                identityScope: {
                  accountId: userId,
                  connectionId: connection.id,
                  courseId: localCourse.id,
                },
                knownNavigationLocations,
                memory: getCourseMemory(
                  userId,
                  connection.id,
                  localCourse.id,
                  kind,
                ),
                onNavigationVerified: (location) => {
                  const navigationIdentity = academicPageIdentity(
                    location.destinationUrl,
                  );
                  const existingNavigationLocation =
                    navigationIdentity &&
                    knownNavigationLocations.find(
                      (candidate) =>
                        candidate.userId === userId &&
                        candidate.connectionId === connection.id &&
                        candidate.courseId === localCourse.id &&
                        candidate.purpose === kind &&
                        candidate.status === 'verified' &&
                        candidate.destinationKind === 'collection' &&
                        !!candidate.parentUrl &&
                        candidate.parentUrl === candidate.evidence.sourceUrl &&
                        isReadNavigation(candidate.destinationUrl, [
                          connection.host,
                        ]) &&
                        academicPageIdentity(candidate.destinationUrl) ===
                          navigationIdentity,
                    );
                  if (existingNavigationLocation)
                    return existingNavigationLocation;
                  const observation = location.parentUrl
                    ? {
                        ...location,
                        evidence: {
                          ...location.evidence,
                          sourceUrl: location.parentUrl,
                          excerpts: location.label?.trim()
                            ? [location.label.trim()]
                            : [],
                        },
                      }
                    : location;
                  return saveNavigationLocation(userId, connection.id, {
                    ...observation,
                    courseId: localCourse.id,
                  });
                },
                onModelCall: () =>
                  academicTasks.recordMetric(signal, 'modelCalls'),
                onError: (message) =>
                  academicTasks.report(
                    signal,
                    refreshReadFailureMessage(message),
                    true,
                  ),
                allowedHosts: hosts,
                courseName: course.name,
                excludedUrls: [
                  ...listPages.map((page) => page.url),
                  ...courseEntries
                    .filter((entry) => entry.url !== course.url)
                    .map((entry) => entry.url),
                ],
                notes: composeAgentNotes(
                  connection.host,
                  connection.notes,
                  notes,
                ).notes,
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
                    `Saved ${scan.items.length} ${kind}`,
                  );
                  persist(course);
                },
              });
              reportMetrics(childScan, true);
              const diagnostic = collectionScanDiagnostic(childScan);
              if (diagnostic) academicTasks.report(signal, diagnostic, true);
              course[kind] = childScan;
              persist(course);
            },
            locationScope,
          )
          .catch((error) => {
            if (
              error === persistenceError ||
              signal.aborted ||
              !isCurrent() ||
              isBrowserCapabilityChangedError(error)
            )
              throw error;
            academicTasks.report(
              signal,
              `${kind === 'assignments' ? 'Assignments' : 'Announcements'}: ${refreshReadFailureMessage(error)}`,
              true,
            );
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
  execution: AcademicTaskExecutionContext,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
  connectionId?: string,
): Promise<CourseRefreshExecution<CourseRefreshResult>> => {
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
  const materialStatuses = new Map<string, CourseScanStatus>();
  const materialStatusesByConnection = new Map<
    string,
    'complete' | 'partial'
  >();
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
        renderingCacheOwner: workspace.browser,
        onPageOpened: () => academicTasks.recordMetric(signal, 'pagesOpened'),
        onNavigate: () =>
          academicTasks.report(signal, 'Opening a connected academic page'),
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
        academicTasks.report(signal, 'Checking a connected academic source');
        const scan = await scanConnection<SourceContent>({
          connection,
          workspace,
          hosts,
          notes: state.settings.notes,
          navigatePage,
          isCurrent,
          signal,
          maxPages: 4,
          withCourseList: (context) =>
            readCourseContent({
              userId,
              connection,
              hosts,
              context,
              notes: state.settings.notes,
              isCurrent,
              signal,
              materialStatuses,
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
        materialStatusesByConnection.set(
          connection.id,
          scan.followed?.materialRefreshStatus ?? 'partial',
        );
        if (!scan.followed || scan.followed.materialRefreshStatus === 'partial')
          materialRefreshStatus = 'partial';
        if (scan.outcome === 'needs-sign-in')
          academicTasks.reportSignInRequired(signal, 'Sign-in required.');
        if (
          scan.followed?.courses.some(
            (course) =>
              course.assignments.status === 'needs-sign-in' ||
              course.announcements.status === 'needs-sign-in',
          )
        )
          academicTasks.reportSignInRequired(signal, 'Sign-in required.');
        if (scan.message)
          academicTasks.report(
            signal,
            refreshReadFailureMessage(scan.message),
            true,
          );
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
    const receipt = createExecutionReceipt(
      execution,
      collectionsFromFullSnapshot(
        snapshot,
        attemptedConnectionIds,
        scans,
        materialStatuses,
        materialStatusesByConnection,
      ),
    );
    const result: CourseRefreshResult = {
      state: applyAcademicDiscovery(userId, discoveryResults),
      snapshot,
      attemptedConnectionIds,
      materialRefreshStatus,
      status: receipt.status,
    };
    if (receipt.status === 'sign-in-required')
      academicTasks.reportSignInRequired(signal, 'Sign-in required.');
    return { result, receipt };
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

const runCourseRefresh = (
  userId: string,
  isCurrent: () => boolean,
  signal: AbortSignal | undefined,
  connectionId: string | undefined,
  captureExecutionScope?: CaptureRefreshScope,
) =>
  academicTasks.run<CourseRefreshExecution<CourseRefreshResult>>(
    userId,
    (taskSignal, execution) =>
      performCourseRefresh(
        userId,
        execution,
        isCurrent,
        taskSignal,
        connectionId,
      ),
    signal,
    connectionId ? `connection:${connectionId}` : 'courses',
    {
      exclusive: connectionId ? true : undefined,
      captureExecutionScope,
      classifyOutcome: (execution) =>
        execution.receipt.status === 'complete' ? 'complete' : 'partial',
    },
  );

export const startCourseRefresh = (
  userId: string,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) =>
  runCourseRefresh(userId, isCurrent, signal, undefined).then(
    ({ result }) => result,
  );

export const startConnectionRefresh = (
  userId: string,
  connectionId: string,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) =>
  runCourseRefresh(userId, isCurrent, signal, connectionId).then(
    ({ result }) => result,
  );

export const startConnectionRefreshWithReceipt = (
  userId: string,
  connectionId: string,
  captureExecutionScope: CaptureRefreshScope,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) =>
  runCourseRefresh(
    userId,
    isCurrent,
    signal,
    connectionId,
    captureExecutionScope,
  );

export const cancelCourseRefresh = (userId?: string, courseId?: string) =>
  academicTasks.cancel(userId, courseId);

const runSingleCourseRefresh = (
  userId: string,
  courseId: string,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
  captureExecutionScope?: CaptureRefreshScope,
): Promise<
  CourseRefreshExecution<
    (CourseDetail & { materialRefreshStatus: 'complete' | 'partial' }) | null
  >
> =>
  academicTasks.run(
    userId,
    async (signal, execution) => {
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
          renderingCacheOwner: workspace.browser,
          onPageOpened: () => academicTasks.recordMetric(signal, 'pagesOpened'),
          onNavigate: () =>
            academicTasks.report(signal, 'Opening a connected academic page'),
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
          locationScope: { userId, courseId },
          withCourseList: async (context) => {
            if (!context.observed)
              throw new Error('The course page could not be read.');
            const coursePage = context.observed;
            course.overview = 'complete';
            const body = resourceRequest({
              page: coursePage,
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
              if (
                signal.aborted ||
                !isCurrent() ||
                isBrowserCapabilityChangedError(error)
              )
                throw error;
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
              from: coursePage,
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
              `Read ${materialRefresh.materialsSaved} course materials`,
              materialRefreshStatus === 'partial',
            );
            for (const kind of ['assignments', 'announcements'] as const) {
              academicTasks.report(signal, `Reading ${kind}`);
              const reportMetrics = createScanMetricReporter(signal);
              const knownNavigationLocations =
                getNavigationLocations({
                  userId,
                  connectionId: connection.id,
                  courseId,
                  purpose: kind,
                }) ?? [];
              let childScan!: CourseChildScan;
              await context.withCoursePage(
                course.url,
                async (purposeContext) => {
                  const from =
                    purposeContext.observed ??
                    (await purposeContext.openFrom(coursePage, course.url));
                  childScan = await scanCourseCollection({
                    from,
                    kind,
                    onError: (message) =>
                      academicTasks.report(
                        signal,
                        refreshReadFailureMessage(message),
                        true,
                      ),
                    host: connection.host,
                    identityScope: {
                      accountId: userId,
                      connectionId: connection.id,
                      courseId,
                    },
                    knownNavigationLocations,
                    memory: getCourseMemory(
                      userId,
                      connection.id,
                      courseId,
                      kind,
                    ),
                    onNavigationVerified: (location) => {
                      const navigationIdentity = academicPageIdentity(
                        location.destinationUrl,
                      );
                      const existingNavigationLocation =
                        navigationIdentity &&
                        knownNavigationLocations.find(
                          (candidate) =>
                            candidate.userId === userId &&
                            candidate.connectionId === connection.id &&
                            candidate.courseId === courseId &&
                            candidate.purpose === kind &&
                            candidate.status === 'verified' &&
                            candidate.destinationKind === 'collection' &&
                            !!candidate.parentUrl &&
                            candidate.parentUrl ===
                              candidate.evidence.sourceUrl &&
                            isReadNavigation(candidate.destinationUrl, [
                              connection.host,
                            ]) &&
                            academicPageIdentity(candidate.destinationUrl) ===
                              navigationIdentity,
                        );
                      if (existingNavigationLocation)
                        return existingNavigationLocation;
                      const observation = location.parentUrl
                        ? {
                            ...location,
                            evidence: {
                              ...location.evidence,
                              sourceUrl: location.parentUrl,
                              excerpts: location.label?.trim()
                                ? [location.label.trim()]
                                : [],
                            },
                          }
                        : location;
                      return saveNavigationLocation(userId, connection.id, {
                        ...observation,
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
                    context: purposeContext,
                    signal,
                    isCurrent,
                    request: (body) =>
                      requestWithNavigation(
                        purposeContext,
                        body as ResourceExtractionRequest,
                        signal,
                      ),
                    onProgress: (progress) => {
                      reportMetrics(progress);
                      course[kind] = progress;
                      academicTasks.report(
                        signal,
                        `Saved ${progress.items.length} ${kind}`,
                      );
                      save();
                    },
                  });
                },
              );
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
            academicTasks.report(
              signal,
              refreshReadFailureMessage(scan.message),
              true,
            );
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
        if (
          error === persistenceError ||
          signal.aborted ||
          !isCurrent() ||
          isBrowserCapabilityChangedError(error)
        )
          throw error;
        academicTasks.report(signal, refreshReadFailureMessage(error), true);
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
      if (
        course.assignments.status === 'needs-sign-in' ||
        course.announcements.status === 'needs-sign-in'
      )
        academicTasks.reportSignInRequired(signal, 'Sign-in required.');
      save();
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error('Your session changed; sign in again.');
      const detail = getCourseDetail(userId, courseId);
      const result = detail ? { ...detail, materialRefreshStatus } : null;
      const collections: CourseRefreshCollectionOutcome[] = detail
        ? [
            {
              connectionId: connection.id,
              courseId,
              kind: 'assignments',
              status: detail.assignmentsStatus,
            },
            {
              connectionId: connection.id,
              courseId,
              kind: 'announcements',
              status: detail.announcementsStatus,
            },
            {
              connectionId: connection.id,
              courseId,
              kind: 'materials',
              status: materialRefreshStatus,
            },
          ]
        : [];
      const receipt = createExecutionReceipt(execution, collections);
      if (receipt.status === 'sign-in-required')
        academicTasks.reportSignInRequired(signal, 'Sign-in required.');
      return { result, receipt };
    },
    externalSignal,
    courseId,
    {
      captureExecutionScope,
      classifyOutcome: (execution) =>
        execution.receipt.status === 'complete' ? 'complete' : 'partial',
    },
  );

export const refreshSingleCourse = (
  userId: string,
  courseId: string,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
): Promise<
  (CourseDetail & { materialRefreshStatus: 'complete' | 'partial' }) | null
> =>
  runSingleCourseRefresh(userId, courseId, isCurrent, externalSignal).then(
    ({ result }) => result,
  );

export const refreshSingleCourseWithReceipt = (
  userId: string,
  courseId: string,
  captureExecutionScope: CaptureRefreshScope,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
) =>
  runSingleCourseRefresh(
    userId,
    courseId,
    isCurrent,
    externalSignal,
    captureExecutionScope,
  );
