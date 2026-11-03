import { errorMessage } from '../../lib/error-message';
import type { SettingsUpdateSchema } from '../onboarding/schemas';
import type { WatchSettings } from '../watch/types';

export type SettingsSaveDraft = Partial<SettingsUpdateSchema> & {
  watchSettings?: WatchSettings;
};

export type SettingsSaveState = {
  pending: number;
  error: string | null;
  draft: SettingsSaveDraft;
  revision: number;
};

const settingsQueues = new Map<string, Promise<void>>();
const settingsStates = new Map<string, SettingsSaveState>();
const settingsListeners = new Map<string, Set<() => void>>();
const idleState: SettingsSaveState = {
  pending: 0,
  error: null,
  draft: {},
  revision: 0,
};

const publishState = (accountId: string, state: SettingsSaveState) => {
  settingsStates.set(accountId, state);
  settingsListeners.get(accountId)?.forEach((listener) => listener());
};

export const getSettingsSaveState = (accountId: string) =>
  settingsStates.get(accountId) ?? idleState;

export const subscribeSettingsSaveState = (
  accountId: string,
  listener: () => void,
) => {
  const listeners = settingsListeners.get(accountId) ?? new Set();
  listeners.add(listener);
  settingsListeners.set(accountId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) settingsListeners.delete(accountId);
  };
};

export const reconcileSettingsSaveDraft = (
  accountId: string,
  persisted: {
    decisionTimeSeconds?: number;
    blockedWords?: string[];
    watchSettings?: WatchSettings;
  },
) => {
  const state = getSettingsSaveState(accountId);
  if (state.pending > 0 || state.error) return;
  const draft = { ...state.draft };
  if (
    draft.decisionTimeSeconds !== undefined &&
    draft.decisionTimeSeconds === persisted.decisionTimeSeconds
  )
    delete draft.decisionTimeSeconds;
  if (
    draft.blockedWords &&
    persisted.blockedWords &&
    draft.blockedWords.length === persisted.blockedWords.length &&
    draft.blockedWords.every(
      (word, index) => word === persisted.blockedWords?.[index],
    )
  )
    delete draft.blockedWords;
  if (
    draft.watchSettings &&
    persisted.watchSettings &&
    draft.watchSettings.watchEnabled === persisted.watchSettings.watchEnabled &&
    draft.watchSettings.watchUrls.length ===
      persisted.watchSettings.watchUrls.length &&
    draft.watchSettings.watchUrls.every(
      (url, index) => url === persisted.watchSettings?.watchUrls[index],
    )
  )
    delete draft.watchSettings;
  if (Object.keys(draft).length !== Object.keys(state.draft).length)
    publishState(accountId, { ...state, draft });
};

const queueSettingsOperation = (
  accountId: string,
  updateDraft: (draft: SettingsSaveDraft) => SettingsSaveDraft,
  save: () => Promise<void>,
) => {
  const currentState = getSettingsSaveState(accountId);
  publishState(accountId, {
    pending: currentState.pending + 1,
    error: null,
    draft: updateDraft(currentState.draft),
    revision: currentState.revision + 1,
  });
  const previous = settingsQueues.get(accountId) ?? Promise.resolve();
  const operation = previous.then(save);
  const settled = operation.then(
    () => {
      const state = getSettingsSaveState(accountId);
      publishState(accountId, {
        ...state,
        pending: Math.max(0, state.pending - 1),
        error: null,
      });
    },
    (error: unknown) => {
      const state = getSettingsSaveState(accountId);
      publishState(accountId, {
        ...state,
        pending: Math.max(0, state.pending - 1),
        error: errorMessage(error, 'Could not save settings.'),
      });
    },
  );
  settingsQueues.set(accountId, settled);
  void settled.then(() => {
    if (settingsQueues.get(accountId) === settled)
      settingsQueues.delete(accountId);
  });
  return operation;
};

export const queueSettingsSave = (
  accountId: string,
  changes: SettingsUpdateSchema,
  save: () => Promise<void>,
) =>
  queueSettingsOperation(
    accountId,
    (draft) => ({ ...draft, ...changes }),
    save,
  );

export const queueWatchSettingsSave = (
  accountId: string,
  settings: WatchSettings,
  save: () => Promise<void>,
) =>
  queueSettingsOperation(
    accountId,
    (draft) => ({ ...draft, watchSettings: settings }),
    save,
  );
