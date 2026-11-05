import {
  createCourseRecordSchema,
  courseRecordSchema,
  courseRecordSuppressionSchema,
  listCourseRecordSuppressionsSchema,
  restoreCourseRecordSuppressionSchema,
  type CreateCourseRecordSchema,
  type CourseRecordSchema,
  type ListCourseRecordSuppressionsSchema,
  type RestoreCourseRecordSuppressionSchema,
  updateCourseRecordSchema,
  type UpdateCourseRecordSchema,
} from '../schemas';
import {
  academicDateFor,
  dateValueFrom,
  isPastDateInput,
  legacyDateFrom,
} from '../lib/dates';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
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
  isCourseNavigationTarget,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import {
  mergeResourceIdentityCandidate,
  reconcileResourceIdentities,
  resourceIdentityKeys,
  type ResourceIdentityRecord,
  type ResourceIdentityScope,
} from '@scholaros/services/ai/resources/identity';
import { isEnrolledCourseDestination } from '../../onboarding/lib/academic-discovery';
import { courseScanSucceeded } from '../types';
import type {
  AcademicConnectionSelectData,
  CourseAnnouncementSelectData,
  CourseAssignmentSelectData,
  CourseSelectData,
} from '../../../db/schema';
import type {
  CourseChildItem,
  CourseChildLocalOverrideDTO,
  CourseChildLocalOverrideField,
  CourseChildLocalOverrideValues,
  CourseChildRecordFields,
  CourseChildScan,
  CourseDetail,
  CourseLocalOverrideDTO,
  CourseLocalOverrideField,
  CourseLocalOverrideValues,
  CourseRecordFields,
  CourseRecordSuppressionDTO,
  CourseSourceScan,
  CourseSourceState,
  CourseSummary,
  ObservedCourse,
  SavedCourseChild,
} from '../types';
import {
  courseChildLocalOverrideFields,
  courseLocalOverrideFields,
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
type CourseLocalRow = Pick<
  CourseSelectData,
  | 'name'
  | 'code'
  | 'term'
  | 'instructor'
  | 'description'
  | 'content'
  | 'localOverrides'
  | 'localEditedAt'
  | 'url'
  | 'contentChangedAt'
  | 'lastSeenAt'
  | 'sourceKey'
>;
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

export type CourseLocalOverrideView = CourseLocalOverrideDTO & {
  origin: 'manual' | 'source';
  sourceUncertain: boolean;
};
export type CourseChildLocalOverrideView = CourseChildLocalOverrideDTO & {
  origin: 'manual' | 'source';
  sourceUncertain: boolean;
};
export type CourseSummaryView = CourseSummary & {
  local: CourseLocalOverrideView;
};
export type SavedCourseChildView = SavedCourseChild & {
  local: CourseChildLocalOverrideView;
};
export type CourseDetailView = Omit<
  CourseDetail,
  'assignments' | 'announcements'
> & {
  local: CourseLocalOverrideView;
  assignments: SavedCourseChildView[];
  announcements: SavedCourseChildView[];
};

export type ResetCourseRecordOverridesInput =
  | {
      kind: 'courses';
      courseId: string;
      id: string;
      fields: CourseLocalOverrideField[];
    }
  | {
      kind: 'assignments';
      courseId: string;
      id: string;
      fields: CourseChildLocalOverrideField[];
    }
  | {
      kind: 'announcements';
      courseId: string;
      id: string;
      fields: CourseChildLocalOverrideField[];
    };

export type CourseRecordSuppressionView = CourseRecordSuppressionDTO & {
  restoreInput: RestoreCourseRecordSuppressionSchema;
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

const courseSourceKey = (
  connectionId: string,
  externalId: string | null,
  url: string,
  observed: ObservedCourse,
) => {
  const key = courseKey(connectionId, externalId, url);
  if (externalId) return key;
  const section = observed.content?.section ?? null;
  const term = observed.content?.term ?? observed.term;
  return section || term ? `${key} ${JSON.stringify([section, term])}` : key;
};

const schoologyCourseAlias = (
  connection: AcademicConnectionSelectData,
  value: string,
) => {
  if (
    !(
      connection.host === 'schoology.com' ||
      connection.host.endsWith('.schoology.com')
    ) ||
    !isEnrolledCourseDestination(connection, value)
  )
    return null;
  const url = new URL(value);
  const [, marker, id] = url.pathname.split('/');
  const alias = `${url.origin}/${marker}/${id}`;
  return isCourseNavigationTarget(
    value,
    { courseUrl: alias, observedResourceRelationships: [] },
    [connection.host],
  )
    ? alias
    : null;
};

const courseIdentityCompatible = (
  existingCourse: CourseSelectData,
  observed: ObservedCourse,
) => {
  const existingSection = existingCourse.content?.section ?? null;
  const observedSection = observed.content?.section ?? null;
  const existingTerm = existingCourse.content?.term ?? existingCourse.term;
  const observedTerm = observed.content?.term ?? observed.term;
  return !(
    (existingSection &&
      observedSection &&
      normalizeTitle(existingSection) !== normalizeTitle(observedSection)) ||
    (existingTerm &&
      observedTerm &&
      normalizeTitle(existingTerm) !== normalizeTitle(observedTerm))
  );
};

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

const stableIdentityValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableIdentityValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'evidence')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableIdentityValue(child)]),
  );
};

const identityResourceFingerprint = (resource: ResourceIdentityRecord) =>
  JSON.stringify(stableIdentityValue(resource));

const ambiguousSourceKey = (
  resource: ResourceIdentityRecord,
  fallbackAlias: string | null,
) =>
  `ambiguous:${createHash('sha256')
    .update(
      JSON.stringify([fallbackAlias, identityResourceFingerprint(resource)]),
    )
    .digest('hex')}`;

