import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  CourseTable,
  NavigationLocationTable,
} from '../../../db/schema';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import {
  navigationFailureClassSchema,
  navigationLocationObservationSchema,
  navigationLocationRowSchema,
} from '../schemas';
import type { NavigationLocationObservationSchema } from '../schemas';
import type { NavigationPurpose } from '../types';
import type { NavigationLocationSelectData } from '../../../db/schema';

type NavigationLocationObservation = NavigationLocationObservationSchema;

type NavigationLocationQuery = {
  userId: string;
  connectionId: string;
  courseId: string | null;
  purpose: NavigationPurpose;
  limit?: number;
};

const safeAcademicUrl = (value: string, host: string) => {
  const identity = academicPageIdentity(value);
  return identity && isReadNavigation(identity, [host]) ? identity : null;
};

const recipeIsSafe = (
  recipe: NavigationLocationObservation['recipe'],
  host: string,
) =>
  !recipe ||
  recipe.steps.every(
    (step) =>
      step.kind === 'reveal-section' || !!safeAcademicUrl(step.url, host),
  );

const statusRank = (status: NavigationLocationSelectData['status']) => {
  switch (status) {
    case 'verified':
      return 0;
    case 'tentative':
      return 1;
    case 'stale':
      return 2;
  }
};

const sameLocation = (
  tx: Omit<typeof db, '$client'>,
  userId: string,
  connectionId: string,
  courseId: string | null,
  purpose: NavigationPurpose,
  destinationUrl: string,
) =>
  tx
    .select()
    .from(NavigationLocationTable)
    .where(
      and(
        eq(NavigationLocationTable.userId, userId),
        eq(NavigationLocationTable.connectionId, connectionId),
        courseId
          ? eq(NavigationLocationTable.courseId, courseId)
          : isNull(NavigationLocationTable.courseId),
        eq(NavigationLocationTable.purpose, purpose),
        eq(NavigationLocationTable.destinationUrl, destinationUrl),
      ),
    )
    .get();

export const saveNavigationLocation = (
  userId: string,
  connectionId: string,
  input: NavigationLocationObservation,
): NavigationLocationSelectData | null => {
  const parsed = navigationLocationObservationSchema.safeParse(input);
  if (!parsed.success) return null;
  try {
    return db.transaction((tx) => {
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
      if (!connection) return null;
      const courseId = parsed.data.courseId ?? null;
      if (courseId) {
        const course = tx
          .select({ id: CourseTable.id })
          .from(CourseTable)
          .where(
            and(
              eq(CourseTable.userId, userId),
              eq(CourseTable.connectionId, connectionId),
              eq(CourseTable.id, courseId),
            ),
          )
          .get();
        if (!course) return null;
      }
      const destinationUrl = safeAcademicUrl(
        parsed.data.destinationUrl,
        connection.host,
      );
      const parentUrl = parsed.data.parentUrl
        ? safeAcademicUrl(parsed.data.parentUrl, connection.host)
        : null;
      const evidenceSourceUrl = safeAcademicUrl(
        parsed.data.evidence?.sourceUrl ??
          parsed.data.parentUrl ??
          parsed.data.destinationUrl,
        connection.host,
      );
      if (
        !destinationUrl ||
        (parsed.data.parentUrl && !parentUrl) ||
        !evidenceSourceUrl ||
        !recipeIsSafe(parsed.data.recipe, connection.host)
      )
        return null;
      const now = new Date().toISOString();
      const existingNavigationLocation = sameLocation(
        tx,
        userId,
        connectionId,
        courseId,
        parsed.data.purpose,
        destinationUrl,
      );
      const evidence =
        parsed.data.evidence ?? existingNavigationLocation?.evidence;
      if (!evidence) return null;
      const observedAt = parsed.data.observedAt ?? now;
      const preserveVerified =
        existingNavigationLocation?.status === 'verified' &&
        parsed.data.status === 'tentative';
      const values = {
        purpose: parsed.data.purpose,
        destinationUrl,
        parentUrl: parentUrl ?? existingNavigationLocation?.parentUrl ?? null,
        recipe:
          parsed.data.recipe ?? existingNavigationLocation?.recipe ?? null,
        label: parsed.data.label ?? existingNavigationLocation?.label ?? null,
        evidence,
        status: preserveVerified ? 'verified' : parsed.data.status,
        destinationKind: parsed.data.destinationKind,
        observedAt,
        verifiedAt:
          parsed.data.status === 'verified'
            ? (parsed.data.verifiedAt ?? now)
            : (existingNavigationLocation?.verifiedAt ?? null),
        failureCount:
          parsed.data.status === 'verified'
            ? 0
            : (existingNavigationLocation?.failureCount ?? 0),
        lastFailureClass:
          parsed.data.status === 'verified'
            ? null
            : (existingNavigationLocation?.lastFailureClass ?? null),
      };
      const navigationLocation = existingNavigationLocation
        ? {
            ...existingNavigationLocation,
            ...values,
          }
        : {
            id: randomUUID(),
            userId,
            connectionId,
            courseId,
            ...values,
          };
      const validation =
        navigationLocationRowSchema.safeParse(navigationLocation);
      if (!validation.success) return null;
      if (existingNavigationLocation)
        tx.update(NavigationLocationTable)
          .set(values)
          .where(eq(NavigationLocationTable.id, existingNavigationLocation.id))
          .run();
      else tx.insert(NavigationLocationTable).values(navigationLocation).run();
      return validation.data;
    });
  } catch {
    return null;
  }
};

