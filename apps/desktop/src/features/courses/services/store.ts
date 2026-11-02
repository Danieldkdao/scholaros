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
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseAnnouncementTable,
  CourseAssignmentTable,
  CourseRecordTombstoneTable,
  CourseSourceTable,
  CourseTable,
} from '../../../db/schema';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import {
  mergeResourceIdentityCandidate,
  reconcileResourceIdentities,
  resourceIdentityKeys,
  type ResourceIdentityRecord,
  type ResourceIdentityScope,
} from '@scholaros/services/ai/resources/identity';
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
type ChildIdentityResource = ResourceIdentityRecord & {
  body: string | null;
  dateValue: string | null;
  dateText: string | null;
};
// A drizzle transaction exposes the same query builders without $client.
type CourseWriter = Omit<typeof db, '$client'>;
type CourseStoreMetrics = {
  recordsCreated: number;
  recordsUpdated: number;
  recordsRetired: number;
};

const emptyCourseStoreMetrics = (): CourseStoreMetrics => ({
  recordsCreated: 0,
  recordsUpdated: 0,
  recordsRetired: 0,
});

const normalizeTitle = (value: string) =>
  value.replace(/\s+/g, ' ').trim().slice(0, 300);

// Identity is decided here once so a rescan of the same page finds the same row.
const courseKey = (
  connectionId: string,
  externalId: string | null,
  url: string,
) => `${connectionId} ${externalId ?? url}`;

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

const childIdentityResource = (
  item: CourseChildItem,
): ChildIdentityResource => {
  const content = item.content;
  return {
    ...content,
    title: content?.title ?? item.title,
    sourceId: content?.sourceId ?? null,
    url: content?.url ?? item.url,
    evidence: content?.evidence ?? {
      sourceUrl: item.url,
      excerpts: [item.title],
      targetIds: [],
    },
    body: item.body,
    dateValue: item.dateValue,
    dateText: item.dateText,
  } as ChildIdentityResource;
};

const savedChildIdentityResource = (row: SavedChildRow) =>
  ({
    ...row.content,
    title: row.content?.title ?? row.title,
    sourceId: row.content?.sourceId ?? null,
    url: row.content?.url ?? row.url,
    evidence: row.content?.evidence ?? {
      sourceUrl: row.url,
      excerpts: [row.title],
      targetIds: [],
    },
    body: row.body,
    dateValue: row.dateValue,
    dateText: row.dateText,
  }) as ChildIdentityResource;

const identitySourceKey = (keys: ReturnType<typeof resourceIdentityKeys>) =>
  keys.sourceId
    ? `id:${keys.sourceId}`
    : keys.urlId
      ? `id:${keys.urlId}`
      : keys.itemUrl
        ? `url:${keys.itemUrl}`
        : (keys.fallback ?? '');

