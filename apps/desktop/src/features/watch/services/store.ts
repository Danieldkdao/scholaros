import { randomUUID } from 'node:crypto';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseTable,
  SettingTable,
  WatchTargetTable,
} from '../../../db/schema';
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
      if (!existingWatchTarget) return null;
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
      if (!connection) return null;
      const verifiedUrl = parseWatchUrl(input.verifiedUrl, [connection]);
      if (verifiedUrl.connectionId !== existingWatchTarget.connectionId)
        return null;
      tx.update(WatchTargetTable)
        .set({
          verifiedUrl: verifiedUrl.url,
          lastAttemptAt: input.checkedAt,
          lastSuccessfulCheckAt: input.checkedAt,
          detectedFingerprint: input.fingerprint,
          pendingChange:
            existingWatchTarget.processedFingerprint !== input.fingerprint,
          nextCheckAt: input.nextCheckAt,
          status: 'active',
          failureCount: 0,
          retryAt: null,
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
    if (!existingWatchTarget) return null;
    tx.update(WatchTargetTable)
      .set({
        processedFingerprint: input.fingerprint,
        pendingChange:
          existingWatchTarget.detectedFingerprint !== input.fingerprint,
        updatedAt: input.processedAt,
      })
      .where(eq(WatchTargetTable.id, input.targetId))
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
    if (!existingWatchTarget) return null;
    tx.update(WatchTargetTable)
      .set({
        lastAttemptAt: input.failedAt,
        failureCount: existingWatchTarget.failureCount + 1,
        retryAt: input.retryAt,
        nextCheckAt: input.retryAt,
        status: input.blocked ? 'blocked' : 'active',
        updatedAt: input.failedAt,
      })
      .where(eq(WatchTargetTable.id, input.targetId))
      .run();
    return tx
      .select()
      .from(WatchTargetTable)
      .where(eq(WatchTargetTable.id, input.targetId))
      .get()!;
  });
