import { errorMessage } from '../../lib/error-message';
import {
  settingsUpdateSchema,
  type SettingsUpdateSchema,
} from '../onboarding/schemas';
import { watchSettingsSchema } from '../watch/schemas';
import type { WatchSettings } from '../watch/types';

export const settingsSaveGroups = [
  'account',
  'device',
  'connections',
  'personal-context',
  'navigation',
  'background',
  'grades',
  'notifications',
  'appearance',
  'local-data',
  'watch',
] as const;
export type SettingsSaveGroup = (typeof settingsSaveGroups)[number];

export type SettingsSaveDraft = Partial<SettingsUpdateSchema> & {
  watchSettings?: WatchSettings;
};

type SettingsSaveGroupState = {
  pending: number;
  error: string | null;
  draft: SettingsSaveDraft;
  revision: number;
};

export type SettingsSaveState = {
  pending: number;
  error: string | null;
  draft: SettingsSaveDraft;
  revision: number;
  groups: Partial<Record<SettingsSaveGroup, SettingsSaveGroupState>>;
};

export const settingsUpdateFromSaveDraft = (draft: SettingsSaveDraft) => {
  const { watchSettings: _watchSettings, ...changes } = draft;
  return settingsUpdateSchema.parse(changes);
};

type RetryOperation = (draft: SettingsSaveDraft) => Promise<void>;

type PersistedSettingsGroup = {
  pending: boolean;
  error: string | null;
  draft: SettingsSaveDraft;
  revision: number;
};

const persistedStateKey = 'scholaros-settings-save-state-v1';
const interruptedSaveMessage =
  'The save was interrupted. Retry to confirm it completed.';

const settingsQueues = new Map<string, Promise<void>>();
const settingsStates = new Map<string, SettingsSaveState>();
const settingsListeners = new Map<string, Set<() => void>>();
const accountEpochs = new Map<string, number>();
const retryOperations = new Map<
  string,
  Partial<Record<SettingsSaveGroup, RetryOperation>>
>();
const idleState: SettingsSaveState = {
  pending: 0,
  error: null,
  draft: {},
  revision: 0,
  groups: {},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const getStorage = () => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const readPersistedAccounts = () => {
  try {
    const value = getStorage()?.getItem(persistedStateKey);
    if (!value) return Object.create(null) as Record<string, unknown>;
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed)
      ? parsed
      : (Object.create(null) as Record<string, unknown>);
  } catch {
    return Object.create(null) as Record<string, unknown>;
  }
};

const parsePersistedDraft = (value: unknown): SettingsSaveDraft | null => {
  if (!isRecord(value)) return null;
  const { watchSettings, ...settingsDraft } = value;
  const parsedSettings = settingsUpdateSchema.safeParse(settingsDraft);
  if (!parsedSettings.success) return null;
  const draft: SettingsSaveDraft = parsedSettings.data;
  if (watchSettings !== undefined) {
    const parsedWatchSettings = watchSettingsSchema.safeParse(watchSettings);
    if (!parsedWatchSettings.success) return null;
    draft.watchSettings = parsedWatchSettings.data;
  }
  return draft;
};

const restoreSettingsSaveState = (accountId: string): SettingsSaveState => {
  const storedAccount = readPersistedAccounts()[accountId];
  if (!isRecord(storedAccount) || !isRecord(storedAccount.groups))
    return idleState;

  const groups: SettingsSaveState['groups'] = {};
  for (const groupName of settingsSaveGroups) {
    const storedGroup = storedAccount.groups[groupName];
    if (!isRecord(storedGroup)) continue;
    const draft = parsePersistedDraft(storedGroup.draft);
    if (!draft) continue;
    const pending = storedGroup.pending === true;
    const error =
      typeof storedGroup.error === 'string' && storedGroup.error.length <= 300
        ? storedGroup.error
        : pending
          ? interruptedSaveMessage
          : null;
    if (!error && Object.keys(draft).length === 0) continue;
    groups[groupName] = {
      pending: 0,
      error,
      draft,
      revision:
        typeof storedGroup.revision === 'number' &&
        Number.isSafeInteger(storedGroup.revision) &&
        storedGroup.revision >= 0
          ? storedGroup.revision
          : 0,
    };
  }

  const groupStates = settingsSaveGroups.flatMap((groupName) =>
    groups[groupName] ? [groups[groupName]!] : [],
  );
  return {
    pending: 0,
    error: groupStates.find((group) => group.error)?.error ?? null,
    draft: Object.assign({}, ...groupStates.map((group) => group.draft)),
    revision: 0,
    groups,
  };
};

