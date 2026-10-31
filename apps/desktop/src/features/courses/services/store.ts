import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseSourceTable,
  CourseTable,
} from '../../../db/schema';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import { courseScanSucceeded } from '../types';
import type {
  AcademicConnectionSelectData,
  CourseAnnouncementSelectData,
  CourseAssignmentSelectData,
} from '../../../db/schema';
import type {
  CourseChildScan,
  CourseDetail,
  CourseSourceScan,
  CourseSourceState,
  CourseSummary,
  ObservedCourse,
} from '../types';

type CourseChildTable =
  | typeof CourseAnnouncementTable
  | typeof CourseAssignmentTable;
type SavedChildRow = CourseAnnouncementSelectData | CourseAssignmentSelectData;
type CourseRow = ReturnType<typeof readCourseRows>[number];
// A drizzle transaction exposes the same query builders without $client.
type CourseWriter = Omit<typeof db, '$client'>;

const normalizeTitle = (value: string) =>
  value.replace(/\s+/g, ' ').trim().slice(0, 300);

// Identity is decided here once so a rescan of the same page finds the same row.
const courseKey = (
  connectionId: string,
  externalId: string | null,
  url: string,
) => `${connectionId} ${externalId ?? url}`;

// One list page carries many items, so the page plus its own wording is the only
// stable identity an extraction can offer.
const childKey = (url: string, title: string) =>
  `${url} ${title.toLowerCase()}`;

// A url the source did not really expose is dropped rather than stored, and it
// stops the scan from counting as complete enough to retire anything.
const observedUrl = (url: string, host: string) => {
  const identity = academicPageIdentity(url);
  return identity && isReadNavigation(identity, [host]) ? identity : null;
};

const courseColumns = {
  id: CourseTable.id,
  connectionId: CourseTable.connectionId,
  name: CourseTable.name,
  code: CourseTable.code,
  term: CourseTable.term,
  instructor: CourseTable.instructor,
  description: CourseTable.description,
  url: CourseTable.url,
  active: CourseTable.active,
  sourceName: CourseTable.sourceName,
  sourceHost: CourseTable.sourceHost,
  lastSeenAt: CourseTable.lastSeenAt,
  overviewSyncedAt: CourseTable.overviewSyncedAt,
  announcementsStatus: CourseTable.announcementsStatus,
  announcementsSyncedAt: CourseTable.announcementsSyncedAt,
  assignmentsStatus: CourseTable.assignmentsStatus,
  assignmentsSyncedAt: CourseTable.assignmentsSyncedAt,
  connected: AcademicConnectionTable.id,
  marked: AcademicConnectionTable.isCourseResource,
};

const readCourseRows = (userId: string) => {
  return db
    .select(courseColumns)
    .from(CourseTable)
    .leftJoin(
      AcademicConnectionTable,
      and(
        eq(AcademicConnectionTable.id, CourseTable.connectionId),
        eq(AcademicConnectionTable.userId, CourseTable.userId),
      ),
    )
    .where(eq(CourseTable.userId, userId))
    .orderBy(CourseTable.name)
    .all();
};

const sourceStateOf = (row: CourseRow): CourseSourceState => {
  if (!row.connectionId || !row.connected) return 'removed';
  return row.marked ? 'connected' : 'unmarked';
};

const toSummary = (
  row: CourseRow,
): Omit<CourseSummary, 'announcementCount' | 'assignmentCount'> => ({
  id: row.id,
  name: row.name,
  code: row.code,
  term: row.term,
  url: row.url,
  active: row.active,
  sourceName: row.sourceName,
  sourceHost: row.sourceHost,
  sourceState: sourceStateOf(row),
  lastSeenAt: row.lastSeenAt,
  overviewSyncedAt: row.overviewSyncedAt,
  announcementsStatus: row.announcementsStatus,
  announcementsSyncedAt: row.announcementsSyncedAt,
  assignmentsStatus: row.assignmentsStatus,
  assignmentsSyncedAt: row.assignmentsSyncedAt,
});

const toChild = ({
  userId: _userId,
  courseId: _courseId,
  sourceKey: _sourceKey,
  ...child
}: SavedChildRow) => child;

