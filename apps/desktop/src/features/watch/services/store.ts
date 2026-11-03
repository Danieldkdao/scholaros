import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseTable,
  SettingTable,
  WatchTargetTable,
} from '../../../db/schema';
import { watchTargetFailureCategories } from '../../../db/shared';
import { parseWatchUrl } from '../lib/watch-url';
import { getEffectiveWatchTargetInputs } from '../lib/watch-url';
import { isWithinCoursePath } from '../../courses/lib/course-content';
import { watchSettingsSchema, watchUrlsSchema } from '../schemas';
import type {
  WatchObservation,
  WatchFailureRecord,
  WatchCheckSchedule,
  WatchProcessedRevision,
  WatchSettings,
  WatchTargetUpsert,
  WatchHealthSummary,
  WatchRuntimeStatus,
} from '../types';
import type { WatchTargetSelectData } from '../../../db/schema';

const emptyWatchSettings: WatchSettings = {
  watchEnabled: false,
  watchUrls: [],
};

const fingerprintPattern = /^[0-9a-f]{64}$/;

export const getLastWatchReconciledAt = (userId: string): string | null =>
  db
    .select({ reconciledAt: SettingTable.watchReconciledAt })
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get()?.reconciledAt ?? null;

export const recordWatchReconciledAt = (
  userId: string,
  reconciledAt: string,
) => {
  if (!Number.isFinite(Date.parse(reconciledAt))) return;
  db.update(SettingTable)
    .set({ watchReconciledAt: reconciledAt })
    .where(
      and(
        eq(SettingTable.userId, userId),
        eq(SettingTable.watchEnabled, true),
        eq(SettingTable.consent, true),
      ),
    )
    .run();
};

export const getWatchSettings = (userId: string): WatchSettings => {
  const existingSettings = db
    .select({
      watchEnabled: SettingTable.watchEnabled,
      watchUrls: SettingTable.watchUrls,
    })
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get();
  if (!existingSettings) return emptyWatchSettings;
  const parsed = watchSettingsSchema.safeParse(existingSettings);
  return parsed.success ? parsed.data : emptyWatchSettings;
};

export const saveWatchSettings = (
  userId: string,
  input: WatchSettings,
): WatchSettings => {
  const parsedSettings = watchSettingsSchema.parse(input);
  const urls = watchUrlsSchema.parse(parsedSettings.watchUrls);
  const existingWatchSettings = db
    .select({ watchUrls: SettingTable.watchUrls })
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get();
  const previouslySavedUrls = new Set(existingWatchSettings?.watchUrls ?? []);
  const connections = db
    .select()
    .from(AcademicConnectionTable)
    .where(
      and(
        eq(AcademicConnectionTable.userId, userId),
        eq(AcademicConnectionTable.isCourseResource, true),
      ),
    )
    .all();
  if (parsedSettings.watchEnabled && !connections.length && !urls.length)
    throw new Error('Add a course resource connection to enable watching.');

  const identities = new Set<string>();
  const watchUrls = urls.map((url) => {
    let safeUrl: Pick<ReturnType<typeof parseWatchUrl>, 'url' | 'identity'>;
    try {
      safeUrl = parseWatchUrl(url, connections);
    } catch (error) {
      if (parsedSettings.watchEnabled || !previouslySavedUrls.has(url))
        throw error;
      safeUrl = { url, identity: url };
    }
    if (identities.has(safeUrl.identity))
      throw new Error('That course page URL is already being watched.');
    identities.add(safeUrl.identity);
    return safeUrl.url;
  });
  const savedWatchSettings = { ...parsedSettings, watchUrls };
  const updatedAt = new Date().toISOString();
  db.transaction((tx) => {
    tx.insert(SettingTable)
      .values({ userId, updatedAt })
      .onConflictDoNothing()
      .run();
    tx.update(SettingTable)
      .set({ ...savedWatchSettings, updatedAt })
      .where(eq(SettingTable.userId, userId))
      .run();
  });
  return savedWatchSettings;
};

export const getWatchTargets = (userId: string): WatchTargetSelectData[] =>
  db
    .select()
    .from(WatchTargetTable)
    .where(eq(WatchTargetTable.userId, userId))
    .all();