const persistSettingsSaveState = (
  accountId: string,
  state: SettingsSaveState,
) => {
  const storage = getStorage();
  if (!storage) return;
  const accounts = Object.assign(Object.create(null), readPersistedAccounts());
  const groups: Partial<Record<SettingsSaveGroup, PersistedSettingsGroup>> = {};
  for (const groupName of settingsSaveGroups) {
    const group = state.groups[groupName];
    if (
      !group ||
      (!group.pending && !group.error && Object.keys(group.draft).length === 0)
    )
      continue;
    groups[groupName] = {
      pending: group.pending > 0,
      error: group.error,
      draft: group.draft,
      revision: group.revision,
    };
  }
  if (Object.keys(groups).length) accounts[accountId] = { groups };
  else delete accounts[accountId];
  try {
    if (Object.keys(accounts).length)
      storage.setItem(persistedStateKey, JSON.stringify(accounts));
    else storage.removeItem(persistedStateKey);
  } catch {
    // A storage quota/privacy restriction must not prevent an in-memory save.
  }
};

const getQueueKey = (accountId: string, group: SettingsSaveGroup) =>
  `${accountId}:${group}`;

const publishState = (accountId: string, state: SettingsSaveState) => {
  settingsStates.set(accountId, state);
  persistSettingsSaveState(accountId, state);
  settingsListeners.get(accountId)?.forEach((listener) => listener());
};

export const getSettingsSaveState = (accountId: string) => {
  const existingState = settingsStates.get(accountId);
  if (existingState) return existingState;
  const restoredState = restoreSettingsSaveState(accountId);
  settingsStates.set(accountId, restoredState);
  return restoredState;
};

export const clearSettingsSaveState = (accountId: string) => {
  accountEpochs.set(accountId, (accountEpochs.get(accountId) ?? 0) + 1);
  for (const groupName of settingsSaveGroups)
    settingsQueues.delete(getQueueKey(accountId, groupName));
  retryOperations.delete(accountId);
  publishState(accountId, idleState);
};

export const registerSettingsSaveRetry = (
  accountId: string,
  groupName: SettingsSaveGroup,
  retry: RetryOperation,
) => {
  const retries = retryOperations.get(accountId) ?? {};
  retries[groupName] = retry;
  retryOperations.set(accountId, retries);
  return () => {
    if (retries[groupName] !== retry) return;
    delete retries[groupName];
    if (!Object.keys(retries).length) retryOperations.delete(accountId);
  };
};

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

const areEqual = (left: unknown, right: unknown) => {
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  return left === right;
};

const aggregateState = (
  previous: SettingsSaveState,
  groups: SettingsSaveState['groups'],
): SettingsSaveState => {
  const groupStates = settingsSaveGroups.flatMap((group) =>
    groups[group] ? [groups[group]!] : [],
  );
  return {
    pending: groupStates.reduce((total, group) => total + group.pending, 0),
    error: groupStates.find((group) => group.error)?.error ?? null,
    draft: Object.assign({}, ...groupStates.map((group) => group.draft)),
    revision: previous.revision + 1,
    groups,
  };
};

export const reconcileSettingsSaveDraft = (
  accountId: string,
  persisted: Partial<SettingsUpdateSchema> & {
    watchSettings?: WatchSettings;
  },
) => {
  const state = getSettingsSaveState(accountId);
  const groups = { ...state.groups };
  let changed = false;

  for (const groupName of settingsSaveGroups) {
    const group = groups[groupName];
    if (!group || group.pending > 0 || group.error) continue;
    const draft = { ...group.draft };
    if (
      groupName === 'watch' &&
      draft.watchSettings &&
      persisted.watchSettings
    ) {
      const draftSettings = draft.watchSettings;
      const persistedSettings = persisted.watchSettings;
      if (
        draftSettings.watchEnabled === persistedSettings.watchEnabled &&
        areEqual(draftSettings.watchUrls, persistedSettings.watchUrls)
      )
        delete draft.watchSettings;
    }
    if (groupName === 'background')
      for (const key of ['launchAtLogin', 'backgroundSync'] as const)
        if (key in persisted && areEqual(draft[key], persisted[key]))
          delete draft[key];
    if (groupName === 'navigation')
      for (const key of Object.keys(draft) as (keyof SettingsUpdateSchema)[]) {
        if (key in persisted && areEqual(draft[key], persisted[key]))
          delete draft[key];
      }
    if (Object.keys(draft).length !== Object.keys(group.draft).length) {
      groups[groupName] = { ...group, draft };
      changed = true;
    }
  }

  if (changed) publishState(accountId, aggregateState(state, groups));
};