export const getNavigationLocations = (
  query: NavigationLocationQuery,
): NavigationLocationSelectData[] | null => {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  if (!Number.isInteger(limit)) return null;
  try {
    const connection = db
      .select()
      .from(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, query.userId),
          eq(AcademicConnectionTable.id, query.connectionId),
          eq(AcademicConnectionTable.isCourseResource, true),
        ),
      )
      .get();
    if (!connection) return null;
    if (query.courseId) {
      const course = db
        .select({ id: CourseTable.id })
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, query.userId),
            eq(CourseTable.connectionId, query.connectionId),
            eq(CourseTable.id, query.courseId),
          ),
        )
        .get();
      if (!course) return null;
    }
    const courseCondition = query.courseId
      ? or(
          eq(NavigationLocationTable.courseId, query.courseId),
          isNull(NavigationLocationTable.courseId),
        )
      : isNull(NavigationLocationTable.courseId);
    const rows = db
      .select()
      .from(NavigationLocationTable)
      .where(
        and(
          eq(NavigationLocationTable.userId, query.userId),
          eq(NavigationLocationTable.connectionId, query.connectionId),
          eq(NavigationLocationTable.purpose, query.purpose),
          courseCondition,
        ),
      )
      .all();
    const locations: NavigationLocationSelectData[] = [];
    for (const row of rows) {
      const parsedRow = navigationLocationRowSchema.safeParse(row);
      if (!parsedRow.success) return null;
      locations.push(parsedRow.data);
    }
    return locations
      .sort(
        (left, right) =>
          statusRank(left.status) - statusRank(right.status) ||
          Number(right.courseId === query.courseId) -
            Number(left.courseId === query.courseId) ||
          right.observedAt.localeCompare(left.observedAt) ||
          left.destinationUrl.localeCompare(right.destinationUrl),
      )
      .slice(0, limit);
  } catch {
    return null;
  }
};

export const recordNavigationLocationFailure = (
  userId: string,
  locationId: string,
  failureClass: string,
): NavigationLocationSelectData | null => {
  const parsedFailure = navigationFailureClassSchema.safeParse(failureClass);
  if (!parsedFailure.success) return null;
  try {
    return db.transaction((tx) => {
      const existingNavigationLocation = tx
        .select()
        .from(NavigationLocationTable)
        .where(
          and(
            eq(NavigationLocationTable.userId, userId),
            eq(NavigationLocationTable.id, locationId),
          ),
        )
        .get();
      if (!existingNavigationLocation) return null;
      const navigationLocation = {
        ...existingNavigationLocation,
        failureCount: existingNavigationLocation.failureCount + 1,
        lastFailureClass: parsedFailure.data,
      };
      tx.update(NavigationLocationTable)
        .set({
          failureCount: navigationLocation.failureCount,
          lastFailureClass: navigationLocation.lastFailureClass,
        })
        .where(eq(NavigationLocationTable.id, locationId))
        .run();
      const parsedRow =
        navigationLocationRowSchema.safeParse(navigationLocation);
      return parsedRow.success ? parsedRow.data : null;
    });
  } catch {
    return null;
  }
};

export const markNavigationLocationStale = (
  userId: string,
  locationId: string,
): NavigationLocationSelectData | null => {
  try {
    return db.transaction((tx) => {
      const existingNavigationLocation = tx
        .select()
        .from(NavigationLocationTable)
        .where(
          and(
            eq(NavigationLocationTable.userId, userId),
            eq(NavigationLocationTable.id, locationId),
          ),
        )
        .get();
      if (!existingNavigationLocation) return null;
      const navigationLocation = {
        ...existingNavigationLocation,
        status: 'stale' as const,
      };
      tx.update(NavigationLocationTable)
        .set({ status: 'stale' })
        .where(eq(NavigationLocationTable.id, locationId))
        .run();
      const parsedRow =
        navigationLocationRowSchema.safeParse(navigationLocation);
      return parsedRow.success ? parsedRow.data : null;
    });
  } catch {
    return null;
  }
};
