import {
  courseRecordSchema,
  createCourseRecordSchema,
  type CreateCourseRecordSchema,
  updateCourseRecordSchema,
  type CourseRecordSchema,
  type UpdateCourseRecordSchema,
} from '../schemas';
import {
  academicDateFor,
  dateValueFrom,
  isPastDateInput,
  legacyDateFrom,
} from '../lib/dates';
import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
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
  CourseChildItem,
  CourseChildScan,
  CourseDetail,
  CourseSourceScan,
  CourseSourceState,
  CourseSummary,
  ObservedCourse,
} from '../types';

const changeListeners = new Set<
  (change: { accountId: string; courseId: string | null }) => void
>();
export const subscribeCourseChanges = (
  listener: (change: { accountId: string; courseId: string | null }) => void,
) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};
const notifyCourseChanges = (
  accountId: string,
  courseId: string | null = null,
) => {
  for (const listener of changeListeners) {
    try {
      listener({ accountId, courseId });
    } catch {
      /* Notifications cannot roll back a completed write. */
    }
  }
};

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

// Items without platform IDs or individual links fall back to their source page and title.
const childKey = (url: string, title: string, item?: CourseChildItem) =>
  item?.content?.sourceId
    ? `id:${item.content.sourceId}`
    : item?.content?.url
      ? `url:${url}`
      : `${url} ${title.toLowerCase()}`;

const meaningfulContent = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (Array.isArray(value))
    return value
      .map(meaningfulContent)
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  if (!value || typeof value !== 'object') return value;
  const fields = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(fields)
      .filter(
        ([key]) =>
          key !== 'evidence' &&
          key !== 'targetId' &&
          key !== 'sourceId' &&
          !(key === 'original' && fields.kind !== 'unresolved') &&
          !(fields.content && (key === 'dateText' || key === 'dateValue')),
      )
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, field]) => [key, meaningfulContent(field)]),
  );
};
const contentFingerprint = (value: unknown) =>
  JSON.stringify(meaningfulContent(value));

// A url the source did not really expose is dropped rather than stored, and it
// stops the scan from counting as complete enough to retire anything.
const observedUrl = (url: string, host: string) => {
  const identity = academicPageIdentity(url);
  return identity && isReadNavigation(identity, [host]) ? identity : null;
};

const courseColumns = {
  id: CourseTable.id,
  content: CourseTable.content,
  contentChangedAt: CourseTable.contentChangedAt,
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
  if (!row.url && !row.connectionId) return 'manual';
  if (!row.connectionId || !row.connected) return 'removed';
  return row.marked ? 'connected' : 'unmarked';
};

const toSummary = (
  row: CourseRow,
): Omit<CourseSummary, 'announcementCount' | 'assignmentCount'> => ({
  id: row.id,
  connectionId: row.connectionId,
  content: row.content,
  contentChangedAt: row.contentChangedAt,
  name: row.name,
  instructor: row.content
    ? row.content.instructors.join(', ') || null
    : row.instructor,
  description: row.content ? row.content.description : row.description,
  code: row.content ? row.content.code : row.code,
  term: row.content ? row.content.term : row.term,
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
    if (!item.url || item.url.split('#')[0] !== coursePageUrl) return true;
    const title = normalizeTitle(item.title).toLowerCase();
    if (assignmentTitles.has(title)) return false;
    assignmentTitles.add(title);
    return true;
  });
};

