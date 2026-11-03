import { createMissionNavigator } from './mission-navigation';
import { getWorkspace } from './browser-workspace';
import { academicTasks } from './academic-tasks';
import { scanConnection } from './connection-scan';
import {
  applyAcademicDiscovery,
  getOnboardingState,
  markAcademicDiscoveryRunning,
  type AcademicDiscoveryResult,
} from './store';
import type { ConnectionOutcome } from '../lib/discovery-outcomes';
import type { OnboardingState } from '../types';

const discoveryTimeoutMs = 45_000;
const discoveryMaxPages = 4;

const performAcademicDiscovery = async (
  userId: string,
  isCurrent: () => boolean = () => true,
  externalSignal?: AbortSignal,
): Promise<OnboardingState> => {
  const state = getOnboardingState(userId);
  if (!state.settings.consent)
    throw new Error('Approve academic access first.');
  if (!state.workspace?.ready)
    throw new Error('Set up and verify your study browser first.');
  const connections = state.connections;
  if (!connections.length)
    throw new Error('Confirm a connected resource first.');
  const hosts = connections.map((connection) => connection.host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), discoveryTimeoutMs);
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  const results: AcademicDiscoveryResult[] = [];
  let notesOmitted = false;
  try {
    const workspace = await getWorkspace(
      userId,
      () => isCurrent() && !signal.aborted,
    );
    signal.throwIfAborted();
    markAcademicDiscoveryRunning(userId);
    await workspace.browser.context.setDomainPolicy({
      allowedDomains: hosts,
      blockedDomains: [],
    });
    const navigatePage = createMissionNavigator(
      () => workspace.browser.context,
      hosts,
      signal,
      isCurrent,
      { scopeId: userId },
    );
    try {
      for (const connection of connections) {
        if (!isCurrent())
          throw new Error('Your session changed; sign in again.');
        signal.throwIfAborted();
        if (connection.status === 'needs-sign-in') {
          results.push({
            connectionId: connection.id,
            outcome: 'needs-sign-in',
            entries: [],
          });
          continue;
        }
        const scan = await scanConnection({
          connection,
          workspace,
          hosts,
          notes: state.settings.notes,
          navigatePage,
          isCurrent,
          signal,
          maxPages: discoveryMaxPages,
        });
        notesOmitted ||= scan.notesOmitted;
        results.push({
          connectionId: connection.id,
          outcome: scan.outcome,
          entries: scan.entries,
        });
      }
    } finally {
      await workspace.browser.context
        .setDomainPolicy(null)
        .catch(() => undefined);
    }
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
    return applyAcademicDiscovery(
      userId,
      results,
      notesOmitted ? { notesOmitted: true } : {},
    );
  } catch (error) {
    // A stopped or failed run still records what could not be read.
    if (isCurrent())
      applyAcademicDiscovery(
        userId,
        results.length
          ? results
          : connections.map((connection) => ({
              connectionId: connection.id,
              outcome: 'blocked' as ConnectionOutcome,
              entries: [],
            })),
        { cancelled: signal.aborted },
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const discoverAcademicContext = (
  userId: string,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) =>
  academicTasks.run(
    userId,
    (taskSignal) => performAcademicDiscovery(userId, isCurrent, taskSignal),
    signal,
  );