export const upsertWatchTarget = (
  userId: string,
  input: WatchTargetUpsert,
): WatchTargetSelectData | null =>
  db.transaction((tx) => {
    const connection = tx
      .select()
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.id, input.connectionId),
          eq(AcademicConnectionTable.isCourseResource, true),
        ),
      )
      .get();
    if (!connection) return null;
    const parsedUrl = parseWatchUrl(input.requestedUrl, [connection]);
    if (input.courseId) {
      const course = tx
        .select({ id: CourseTable.id })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, userId),
            eq(CourseTable.connectionId, input.connectionId),
            eq(CourseTable.id, input.courseId),
          ),
        )
        .get();
      if (!course) return null;
    }

    const existingWatchTarget = tx
      .select()
      .from(WatchTargetTable)
      .where(
        and(
          eq(WatchTargetTable.userId, userId),
          eq(WatchTargetTable.connectionId, input.connectionId),
          eq(WatchTargetTable.urlIdentity, parsedUrl.identity),
        ),
      )
      .get();
    const now = new Date().toISOString();
    if (existingWatchTarget) {
      tx.update(WatchTargetTable)
        .set({
          courseId: input.courseId,
          requestedUrl: parsedUrl.url,
          recipeVersion: input.recipeVersion,
          updatedAt: now,
        })
        .where(eq(WatchTargetTable.id, existingWatchTarget.id))
        .run();
      return tx
        .select()
        .from(WatchTargetTable)
        .where(eq(WatchTargetTable.id, existingWatchTarget.id))
        .get()!;
    }

    const insertedWatchTarget = {
      id: randomUUID(),
      userId,
      connectionId: input.connectionId,
      courseId: input.courseId,
      requestedUrl: parsedUrl.url,
      verifiedUrl: null,
      urlIdentity: parsedUrl.identity,
      status: 'active' as const,
      pendingChange: false,
      failureCount: 0,
      recipeVersion: input.recipeVersion,
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(WatchTargetTable).values(insertedWatchTarget).run();
    return tx
      .select()
      .from(WatchTargetTable)
      .where(eq(WatchTargetTable.id, insertedWatchTarget.id))
      .get()!;
  });

export const recordWatchObservation = (
  input: WatchObservation,
): WatchTargetSelectData | null => {
  if (!fingerprintPattern.test(input.fingerprint)) return null;
  try {
    return db.transaction((tx) => {
      const existingWatchTarget = tx
        .select()
        .from(WatchTargetTable)
        .where(
          and(
            eq(WatchTargetTable.userId, input.userId),
            eq(WatchTargetTable.id, input.targetId),
          ),
        )
        .get();
      if (!existingWatchTarget || existingWatchTarget.status !== 'active')
        return null;
      const setting = tx
        .select({
          watchEnabled: SettingTable.watchEnabled,
          consent: SettingTable.consent,
        })
        .from(SettingTable)
        .where(eq(SettingTable.userId, input.userId))
        .get();
      if (!setting?.watchEnabled || !setting.consent) return null;
      const connection = tx
        .select()
        .from(AcademicConnectionTable)
        .where(
          and(
            eq(AcademicConnectionTable.userId, input.userId),
            eq(AcademicConnectionTable.id, existingWatchTarget.connectionId),
            eq(AcademicConnectionTable.isCourseResource, true),
          ),
        )
        .get();
      if (!connection || connection.status === 'needs-sign-in') return null;
      const verifiedUrl = parseWatchUrl(input.verifiedUrl, [connection]);
      if (verifiedUrl.connectionId !== existingWatchTarget.connectionId)
        return null;
      const pendingChange =
        existingWatchTarget.processedFingerprint !== input.fingerprint;
      const samePendingRevision =
        existingWatchTarget.pendingChange &&
        existingWatchTarget.detectedFingerprint === input.fingerprint;
      tx.update(WatchTargetTable)
        .set({
          verifiedUrl: verifiedUrl.url,
          lastAttemptAt: input.checkedAt,
          lastSuccessfulCheckAt: input.checkedAt,
          detectedFingerprint: input.fingerprint,
          pendingChange,
          pendingSince: pendingChange
            ? samePendingRevision
              ? (existingWatchTarget.pendingSince ??
                existingWatchTarget.updatedAt)
              : input.checkedAt
            : null,
          pendingSinceEstimated: pendingChange
            ? samePendingRevision
              ? existingWatchTarget.pendingSinceEstimated ||
                existingWatchTarget.pendingSince === null
              : false
            : false,
          lastFailureCategory: samePendingRevision
            ? existingWatchTarget.lastFailureCategory
            : null,
          nextCheckAt: input.nextCheckAt,
          status: samePendingRevision ? existingWatchTarget.status : 'active',
          failureCount: samePendingRevision
            ? existingWatchTarget.failureCount
            : 0,
          retryAt: samePendingRevision ? existingWatchTarget.retryAt : null,
          recipeVersion: input.recipeVersion,
          updatedAt: input.checkedAt,
        })
        .where(eq(WatchTargetTable.id, input.targetId))
        .run();
      return tx
        .select()
        .from(WatchTargetTable)
        .where(eq(WatchTargetTable.id, input.targetId))
        .get()!;
    });
  } catch {
    return null;
  }
};