const queueSettingsOperation = (
  accountId: string,
  groupName: SettingsSaveGroup,
  draft: SettingsSaveDraft,
  save: RetryOperation,
) => {
  const accountEpoch = accountEpochs.get(accountId) ?? 0;
  const currentState = getSettingsSaveState(accountId);
  const previousGroup = currentState.groups[groupName] ?? {
    pending: 0,
    error: null,
    draft: {},
    revision: 0,
  };
  const revision = previousGroup.revision + 1;
  const nextGroup: SettingsSaveGroupState = {
    pending: previousGroup.pending + 1,
    error: previousGroup.error,
    draft: { ...previousGroup.draft, ...draft },
    revision,
  };
  const groups = { ...currentState.groups, [groupName]: nextGroup };
  publishState(accountId, aggregateState(currentState, groups));
  registerSettingsSaveRetry(accountId, groupName, save);

  const queueKey = getQueueKey(accountId, groupName);
  const previous = settingsQueues.get(queueKey) ?? Promise.resolve();
  const operation = previous.then(() =>
    (accountEpochs.get(accountId) ?? 0) === accountEpoch
      ? save(nextGroup.draft)
      : undefined,
  );
  const settled = operation.then(
    () => {
      if ((accountEpochs.get(accountId) ?? 0) !== accountEpoch) return;
      const state = getSettingsSaveState(accountId);
      const group = state.groups[groupName];
      if (!group) return;
      const isLatestRevision = group.revision === revision;
      const nextGroups = {
        ...state.groups,
        [groupName]: {
          ...group,
          pending: Math.max(0, group.pending - 1),
          error: isLatestRevision ? null : group.error,
        },
      };
      publishState(accountId, aggregateState(state, nextGroups));
    },
    (error: unknown) => {
      if ((accountEpochs.get(accountId) ?? 0) !== accountEpoch) return;
      const state = getSettingsSaveState(accountId);
      const group = state.groups[groupName];
      if (!group) return;
      const isLatestRevision = group.revision === revision;
      const nextGroups = {
        ...state.groups,
        [groupName]: {
          ...group,
          pending: Math.max(0, group.pending - 1),
          error: isLatestRevision
            ? errorMessage(error, 'Could not save settings.')
            : group.error,
        },
      };
      publishState(accountId, aggregateState(state, nextGroups));
    },
  );
  settingsQueues.set(queueKey, settled);
  void settled.then(() => {
    if (settingsQueues.get(queueKey) === settled)
      settingsQueues.delete(queueKey);
  });
  return operation;
};

export const queueSettingsGroupSave = (
  accountId: string,
  groupName: SettingsSaveGroup,
  draft: SettingsSaveDraft,
  save: RetryOperation,
) => queueSettingsOperation(accountId, groupName, draft, save);

export const queueSettingsSave = (
  accountId: string,
  changes: SettingsUpdateSchema,
  save: RetryOperation,
) => queueSettingsOperation(accountId, 'navigation', changes, save);

export const queueWatchSettingsSave = (
  accountId: string,
  settings: WatchSettings,
  save: RetryOperation,
) =>
  queueSettingsOperation(accountId, 'watch', { watchSettings: settings }, save);

export const retrySettingsSave = (
  accountId: string,
  groupName: SettingsSaveGroup,
) => {
  const group = getSettingsSaveState(accountId).groups[groupName];
  const retry = retryOperations.get(accountId)?.[groupName];
  if (!group?.error || !retry) return Promise.resolve();
  return queueSettingsOperation(accountId, groupName, group.draft, retry);
};
