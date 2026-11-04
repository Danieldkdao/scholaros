import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  notificationSettingsSchema,
  type NotificationSettings as NotificationSettingsValue,
} from '@scholaros/services/learning/notification-contracts';
import type { SettingsUpdateSchema } from '../../features/onboarding/schemas';
import type {
  ScholarBridge,
  WatchRuntimeState,
  WatchSettings,
} from '../../features/onboarding/types';
import { errorMessage } from '../../lib/error-message';
import { PageHeading } from '../../features/dashboard/page-heading';
import { useOnboardingState } from '../../features/onboarding/hooks/use-onboarding-state';
import type { WatchHealthSummary } from '../../features/watch/types';
import { watchSettingsSchema } from '../../features/watch/schemas';
import { settingsSections } from '../../db/shared';
import { ProductSettings } from '../../features/settings/components/product-settings';
import type { DeviceReplacementActions } from '../../features/settings/components/device-settings';
import { NotificationSettings } from '../../features/notifications/components/notification-settings';
import { notificationPermissionStates } from '../../features/notifications/services/notification-policy';
import type { NotificationPermission } from '../../features/notifications/services/notification-policy';
import {
  clearSettingsSaveState,
  registerSettingsSaveRetry,
  reconcileSettingsSaveDraft,
  settingsUpdateFromSaveDraft,
} from '../../features/dashboard/settings-save-queue';

type DeviceReplacementBridge = {
  stageWorkspaceReplacement?: DeviceReplacementActions['stage'];
  commitWorkspaceReplacement?: DeviceReplacementActions['commit'];
  cancelWorkspaceReplacement?: DeviceReplacementActions['cancel'];
};

type WatchHealthBridge = {
  getWatchHealthSummary?: () => Promise<WatchHealthSummary | null>;
  onWatchHealthChange?: (
    listener: (change: { accountId: string; revision: number }) => void,
  ) => () => void;
};

type NotificationSettingsBridge = {
  getNotificationSettings?: () => Promise<NotificationSettingsValue>;
  saveNotificationSettings?: (input: {
    settings: Omit<NotificationSettingsValue, 'revision'>;
    expectedRevision: number;
  }) => Promise<NotificationSettingsValue>;
  getNotificationPermissionState?: () => Promise<NotificationPermission>;
  requestNotificationPermission?: (
    input: Record<string, never>,
  ) => Promise<{ state: NotificationPermission }>;
};

type SettingsBridge = Omit<
  ScholarBridge,
  | 'getNotificationSettings'
  | 'saveNotificationSettings'
  | 'requestNotificationPermission'
  | 'deleteLocalAcademicData'
  | 'stageWorkspaceReplacement'
  | 'commitWorkspaceReplacement'
  | 'cancelWorkspaceReplacement'
> &
  DeviceReplacementBridge &
  WatchHealthBridge &
  NotificationSettingsBridge;

type AccountSnapshot<T> = { accountId: string; value: T };
type NotificationSnapshot = {
  accountId: string;
  settings: NotificationSettingsValue;
  permissionState: NotificationPermission;
};

const isNotificationPermission = (
  value: unknown,
): value is NotificationPermission =>
  notificationPermissionStates.some((permission) => permission === value);

const normalizeNotificationPermission = (value: unknown) => {
  if (isNotificationPermission(value)) return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    'state' in value &&
    isNotificationPermission(value.state)
  )
    return value.state;
  return 'unknown';
};

const getReplacementActions = (
  bridge: SettingsBridge,
): DeviceReplacementActions | null => {
  if (
    !bridge.stageWorkspaceReplacement ||
    !bridge.commitWorkspaceReplacement ||
    !bridge.cancelWorkspaceReplacement
  )
    return null;
  return {
    stage: (input) => bridge.stageWorkspaceReplacement!(input),
    commit: (input) => bridge.commitWorkspaceReplacement!(input),
    cancel: (input) => bridge.cancelWorkspaceReplacement!(input),
  };
};

