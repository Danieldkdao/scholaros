import { configureBrowserPolicy } from '../lib/browser-policy';
import { missionTraffic } from './mission-traffic';
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
  const existingContext = db
    .select({
      coverage: AcademicContextTable.discoveryCoverage,
      discoveredAt: AcademicContextTable.discoveredAt,
    })
    .from(AcademicContextTable)
    .where(eq(AcademicContextTable.userId, userId))
    .get()!;
  return {
    coverage: existingContext.coverage ?? {},
    discoveredAt: existingContext.discoveredAt,
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
  const existingSettings = db
    .select()
    .from(SettingTable)
    .where(eq(SettingTable.userId, userId))
    .get()!;
  const existingContext = db
    .select()
    .from(AcademicContextTable)
    .where(eq(AcademicContextTable.userId, userId))
    .get()!;
  const existingWorkspace = db
    .select()
    .from(BrowserWorkspaceTable)
    .where(eq(BrowserWorkspaceTable.userId, userId))
    .get();
  let workspaceStatus: BrowserWorkspaceStatus | null = null;
  if (existingWorkspace) {
    const installationAvailable = existsSync(existingWorkspace.executable);
    const profileProvisioned =
      installationAvailable &&
      existsSync(
        profileDirectoryFor(
          app.getPath('userData'),
          userId,
          existingWorkspace.executable,
        ),
      );
    if (!installationAvailable) workspaceStatus = 'browser-missing';
    else if (!profileProvisioned) workspaceStatus = 'profile-missing';
    else if (!existingWorkspace.verifiedAt) workspaceStatus = 'unverified';
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
  configureBrowserPolicy(existingSettings.blockedWords);
  missionTraffic.setIntervalSeconds(existingSettings.decisionTimeSeconds);
  return {
    accountId: userId,
    settings: {
      step: existingSettings.step,
      consent: existingSettings.consent,
      launchAtLogin: existingSettings.launchAtLogin,
      backgroundSync: existingSettings.backgroundSync,
      decisionTimeSeconds: existingSettings.decisionTimeSeconds,
      blockedWords: existingSettings.blockedWords,
      localSetupCompletedAt: existingSettings.localSetupCompletedAt,
      notes: existingContext.notes,
    },
    workspace: existingWorkspace
      ? {
          browser: existingWorkspace.browser,
          browserName: existingWorkspace.browserName,
          ready: workspaceStatus === 'ready',
          status: workspaceStatus!,
          verifiedAt: existingWorkspace.verifiedAt || null,
        }
      : null,
    connections: connections.map(
      ({ userId: _userId, ...connection }) => connection,
    ),
    primaryLms: existingContext.primaryLms,
    discovery: {
      status: existingContext.discoveryStatus,
      message: existingContext.discoveryMessage,
      discoveredAt: existingContext.discoveredAt,
      coverage: existingContext.discoveryCoverage ?? {},
      entries: contextEntries.map(({ userId: _userId, ...entry }) => entry),
    },
    preferences: {
      launchAtLogin: getLaunchAtLoginState(existingSettings.launchAtLogin),
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

// An account that already finished onboarding elsewhere only has to set up this
// computer, so the dashboard records local completion as soon as it is ready.
export const settleLocalSetup = (
  state: OnboardingState,
  options: { accountCompleted: boolean },
): OnboardingState => {
  if (
    !options.accountCompleted ||
    state.settings.localSetupCompletedAt ||
    !state.settings.consent ||
    state.workspace?.ready !== true
  )
    return state;
  const now = new Date().toISOString();
  db.update(SettingTable)
    .set({ localSetupCompletedAt: now, updatedAt: now })
    .where(eq(SettingTable.userId, state.accountId))
    .run();
  return getOnboardingState(state.accountId);
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
    const existingContext = tx
      .select({
        coverage: AcademicContextTable.discoveryCoverage,
        discoveredAt: AcademicContextTable.discoveredAt,
      })
      .from(AcademicContextTable)
      .where(eq(AcademicContextTable.userId, userId))
      .get()!;
    const coverage = { ...existingContext.coverage };
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
  options: { cancelled?: boolean; now?: string; notesOmitted?: boolean } = {},
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
    const courseEntries = tx
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
        courseCount: courseEntries.filter(
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
        discoveryMessage: options.notesOmitted
          ? `${summary.message ?? 'Discovery finished.'} Some general notes were omitted because they were too long.`
          : summary.message,
        discoveredAt: summary.discoveredAt,
        discoveryCoverage: summary.coverage,
      })
      .where(eq(AcademicContextTable.userId, userId))
      .run();
  });
  return getOnboardingState(userId);
};