const courseColumns = {
  id: CourseTable.id,
  sourceKey: CourseTable.sourceKey,
  content: CourseTable.content,
  contentChangedAt: CourseTable.contentChangedAt,
  localOverrides: CourseTable.localOverrides,
  localEditedAt: CourseTable.localEditedAt,
  suppressionId: CourseTable.suppressionId,
  suppressedAt: CourseTable.suppressedAt,
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

const applyLocalOverrides = <T extends object>(
  source: T,
  overrides: Partial<T> | null,
): T => {
  const effective = { ...source };
  if (!overrides) return effective;
  for (const field of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[field];
    if (value !== undefined) effective[field] = value;
  }
  return effective;
};

const updateLocalOverrideFields = <T extends object>(
  source: T,
  currentOverrides: Partial<T> | null,
  values: T,
  fields: readonly (keyof T)[],
): Partial<T> => {
  const nextOverrides = { ...currentOverrides } as Record<string, unknown>;
  for (const field of fields) {
    const key = String(field);
    if (Object.is(source[field], values[field])) delete nextOverrides[key];
    else nextOverrides[key] = values[field];
  }
  return nextOverrides as Partial<T>;
};

const courseSourceFields = (row: CourseLocalRow): CourseRecordFields => ({
  name: row.name,
  code: row.content ? row.content.code : row.code,
  term: row.content ? row.content.term : row.term,
  instructor: row.content
    ? row.content.instructors.join(', ') || null
    : row.instructor,
  description: row.content ? row.content.description : row.description,
});

const courseLocalView = (row: CourseLocalRow): CourseLocalOverrideView => {
  const source = courseSourceFields(row);
  const overrides = row.localOverrides ?? {};
  const effective = applyLocalOverrides(source, overrides);
  return {
    source,
    effective,
    overrides,
    overriddenFields: courseLocalOverrideFields.filter(
      (field) => overrides[field] !== undefined,
    ),
    localEditedAt: row.localEditedAt,
    origin: row.sourceKey.startsWith('manual:') ? 'manual' : 'source',
    sourceUncertain:
      !!row.url &&
      (row.localOverrides === null ||
        (!!row.contentChangedAt && row.contentChangedAt > row.lastSeenAt)),
  };
};

const childSourceFields = (row: SavedChildRow): CourseChildRecordFields => ({
  title: row.title,
  body: row.body,
  dateValue: row.dateValue,
  dateText: row.dateText,
});

const childLocalView = (row: SavedChildRow): CourseChildLocalOverrideView => {
  const source = childSourceFields(row);
  const overrides = row.localOverrides ?? {};
  const effective = applyLocalOverrides(source, overrides);
  return {
    source,
    effective,
    overrides,
    overriddenFields: courseChildLocalOverrideFields.filter(
      (field) => overrides[field] !== undefined,
    ),
    localEditedAt: row.localEditedAt,
    origin: row.sourceKey.startsWith('manual:') ? 'manual' : 'source',
    sourceUncertain:
      !row.sourceKey.startsWith('manual:') &&
      (row.localOverrides === null ||
        (!!row.contentChangedAt && row.contentChangedAt > row.lastSeenAt)),
  };
};

const toSummary = (
  row: CourseRow,
): Omit<CourseSummaryView, 'announcementCount' | 'assignmentCount'> => {
  const local = courseLocalView(row);
  return {
    id: row.id,
    connectionId: row.connectionId,
    content: row.content,
    contentChangedAt: row.contentChangedAt,
    local,
    name: local.effective.name,
    instructor: local.effective.instructor,
    description: local.effective.description,
    code: local.effective.code,
    term: local.effective.term,
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
  };
};

const toChild = (row: SavedChildRow): SavedCourseChildView => {
  const {
    userId: _userId,
    courseId: _courseId,
    sourceKey: _sourceKey,
    localOverrides: _localOverrides,
    localEditedAt: _localEditedAt,
    suppressionId: _suppressionId,
    suppressedAt: _suppressedAt,
    ...child
  } = row;
  const local = childLocalView(row);
  return {
    ...child,
    title: local.effective.title,
    body: local.effective.body,
    dateValue: local.effective.dateValue,
    dateText: local.effective.dateText,
    content: row.content,
    local,
  };
};

export const getCoursesSnapshot = (userId: string) => {
  const visibleCourseRows = readCourseRows(userId).filter(
    (row) => !row.suppressionId,
  );
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
        isNull(CourseAnnouncementTable.suppressionId),
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
        isNull(CourseAssignmentTable.suppressionId),
      ),
    )
    .all();
  return {
    courses: visibleCourseRows.map((row) => ({
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
): CourseDetailView | null => {
  const existingCourseRow = readCourseRows(userId).find(
    (row) => row.id === courseId && !row.suppressionId,
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
        isNull(CourseAnnouncementTable.suppressionId),
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
        isNull(CourseAssignmentTable.suppressionId),
      ),
    )
    .all();
  const courseSummary = toSummary(existingCourseRow);
  return {
    ...courseSummary,
    announcementCount: existingCourseAnnouncements.length,
    assignmentCount: existingCourseAssignments.length,
    instructor: courseSummary.instructor ?? null,
    description: courseSummary.description ?? null,
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
    reconciled.ambiguities.flatMap((ambiguity) => ambiguity.resources),
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
  const historicalConflicts = historicalAmbiguities.filter((ambiguity) => {
    const existingResources = ambiguity.resources.filter((resource) =>
      existingResourceSet.has(resource),
    );
    const incomingResources = ambiguity.resources.filter(
      (resource) => !existingResourceSet.has(resource),
    );
    if (ambiguity.reason === 'conflicting-source-ids')
      return existingResources.length > 0 && incomingResources.length > 0;
    return (
      ambiguity.reason === 'ambiguous-fallback' &&
      existingResources.length > 1 &&
      incomingResources.length > 0
    );
  });
  const historicalAmbiguousResources = new Set(
    historicalConflicts.flatMap((ambiguity) =>
      ambiguity.resources.filter(
        (resource) => !existingResourceSet.has(resource),
      ),
    ),
  );
  let ambiguous =
    reconciled.ambiguities.length > 0 || historicalConflicts.length > 0;
  const seen = new Set<string>();
  const uniqueRows = (rows: SavedChildRow[]) => [
    ...new Map(rows.map((row) => [row.id, row])).values(),
  ];
  const matchExisting = (
    keys: ReturnType<typeof resourceIdentityKeys>,
    sourceKey: string,
    resource: ChildIdentityResource,
  ): { rows: SavedChildRow[]; ambiguous: boolean } => {
    const rowsFor = (alias: string | null) =>
      alias ? uniqueRows(rowsByAlias.get(alias) ?? []) : [];
    const weakFallbackMatch = () => {
      const sourcePages = new Set([resource.evidence.sourceUrl]);
      if (keys.urlId && keys.itemUrl) {
        try {
          const itemUrl = new URL(keys.itemUrl);
          const parts = itemUrl.pathname.split('/').filter(Boolean);
          const last = parts.at(-1) ?? '';
          const previous = parts.at(-2) ?? '';
          const isCollectionPath = (part: string) =>
            /^(?:assignment|assignments|announcement|announcements)$/i.test(
              part,
            );
          if (isCollectionPath(last)) {
            itemUrl.search = '';
            itemUrl.hash = '';
            sourcePages.add(itemUrl.href);
          } else if (isCollectionPath(previous)) {
            parts.pop();
            itemUrl.pathname = `/${parts.join('/')}`;
            itemUrl.search = '';
            itemUrl.hash = '';
            sourcePages.add(itemUrl.href);
          }
        } catch {
          // A malformed detail URL cannot supply a fallback scope.
        }
      }
      const fallbackAliases = [...sourcePages].flatMap((sourcePageUrl) => {
        const fallback = resourceIdentityKeys(scope, {
          ...resource,
          sourceId: null,
          url: sourcePageUrl,
          evidence: { ...resource.evidence, sourceUrl: sourcePageUrl },
        }).fallback;
        return fallback ? [fallback] : [];
      });
      const weakRows = uniqueRows(
        fallbackAliases.flatMap((alias) => rowsFor(alias)),
      ).filter((row) => {
        const saved = existingKeys.get(row);
        return !saved?.sourceId && !saved?.urlId && !saved?.itemUrl;
      });
      return {
        rows: weakRows.length === 1 ? weakRows : [],
        ambiguous: weakRows.length > 1,
      };
    };
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
      if (unknownIdentity.length)
        return {
          rows: unknownIdentity.length === 1 ? unknownIdentity : [],
          ambiguous: unknownIdentity.length > 1,
        };
      return weakFallbackMatch();
    }
    if (keys.urlId) {
      const sameId = idMatches(keys.urlId);
      if (sameId.length) return { rows: sameId, ambiguous: false };
      const fallbackMatch = weakFallbackMatch();
      if (fallbackMatch.rows.length || fallbackMatch.ambiguous)
        return fallbackMatch;
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
      const fallbackMatch = weakFallbackMatch();
      if (fallbackMatch.rows.length || fallbackMatch.ambiguous)
        return fallbackMatch;
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
    const identityConflict = candidate.resources.some(
      (resource) =>
        ambiguousInputResources.has(resource) ||
        historicalAmbiguousResources.has(resource),
    );
    const unresolvedWeakIdentity =
      identityConflict && !keys.sourceId && !keys.urlId && !keys.itemUrl;
    const exactUnresolvedRows = unresolvedWeakIdentity
      ? existingChildren.filter((row) => {
          const savedResource = identityResourceByRow.get(row);
          const savedKeys = savedResource
            ? resourceIdentityKeys(scope, savedResource)
            : null;
          return (
            !!savedResource &&
            !!savedKeys &&
            savedKeys.fallback === keys.fallback &&
            identityResourceFingerprint({
              ...savedResource,
              url: savedKeys.itemUrl,
            }) ===
              identityResourceFingerprint({
                ...merged.resource!,
                url: keys.itemUrl,
              })
          );
        })
      : [];
    if (exactUnresolvedRows.length > 1) {
      ambiguous = true;
      continue;
    }
    const sourceKey = unresolvedWeakIdentity
      ? (exactUnresolvedRows[0]?.sourceKey ??
        ambiguousSourceKey(merged.resource, keys.fallback))
      : identitySourceKey(keys);
    if (
      deletedSourceKeys.has(sourceKey) ||
      keys.aliases.some((alias) => deletedSourceKeys.has(alias))
    )
      continue;
    const match = unresolvedWeakIdentity
      ? { rows: exactUnresolvedRows, ambiguous: false }
      : matchExisting(keys, sourceKey, merged.resource);
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
    if (existingCourseChild?.suppressionId) {
      seen.add(existingCourseChild.sourceKey);
      continue;
    }
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
    const localOverrides =
      existingCourseChild?.localOverrides ?? (complete ? {} : null);
    const localEditedAt = existingCourseChild?.localEditedAt ?? null;
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
          localOverrides,
          localEditedAt,
          sourceKey: existingCourseChild.sourceKey,
          lastSeenAt,
          contentChangedAt,
        })
        .where(eq(table.id, existingCourseChild.id))
        .run();
      Object.assign(existingCourseChild, {
        ...fields,
        localOverrides,
        localEditedAt,
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
        localOverrides,
        localEditedAt,
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
  url: string,
  observed: ObservedCourse,
  now: string,
) => {
  const externalId = observed.externalId ?? observed.content?.sourceId ?? null;
  const sourceKey = courseSourceKey(connection.id, externalId, url, observed);
  const courseAlias = schoologyCourseAlias(connection, url);
  const existingCourses = tx
    .select()
    .from(CourseTable)
    .where(
      and(
        eq(CourseTable.userId, userId),
        eq(CourseTable.connectionId, connection.id),
      ),
    )
    .all();
  const explicitMatches = externalId
    ? existingCourses.filter(
        (course) =>
          (course.externalId ?? course.content?.sourceId ?? null) ===
            externalId ||
          (course.sourceKey === courseKey(connection.id, externalId, url) &&
            !course.externalId),
      )
    : [];
  if (explicitMatches.length > 1)
    return {
      id: null,
      sourceKey: null,
      created: false,
      updated: false,
      ambiguous: true,
      previousCoverage: null,
    };
  let existingCourse = explicitMatches[0];
  if (!existingCourse) {
    const matchingUrlCourses = existingCourses.filter(
      (course) =>
        (course.url === url ||
          (courseAlias !== null &&
            schoologyCourseAlias(connection, course.url) === courseAlias)) &&
        courseIdentityCompatible(course, observed),
    );
    const adoptableCourses = externalId
      ? matchingUrlCourses.filter(
          (course) => !(course.externalId ?? course.content?.sourceId),
        )
      : matchingUrlCourses;
    if (adoptableCourses.length > 1)
      return {
        id: null,
        sourceKey: null,
        created: false,
        updated: false,
        ambiguous: true,
        previousCoverage: null,
      };
    existingCourse = adoptableCourses[0];
  }
  if (existingCourse?.suppressionId)
    return {
      id: existingCourse.id,
      sourceKey: existingCourse.sourceKey,
      created: false,
      updated: false,
      ambiguous: false,
      suppressed: true,
      previousCoverage: {
        announcementsSyncedAt: existingCourse.announcementsSyncedAt,
        assignmentsSyncedAt: existingCourse.assignmentsSyncedAt,
      },
    };
  const preservesAliasKey =
    existingCourse &&
    courseAlias !== null &&
    existingCourse.sourceKey.startsWith(`${connection.id} `) &&
    schoologyCourseAlias(
      connection,
      existingCourse.sourceKey.slice(connection.id.length + 1).split(' ')[0] ??
        '',
    ) === courseAlias;
  const persistedSourceKey = existingCourse
    ? externalId &&
      (existingCourse.externalId ?? existingCourse.content?.sourceId) !==
        externalId
      ? courseKey(connection.id, externalId, url)
      : !externalId &&
          !existingCourse.externalId &&
          (observed.content?.section || observed.content?.term || observed.term)
        ? preservesAliasKey
          ? existingCourse.sourceKey
          : sourceKey
        : existingCourse.sourceKey
    : sourceKey;
  const coverage = coverageOf(observed, now);
  // Only what this scan really read replaces a stored value, so a thinner
  // result cannot blank out details an earlier refresh found.
  const fields = {
    name: normalizeTitle(observed.name) || existingCourse?.name || url,
    code: observed.code ?? existingCourse?.code ?? null,
    term: observed.term ?? existingCourse?.term ?? null,
    instructor: observed.instructor ?? existingCourse?.instructor ?? null,
    description: observed.description ?? existingCourse?.description ?? null,
    externalId:
      externalId ??
      existingCourse?.externalId ??
      existingCourse?.content?.sourceId ??
      null,
    content: observed.content ?? existingCourse?.content ?? null,
    localOverrides:
      existingCourse?.localOverrides ??
      (courseScanSucceeded(observed.overview) ? {} : null),
    localEditedAt: existingCourse?.localEditedAt ?? null,
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
    if (existingCourse.sourceKey !== persistedSourceKey) {
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
            courseSourceKey: persistedSourceKey,
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
        sourceKey: persistedSourceKey,
        contentChangedAt: changed ? now : existingCourse.contentChangedAt,
      })
      .where(eq(CourseTable.id, existingCourse.id))
      .run();
    return {
      id: existingCourse.id,
      sourceKey: persistedSourceKey,
      created: false,
      updated: changed || !existingCourse.active,
      ambiguous: false,
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
      sourceKey: persistedSourceKey,
      firstSeenAt: now,
      contentChangedAt: now,
      ...fields,
    })
    .run();
  return {
    id,
    sourceKey: persistedSourceKey,
    created: true,
    updated: false,
    ambiguous: false,
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
  let ambiguous = false;
  const deletedCourseTombstones = tx
    .select()
    .from(CourseRecordTombstoneTable)
    .where(
      and(
        eq(CourseRecordTombstoneTable.userId, userId),
        eq(CourseRecordTombstoneTable.connectionId, connection.id),
        eq(CourseRecordTombstoneTable.kind, 'courses'),
      ),
    )
    .all();
  for (const observed of scan.courses) {
    const url = observedUrl(observed.url, connection.host);
    if (!url) {
      untrusted = true;
      continue;
    }
    const externalId =
      observed.externalId ?? observed.content?.sourceId ?? null;
    const sourceKey = courseSourceKey(
      scan.connectionId,
      externalId,
      url,
      observed,
    );
    const urlAlias = courseKey(scan.connectionId, null, url);
    const matchingTombstones = deletedCourseTombstones.filter(
      (tombstone) =>
        tombstone.resourceSourceKey === sourceKey ||
        tombstone.resourceSourceKey === urlAlias,
    );
    const blockedTombstones = matchingTombstones.filter((tombstone) => {
      if (!externalId || tombstone.resourceSourceKey !== urlAlias) return true;
      const hiddenCourse = tx
        .select()
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.connectionId, connection.id),
            eq(CourseTable.sourceKey, tombstone.courseSourceKey),
          ),
        )
        .get();
      const hiddenExternalId =
        hiddenCourse?.externalId ?? hiddenCourse?.content?.sourceId ?? null;
      return !hiddenExternalId || hiddenExternalId === externalId;
    });
    if (blockedTombstones.length) {
      for (const tombstone of blockedTombstones) {
        const hiddenCourse = tx
          .select()
          .from(CourseTable)
          .where(
            and(
              eq(CourseTable.userId, userId),
              eq(CourseTable.connectionId, connection.id),
              eq(CourseTable.sourceKey, tombstone.courseSourceKey),
            ),
          )
          .get();
        if (hiddenCourse) seen.add(hiddenCourse.sourceKey);
      }
      continue;
    }
    const upsertedCourse = upsertCourse(
      tx,
      userId,
      connection,
      url,
      observed,
      now,
    );
    if (
      upsertedCourse.ambiguous ||
      !upsertedCourse.id ||
      !upsertedCourse.sourceKey
    ) {
      ambiguous = true;
      continue;
    }
    seen.add(upsertedCourse.sourceKey);
    if (upsertedCourse.suppressed) continue;
    if (upsertedCourse.created) metrics.recordsCreated += 1;
    if (upsertedCourse.updated) metrics.recordsUpdated += 1;
    const ambiguousAnnouncements = applyChildren(
      tx,
      CourseAnnouncementTable,
      userId,
      upsertedCourse.id,
      upsertedCourse.sourceKey,
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
      upsertedCourse.sourceKey,
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
  const outcome =
    scan.outcome === 'complete' && (untrusted || ambiguous)
      ? 'partial'
      : scan.outcome;
  if (outcome !== 'complete')
    return { outcome, acceptedCourseCount: seen.size };
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
  return { outcome, acceptedCourseCount: seen.size };
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
      const listResult =
        scan.outcome === 'complete' || scan.outcome === 'partial'
          ? applyCourseList(tx, userId, existingConnection, scan, now, metrics)
          : null;
      const outcome = listResult?.outcome ?? scan.outcome;
      const succeeded = courseScanSucceeded(outcome);
      if (
        existingConnection.status === 'needs-sign-in' &&
        (succeeded ||
          (outcome === 'partial' &&
            (listResult?.acceptedCourseCount ?? scan.courses.length) > 0))
      )
        tx.update(AcademicConnectionTable)
          .set({ status: 'confirmed' })
          .where(eq(AcademicConnectionTable.id, existingConnection.id))
          .run();
      tx.insert(CourseSourceTable)
        .values({
          userId,
          connectionId: scan.connectionId,
          outcome,
          message: scan.message,
          lastAttemptedAt: now,
          lastSuccessfulAt: succeeded ? now : null,
        })
        .onConflictDoUpdate({
          target: [CourseSourceTable.userId, CourseSourceTable.connectionId],
          set: {
            outcome,
            message: scan.message,
            lastAttemptedAt: now,
            ...(succeeded ? { lastSuccessfulAt: now } : {}),
          },
        })
        .run();
    }
  });
  options.onMetrics?.(metrics);
  notifyCourseChanges(userId);
  return getCoursesSnapshot(userId);
};