const SettingsPage = () => {
  const search = Route.useSearch();
  const { state, loading, loadError, setState } = useOnboardingState();
  const [watchSnapshot, setWatchSnapshot] =
    useState<AccountSnapshot<WatchSettings> | null>(null);
  const [watchRuntimeSnapshot, setWatchRuntimeSnapshot] =
    useState<AccountSnapshot<WatchRuntimeState> | null>(null);
  const [watchHealthSnapshot, setWatchHealthSnapshot] =
    useState<AccountSnapshot<WatchHealthSummary | null> | null>(null);
  const [notificationSnapshot, setNotificationSnapshot] =
    useState<NotificationSnapshot | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(
    null,
  );
  const snapshotRevision = useRef(0);
  const notificationSnapshotRevision = useRef(0);
  const lastHealthEventRevision = useRef(-1);
  const watchSettings =
    state && watchSnapshot?.accountId === state.accountId
      ? watchSnapshot.value
      : null;
  const watchRuntime =
    state && watchRuntimeSnapshot?.accountId === state.accountId
      ? watchRuntimeSnapshot.value
      : null;
  const watchHealth =
    state && watchHealthSnapshot?.accountId === state.accountId
      ? watchHealthSnapshot.value
      : null;
  const notificationSettings =
    state && notificationSnapshot?.accountId === state.accountId
      ? notificationSnapshot.settings
      : null;
  const notificationPermission =
    state && notificationSnapshot?.accountId === state.accountId
      ? notificationSnapshot.permissionState
      : 'unknown';
  const bridge = window.scholar as unknown as SettingsBridge;
  const replacementActions = getReplacementActions(bridge);

  useEffect(() => {
    snapshotRevision.current += 1;
    if (!state) {
      setWatchSnapshot(null);
      setWatchRuntimeSnapshot(null);
      setWatchHealthSnapshot(null);
      setWatchError(null);
      lastHealthEventRevision.current = -1;
      return;
    }
    let active = true;
    const accountId = state.accountId;
    setWatchSnapshot(null);
    setWatchRuntimeSnapshot(null);
    setWatchHealthSnapshot(null);
    setWatchError(null);
    lastHealthEventRevision.current = -1;

    const readWatchSnapshot = async () => {
      if ((await bridge.getCurrentUser())?.id !== accountId) return null;
      const healthRequest = bridge.getWatchHealthSummary
        ? bridge.getWatchHealthSummary().catch(() => null)
        : Promise.resolve(null);
      const [settings, runtime, health] = await Promise.all([
        bridge.getWatchSettings(),
        bridge.getWatchRuntimeState(),
        healthRequest,
      ]);
      if ((await bridge.getCurrentUser())?.id !== accountId) return null;
      return { settings, runtime, health };
    };
    const applySnapshot = async () => {
      const revision = ++snapshotRevision.current;
      const snapshot = await readWatchSnapshot();
      if (!active || !snapshot || revision !== snapshotRevision.current) return;
      setWatchSnapshot({ accountId, value: snapshot.settings });
      setWatchRuntimeSnapshot({ accountId, value: snapshot.runtime });
      setWatchHealthSnapshot({ accountId, value: snapshot.health });
      setWatchError(null);
    };
    const unsubscribe = bridge.onWatchChange((change) => {
      if (!active || change.accountId !== accountId) return;
      void applySnapshot().catch(() => undefined);
    });
    const unsubscribeCourses = bridge.onCoursesChange((change) => {
      if (!active || change.accountId !== accountId) return;
      void applySnapshot().catch(() => undefined);
    });
    const unsubscribeHealth = bridge.onWatchHealthChange?.((change) => {
      if (
        !active ||
        change.accountId !== accountId ||
        change.revision <= lastHealthEventRevision.current
      )
        return;
      lastHealthEventRevision.current = change.revision;
      void applySnapshot().catch(() => undefined);
    });
    void applySnapshot().catch((cause: unknown) => {
      if (!active) return;
      setWatchError(
        cause instanceof Error
          ? cause.message
          : 'Could not load course page watching.',
      );
    });
    return () => {
      active = false;
      snapshotRevision.current += 1;
      unsubscribe();
      unsubscribeCourses();
      unsubscribeHealth?.();
    };
  }, [state?.accountId]);

  useEffect(() => {
    const revision = ++notificationSnapshotRevision.current;
    if (!state) {
      setNotificationSnapshot(null);
      setNotificationError(null);
      return;
    }
    let active = true;
    const accountId = state.accountId;
    setNotificationSnapshot(null);
    setNotificationError(null);

    const loadNotificationSnapshot = async () => {
      if ((await bridge.getCurrentUser())?.id !== accountId) return;
      if (!bridge.getNotificationSettings) {
        if (!active || revision !== notificationSnapshotRevision.current)
          return;
        setNotificationError(
          'Notification settings are unavailable until the desktop settings bridge is connected.',
        );
        return;
      }
      const permissionRequest = bridge.getNotificationPermissionState
        ? bridge
            .getNotificationPermissionState()
            .catch(() => 'unknown' as const)
        : Promise.resolve('unknown' as const);
      const [settings, permissionState] = await Promise.all([
        bridge.getNotificationSettings(),
        permissionRequest,
      ]);
      const parsedSettings = notificationSettingsSchema.safeParse(settings);
      if (!parsedSettings.success)
        throw new Error('Notification settings are invalid.');
      if ((await bridge.getCurrentUser())?.id !== accountId) return;
      if (!active || revision !== notificationSnapshotRevision.current) return;
      setNotificationSnapshot({
        accountId,
        settings: parsedSettings.data,
        permissionState,
      });
      setNotificationError(null);
    };

    void loadNotificationSnapshot().catch((cause: unknown) => {
      if (!active || revision !== notificationSnapshotRevision.current) return;
      setNotificationError(
        errorMessage(cause, 'Could not load notification settings.'),
      );
    });
    return () => {
      active = false;
    };
  }, [state?.accountId]);

  const saveSettings = useCallback(
    async (changes: SettingsUpdateSchema) => {
      const accountId = state?.accountId;
      if (!accountId || (await bridge.getCurrentUser())?.id !== accountId)
        throw new Error('Your session changed; sign in again.');
      const updatedState = await bridge.saveSettings(changes);
      if ((await bridge.getCurrentUser())?.id !== accountId)
        throw new Error('Your session changed; sign in again.');
      setState(updatedState);
      return updatedState;
    },
    [bridge, setState, state?.accountId],
  );

  const saveWatchSettings = useCallback(
    async (settings: WatchSettings) => {
      const accountId = state?.accountId;
      if (!accountId || (await bridge.getCurrentUser())?.id !== accountId)
        throw new Error('Your session changed; sign in again.');
      const saved = await bridge.saveWatchSettings(settings);
      if ((await bridge.getCurrentUser())?.id !== accountId)
        throw new Error('Your session changed; sign in again.');
      snapshotRevision.current += 1;
      setWatchSnapshot({ accountId, value: saved });
      return saved;
    },
    [bridge, setWatchSnapshot, state?.accountId],
  );

  const saveNotificationPreferences = useCallback(
    async (settings: NotificationSettingsValue) => {
      const accountId = state?.accountId;
      if (!accountId || (await bridge.getCurrentUser())?.id !== accountId)
        throw new Error('Your session changed; sign in again.');
      if (!bridge.saveNotificationSettings)
        throw new Error('Notification settings are unavailable right now.');
      const parsedSettings = notificationSettingsSchema.safeParse(settings);
      if (!parsedSettings.success)
        throw new Error('Notification settings are invalid.');
      const { revision: _revision, ...preferences } = parsedSettings.data;
      const savedSettings = await bridge.saveNotificationSettings({
        settings: preferences,
        expectedRevision: parsedSettings.data.revision,
      });
      const parsedSavedSettings =
        notificationSettingsSchema.safeParse(savedSettings);
      if (!parsedSavedSettings.success)
        throw new Error('Saved notification settings are invalid.');
      if ((await bridge.getCurrentUser())?.id !== accountId)
        throw new Error('Your session changed; sign in again.');
      const saved = parsedSavedSettings.data;
      setNotificationSnapshot((current) =>
        current?.accountId === accountId
          ? { ...current, settings: saved }
          : { accountId, settings: saved, permissionState: 'unknown' },
      );
      reconcileSettingsSaveDraft(accountId, { notificationSettings: saved });
      return saved;
    },
    [bridge, state?.accountId],
  );

  const requestNotificationPermission = useCallback(async () => {
    const accountId = state?.accountId;
    if (!accountId || (await bridge.getCurrentUser())?.id !== accountId)
      throw new Error('Your session changed; sign in again.');
    if (!bridge.requestNotificationPermission) return 'unknown';
    let permission: NotificationPermission;
    try {
      permission = normalizeNotificationPermission(
        await bridge.requestNotificationPermission({}),
      );
    } catch {
      return 'unknown';
    }
    if ((await bridge.getCurrentUser())?.id !== accountId)
      throw new Error('Your session changed; sign in again.');
    return permission;
  }, [bridge, state?.accountId]);

  useEffect(() => {
    if (!state?.accountId) return;
    const accountId = state.accountId;
    const unregister = [
      registerSettingsSaveRetry(accountId, 'navigation', async (draft) => {
        await saveSettings(settingsUpdateFromSaveDraft(draft));
      }),
      registerSettingsSaveRetry(accountId, 'background', async (draft) => {
        await saveSettings(settingsUpdateFromSaveDraft(draft));
      }),
      registerSettingsSaveRetry(accountId, 'watch', async (draft) => {
        const parsed = watchSettingsSchema.safeParse(draft.watchSettings);
        if (!parsed.success) throw new Error('Watch settings are invalid.');
        await saveWatchSettings(parsed.data);
      }),
      registerSettingsSaveRetry(accountId, 'notifications', async (draft) => {
        const parsed = notificationSettingsSchema.safeParse(
          draft.notificationSettings,
        );
        if (!parsed.success)
          throw new Error('Notification settings are invalid.');
        await saveNotificationPreferences(parsed.data);
      }),
    ];
    return () => unregister.forEach((stop) => stop());
  }, [
    saveNotificationPreferences,
    saveSettings,
    saveWatchSettings,
    state?.accountId,
  ]);

  const notificationLeaf =
    !bridge.getNotificationSettings || !bridge.saveNotificationSettings ? (
      <p role="status" className="text-base text-muted-foreground">
        Notification settings are unavailable until the desktop settings bridge
        is connected.
      </p>
    ) : notificationError ? (
      <p role="alert" className="text-base text-destructive">
        {notificationError}
      </p>
    ) : notificationSettings ? (
      <NotificationSettings
        accountId={state?.accountId ?? ''}
        settings={notificationSettings}
        onSave={saveNotificationPreferences}
        requestPermission={requestNotificationPermission}
        permissionState={notificationPermission}
      />
    ) : (
      <p role="status" className="text-base text-muted-foreground">
        Loading notification settings.
      </p>
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeading page="settings" />
      {loading && <p role="status">Loading settings</p>}
      {loadError && (
        <p role="alert" className="text-base text-destructive">
          {loadError}
        </p>
      )}
      {watchError && (
        <p role="alert" className="text-base text-destructive">
          {watchError}
        </p>
      )}
      {state && (
        <ProductSettings
          key={state.accountId}
          accountId={state.accountId}
          state={state}
          section={search.section}
          watchSettings={watchSettings}
          watchRuntime={watchRuntime}
          watchHealth={watchHealth}
          watchError={watchError}
          replacementActions={replacementActions}
          leafSettings={{ notifications: notificationLeaf }}
          onSettingsSave={saveSettings}
          onWatchSave={saveWatchSettings}
          onStateChange={setState}
          onLocalDataDeleted={() => clearSettingsSaveState(state.accountId)}
        />
      )}
    </div>
  );
};

export const Route = createFileRoute('/dashboard/settings')({
  validateSearch: z.object({
    section: z.enum([...settingsSections, 'watch']).optional(),
  }),
  component: SettingsPage,
});