export const markWatchTargetProcessed = (
  input: WatchProcessedRevision,
): WatchTargetSelectData | null => {
  if (!fingerprintPattern.test(input.fingerprint)) return null;
  return db.transaction((tx) => {
    const existingWatchTarget = tx
      .select()
      .from(WatchTargetTable)
      .where(
        and(
          eq(WatchTargetTable.userId, input.userId),
          eq(WatchTargetTable.id, input.targetId),
        ),
      )
      .get();
    if (
      !existingWatchTarget ||
      existingWatchTarget.status !== 'active' ||
      !existingWatchTarget.pendingChange ||
      existingWatchTarget.detectedFingerprint !== input.fingerprint
    )
      return null;
    const setting = tx
      .select({
        watchEnabled: SettingTable.watchEnabled,
        consent: SettingTable.consent,
      })
      .from(SettingTable)
      .where(eq(SettingTable.userId, input.userId))
      .get();
    if (!setting?.watchEnabled || !setting.consent) return null;
    const connection = tx
      .select({ status: AcademicConnectionTable.status })
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, input.userId),
          eq(AcademicConnectionTable.id, existingWatchTarget.connectionId),
          eq(AcademicConnectionTable.isCourseResource, true),
        ),
      )
      .get();
    if (!connection || connection.status === 'needs-sign-in') return null;
    tx.update(WatchTargetTable)
      .set({
        processedFingerprint: input.fingerprint,
        pendingChange: false,
        pendingSince: null,
        pendingSinceEstimated: false,
        lastFailureCategory: null,
        failureCount: 0,
        retryAt: null,
        nextCheckAt: input.processedAt,
        updatedAt: input.processedAt,
      })
      .where(
        and(
          eq(WatchTargetTable.userId, input.userId),
          eq(WatchTargetTable.id, input.targetId),
          eq(WatchTargetTable.detectedFingerprint, input.fingerprint),
          eq(WatchTargetTable.pendingChange, true),
        ),
      )
      .run();
    return tx
      .select()
      .from(WatchTargetTable)
      .where(eq(WatchTargetTable.id, input.targetId))
      .get()!;
  });
};

export const scheduleWatchTargetCheck = (
  input: WatchCheckSchedule,
): WatchTargetSelectData | null => {
  const existingWatchTarget = db
    .select()
    .from(WatchTargetTable)
    .where(
      and(
        eq(WatchTargetTable.userId, input.userId),
        eq(WatchTargetTable.id, input.targetId),
      ),
    )
    .get();
  if (!existingWatchTarget) return null;
  db.update(WatchTargetTable)
    .set({
      ...(input.attempted === false ? {} : { lastAttemptAt: input.checkedAt }),
      nextCheckAt: input.nextCheckAt,
      updatedAt: input.checkedAt,
    })
    .where(eq(WatchTargetTable.id, input.targetId))
    .run();
  return db
    .select()
    .from(WatchTargetTable)
    .where(eq(WatchTargetTable.id, input.targetId))
    .get()!;
};