const uniqueAssignments = <TItem extends { title: string; url: string }>(
  assignments: TItem[],
  courseUrl: string,
) => {
  const coursePageUrl = courseUrl.split('#')[0];
  const assignmentTitles = new Set(
    assignments
      .filter((item) => item.url.split('#')[0] !== coursePageUrl)
      .map((item) => normalizeTitle(item.title).toLowerCase()),
  );
  return assignments.filter((item) => {
    if (item.url.split('#')[0] !== coursePageUrl) return true;
    const title = normalizeTitle(item.title).toLowerCase();
    if (assignmentTitles.has(title)) return false;
    assignmentTitles.add(title);
    return true;
  });
};

export const getCoursesSnapshot = (userId: string) => {
  const sources = db
    .select()
    .from(CourseSourceTable)
    .where(eq(CourseSourceTable.userId, userId))
    .all();
  const announcements = db
    .select({ courseId: CourseAnnouncementTable.courseId })
    .from(CourseAnnouncementTable)
    .where(
      and(
        eq(CourseAnnouncementTable.userId, userId),
        eq(CourseAnnouncementTable.active, true),
      ),
    )
    .all();
  const assignments = db
    .select({
      courseId: CourseAssignmentTable.courseId,
      title: CourseAssignmentTable.title,
      url: CourseAssignmentTable.url,
    })
    .from(CourseAssignmentTable)
    .where(
      and(
        eq(CourseAssignmentTable.userId, userId),
        eq(CourseAssignmentTable.active, true),
      ),
    )
    .all();
  return {
    courses: readCourseRows(userId).map((row) => ({
      ...toSummary(row),
      announcementCount: announcements.filter(
        (item) => item.courseId === row.id,
      ).length,
      assignmentCount: uniqueAssignments(
        assignments.filter((item) => item.courseId === row.id),
        row.url,
      ).length,
    })),
    sources: sources.map(({ userId: _userId, ...source }) => source),
    lastSuccessfulAt: sources.reduce<string | null>(
      (latest, source) =>
        source.lastSuccessfulAt && (!latest || source.lastSuccessfulAt > latest)
          ? source.lastSuccessfulAt
          : latest,
      null,
    ),
  };
};

export const getCourseDetail = (
  userId: string,
  courseId: string,
): CourseDetail | null => {
  const courseRow = readCourseRows(userId).find((row) => row.id === courseId);
  if (!courseRow) return null;
  const announcements = db
    .select()
    .from(CourseAnnouncementTable)
    .where(
      and(
        eq(CourseAnnouncementTable.userId, userId),
        eq(CourseAnnouncementTable.courseId, courseId),
        eq(CourseAnnouncementTable.active, true),
      ),
    )
    .all();
  const assignments = db
    .select()
    .from(CourseAssignmentTable)
    .where(
      and(
        eq(CourseAssignmentTable.userId, userId),
        eq(CourseAssignmentTable.courseId, courseId),
        eq(CourseAssignmentTable.active, true),
      ),
    )
    .all();
  const visibleAssignments = uniqueAssignments(assignments, courseRow.url);
  return {
    ...toSummary(courseRow),
    announcementCount: announcements.length,
    assignmentCount: visibleAssignments.length,
    instructor: courseRow.instructor,
    description: courseRow.description,
    announcements: announcements.map(toChild),
    assignments: visibleAssignments.map(toChild),
  };
};

// A removed connection keeps its saved courses; only the link and the refresh
// coverage for that source go away.
export const detachCourseSource = (userId: string, connectionId: string) => {
  db.transaction((tx) => {
    tx.update(CourseTable)
      .set({ connectionId: null })
      .where(
        and(
          eq(CourseTable.userId, userId),
          eq(CourseTable.connectionId, connectionId),
        ),
      )
      .run();
    tx.delete(CourseSourceTable)
      .where(
        and(
          eq(CourseSourceTable.userId, userId),
          eq(CourseSourceTable.connectionId, connectionId),
        ),
      )
      .run();
  });
};

