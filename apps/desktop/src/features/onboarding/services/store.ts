import { app } from 'electron';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db';
import { profileDirectoryFor } from '../lib/profile-directory';
import { summarizeDiscovery } from '../lib/discovery-outcomes';
import { getLaunchAtLoginState } from './preferences';
import type { ConnectionOutcome } from '../lib/discovery-outcomes';
import type {
  AcademicContextEntryDraft,
  BrowserWorkspaceStatus,
} from '../types';
import {
  SettingTable,
  AcademicContextTable,
  AcademicContextEntryTable,
  AcademicConnectionTable,
  BrowserWorkspaceTable,
} from '../../../db/schema';
import type { OnboardingState } from '../types';
import type { SettingsUpdateSchema } from '../schemas';

export type AcademicDiscoveryResult = {
  connectionId: string;
  outcome: ConnectionOutcome;
  entries: AcademicContextEntryDraft[];
};

// These outcomes came from a page the agent actually loaded.
const readableOutcomes: ConnectionOutcome[] = ['courses', 'empty'];

const readDiscoveryRow = (userId: string) => {
  const context = db
    .select({
      coverage: AcademicContextTable.discoveryCoverage,
      discoveredAt: AcademicContextTable.discoveredAt,
    })
    .from(AcademicContextTable)
    .where(eq(AcademicContextTable.userId, userId))
    .get()!;
  return {
    coverage: context.coverage ?? {},
    discoveredAt: context.discoveredAt,
  };
};

