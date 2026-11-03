import { errorMessage } from '../../lib/error-message';
import type { SettingsUpdateSchema } from '../onboarding/schemas';
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

type RetryOperation = {
  draft: SettingsSaveDraft;
  save: () => Promise<void>;
};

const settingsQueues = new Map<string, Promise<void>>();
const settingsStates = new Map<string, SettingsSaveState>();
const settingsListeners = new Map<string, Set<() => void>>();
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

const getQueueKey = (accountId: string, group: SettingsSaveGroup) =>
  `${accountId}:${group}`;

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
  save: () => Promise<void>,
) => {
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
  const retryForAccount = retryOperations.get(accountId) ?? {};
  retryForAccount[groupName] = { draft, save };
  retryOperations.set(accountId, retryForAccount);

  const queueKey = getQueueKey(accountId, groupName);
  const previous = settingsQueues.get(queueKey) ?? Promise.resolve();
  const operation = previous.then(save);
  const settled = operation.then(
    () => {
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

export const queueSettingsSave = (
  accountId: string,
  changes: SettingsUpdateSchema,
  save: () => Promise<void>,
) => queueSettingsOperation(accountId, 'navigation', changes, save);

export const queueWatchSettingsSave = (
  accountId: string,
  settings: WatchSettings,
  save: () => Promise<void>,
) =>
  queueSettingsOperation(accountId, 'watch', { watchSettings: settings }, save);

export const retrySettingsSave = (
  accountId: string,
  groupName: SettingsSaveGroup,
) => {
  const group = getSettingsSaveState(accountId).groups[groupName];
  const retry = retryOperations.get(accountId)?.[groupName];
  if (!group?.error || !retry) return Promise.resolve();
  return queueSettingsOperation(accountId, groupName, retry.draft, retry.save);
};