export const getCourseRefreshTarget = (userId: string, courseId: string) => {
  const existingCourse = db
    .select()
    .from(CourseTable)
    .where(and(eq(CourseTable.userId, userId), eq(CourseTable.id, courseId)))
    .get();
  return existingCourse && !existingCourse.suppressionId
    ? existingCourse
    : null;
};

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
    const observedExternalId =
      observed.externalId ?? observed.content?.sourceId ?? null;
    const existingExternalId =
      existingCourse.externalId ?? existingCourse.content?.sourceId ?? null;
    if (
      observedExternalId &&
      existingExternalId &&
      observedExternalId !== existingExternalId
    )
      return;
    const now = new Date().toISOString();
    const upsertedCourse = upsertCourse(
      tx,
      userId,
      existingConnection,
      url,
      observed,
      now,
    );
    if (
      upsertedCourse.ambiguous ||
      !upsertedCourse.id ||
      upsertedCourse.id !== courseId ||
      !upsertedCourse.sourceKey ||
      !upsertedCourse.previousCoverage
    )
      return;
    const ambiguousAnnouncements = applyChildren(
      tx,
      CourseAnnouncementTable,
      userId,
      courseId,
      upsertedCourse.sourceKey,
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
      upsertedCourse.sourceKey,
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
    const values: CourseRecordFields = {
      name: data.values.name,
      code: data.values.code || null,
      term: data.values.term || null,
      instructor: data.values.instructor || null,
      description: data.values.description || null,
    };
    if (existingCourse.sourceKey.startsWith('manual:')) {
      db.update(CourseTable)
        .set(values)
        .where(and(eq(CourseTable.id, data.id), eq(CourseTable.userId, userId)))
        .run();
    } else {
      const localOverrides = updateLocalOverrideFields(
        courseSourceFields(existingCourse),
        existingCourse.localOverrides,
        values,
        courseLocalOverrideFields,
      ) as CourseLocalOverrideValues;
      db.update(CourseTable)
        .set({
          localOverrides,
          localEditedAt: Object.keys(localOverrides).length ? now : null,
        })
        .where(and(eq(CourseTable.id, data.id), eq(CourseTable.userId, userId)))
        .run();
    }
  } else {
    const table =
      data.kind === 'assignments'
        ? CourseAssignmentTable
        : CourseAnnouncementTable;
    const scope = and(
      eq(table.userId, userId),
      eq(table.courseId, data.courseId),
      eq(table.id, data.id),
      isNull(table.suppressionId),
    );
    const existingCourseChild = db.select().from(table).where(scope).get();
    if (!existingCourseChild)
      throw new Error('This item is no longer available.');
    const values = data.values;
    const sourceFields = childSourceFields(existingCourseChild);
    const existingOverrides = existingCourseChild.localOverrides;
    const effectiveFields = applyLocalOverrides(
      sourceFields,
      existingOverrides,
    );
    const hasLocalDateOverride =
      existingOverrides?.dateValue !== undefined ||
      existingOverrides?.dateText !== undefined;
    const previousDate = hasLocalDateOverride
      ? legacyDateFrom({
          dateValue: effectiveFields.dateValue,
          dateText: effectiveFields.dateText,
        })
      : academicDateFor(existingCourseChild);
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
    const editedFields: CourseChildRecordFields = {
      title: values.title,
      body: values.body || null,
      dateValue: dateChanged ? dateValueFrom(date) : effectiveFields.dateValue,
      dateText: dateChanged
        ? (date?.original ?? null)
        : effectiveFields.dateText,
    };
    if (existingCourseChild.sourceKey.startsWith('manual:')) {
      const content = existingCourseChild.content;
      db.update(table)
        .set({
          title: editedFields.title,
          body: editedFields.body,
          dateText: editedFields.dateText,
          dateValue: editedFields.dateValue,
          content: content
            ? 'due' in content
              ? {
                  ...content,
                  title: editedFields.title,
                  description: editedFields.body,
                  due: date,
                }
              : {
                  ...content,
                  title: editedFields.title,
                  body: editedFields.body,
                  published: date,
                }
            : null,
          contentChangedAt: now,
        })
        .where(scope)
        .run();
    } else {
      const fieldsToUpdate = dateChanged
        ? courseChildLocalOverrideFields
        : (['title', 'body'] as const);
      const localOverrides = updateLocalOverrideFields(
        sourceFields,
        existingOverrides,
        editedFields,
        fieldsToUpdate,
      ) as CourseChildLocalOverrideValues;
      db.update(table)
        .set({
          localOverrides,
          localEditedAt: Object.keys(localOverrides).length ? now : null,
        })
        .where(scope)
        .run();
    }
  }
  notifyCourseChanges(userId, data.courseId);
};

