import { randomUUID } from 'node:crypto';
import type { Page } from '@browserbasehq/stagehand';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db';
import {
  AcademicConnectionTable,
  AcademicContextTable,
} from '../../../db/schema';
import { getAcademicPage, peekAcademicPage } from './browser-workspace';
import { readPageEvidence } from './page-evidence';
import { fetchSiteIcon } from './site-icons';
import { getOnboardingState } from './store';
import { classifyCapturedPage } from '../lib/connection-policy';
import type { AcademicConnection, PreviewedConnection } from '../types';

export const previewResource = async (
  userId: string,
): Promise<PreviewedConnection | null> => {
  const page = await peekAcademicPage(userId);
  if (!page) return null;
  try {
    return classifyCapturedPage(await readPageEvidence(page));
  } catch {
    // A page that cannot be connected yet is the normal state while the student
    // is still navigating, not something to report.
    return null;
  }
};

export const captureResource = async (
  userId: string,
  isCurrent: () => boolean = () => true,
): Promise<AcademicConnection> => {
  const page = await getAcademicPage(userId, isCurrent);
  return captureResourcePage(userId, page, isCurrent);
};

export const captureResourcePage = async (
  userId: string,
  page: Page,
  isCurrent: () => boolean,
  expectedHost?: string,
): Promise<AcademicConnection> => {
  const evidence = await readPageEvidence(page);
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  const captured = classifyCapturedPage(evidence);
  if (expectedHost && captured.host !== expectedHost)
    throw new Error('This page left the approved site.');
  const favicon = await fetchSiteIcon(captured.host, evidence.icon ?? null);
  if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  // Read editable fields after the network request so recapture cannot replace
  // notes saved while the icon was loading.
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
    notes: existingConnection?.notes ?? null,
    // A recapture that cannot read an icon keeps the last one students saw.
    favicon: favicon ?? existingConnection?.favicon ?? null,
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

export const saveConnectionNotes = (
  userId: string,
  id: string,
  notes: string,
) => {
  if (notes.length > 500)
    throw new Error('Notes must be 500 characters or fewer.');
  db.update(AcademicConnectionTable)
    .set({ notes: notes.trim() })
    .where(
      and(
        eq(AcademicConnectionTable.userId, userId),
        eq(AcademicConnectionTable.id, id),
      ),
    )
    .run();
  return getOnboardingState(userId);
};