const applyChildren = (
  tx: CourseWriter,
  table: CourseChildTable,
  userId: string,
  courseId: string,
  host: string,
  scan: CourseChildScan,
  now: string,
) => {
  // 'pending' means this run never looked, so nothing may be replaced.
  if (scan.status === 'pending') return;
  const complete = courseScanSucceeded(scan.status);
  const read = complete || scan.status === 'partial';
  if (!read) return;
  const seen = new Set<string>();
  let untrusted = false;
  for (const item of scan.items) {
    const url = observedUrl(item.url, host);
    const title = normalizeTitle(item.title);
    if (!url || !title) {
      untrusted = true;
      continue;
    }
    const sourceKey = childKey(url, title);
    seen.add(sourceKey);
    const existingChild = tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.userId, userId),
          eq(table.courseId, courseId),
          eq(table.sourceKey, sourceKey),
        ),
      )
      .get();
    if (existingChild)
      tx.update(table)
        .set({
          title,
          body: item.body ?? existingChild.body,
          ...(item.dateValue !== null || item.dateText !== null
            ? { dateValue: item.dateValue, dateText: item.dateText }
            : {}),
          url,
          active: true,
          lastSeenAt: now,
        })
        .where(eq(table.id, existingChild.id))
        .run();
    else
      tx.insert(table)
        .values({
          id: randomUUID(),
          userId,
          courseId,
          sourceKey,
          title,
          body: item.body,
          dateValue: item.dateValue,
          dateText: item.dateText,
          url,
          active: true,
          lastSeenAt: now,
        })
        .run();
  }
  for (const item of scan.inactiveItems ?? []) {
    const url = observedUrl(item.url, host);
    const title = normalizeTitle(item.title);
    if (!url || !title) continue;
    const sourceKey = childKey(url, title);
    tx.update(table)
      .set({ active: false })
      .where(
        and(
          eq(table.userId, userId),
          eq(table.courseId, courseId),
          eq(table.sourceKey, sourceKey),
        ),
      )
      .run();
    seen.delete(sourceKey);
  }
  if (!complete || untrusted) return;
  const savedChildren = tx
    .select({ id: table.id, sourceKey: table.sourceKey })
    .from(table)
    .where(
      and(
        eq(table.userId, userId),
        eq(table.courseId, courseId),
        eq(table.active, true),
      ),
    )
    .all();
  for (const savedChild of savedChildren)
    if (!seen.has(savedChild.sourceKey))
      tx.update(table)
        .set({ active: false })
        .where(eq(table.id, savedChild.id))
        .run();
};

// Coverage a scan actually established; 'pending' never overwrites known state.
const coverageOf = (observed: ObservedCourse, now: string) => ({
  ...(observed.announcements.status === 'pending'
    ? {}
    : {
        announcementsStatus: observed.announcements.status,
        ...(courseScanSucceeded(observed.announcements.status)
          ? { announcementsSyncedAt: now }
          : {}),
      }),
  ...(observed.assignments.status === 'pending'
    ? {}
    : {
        assignmentsStatus: observed.assignments.status,
        ...(courseScanSucceeded(observed.assignments.status)
          ? { assignmentsSyncedAt: now }
          : {}),
      }),
});

const upsertCourse = (
  tx: CourseWriter,
  userId: string,
  connection: AcademicConnectionSelectData,
  sourceKey: string,
  url: string,
  observed: ObservedCourse,
  now: string,
) => {
  const existingCourse = tx
    .select()
    .from(CourseTable)
    .where(
      and(eq(CourseTable.userId, userId), eq(CourseTable.sourceKey, sourceKey)),
    )
    .get();
  const coverage = coverageOf(observed, now);
  // Only what this scan really read replaces a stored value, so a thinner
  // result cannot blank out details an earlier refresh found.
  const fields = {
    name: normalizeTitle(observed.name) || existingCourse?.name || url,
    code: observed.code ?? existingCourse?.code ?? null,
    term: observed.term ?? existingCourse?.term ?? null,
    instructor: observed.instructor ?? existingCourse?.instructor ?? null,
    description: observed.description ?? existingCourse?.description ?? null,
    externalId: observed.externalId ?? existingCourse?.externalId ?? null,
    sourceName: connection.name,
    sourceHost: connection.host,
    url,
    active: true,
    lastSeenAt: now,
    ...(courseScanSucceeded(observed.overview)
      ? { overviewSyncedAt: now }
      : {}),
    ...coverage,
  };
  if (existingCourse) {
    tx.update(CourseTable)
      .set(fields)
      .where(eq(CourseTable.id, existingCourse.id))
      .run();
    return existingCourse.id;
  }
  const id = randomUUID();
  tx.insert(CourseTable)
    .values({
      id,
      userId,
      connectionId: connection.id,
      sourceKey,
      firstSeenAt: now,
      ...fields,
    })
    .run();
  return id;
};