const validateOverrideFields = <T extends string>(
  fields: unknown,
  allowedFields: readonly T[],
): T[] => {
  if (
    !Array.isArray(fields) ||
    !fields.length ||
    fields.length > allowedFields.length ||
    fields.some(
      (field) =>
        typeof field !== 'string' || !allowedFields.includes(field as T),
    ) ||
    new Set(fields).size !== fields.length
  )
    throw new Error('Choose valid fields to reset.');
  return fields as T[];
};

export const resetCourseRecordOverrides = (
  userId: string,
  input: ResetCourseRecordOverridesInput,
) => {
  const data = courseRecordSchema.parse(input);
  const now = new Date().toISOString();
  const existingCourse = getCourseRefreshTarget(userId, data.courseId);
  if (!existingCourse) throw new Error('This course is no longer available.');
  if (data.kind === 'courses') {
    if (data.id !== data.courseId) throw new Error('Choose this course.');
    const fields = validateOverrideFields(
      input.fields,
      courseLocalOverrideFields,
    );
    if (existingCourse.sourceKey.startsWith('manual:')) return;
    const existingOverrides = existingCourse.localOverrides ?? {};
    const localOverrides = { ...existingOverrides };
    for (const field of fields) delete localOverrides[field];
    db.update(CourseTable)
      .set({
        localOverrides,
        localEditedAt: Object.keys(localOverrides).length ? now : null,
      })
      .where(and(eq(CourseTable.userId, userId), eq(CourseTable.id, data.id)))
      .run();
  } else {
    const fields = validateOverrideFields(
      input.fields,
      courseChildLocalOverrideFields,
    );
    const table =
      data.kind === 'assignments'
        ? CourseAssignmentTable
        : CourseAnnouncementTable;
    const existingCourseChild = db
      .select()
      .from(table)
      .where(
        and(
          eq(table.userId, userId),
          eq(table.courseId, data.courseId),
          eq(table.id, data.id),
          isNull(table.suppressionId),
        ),
      )
      .get();
    if (!existingCourseChild)
      throw new Error('This item is no longer available.');
    if (existingCourseChild.sourceKey.startsWith('manual:')) return;
    const localOverrides = {
      ...existingCourseChild.localOverrides,
    } as CourseChildLocalOverrideValues;
    for (const field of fields) delete localOverrides[field];
    db.update(table)
      .set({
        localOverrides,
        localEditedAt: Object.keys(localOverrides).length ? now : null,
      })
      .where(
        and(
          eq(table.userId, userId),
          eq(table.courseId, data.courseId),
          eq(table.id, data.id),
        ),
      )
      .run();
  }
  notifyCourseChanges(userId, data.courseId);
};

