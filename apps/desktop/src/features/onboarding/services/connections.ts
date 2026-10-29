import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  AcademicContextTable,
} from '../../../db/schema';
import { getAcademicPage } from './browser-workspace';
import { getOnboardingState } from './store';
import { classifyCapturedPage } from '../lib/connection-policy';
import type { AcademicConnection } from '../types';

export const captureResource = async (
  userId: string,
  isCurrent: () => boolean = () => true,
): Promise<AcademicConnection> => {
  const page = await getAcademicPage(userId, isCurrent);
  const evidence = await page.evaluate(() => ({
    origin: location.origin,
    host: location.hostname,
    pathname: location.pathname,
    href: location.href,
    title: document.title,
    hasPasswordField: !!document.querySelector('input[type="password"]'),
    hasCanvasMarkers: !!document.querySelector(
      '.ic-DashboardCard, #dashboard-activity, #course_home_content',
    ),
    courseLinkCount: [
      ...document.querySelectorAll<HTMLAnchorElement>('a[href]'),
    ].filter((anchor) => /^\/courses\/\d+/.test(new URL(anchor.href).pathname))
      .length,
  }));
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  const captured = classifyCapturedPage(evidence);
  const existingConnection = db
    .select()
    .from(AcademicConnectionTable)
    .where(
      and(
        eq(AcademicConnectionTable.userId, userId),
        eq(AcademicConnectionTable.host, captured.host),
      ),
    )
    .get();
  const connection: AcademicConnection = {
    id: existingConnection?.id ?? randomUUID(),
    ...captured,
    verifiedAt:
      captured.status === 'verified' ? new Date().toISOString() : null,
  };
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  db.insert(AcademicConnectionTable)
    .values({ ...connection, userId })
    .onConflictDoUpdate({ target: AcademicConnectionTable.id, set: connection })
    .run();
  getOnboardingState(userId);
  if (captured.kind !== 'resource') {
    const existingContext = db
      .select()
      .from(AcademicContextTable)
      .where(eq(AcademicContextTable.userId, userId))
      .get();
    if (!existingContext?.primaryLms)
      db.update(AcademicContextTable)
        .set({ primaryLms: connection.id })
        .where(eq(AcademicContextTable.userId, userId))
        .run();
  }
  return connection;
};

export const confirmResource = (userId: string, id: string) => {
  db.update(AcademicConnectionTable)
    .set({ status: 'confirmed', verifiedAt: null })
    .where(
      and(
        eq(AcademicConnectionTable.userId, userId),
        eq(AcademicConnectionTable.id, id),
        eq(AcademicConnectionTable.status, 'needs-sign-in'),
      ),
    )
    .run();
  return getOnboardingState(userId);
};

export const setPrimaryLms = (userId: string, id: string) => {
  const existingConnection = db
    .select()
    .from(AcademicConnectionTable)
    .where(
      and(
        eq(AcademicConnectionTable.userId, userId),
        eq(AcademicConnectionTable.id, id),
      ),
    )
    .get();
  if (!existingConnection) throw new Error('Choose a connected resource.');
  db.update(AcademicContextTable)
    .set({ primaryLms: id })
    .where(eq(AcademicContextTable.userId, userId))
    .run();
  return getOnboardingState(userId);
};