const ambiguousSourceKey = (resource: ResourceIdentityRecord) =>
  `ambiguous:${createHash('sha256').update(JSON.stringify(resource)).digest('hex')}`;

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
      assignmentCount: existingCourseAssignments.filter(
        (item) => item.courseId === row.id,
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
  return {
    ...toSummary(existingCourseRow),
    announcementCount: existingCourseAnnouncements.length,
    assignmentCount: existingCourseAssignments.length,
    instructor: existingCourseRow.content
      ? existingCourseRow.content.instructors.join(', ') || null
      : existingCourseRow.instructor,
    description: existingCourseRow.content
      ? existingCourseRow.content.description
      : existingCourseRow.description,
    announcements: existingCourseAnnouncements.map(toChild),
    assignments: existingCourseAssignments.map(toChild),
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
  courseSourceKey: string,
  connectionId: string,
  host: string,
  scan: CourseChildScan,
  now: string,
  metrics?: CourseStoreMetrics,
): boolean => {
  // 'pending' means this run never looked, so nothing may be replaced.
  if (scan.status === 'pending') return false;
  const complete = courseScanSucceeded(scan.status);
  const read = complete || scan.status === 'partial';
  if (!read) return false;
  const kind =
    table === CourseAssignmentTable ? 'assignments' : 'announcements';
  const scope: ResourceIdentityScope = {
    accountId: userId,
    connectionId,
    courseId,
    kind,
  };
  const existingChildren = tx
    .select()
    .from(table)
    .where(and(eq(table.userId, userId), eq(table.courseId, courseId)))
    .all()
    .filter((row) => !row.sourceKey.startsWith('manual:'));
  const deletedSourceKeys = new Set(
    tx
      .select({ sourceKey: CourseRecordTombstoneTable.resourceSourceKey })
      .from(CourseRecordTombstoneTable)
      .where(
        and(
          eq(CourseRecordTombstoneTable.userId, userId),
          eq(CourseRecordTombstoneTable.connectionId, connectionId),
          eq(CourseRecordTombstoneTable.courseSourceKey, courseSourceKey),
          eq(CourseRecordTombstoneTable.kind, kind),
        ),
      )
      .all()
      .map(({ sourceKey }) => sourceKey),
  );
  const existingKeys = new Map<
    SavedChildRow,
    ReturnType<typeof resourceIdentityKeys>
  >();
  const rowsByAlias = new Map<string, SavedChildRow[]>();
  const identityResourceByRow = new Map<SavedChildRow, ChildIdentityResource>();
  const addRowToIndex = (
    row: SavedChildRow,
    resource: ChildIdentityResource,
  ) => {
    const keys = resourceIdentityKeys(scope, resource);
    existingKeys.set(row, keys);
    identityResourceByRow.set(row, resource);
    for (const alias of [...keys.aliases, `record:${row.sourceKey}`]) {
      const rows = rowsByAlias.get(alias) ?? [];
      if (!rows.some((existing) => existing.id === row.id)) rows.push(row);
      rowsByAlias.set(alias, rows);
    }
  };
  for (const row of existingChildren)
    addRowToIndex(row, savedChildIdentityResource(row));

  const incomingEntries: Array<{
    item: CourseChildItem;
    resource: ChildIdentityResource;
    inactive: boolean;
  }> = [];
  let untrusted = false;
  for (const [items, inactive] of [
    [scan.items, false],
    [scan.inactiveItems ?? [], true],
  ] as const)
    for (const item of items) {
      const url = observedUrl(item.url, host);
      const title = normalizeTitle(item.title);
      if (!url || !title) {
        untrusted = true;
        continue;
      }
      const trustedItem = { ...item, title, url };
      incomingEntries.push({
        item: trustedItem,
        resource: childIdentityResource(trustedItem),
        inactive,
      });
    }
  const entryByResource = new Map(
    incomingEntries.map((entry) => [entry.resource, entry] as const),
  );
  const reconciled = reconcileResourceIdentities(
    incomingEntries.map(({ resource }) => ({ scope, resource })),
  );
  const ambiguousInputResources = new Set(
    reconciled.ambiguities
      .filter((ambiguity) => ambiguity.reason !== 'conflicting-source-ids')
      .flatMap((ambiguity) => ambiguity.resources),
  );
  const savedResources = existingChildren.flatMap((row) => {
    const resource = identityResourceByRow.get(row);
    return resource ? [resource] : [];
  });
  const existingResourceSet = new Set(savedResources);
  const historicalAmbiguities = reconcileResourceIdentities(
    [...savedResources, ...incomingEntries.map(({ resource }) => resource)].map(
      (resource) => ({ scope, resource }),
    ),
  ).ambiguities;
  const unresolvedHistoricalAmbiguities = historicalAmbiguities.filter(
    (ambiguity) => {
      if (ambiguity.reason !== 'ambiguous-fallback') return false;
      const existing = ambiguity.resources.filter((resource) =>
        existingResourceSet.has(resource),
      );
      const incoming = ambiguity.resources.filter(
        (resource) => !existingResourceSet.has(resource),
      );
      if (!existing.length || !incoming.length) return false;
      return !incoming.some((incomingResource) => {
        const incomingFallback = resourceIdentityKeys(
          scope,
          incomingResource,
        ).fallback;
        return existing.some(
          (existingResource) =>
            !!incomingFallback &&
            incomingFallback ===
              resourceIdentityKeys(scope, existingResource).fallback,
        );
      });
    },
  );
  const preserveHistoricalResources = new Set(
    unresolvedHistoricalAmbiguities.flatMap((ambiguity) =>
      ambiguity.resources.filter(
        (resource) => !existingResourceSet.has(resource),
      ),
    ),
  );
  let ambiguous =
    reconciled.ambiguities.length > 0 ||
    unresolvedHistoricalAmbiguities.length > 0;
  const seen = new Set<string>();
  const uniqueRows = (rows: SavedChildRow[]) => [
    ...new Map(rows.map((row) => [row.id, row])).values(),
  ];
  const matchExisting = (
    keys: ReturnType<typeof resourceIdentityKeys>,
    sourceKey: string,
  ): { rows: SavedChildRow[]; ambiguous: boolean } => {
    const rowsFor = (alias: string | null) =>
      alias ? uniqueRows(rowsByAlias.get(alias) ?? []) : [];
    const exactRecord = rowsFor(`record:${sourceKey}`);
    if (exactRecord.length) return { rows: exactRecord, ambiguous: false };
    const idMatches = (id: string) =>
      rowsFor(`id:${id}`).filter((row) => {
        const saved = existingKeys.get(row);
        return saved?.sourceId === id || saved?.urlId === id;
      });
    if (keys.sourceId) {
      const sameId = idMatches(keys.sourceId);
      if (sameId.length) return { rows: sameId, ambiguous: false };
      const byUrl = rowsFor(keys.itemUrl ? `url:${keys.itemUrl}` : null);
      const unknownIdentity = byUrl.filter(
        (row) => !existingKeys.get(row)?.sourceId,
      );
      return {
        rows: unknownIdentity.length === 1 ? unknownIdentity : [],
        ambiguous: unknownIdentity.length > 1,
      };
    }
    if (keys.urlId) {
      const sameId = idMatches(keys.urlId);
      if (sameId.length) return { rows: sameId, ambiguous: false };
    }
    if (keys.itemUrl) {
      const byUrl = rowsFor(`url:${keys.itemUrl}`);
      const knownIds = new Set(
        byUrl.flatMap((row) => {
          const saved = existingKeys.get(row);
          return saved?.sourceId ? [saved.sourceId] : [];
        }),
      );
      if (knownIds.size > 1) return { rows: [], ambiguous: true };
      if (byUrl.length) return { rows: byUrl, ambiguous: false };
    }
    const byFallback = rowsFor(keys.fallback);
    return {
      rows: byFallback.length === 1 ? byFallback : [],
      ambiguous: byFallback.length > 1,
    };
  };

  for (const candidate of reconciled.candidates) {
    const entries = candidate.resources
      .map((resource) => entryByResource.get(resource))
      .filter((entry): entry is (typeof incomingEntries)[number] => !!entry);
    if (!entries.length) continue;
    if (
      candidate.resources.some((resource) =>
        preserveHistoricalResources.has(resource),
      )
    )
      continue;
    if (new Set(entries.map((entry) => entry.inactive)).size > 1) {
      ambiguous = true;
      continue;
    }
    const merged = mergeResourceIdentityCandidate(
      candidate.resources as ChildIdentityResource[],
    );
    if (!merged.resource || merged.ambiguous) {
      ambiguous = true;
      continue;
    }
    const itemUrl = entries
      .map(({ item }) => item.url)
      .sort(
        (left, right) =>
          right.length - left.length || left.localeCompare(right),
      )[0]!;
    const { body, dateValue, dateText, ...contentFields } = merged.resource;
    const content = entries.some((entry) => entry.item.content)
      ? (contentFields as CourseChildItem['content'])
      : null;
    const item: CourseChildItem = {
      title: merged.resource.title,
      body: body ?? null,
      dateValue: dateValue ?? null,
      dateText: dateText ?? null,
      url: itemUrl,
      content,
      retrievedAt: entries
        .map(({ item: entryItem }) => entryItem.retrievedAt)
        .filter((value): value is string => !!value)
        .sort()
        .slice(-1)[0],
    };
    const keys = resourceIdentityKeys(scope, merged.resource);
    const identityConflict = candidate.resources.some((resource) =>
      ambiguousInputResources.has(resource),
    );
    const hasExistingIdentity = keys.aliases.some(
      (alias) => (rowsByAlias.get(alias)?.length ?? 0) > 0,
    );
    if (identityConflict && hasExistingIdentity) {
      ambiguous = true;
      continue;
    }
    const sourceKey = identityConflict
      ? ambiguousSourceKey(merged.resource)
      : identitySourceKey(keys);
    if (
      deletedSourceKeys.has(sourceKey) ||
      keys.aliases.some((alias) => deletedSourceKeys.has(alias))
    )
      continue;
    const match = matchExisting(keys, sourceKey);
    if (match.ambiguous) ambiguous = true;
    if (match.ambiguous && !keys.sourceId && !keys.urlId && !keys.itemUrl)
      continue;
    const sameIdentityRows = match.rows;
    const existingCourseChild = sameIdentityRows.sort(
      (left, right) =>
        Number(right.active) - Number(left.active) ||
        Number(!!existingKeys.get(right)?.sourceId) -
          Number(!!existingKeys.get(left)?.sourceId) ||
        right.url.length - left.url.length ||
        left.id.localeCompare(right.id),
    )[0];
    for (const duplicate of sameIdentityRows)
      if (existingCourseChild && duplicate.id !== existingCourseChild.id) {
        if (duplicate.active && metrics) metrics.recordsRetired += 1;
        tx.update(table)
          .set({ active: false })
          .where(eq(table.id, duplicate.id))
          .run();
      }
    for (const duplicate of sameIdentityRows)
      if (existingCourseChild && duplicate.id !== existingCourseChild.id)
        duplicate.active = false;
    const inactive = entries[0]!.inactive;
    if (inactive) {
      if (existingCourseChild) {
        if (existingCourseChild.active && metrics) metrics.recordsRetired += 1;
        tx.update(table)
          .set({
            active: false,
            sourceKey: existingCourseChild.sourceKey,
            title: item.title,
            content: item.content ?? existingCourseChild.content,
            contentChangedAt:
              existingCourseChild.active ||
              existingCourseChild.title !== item.title ||
              contentFingerprint(existingCourseChild.content) !==
                contentFingerprint(item.content ?? existingCourseChild.content)
                ? now
                : existingCourseChild.contentChangedAt,
            lastSeenAt: item.retrievedAt ?? now,
          })
          .where(eq(table.id, existingCourseChild.id))
          .run();
        seen.delete(existingCourseChild.sourceKey);
      }
      continue;
    }
    if (!sourceKey) {
      ambiguous = true;
      continue;
    }
    seen.add(existingCourseChild?.sourceKey ?? sourceKey);
    const fields = {
      title: item.title,
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
        existingCourseChild.url.startsWith(`${item.url}/`)
          ? existingCourseChild.url
          : item.url,
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
    const lastSeenAt = item.retrievedAt ?? now;
    if (existingCourseChild) {
      if (changed && metrics) metrics.recordsUpdated += 1;
      tx.update(table)
        .set({
          ...(changed
            ? fields
            : { content: fields.content, dateText: fields.dateText }),
          sourceKey: existingCourseChild.sourceKey,
          lastSeenAt,
          contentChangedAt,
        })
        .where(eq(table.id, existingCourseChild.id))
        .run();
      Object.assign(existingCourseChild, {
        ...fields,
        lastSeenAt,
        contentChangedAt,
      });
      addRowToIndex(
        existingCourseChild,
        savedChildIdentityResource(existingCourseChild),
      );
    } else {
      if (metrics) metrics.recordsCreated += 1;
      const insertedRow = {
        id: randomUUID(),
        userId,
        courseId,
        sourceKey,
        ...fields,
        lastSeenAt,
        contentChangedAt,
      } as SavedChildRow;
      tx.insert(table).values(insertedRow).run();
      existingChildren.push(insertedRow);
      addRowToIndex(insertedRow, savedChildIdentityResource(insertedRow));
    }
  }
  if (!complete || untrusted || ambiguous) return untrusted || ambiguous;
  for (const existingCourseChild of existingChildren)
    if (
      existingCourseChild.active &&
      !seen.has(existingCourseChild.sourceKey)
    ) {
      if (metrics) metrics.recordsRetired += 1;
      tx.update(table)
        .set({ active: false })
        .where(eq(table.id, existingCourseChild.id))
        .run();
    }
  return false;
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
    if (existingCourse.sourceKey !== sourceKey) {
      const existingTombstones = tx
        .select()
        .from(CourseRecordTombstoneTable)
        .where(
          and(
            eq(CourseRecordTombstoneTable.userId, userId),
            eq(CourseRecordTombstoneTable.connectionId, connection.id),
            eq(
              CourseRecordTombstoneTable.courseSourceKey,
              existingCourse.sourceKey,
            ),
            or(
              eq(CourseRecordTombstoneTable.kind, 'assignments'),
              eq(CourseRecordTombstoneTable.kind, 'announcements'),
            ),
          ),
        )
        .all();
      for (const tombstone of existingTombstones) {
        tx.insert(CourseRecordTombstoneTable)
          .values({
            ...tombstone,
            id: randomUUID(),
            courseSourceKey: sourceKey,
          })
          .onConflictDoNothing()
          .run();
        tx.delete(CourseRecordTombstoneTable)
          .where(eq(CourseRecordTombstoneTable.id, tombstone.id))
          .run();
      }
    }
    tx.update(CourseTable)
      .set({
        ...fields,
        sourceKey,
        contentChangedAt: changed ? now : existingCourse.contentChangedAt,
      })
      .where(eq(CourseTable.id, existingCourse.id))
      .run();
    return {
      id: existingCourse.id,
      created: false,
      updated: changed || !existingCourse.active,
      previousCoverage: {
        announcementsSyncedAt: existingCourse.announcementsSyncedAt,
        assignmentsSyncedAt: existingCourse.assignmentsSyncedAt,
      },
    };
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
  return {
    id,
    created: true,
    updated: false,
    previousCoverage: {
      announcementsSyncedAt: null,
      assignmentsSyncedAt: null,
    },
  };
};

const lowerAmbiguousCourseCoverage = (
  tx: CourseWriter,
  courseId: string,
  previousCoverage: {
    announcementsSyncedAt: string | null;
    assignmentsSyncedAt: string | null;
  },
  ambiguous: { announcements: boolean; assignments: boolean },
) => {
  const fields = {
    ...(ambiguous.announcements
      ? {
          announcementsStatus: 'partial' as const,
          announcementsSyncedAt: previousCoverage.announcementsSyncedAt,
        }
      : {}),
    ...(ambiguous.assignments
      ? {
          assignmentsStatus: 'partial' as const,
          assignmentsSyncedAt: previousCoverage.assignmentsSyncedAt,
        }
      : {}),
  };
  if (Object.keys(fields).length)
    tx.update(CourseTable)
      .set(fields)
      .where(eq(CourseTable.id, courseId))
      .run();
};

const applyCourseList = (
  tx: CourseWriter,
  userId: string,
  connection: AcademicConnectionSelectData,
  scan: CourseSourceScan,
  now: string,
  metrics: CourseStoreMetrics,
) => {
  const seen = new Set<string>();
  let untrusted = false;
  const deletedCourseSourceKeys = new Set(
    tx
      .select({ sourceKey: CourseRecordTombstoneTable.resourceSourceKey })
      .from(CourseRecordTombstoneTable)
      .where(
        and(
          eq(CourseRecordTombstoneTable.userId, userId),
          eq(CourseRecordTombstoneTable.connectionId, connection.id),
          eq(CourseRecordTombstoneTable.kind, 'courses'),
        ),
      )
      .all()
      .map(({ sourceKey }) => sourceKey),
  );
  for (const observed of scan.courses) {
    const url = observedUrl(observed.url, connection.host);
    if (!url) {
      untrusted = true;
      continue;
    }
    const sourceKey = courseKey(scan.connectionId, observed.externalId, url);
    if (
      deletedCourseSourceKeys.has(sourceKey) ||
      deletedCourseSourceKeys.has(courseKey(scan.connectionId, null, url))
    ) {
      seen.add(sourceKey);
      continue;
    }
    seen.add(sourceKey);
    const upsertedCourse = upsertCourse(
      tx,
      userId,
      connection,
      sourceKey,
      url,
      observed,
      now,
    );
    if (upsertedCourse.created) metrics.recordsCreated += 1;
    if (upsertedCourse.updated) metrics.recordsUpdated += 1;
    const ambiguousAnnouncements = applyChildren(
      tx,
      CourseAnnouncementTable,
      userId,
      upsertedCourse.id,
      sourceKey,
      connection.id,
      connection.host,
      observed.announcements,
      now,
      metrics,
    );
    const ambiguousAssignments = applyChildren(
      tx,
      CourseAssignmentTable,
      userId,
      upsertedCourse.id,
      sourceKey,
      connection.id,
      connection.host,
      observed.assignments,
      now,
      metrics,
    );
    lowerAmbiguousCourseCoverage(
      tx,
      upsertedCourse.id,
      upsertedCourse.previousCoverage,
      {
        announcements: ambiguousAnnouncements,
        assignments: ambiguousAssignments,
      },
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
    if (!seen.has(existingCourse.sourceKey)) {
      metrics.recordsRetired += 1;
      tx.update(CourseTable)
        .set({ active: false })
        .where(eq(CourseTable.id, existingCourse.id))
        .run();
    }
};

export const applyCourseRefresh = (
  userId: string,
  scans: CourseSourceScan[],
  options: {
    now?: string;
    onMetrics?: (metrics: CourseStoreMetrics) => void;
  } = {},
) => {
  const now = options.now ?? new Date().toISOString();
  const metrics = emptyCourseStoreMetrics();
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
        applyCourseList(tx, userId, existingConnection, scan, now, metrics);
    }
  });
  options.onMetrics?.(metrics);
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
    const upsertedCourse = upsertCourse(
      tx,
      userId,
      existingConnection,
      existingCourse.sourceKey,
      url,
      observed,
      now,
    );
    const ambiguousAnnouncements = applyChildren(
      tx,
      CourseAnnouncementTable,
      userId,
      courseId,
      existingCourse.sourceKey,
      existingConnection.id,
      existingConnection.host,
      observed.announcements,
      now,
    );
    const ambiguousAssignments = applyChildren(
      tx,
      CourseAssignmentTable,
      userId,
      courseId,
      existingCourse.sourceKey,
      existingConnection.id,
      existingConnection.host,
      observed.assignments,
      now,
    );
    lowerAmbiguousCourseCoverage(
      tx,
      courseId,
      upsertedCourse.previousCoverage,
      {
        announcements: ambiguousAnnouncements,
        assignments: ambiguousAssignments,
      },
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
      const existingCourse = tx
        .select({
          connectionId: CourseTable.connectionId,
          sourceKey: CourseTable.sourceKey,
          url: CourseTable.url,
        })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.id, data.courseId),
          ),
        )
        .get();
      if (data.id !== data.courseId || !existingCourse)
        throw new Error('This course is no longer available.');
      if (
        existingCourse.connectionId &&
        !existingCourse.sourceKey.startsWith('manual:')
      )
        tx.insert(CourseRecordTombstoneTable)
          .values(
            [
              ...new Set([
                existingCourse.sourceKey,
                courseKey(
                  existingCourse.connectionId,
                  null,
                  existingCourse.url,
                ),
              ]),
            ].map((resourceSourceKey) => ({
              id: randomUUID(),
              userId,
              connectionId: existingCourse.connectionId!,
              courseSourceKey: existingCourse.sourceKey,
              kind: 'courses' as const,
              resourceSourceKey,
              createdAt: new Date().toISOString(),
            })),
          )
          .onConflictDoNothing()
          .run();
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
        .returning()
        .get();
      if (!deletedCourseChild)
        throw new Error('This item is no longer available.');
      const existingCourse = tx
        .select({
          connectionId: CourseTable.connectionId,
          sourceKey: CourseTable.sourceKey,
        })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.id, data.courseId),
          ),
        )
        .get();
      if (
        existingCourse?.connectionId &&
        !existingCourse.sourceKey.startsWith('manual:') &&
        !deletedCourseChild.sourceKey.startsWith('manual:')
      )
        tx.insert(CourseRecordTombstoneTable)
          .values(
            [
              ...new Set([
                deletedCourseChild.sourceKey,
                ...resourceIdentityKeys(
                  {
                    accountId: userId,
                    connectionId: existingCourse.connectionId,
                    courseId: data.courseId,
                    kind: data.kind,
                  },
                  savedChildIdentityResource(deletedCourseChild),
                ).aliases,
              ]),
            ].map((resourceSourceKey) => ({
              id: randomUUID(),
              userId,
              connectionId: existingCourse.connectionId!,
              courseSourceKey: existingCourse.sourceKey,
              kind: data.kind,
              resourceSourceKey,
              createdAt: new Date().toISOString(),
            })),
          )
          .onConflictDoNothing()
          .run();
    }
  });
  notifyCourseChanges(userId, data.kind === 'courses' ? null : data.courseId);
};