export const listCourseRecordSuppressions = (
  userId: string,
  input: ListCourseRecordSuppressionsSchema = {},
): CourseRecordSuppressionView[] | null => {
  const parsed = listCourseRecordSuppressionsSchema.safeParse(input);
  if (!parsed.success) return null;
  try {
    const tombstones = db
      .select()
      .from(CourseRecordTombstoneTable)
      .where(eq(CourseRecordTombstoneTable.userId, userId))
      .limit(20_001)
      .all();
    const courseRows = db
      .select()
      .from(CourseTable)
      .where(eq(CourseTable.userId, userId))
      .limit(20_001)
      .all();
    const assignmentRows = db
      .select()
      .from(CourseAssignmentTable)
      .where(eq(CourseAssignmentTable.userId, userId))
      .limit(20_001)
      .all();
    const announcementRows = db
      .select()
      .from(CourseAnnouncementTable)
      .where(eq(CourseAnnouncementTable.userId, userId))
      .limit(20_001)
      .all();
    if (
      tombstones.length > 20_000 ||
      courseRows.length > 20_000 ||
      assignmentRows.length > 20_000 ||
      announcementRows.length > 20_000
    )
      return null;

    type SuppressionEntry = {
      connectionId: string;
      courseSourceKey: string;
      kind: CourseRecordSuppressionDTO['kind'];
      resourceSourceKey: string;
      suppressionId: string | null;
      createdAt: string;
    };
    type SuppressionGroup = {
      suppressionId: string;
      legacy: boolean;
      entries: SuppressionEntry[];
    };
    const groups = new Map<string, SuppressionGroup>();
    const addEntry = (entry: SuppressionEntry) => {
      const suppressionId =
        entry.suppressionId ??
        `legacy:${createHash('sha256')
          .update(JSON.stringify([entry.connectionId, entry.kind]))
          .digest('hex')}`;
      const group = groups.get(suppressionId) ?? {
        suppressionId,
        legacy: entry.suppressionId === null,
        entries: [],
      };
      group.entries.push(entry);
      groups.set(suppressionId, group);
    };
    for (const row of tombstones)
      addEntry({
        connectionId: row.connectionId,
        courseSourceKey: row.courseSourceKey,
        kind: row.kind,
        resourceSourceKey: row.resourceSourceKey,
        suppressionId: row.suppressionId,
        createdAt: row.createdAt,
      });

    const courseById = new Map(courseRows.map((row) => [row.id, row]));
    const courseBySuppressionId = new Map(
      courseRows
        .filter((row) => row.suppressionId)
        .map((row) => [row.suppressionId!, row]),
    );
    const courseByScopeKey = new Map(
      courseRows.map((row) => [
        JSON.stringify([row.connectionId ?? '', row.sourceKey]),
        row,
      ]),
    );
    const assignmentBySuppressionId = new Map(
      assignmentRows
        .filter((row) => row.suppressionId)
        .map((row) => [row.suppressionId!, row]),
    );
    const announcementBySuppressionId = new Map(
      announcementRows
        .filter((row) => row.suppressionId)
        .map((row) => [row.suppressionId!, row]),
    );
    const connectionById = new Map(
      db
        .select({
          id: AcademicConnectionTable.id,
          name: AcademicConnectionTable.name,
        })
        .from(AcademicConnectionTable)
        .where(eq(AcademicConnectionTable.userId, userId))
        .all()
        .map((connection) => [connection.id, connection]),
    );
    for (const row of courseRows)
      if (row.suppressionId)
        addEntry({
          connectionId: row.connectionId ?? '',
          courseSourceKey: row.sourceKey,
          kind: 'courses',
          resourceSourceKey: row.sourceKey,
          suppressionId: row.suppressionId,
          createdAt: row.suppressedAt ?? row.lastSeenAt,
        });
    for (const row of assignmentRows)
      if (row.suppressionId) {
        const course = courseById.get(row.courseId);
        if (!course) continue;
        addEntry({
          connectionId: course.connectionId ?? '',
          courseSourceKey: course.sourceKey,
          kind: 'assignments',
          resourceSourceKey: row.sourceKey,
          suppressionId: row.suppressionId,
          createdAt: row.suppressedAt ?? row.lastSeenAt,
        });
      }
    for (const row of announcementRows)
      if (row.suppressionId) {
        const course = courseById.get(row.courseId);
        if (!course) continue;
        addEntry({
          connectionId: course.connectionId ?? '',
          courseSourceKey: course.sourceKey,
          kind: 'announcements',
          resourceSourceKey: row.sourceKey,
          suppressionId: row.suppressionId,
          createdAt: row.suppressedAt ?? row.lastSeenAt,
        });
      }

    const courseIdFilter =
      parsed.data.courseId && parsed.data.courseId !== '*'
        ? (courseRows.find((row) => row.id === parsed.data.courseId)
            ?.sourceKey ?? parsed.data.courseId)
        : null;
    const kindLabel = (kind: CourseRecordSuppressionDTO['kind']) => {
      switch (kind) {
        case 'courses':
          return 'courses';
        case 'assignments':
          return 'assignments';
        case 'announcements':
          return 'announcements';
      }
    };
    const listed = [...groups.values()].flatMap((group) => {
      const matchingEntries = group.entries.filter(
        (entry) =>
          (!parsed.data.connectionId ||
            entry.connectionId === parsed.data.connectionId) &&
          (!courseIdFilter || entry.courseSourceKey === courseIdFilter) &&
          (!parsed.data.kind || entry.kind === parsed.data.kind),
      );
      if (!matchingEntries.length) return [];
      const kind =
        parsed.data.kind ??
        (matchingEntries.some((entry) => entry.kind === 'courses')
          ? 'courses'
          : matchingEntries[0]!.kind);
      const matchingEntry = matchingEntries[0]!;
      const groupCourse =
        courseBySuppressionId.get(group.suppressionId) ??
        courseByScopeKey.get(
          JSON.stringify([
            matchingEntry.connectionId,
            matchingEntry.courseSourceKey,
          ]),
        );
      const childRow =
        kind === 'assignments'
          ? assignmentBySuppressionId.get(group.suppressionId)
          : kind === 'announcements'
            ? announcementBySuppressionId.get(group.suppressionId)
            : undefined;
      const connection = connectionById.get(matchingEntry.connectionId);
      const title = group.legacy
        ? `Legacy hidden ${kindLabel(kind)}`
        : kind === 'courses'
          ? (groupCourse?.name ?? 'Hidden course')
          : (childRow?.title ??
            `Hidden ${kind === 'assignments' ? 'assignment' : 'announcement'}`);
      const base = courseRecordSuppressionSchema.parse({
        suppressionId: group.suppressionId,
        kind,
        title,
        context:
          kind === 'courses'
            ? (groupCourse?.sourceName ?? connection?.name ?? null)
            : (groupCourse?.name ?? connection?.name ?? null),
        hiddenAt:
          groupCourse?.suppressedAt ??
          childRow?.suppressedAt ??
          matchingEntries
            .map((entry) => entry.createdAt)
            .sort()
            .at(-1)!,
        legacy: group.legacy,
      });
      return [
        {
          ...base,
          restoreInput: group.legacy
            ? {
                scope: 'legacy' as const,
                connectionId: matchingEntry.connectionId,
                courseId: '*',
                kind,
              }
            : {
                scope: 'group' as const,
                suppressionId: group.suppressionId,
              },
        },
      ];
    });
    const cursor = parsed.data.cursor;
    return listed
      .filter((suppression) => !cursor || suppression.suppressionId > cursor)
      .sort((left, right) =>
        left.suppressionId.localeCompare(right.suppressionId),
      )
      .slice(0, parsed.data.limit ?? 50);
  } catch {
    return null;
  }
};