export const synchronizeWatchTargets = (
  userId: string,
): WatchTargetSelectData[] => {
  const settings = getWatchSettings(userId);
  const connections = db
    .select()
    .from(AcademicConnectionTable)
    .where(eq(AcademicConnectionTable.userId, userId))
    .all();
  const courseRoutes = db
    .select({
      id: CourseTable.id,
      connectionId: CourseTable.connectionId,
      url: CourseTable.url,
    })
    .from(CourseTable)
    .where(eq(CourseTable.userId, userId))
    .all();
  const targetInputs = getEffectiveWatchTargetInputs(settings, connections);
  const activeTargets = targetInputs.flatMap((input) => {
    const matchingCourses = courseRoutes.flatMap((course) => {
      if (
        course.connectionId !== input.connectionId ||
        !course.url ||
        !isWithinCoursePath(course.url, input.requestedUrl)
      )
        return [];
      const path = new URL(course.url).pathname.replace(/\/+$/, '') || '/';
      return [{ id: course.id, pathLength: path.length }];
    });
    const longestPath = Math.max(
      -1,
      ...matchingCourses.map((course) => course.pathLength),
    );
    const mostSpecificCourses = matchingCourses.filter(
      (course) => course.pathLength === longestPath,
    );
    const courseId =
      input.courseId ??
      (mostSpecificCourses.length === 1 ? mostSpecificCourses[0]!.id : null);
    const target = upsertWatchTarget(userId, { ...input, courseId });
    return target ? [target] : [];
  });
  const synchronizedAt = new Date().toISOString();
  if (activeTargets.length) {
    db.update(WatchTargetTable)
      .set({ status: 'active', updatedAt: synchronizedAt })
      .where(
        and(
          eq(WatchTargetTable.userId, userId),
          inArray(
            WatchTargetTable.id,
            activeTargets.map((target) => target.id),
          ),
          eq(WatchTargetTable.status, 'suspended'),
          or(
            isNull(WatchTargetTable.lastFailureCategory),
            and(
              ne(WatchTargetTable.lastFailureCategory, 'needs-sign-in'),
              ne(WatchTargetTable.lastFailureCategory, 'scope-changed'),
            ),
          ),
        ),
      )
      .run();
    db.update(WatchTargetTable)
      .set({ status: 'suspended', updatedAt: synchronizedAt })
      .where(
        and(
          eq(WatchTargetTable.userId, userId),
          notInArray(
            WatchTargetTable.id,
            activeTargets.map((target) => target.id),
          ),
        ),
      )
      .run();
  } else {
    db.update(WatchTargetTable)
      .set({ status: 'suspended', updatedAt: synchronizedAt })
      .where(eq(WatchTargetTable.userId, userId))
      .run();
  }
  return db
    .select()
    .from(WatchTargetTable)
    .where(eq(WatchTargetTable.userId, userId))
    .all();
};

export const recordWatchFailure = (
  input: WatchFailureRecord,
): WatchTargetSelectData | null =>
  db.transaction((tx) => {
    const existingWatchTarget = tx
      .select()
      .from(WatchTargetTable)
      .where(
        and(
          eq(WatchTargetTable.userId, input.userId),
          eq(WatchTargetTable.id, input.targetId),
        ),
      )
      .get();
    if (!existingWatchTarget || existingWatchTarget.status !== 'active')
      return null;
    const setting = tx
      .select({
        watchEnabled: SettingTable.watchEnabled,
        consent: SettingTable.consent,
      })
      .from(SettingTable)
      .where(eq(SettingTable.userId, input.userId))
      .get();
    if (!setting?.watchEnabled || !setting.consent) return null;
    const connection = tx
      .select({ id: AcademicConnectionTable.id })
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, input.userId),
          eq(AcademicConnectionTable.id, existingWatchTarget.connectionId),
          eq(AcademicConnectionTable.isCourseResource, true),
        ),
      )
      .get();
    if (!connection) return null;
    const needsIntervention =
      input.category === 'needs-sign-in' || input.category === 'scope-changed';
    tx.update(WatchTargetTable)
      .set({
        lastAttemptAt: input.failedAt,
        failureCount: needsIntervention
          ? existingWatchTarget.failureCount
          : existingWatchTarget.failureCount + 1,
        lastFailureCategory: input.category,
        retryAt: input.retryAt,
        nextCheckAt: input.retryAt,
        status: input.blocked
          ? 'blocked'
          : needsIntervention
            ? 'suspended'
            : 'active',
        updatedAt: input.failedAt,
      })
      .where(
        and(
          eq(WatchTargetTable.userId, input.userId),
          eq(WatchTargetTable.id, input.targetId),
        ),
      )
      .run();
    return tx
      .select()
      .from(WatchTargetTable)
      .where(
        and(
          eq(WatchTargetTable.userId, input.userId),
          eq(WatchTargetTable.id, input.targetId),
        ),
      )
      .get()!;
  });

const reconnectFailureCategories = ['needs-sign-in', 'scope-changed'] as const;