export const getOnboardingState = (userId: string): OnboardingState => {
  db.insert(SettingTable)
    .values({ userId, updatedAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
  db.insert(AcademicContextTable)
    .values({ userId })
    .onConflictDoNothing()
    .run();
  const settings = db
    .select()
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get()!;
  const context = db
    .select()
    .from(AcademicContextTable)
    .where(eq(AcademicContextTable.userId, userId))
    .get()!;
  const workspace = db
    .select()
    .from(BrowserWorkspaceTable)
    .where(eq(BrowserWorkspaceTable.userId, userId))
    .get();
  let workspaceStatus: BrowserWorkspaceStatus | null = null;
  if (workspace) {
    const installationAvailable = existsSync(workspace.executable);
    const profileProvisioned =
      installationAvailable &&
      existsSync(
        profileDirectoryFor(
          app.getPath('userData'),
          userId,
          workspace.executable,
        ),
      );
    if (!installationAvailable) workspaceStatus = 'browser-missing';
    else if (!profileProvisioned) workspaceStatus = 'profile-missing';
    else if (!workspace.verifiedAt) workspaceStatus = 'unverified';
    else workspaceStatus = 'ready';
  }
  const connections = db
    .select()
    .from(AcademicConnectionTable)
    .where(eq(AcademicConnectionTable.userId, userId))
    .all();
  const contextEntries = db
    .select()
    .from(AcademicContextEntryTable)
    .where(eq(AcademicContextEntryTable.userId, userId))
    .all();
  return {
    accountId: userId,
    settings: {
      step: settings.step,
      consent: settings.consent,
      launchAtLogin: settings.launchAtLogin,
      backgroundSync: settings.backgroundSync,
      localSetupCompletedAt: settings.localSetupCompletedAt,
      notes: context.notes,
    },
    workspace: workspace
      ? {
          browser: workspace.browser,
          browserName: workspace.browserName,
          ready: workspaceStatus === 'ready',
          status: workspaceStatus!,
          verifiedAt: workspace.verifiedAt || null,
        }
      : null,
    connections: connections.map(
      ({ userId: _userId, ...connection }) => connection,
    ),
    primaryLms: context.primaryLms,
    discovery: {
      status: context.discoveryStatus,
      message: context.discoveryMessage,
      discoveredAt: context.discoveredAt,
      coverage: context.discoveryCoverage ?? {},
      entries: contextEntries.map(({ userId: _userId, ...entry }) => entry),
    },
    preferences: {
      launchAtLogin: getLaunchAtLoginState(settings.launchAtLogin),
      backgroundSync: {
        status: 'off',
        message: null,
        lastSyncedAt: null,
      },
    },
  };
};

export const saveOnboardingSettings = (
  userId: string,
  changes: SettingsUpdateSchema,
) => {
  getOnboardingState(userId);
  const { notes, ...settings } = changes;
  db.transaction((tx) => {
    tx.update(SettingTable)
      .set({ ...settings, updatedAt: new Date().toISOString() })
      .where(eq(SettingTable.userId, userId))
      .run();
    if (notes !== undefined)
      tx.update(AcademicContextTable)
        .set({ notes })
        .where(eq(AcademicContextTable.userId, userId))
        .run();
  });
  return getOnboardingState(userId);
};

export const removeAcademicConnection = (userId: string, id: string) => {
  // Ensures the context row exists before coverage is rewritten.
  getOnboardingState(userId);
  db.transaction((tx) => {
    tx.delete(AcademicConnectionTable)
      .where(
        and(
          eq(AcademicConnectionTable.userId, userId),
          eq(AcademicConnectionTable.id, id),
        ),
      )
      .run();
    tx.delete(AcademicContextEntryTable)
      .where(
        and(
          eq(AcademicContextEntryTable.userId, userId),
          eq(AcademicContextEntryTable.connectionId, id),
        ),
      )
      .run();
    tx.update(AcademicContextTable)
      .set({ primaryLms: null })
      .where(
        and(
          eq(AcademicContextTable.userId, userId),
          eq(AcademicContextTable.primaryLms, id),
        ),
      )
      .run();
    const remainingEntries = tx
      .select({ id: AcademicContextEntryTable.id })
      .from(AcademicContextEntryTable)
      .where(eq(AcademicContextEntryTable.userId, userId))
      .all();
    const contextRow = tx
      .select({
        coverage: AcademicContextTable.discoveryCoverage,
        discoveredAt: AcademicContextTable.discoveredAt,
      })
      .from(AcademicContextTable)
      .where(eq(AcademicContextTable.userId, userId))
      .get()!;
    const coverage = { ...contextRow.coverage };
    delete coverage[id];
    if (!remainingEntries.length)
      tx.update(AcademicContextTable)
        .set({
          discoveryStatus: 'pending',
          discoveryMessage: null,
          discoveredAt: null,
          discoveryCoverage: {},
        })
        .where(eq(AcademicContextTable.userId, userId))
        .run();
    else
      tx.update(AcademicContextTable)
        .set({ discoveryCoverage: coverage })
        .where(eq(AcademicContextTable.userId, userId))
        .run();
  });
  return getOnboardingState(userId);
};

export const markAcademicDiscoveryRunning = (userId: string) => {
  getOnboardingState(userId);
  const summary = summarizeDiscovery({
    results: [],
    previous: readDiscoveryRow(userId),
    now: new Date().toISOString(),
    running: true,
  });
  db.update(AcademicContextTable)
    .set({
      discoveryStatus: summary.status,
      discoveryMessage: summary.message,
      discoveryCoverage: summary.coverage,
    })
    .where(eq(AcademicContextTable.userId, userId))
    .run();
  return getOnboardingState(userId);
};

// Only resources that were actually read have their observations replaced, so a
// failed, blocked, or cancelled refresh cannot erase the last real course map.
export const applyAcademicDiscovery = (
  userId: string,
  results: AcademicDiscoveryResult[],
  options: { cancelled?: boolean; now?: string } = {},
) => {
  getOnboardingState(userId);
  const now = options.now ?? new Date().toISOString();
  const previous = readDiscoveryRow(userId);
  db.transaction((tx) => {
    for (const result of results) {
      if (options.cancelled || !readableOutcomes.includes(result.outcome))
        continue;
      tx.delete(AcademicContextEntryTable)
        .where(
          and(
            eq(AcademicContextEntryTable.userId, userId),
            eq(AcademicContextEntryTable.connectionId, result.connectionId),
          ),
        )
        .run();
      if (result.entries.length)
        tx.insert(AcademicContextEntryTable)
          .values(
            result.entries.map((entry) => ({
              ...entry,
              id: randomUUID(),
              userId,
              observedAt: now,
            })),
          )
          .run();
    }
    const courseRows = tx
      .select({ connectionId: AcademicContextEntryTable.connectionId })
      .from(AcademicContextEntryTable)
      .where(
        and(
          eq(AcademicContextEntryTable.userId, userId),
          eq(AcademicContextEntryTable.role, 'course'),
        ),
      )
      .all();
    const summary = summarizeDiscovery({
      results: (options.cancelled ? [] : results).map((result) => ({
        connectionId: result.connectionId,
        outcome: result.outcome,
        courseCount: courseRows.filter(
          (course) => course.connectionId === result.connectionId,
        ).length,
      })),
      previous,
      now,
      cancelled: options.cancelled,
    });
    tx.update(AcademicContextTable)
      .set({
        discoveryStatus: summary.status,
        discoveryMessage: summary.message,
        discoveredAt: summary.discoveredAt,
        discoveryCoverage: summary.coverage,
      })
      .where(eq(AcademicContextTable.userId, userId))
      .run();
  });
  return getOnboardingState(userId);
};