export const restoreCourseRecordSuppression = (
  userId: string,
  input: RestoreCourseRecordSuppressionSchema,
) => {
  const data = restoreCourseRecordSuppressionSchema.parse(input);
  const changed = db.transaction((tx) => {
    if (data.scope === 'legacy') {
      const existingCourse =
        data.courseId === '*'
          ? undefined
          : tx
              .select({ sourceKey: CourseTable.sourceKey })
              .from(CourseTable)
              .where(
                and(
                  eq(CourseTable.userId, userId),
                  eq(CourseTable.id, data.courseId),
                ),
              )
              .get();
      const legacyScope = and(
        eq(CourseRecordTombstoneTable.userId, userId),
        eq(CourseRecordTombstoneTable.connectionId, data.connectionId),
        eq(CourseRecordTombstoneTable.kind, data.kind),
        isNull(CourseRecordTombstoneTable.suppressionId),
        ...(data.courseId === '*'
          ? []
          : [
              eq(
                CourseRecordTombstoneTable.courseSourceKey,
                existingCourse?.sourceKey ?? data.courseId,
              ),
            ]),
      );
      return (
        tx.delete(CourseRecordTombstoneTable).where(legacyScope).run().changes >
        0
      );
    }

    const suppressedCourses = tx
      .select({ id: CourseTable.id })
      .from(CourseTable)
      .where(
        and(
          eq(CourseTable.userId, userId),
          eq(CourseTable.suppressionId, data.suppressionId),
        ),
      )
      .all();
    const suppressedAssignments = tx
      .select({ id: CourseAssignmentTable.id })
      .from(CourseAssignmentTable)
      .where(
        and(
          eq(CourseAssignmentTable.userId, userId),
          eq(CourseAssignmentTable.suppressionId, data.suppressionId),
        ),
      )
      .all();
    const suppressedAnnouncements = tx
      .select({ id: CourseAnnouncementTable.id })
      .from(CourseAnnouncementTable)
      .where(
        and(
          eq(CourseAnnouncementTable.userId, userId),
          eq(CourseAnnouncementTable.suppressionId, data.suppressionId),
        ),
      )
      .all();
    const hasGroupTombstone = tx
      .select({ id: CourseRecordTombstoneTable.id })
      .from(CourseRecordTombstoneTable)
      .where(
        and(
          eq(CourseRecordTombstoneTable.userId, userId),
          eq(CourseRecordTombstoneTable.suppressionId, data.suppressionId),
        ),
      )
      .get();
    if (
      !suppressedCourses.length &&
      !suppressedAssignments.length &&
      !suppressedAnnouncements.length &&
      !hasGroupTombstone
    )
      return false;

    for (const table of [
      CourseTable,
      CourseAssignmentTable,
      CourseAnnouncementTable,
    ])
      tx.update(table)
        .set({ suppressionId: null, suppressedAt: null })
        .where(
          and(
            eq(table.userId, userId),
            eq(table.suppressionId, data.suppressionId),
          ),
        )
        .run();
    tx.delete(CourseRecordTombstoneTable)
      .where(
        and(
          eq(CourseRecordTombstoneTable.userId, userId),
          eq(CourseRecordTombstoneTable.suppressionId, data.suppressionId),
        ),
      )
      .run();
    return true;
  });
  if (changed) notifyCourseChanges(userId);
};