export const getCoursesSnapshot = (userId: string) => {
  const existingCourseSources = db
    .select()
    .from(CourseSourceTable)
    .where(eq(CourseSourceTable.userId, userId))
    .all();
  const existingCourseAnnouncements = db
    .select({ courseId: CourseAnnouncementTable.courseId })
    .from(CourseAnnouncementTable)
    .where(
      and(
        eq(CourseAnnouncementTable.userId, userId),
        eq(CourseAnnouncementTable.active, true),
      ),
    )
    .all();
  const existingCourseAssignments = db
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
      announcementCount: existingCourseAnnouncements.filter(
        (item) => item.courseId === row.id,
      ).length,
      assignmentCount: uniqueAssignments(
        existingCourseAssignments.filter((item) => item.courseId === row.id),
        row.url,
      ).length,
    })),
    sources: existingCourseSources.map(
      ({ userId: _userId, ...source }) => source,
    ),
    lastSuccessfulAt: existingCourseSources.reduce<string | null>(
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
  const existingCourseRow = readCourseRows(userId).find(
    (row) => row.id === courseId,
  );
  if (!existingCourseRow) return null;
  const existingCourseAnnouncements = db
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
  const existingCourseAssignments = db
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
  const visibleAssignments = uniqueAssignments(
    existingCourseAssignments,
    existingCourseRow.url,
  );
  return {
    ...toSummary(existingCourseRow),
    announcementCount: existingCourseAnnouncements.length,
    assignmentCount: visibleAssignments.length,
    instructor: existingCourseRow.content
      ? existingCourseRow.content.instructors.join(', ') || null
      : existingCourseRow.instructor,
    description: existingCourseRow.content
      ? existingCourseRow.content.description
      : existingCourseRow.description,
    announcements: existingCourseAnnouncements.map(toChild),
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
  const findExistingChild = (
    item: CourseChildItem,
    sourceKey: string,
    url: string,
    title: string,
  ) => {
    const existingCourseChildren = tx
      .select()
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.courseId, courseId)))
      .all()
      .filter((row) => {
        if (row.sourceKey.startsWith('manual:')) return false;
        if (
          row.content?.sourceId &&
          item.content?.sourceId &&
          row.content.sourceId !== item.content.sourceId
        )
          return false;
        if (
          item.content?.sourceId &&
          row.content?.sourceId === item.content.sourceId
        )
          return true;
        if (
          row.sourceKey === sourceKey ||
          row.sourceKey === childKey(url, title)
        )
          return true;
        if (row.url === url && (row.content?.url || item.content?.url))
          return true;
        // A collection entry can become a detail link without becoming a new item.
        return (
          (url.startsWith(`${row.url}/`) ||
            row.url.startsWith(`${url}/`) ||
            row.url === url) &&
          normalizeTitle(row.title).toLowerCase() === title.toLowerCase() &&
          ((!row.content?.sourceId && !row.content?.url) ||
            (!item.content?.sourceId && !item.content?.url))
        );
      });
    const sourceIds = new Set(
      existingCourseChildren.flatMap((row) =>
        row.content?.sourceId ? [row.content.sourceId] : [],
      ),
    );
    if (sourceIds.size > 1)
      return existingCourseChildren.find((row) => row.sourceKey === sourceKey);
    const existingCourseChild = existingCourseChildren.sort(
      (a, b) =>
        Number(!!b.content?.sourceId) - Number(!!a.content?.sourceId) ||
        b.url.length - a.url.length,
    )[0];
    for (const duplicate of existingCourseChildren)
      if (duplicate.id !== existingCourseChild.id)
        tx.update(table)
          .set({ active: false })
          .where(eq(table.id, duplicate.id))
          .run();
    return existingCourseChild;
  };
  const seen = new Set<string>();
  let untrusted = false;
  for (const item of scan.items) {
    const url = observedUrl(item.url, host);
    const title = normalizeTitle(item.title);
    if (!url || !title) {
      untrusted = true;
      continue;
    }
    const sourceKey = childKey(url, title, item);
    const existingCourseChild = findExistingChild(item, sourceKey, url, title);
    seen.add(existingCourseChild?.sourceKey ?? sourceKey);
    const fields = {
      title,
      body: item.body ?? existingCourseChild?.body ?? null,
      dateValue:
        item.content || item.dateValue !== null || item.dateText !== null
          ? item.dateValue
          : (existingCourseChild?.dateValue ?? null),
      dateText:
        item.content || item.dateValue !== null || item.dateText !== null
          ? item.dateText
          : (existingCourseChild?.dateText ?? null),
      url:
        existingCourseChild &&
        !item.content?.url &&
        existingCourseChild.url.startsWith(`${url}/`)
          ? existingCourseChild.url
          : url,
      content: item.content
        ? {
            ...item.content,
            sourceId:
              item.content.sourceId ??
              existingCourseChild?.content?.sourceId ??
              null,
            url: item.content.url ?? existingCourseChild?.content?.url ?? null,
          }
        : (existingCourseChild?.content ?? null),
      active: true,
    };
    const previous = existingCourseChild && {
      title: existingCourseChild.title,
      body: existingCourseChild.body,
      dateValue: existingCourseChild.dateValue,
      dateText: existingCourseChild.dateText,
      url: existingCourseChild.url,
      content: existingCourseChild.content,
      active: existingCourseChild.active,
    };
    const changed =
      !previous || contentFingerprint(fields) !== contentFingerprint(previous);
    const contentChangedAt = changed
      ? now
      : (existingCourseChild?.contentChangedAt ?? null);
    if (existingCourseChild)
      tx.update(table)
        .set({
          ...(changed
            ? fields
            : { content: fields.content, dateText: fields.dateText }),
          sourceKey: existingCourseChild.sourceKey,
          lastSeenAt: item.retrievedAt ?? now,
          contentChangedAt,
        })
        .where(eq(table.id, existingCourseChild.id))
        .run();
    else
      tx.insert(table)
        .values({
          id: randomUUID(),
          userId,
          courseId,
          sourceKey,
          ...fields,
          lastSeenAt: item.retrievedAt ?? now,
          contentChangedAt,
        })
        .run();
  }
  for (const item of scan.inactiveItems ?? []) {
    const url = observedUrl(item.url, host);
    const title = normalizeTitle(item.title);
    if (!url || !title) continue;
    const sourceKey = childKey(url, title, item);
    const existingCourseChild = findExistingChild(item, sourceKey, url, title);
    if (existingCourseChild)
      tx.update(table)
        .set({
          active: false,
          sourceKey: existingCourseChild.sourceKey,
          title,
          content: item.content ?? existingCourseChild.content,
          contentChangedAt:
            existingCourseChild.active ||
            existingCourseChild.title !== title ||
            contentFingerprint(existingCourseChild.content) !==
              contentFingerprint(item.content ?? existingCourseChild.content)
              ? now
              : existingCourseChild.contentChangedAt,
          lastSeenAt: item.retrievedAt ?? now,
        })
        .where(eq(table.id, existingCourseChild.id))
        .run();
    seen.delete(existingCourseChild?.sourceKey ?? sourceKey);
  }
  if (!complete || untrusted) return;
  const existingCourseChildren = tx
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
  for (const existingCourseChild of existingCourseChildren)
    if (
      !existingCourseChild.sourceKey.startsWith('manual:') &&
      !seen.has(existingCourseChild.sourceKey)
    )
      tx.update(table)
        .set({ active: false })
        .where(eq(table.id, existingCourseChild.id))
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
      and(
        eq(CourseTable.userId, userId),
        eq(CourseTable.connectionId, connection.id),
        or(eq(CourseTable.sourceKey, sourceKey), eq(CourseTable.url, url)),
      ),
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
    content: observed.content ?? existingCourse?.content ?? null,
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
  const changed =
    !existingCourse ||
    [
      'name',
      'code',
      'term',
      'instructor',
      'description',
      'content',
      'url',
    ].some(
      (key) =>
        contentFingerprint(fields[key as keyof typeof fields]) !==
        contentFingerprint(existingCourse[key as keyof typeof existingCourse]),
    );
  if (existingCourse) {
    tx.update(CourseTable)
      .set({
        ...fields,
        sourceKey,
        contentChangedAt: changed ? now : existingCourse.contentChangedAt,
      })
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
      contentChangedAt: now,
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
  const existingCourses = tx
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
  for (const existingCourse of existingCourses)
    if (!seen.has(existingCourse.sourceKey))
      tx.update(CourseTable)
        .set({ active: false })
        .where(eq(CourseTable.id, existingCourse.id))
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
      const existingConnection = tx
        .select()
        .from(AcademicConnectionTable)
        .where(
          and(
            eq(AcademicConnectionTable.userId, userId),
            eq(AcademicConnectionTable.id, scan.connectionId),
          ),
        )
        .get();
      if (!existingConnection?.isCourseResource) continue;
      const succeeded = courseScanSucceeded(scan.outcome);
      if (
        existingConnection.status === 'needs-sign-in' &&
        (succeeded || (scan.outcome === 'partial' && scan.courses.length > 0))
      )
        tx.update(AcademicConnectionTable)
          .set({ status: 'confirmed' })
          .where(eq(AcademicConnectionTable.id, existingConnection.id))
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
        applyCourseList(tx, userId, existingConnection, scan, now);
    }
  });
  notifyCourseChanges(userId);
  return getCoursesSnapshot(userId);
};