export const resetWatchTargetsAfterReconnect = (
  userId: string,
  connectionId: string,
  reconnectedAt = new Date().toISOString(),
) =>
  db.transaction((tx) => {
    const setting = tx
      .select({
        watchEnabled: SettingTable.watchEnabled,
        consent: SettingTable.consent,
        watchUrls: SettingTable.watchUrls,
      })
      .from(SettingTable)
      .where(eq(SettingTable.userId, userId))
      .get();
    if (!setting?.watchEnabled || !setting.consent) return [];
    const parsedSettings = watchSettingsSchema.safeParse({
      watchEnabled: setting.watchEnabled,
      watchUrls: setting.watchUrls,
    });
    if (!parsedSettings.success) return [];
    const connection = tx
      .select()
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.id, connectionId),
          eq(AcademicConnectionTable.isCourseResource, true),
        ),
      )
      .get();
    if (!connection || connection.status === 'needs-sign-in') return [];
    const activeIdentities = new Set(
      getEffectiveWatchTargetInputs(parsedSettings.data, [connection]).flatMap(
        (input) => {
          try {
            return [
              `${input.connectionId}:${parseWatchUrl(input.requestedUrl, [connection]).identity}`,
            ];
          } catch {
            return [];
          }
        },
      ),
    );
    const affectedTargets = tx
      .select()
      .from(WatchTargetTable)
      .where(
        and(
          eq(WatchTargetTable.userId, userId),
          eq(WatchTargetTable.connectionId, connectionId),
          inArray(
            WatchTargetTable.lastFailureCategory,
            reconnectFailureCategories,
          ),
        ),
      )
      .all()
      .filter((target) =>
        activeIdentities.has(`${target.connectionId}:${target.urlIdentity}`),
      );
    for (const target of affectedTargets)
      tx.update(WatchTargetTable)
        .set({
          status: 'active',
          failureCount: 0,
          lastFailureCategory: null,
          retryAt: null,
          nextCheckAt: reconnectedAt,
          updatedAt: reconnectedAt,
        })
        .where(
          and(
            eq(WatchTargetTable.userId, userId),
            eq(WatchTargetTable.id, target.id),
            inArray(
              WatchTargetTable.lastFailureCategory,
              reconnectFailureCategories,
            ),
          ),
        )
        .run();
    return affectedTargets.map((target) => target.id);
  });

export const getWatchHealthSummary = (
  userId: string,
  runtimeStatus: WatchRuntimeStatus,
  now = Date.now(),
): WatchHealthSummary => {
  const targets = getWatchTargets(userId);
  const pending = targets.flatMap((target) => {
    if (!target.pendingChange) return [];
    const pendingTimestamp = Date.parse(
      target.pendingSince ?? target.updatedAt,
    );
    return [
      {
        timestamp: Number.isFinite(pendingTimestamp) ? pendingTimestamp : null,
        estimated: target.pendingSinceEstimated || target.pendingSince === null,
      },
    ];
  });
  const oldestPending = pending
    .filter(
      (item): item is { timestamp: number; estimated: boolean } =>
        item.timestamp !== null,
    )
    .sort((left, right) => left.timestamp - right.timestamp)[0];
  const nextRetryAt = targets
    .flatMap((target) => (target.retryAt ? [Date.parse(target.retryAt)] : []))
    .filter((retryAt) => Number.isFinite(retryAt) && retryAt > now)
    .sort((left, right) => left - right)[0];
  const lastSuccessfulCheckAt = targets
    .flatMap((target) =>
      target.lastSuccessfulCheckAt
        ? [Date.parse(target.lastSuccessfulCheckAt)]
        : [],
    )
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  const failures = watchTargetFailureCategories.flatMap((category) => {
    const targetCount = targets.filter(
      (target) => target.lastFailureCategory === category,
    ).length;
    return targetCount ? [{ category, targetCount }] : [];
  });
  const status =
    runtimeStatus === 'off' || runtimeStatus === 'paused'
      ? runtimeStatus
      : failures.some((failure) => failure.category === 'needs-sign-in')
        ? 'needs-sign-in'
        : targets.some((target) => target.status === 'blocked') ||
            failures.length
          ? 'blocked'
          : runtimeStatus;
  return {
    status,
    pendingRevisionCount: pending.length,
    oldestPendingSince: oldestPending
      ? new Date(oldestPending.timestamp).toISOString()
      : null,
    oldestPendingSinceEstimated:
      pending.some((item) => item.timestamp === null) ||
      (oldestPending?.estimated ?? pending.length > 0),
    lastSuccessfulCheckAt: lastSuccessfulCheckAt
      ? new Date(lastSuccessfulCheckAt).toISOString()
      : null,
    nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null,
    failures,
  };
};