export const deleteCourseRecord = (
  userId: string,
  input: CourseRecordSchema,
) => {
  const data = courseRecordSchema.parse(input);
  db.transaction((tx) => {
    const now = new Date().toISOString();
    const existingCourse = tx
      .select()
      .from(CourseTable)
      .where(
        and(eq(CourseTable.userId, userId), eq(CourseTable.id, data.courseId)),
      )
      .get();
    if (!existingCourse || existingCourse.suppressionId)
      throw new Error('This course is no longer available.');

    const insertSuppressionTombstones = (
      connectionId: string | null,
      courseSourceKey: string,
      kind: CourseRecordSuppressionDTO['kind'],
      suppressionId: string,
      resourceSourceKeys: string[],
    ) => {
      if (!connectionId) return;
      const values = [...new Set(resourceSourceKeys.filter(Boolean))].map(
        (resourceSourceKey) => ({
          id: randomUUID(),
          userId,
          connectionId,
          courseSourceKey,
          kind,
          resourceSourceKey,
          suppressionId,
          createdAt: now,
        }),
      );
      if (values.length)
        tx.insert(CourseRecordTombstoneTable)
          .values(values)
          .onConflictDoNothing()
          .run();
    };

    if (data.kind === 'courses') {
      if (data.id !== data.courseId)
        throw new Error('This course is no longer available.');
      if (existingCourse.sourceKey.startsWith('manual:')) {
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
        return;
      }

      const suppressionId = randomUUID();
      const externalId =
        existingCourse.externalId ?? existingCourse.content?.sourceId ?? null;
      const contentUrl = existingCourse.content?.url
        ? observedUrl(existingCourse.content.url, existingCourse.sourceHost)
        : null;
      insertSuppressionTombstones(
        existingCourse.connectionId,
        existingCourse.sourceKey,
        'courses',
        suppressionId,
        [
          existingCourse.sourceKey,
          ...(existingCourse.connectionId
            ? [
                courseKey(
                  existingCourse.connectionId,
                  externalId,
                  existingCourse.url,
                ),
                courseKey(
                  existingCourse.connectionId,
                  null,
                  existingCourse.url,
                ),
              ]
            : []),
          ...(contentUrl && existingCourse.connectionId
            ? [courseKey(existingCourse.connectionId, null, contentUrl)]
            : []),
        ],
      );
      for (const [kind, table] of [
        ['assignments', CourseAssignmentTable],
        ['announcements', CourseAnnouncementTable],
      ] as const) {
        const children = tx
          .select()
          .from(table)
          .where(
            and(
              eq(table.userId, userId),
              eq(table.courseId, data.courseId),
              isNull(table.suppressionId),
            ),
          )
          .all();
        for (const child of children) {
          if (child.sourceKey.startsWith('manual:')) continue;
          const keys = existingCourse.connectionId
            ? resourceIdentityKeys(
                {
                  accountId: userId,
                  connectionId: existingCourse.connectionId,
                  courseId: data.courseId,
                  kind,
                },
                savedChildIdentityResource(child),
              )
            : null;
          insertSuppressionTombstones(
            existingCourse.connectionId,
            existingCourse.sourceKey,
            kind,
            suppressionId,
            [child.sourceKey, ...(keys?.aliases ?? [])],
          );
        }
        tx.update(table)
          .set({ suppressionId, suppressedAt: now })
          .where(
            and(
              eq(table.userId, userId),
              eq(table.courseId, data.courseId),
              isNull(table.suppressionId),
            ),
          )
          .run();
      }
      tx.update(CourseTable)
        .set({ suppressionId, suppressedAt: now })
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.id, data.courseId),
          ),
        )
        .run();
      return;
    }

    const table =
      data.kind === 'assignments'
        ? CourseAssignmentTable
        : CourseAnnouncementTable;
    const existingCourseChild = tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.userId, userId),
          eq(table.courseId, data.courseId),
          eq(table.id, data.id),
          isNull(table.suppressionId),
        ),
      )
      .get();
    if (!existingCourseChild)
      throw new Error('This item is no longer available.');
    if (existingCourseChild.sourceKey.startsWith('manual:')) {
      tx.delete(table)
        .where(
          and(
            eq(table.userId, userId),
            eq(table.courseId, data.courseId),
            eq(table.id, data.id),
          ),
        )
        .run();
      return;
    }

    const suppressionId = randomUUID();
    const keys = existingCourse.connectionId
      ? resourceIdentityKeys(
          {
            accountId: userId,
            connectionId: existingCourse.connectionId,
            courseId: data.courseId,
            kind: data.kind,
          },
          savedChildIdentityResource(existingCourseChild),
        )
      : null;
    insertSuppressionTombstones(
      existingCourse.connectionId,
      existingCourse.sourceKey,
      data.kind,
      suppressionId,
      [existingCourseChild.sourceKey, ...(keys?.aliases ?? [])],
    );
    tx.update(table)
      .set({ suppressionId, suppressedAt: now })
      .where(
        and(
          eq(table.userId, userId),
          eq(table.courseId, data.courseId),
          eq(table.id, data.id),
        ),
      )
      .run();
  });
  notifyCourseChanges(userId, data.kind === 'courses' ? null : data.courseId);
};