export const getCourseRefreshTarget = (userId: string, courseId: string) =>
  db
    .select()
    .from(CourseTable)
    .where(and(eq(CourseTable.userId, userId), eq(CourseTable.id, courseId)))
    .get();

export const applySingleCourseRefresh = (
  userId: string,
  courseId: string,
  observed: ObservedCourse,
) => {
  db.transaction((tx) => {
    const existingCourse = getCourseRefreshTarget(userId, courseId);
    if (!existingCourse?.connectionId) return;
    const existingConnection = tx
      .select()
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.id, existingCourse.connectionId),
        ),
      )
      .get();
    if (!existingConnection?.isCourseResource) return;
    const url = observedUrl(observed.url, existingConnection.host);
    if (!url || url !== existingCourse.url) return;
    const now = new Date().toISOString();
    upsertCourse(
      tx,
      userId,
      existingConnection,
      existingCourse.sourceKey,
      url,
      observed,
      now,
    );
    applyChildren(
      tx,
      CourseAnnouncementTable,
      userId,
      courseId,
      existingConnection.host,
      observed.announcements,
      now,
    );
    applyChildren(
      tx,
      CourseAssignmentTable,
      userId,
      courseId,
      existingConnection.host,
      observed.assignments,
      now,
    );
  });
  notifyCourseChanges(userId, courseId);
};