const applyCourseList = (
  tx: CourseWriter,
  userId: string,
  connection: AcademicConnectionSelectData,
  scan: CourseSourceScan,
  now: string,
) => {
  const seen = new Set<string>();
  let untrusted = false;
  for (const observed of scan.courses) {
    const url = observedUrl(observed.url, connection.host);
    if (!url) {
      untrusted = true;
      continue;
    }
    const sourceKey = courseKey(scan.connectionId, observed.externalId, url);
    seen.add(sourceKey);
    const courseId = upsertCourse(
      tx,
      userId,
      connection,
      sourceKey,
      url,
      observed,
      now,
    );
    applyChildren(
      tx,
      CourseAnnouncementTable,
      userId,
      courseId,
      connection.host,
      observed.announcements,
      now,
    );
    applyChildren(
      tx,
      CourseAssignmentTable,
      userId,
      courseId,
      connection.host,
      observed.assignments,
      now,
    );
  }
  // Retirement needs a list we are sure is whole; anything less keeps history.
  if (scan.outcome !== 'complete' || untrusted) return;
  const savedCourses = tx
    .select({ id: CourseTable.id, sourceKey: CourseTable.sourceKey })
    .from(CourseTable)
    .where(
      and(
        eq(CourseTable.userId, userId),
        eq(CourseTable.connectionId, scan.connectionId),
        eq(CourseTable.active, true),
      ),
    )
    .all();
  for (const savedCourse of savedCourses)
    if (!seen.has(savedCourse.sourceKey))
      tx.update(CourseTable)
        .set({ active: false })
        .where(eq(CourseTable.id, savedCourse.id))
        .run();
};

export const applyCourseRefresh = (
  userId: string,
  scans: CourseSourceScan[],
  options: { now?: string } = {},
) => {
  const now = options.now ?? new Date().toISOString();
  db.transaction((tx) => {
    for (const scan of scans) {
      // Re-read at commit time: a source unmarked or removed while the browser
      // was open must not receive this run's results.
      const connection = tx
        .select()
        .from(AcademicConnectionTable)
        .where(
          and(
            eq(AcademicConnectionTable.userId, userId),
            eq(AcademicConnectionTable.id, scan.connectionId),
          ),
        )
        .get();
      if (!connection?.isCourseResource) continue;
      const succeeded = courseScanSucceeded(scan.outcome);
      if (
        connection.status === 'needs-sign-in' &&
        (succeeded || (scan.outcome === 'partial' && scan.courses.length > 0))
      )
        tx.update(AcademicConnectionTable)
          .set({ status: 'confirmed' })
          .where(eq(AcademicConnectionTable.id, connection.id))
          .run();
      tx.insert(CourseSourceTable)
        .values({
          userId,
          connectionId: scan.connectionId,
          outcome: scan.outcome,
          message: scan.message,
          lastAttemptedAt: now,
          lastSuccessfulAt: succeeded ? now : null,
        })
        .onConflictDoUpdate({
          target: [CourseSourceTable.userId, CourseSourceTable.connectionId],
          set: {
            outcome: scan.outcome,
            message: scan.message,
            lastAttemptedAt: now,
            ...(succeeded ? { lastSuccessfulAt: now } : {}),
          },
        })
        .run();
      if (succeeded || scan.outcome === 'partial')
        applyCourseList(tx, userId, connection, scan, now);
    }
  });
  return getCoursesSnapshot(userId);
};