export const createCourseRecord = (
  userId: string,
  input: CreateCourseRecordSchema,
) => {
  const data = createCourseRecordSchema.parse(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  if (data.kind === 'courses') {
    db.insert(CourseTable)
      .values({
        id,
        userId,
        sourceKey: `manual:${id}`,
        sourceName: 'Manual',
        sourceHost: '',
        url: '',
        name: data.values.name,
        code: data.values.code || null,
        term: data.values.term || null,
        instructor: data.values.instructor || null,
        description: data.values.description || null,
        firstSeenAt: now,
        lastSeenAt: now,
        contentChangedAt: now,
      })
      .run();
  } else {
    if (!getCourseRefreshTarget(userId, data.courseId))
      throw new Error('This course is no longer available.');
    if (data.kind === 'assignments' && isPastDateInput(data.values.date))
      throw new Error('Choose a date and time in the future.');
    const date = legacyDateFrom({
      dateValue: data.values.date || null,
      dateText: data.values.date || null,
    });
    const table =
      data.kind === 'assignments'
        ? CourseAssignmentTable
        : CourseAnnouncementTable;
    db.insert(table)
      .values({
        id,
        userId,
        courseId: data.courseId,
        sourceKey: `manual:${id}`,
        url: '',
        title: data.values.title,
        body: data.values.body || null,
        dateText: date?.original ?? null,
        dateValue: dateValueFrom(date),
        lastSeenAt: now,
        contentChangedAt: now,
      })
      .run();
  }
  notifyCourseChanges(userId, data.kind === 'courses' ? id : data.courseId);
  return id;
};

export const updateCourseRecord = (
  userId: string,
  input: UpdateCourseRecordSchema,
) => {
  const data = updateCourseRecordSchema.parse(input);
  const now = new Date().toISOString();
  const existingCourse = getCourseRefreshTarget(userId, data.courseId);
  if (!existingCourse) throw new Error('This course is no longer available.');
  if (data.kind === 'courses') {
    if (data.id !== data.courseId) throw new Error('Choose this course.');
    const values = data.values;
    db.update(CourseTable)
      .set({
        name: values.name,
        code: values.code || null,
        term: values.term || null,
        instructor: values.instructor || null,
        description: values.description || null,
        content: existingCourse.content
          ? {
              ...existingCourse.content,
              name: values.name,
              code: values.code || null,
              term: values.term || null,
              instructors: values.instructor ? [values.instructor] : [],
              description: values.description || null,
            }
          : null,
        contentChangedAt: now,
      })
      .where(and(eq(CourseTable.id, data.id), eq(CourseTable.userId, userId)))
      .run();
  } else {
    const table =
      data.kind === 'assignments'
        ? CourseAssignmentTable
        : CourseAnnouncementTable;
    const scope = and(
      eq(table.userId, userId),
      eq(table.courseId, data.courseId),
      eq(table.id, data.id),
    );
    const existingCourseChild = db.select().from(table).where(scope).get();
    if (!existingCourseChild)
      throw new Error('This item is no longer available.');
    const values = data.values;
    const previousDate = academicDateFor(existingCourseChild);
    const dateChanged = values.date !== (previousDate?.original ?? '');
    if (
      data.kind === 'assignments' &&
      dateChanged &&
      isPastDateInput(values.date)
    )
      throw new Error('Choose a date and time in the future.');
    const date = dateChanged
      ? legacyDateFrom({
          dateValue: values.date || null,
          dateText: values.date || null,
        })
      : previousDate;
    const content = existingCourseChild.content;
    db.update(table)
      .set({
        title: values.title,
        body: values.body || null,
        dateText: date?.original ?? null,
        dateValue: dateValueFrom(date),
        content: content
          ? 'due' in content
            ? {
                ...content,
                title: values.title,
                description: values.body || null,
                due: date,
              }
            : {
                ...content,
                title: values.title,
                body: values.body || null,
                published: date,
              }
          : null,
        contentChangedAt: now,
      })
      .where(scope)
      .run();
  }
  notifyCourseChanges(userId, data.courseId);
};

export const deleteCourseRecord = (
  userId: string,
  input: CourseRecordSchema,
) => {
  const data = courseRecordSchema.parse(input);
  db.transaction((tx) => {
    if (data.kind === 'courses') {
      if (
        data.id !== data.courseId ||
        !getCourseRefreshTarget(userId, data.courseId)
      )
        throw new Error('This course is no longer available.');
      for (const table of [CourseAssignmentTable, CourseAnnouncementTable])
        tx.delete(table)
          .where(
            and(eq(table.userId, userId), eq(table.courseId, data.courseId)),
          )
          .run();
      tx.delete(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.id, data.courseId),
          ),
        )
        .run();
    } else {
      const table =
        data.kind === 'assignments'
          ? CourseAssignmentTable
          : CourseAnnouncementTable;
      const deletedCourseChild = tx
        .delete(table)
        .where(
          and(
            eq(table.userId, userId),
            eq(table.courseId, data.courseId),
            eq(table.id, data.id),
          ),
        )
        .returning({ id: table.id })
        .get();
      if (!deletedCourseChild)
        throw new Error('This item is no longer available.');
    }
  });
  notifyCourseChanges(userId, data.kind === 'courses' ? null : data.courseId);
};
