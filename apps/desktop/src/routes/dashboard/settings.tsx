import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { SettingsUpdateSchema } from '../../features/onboarding/schemas';
import type {
  ScholarBridge,
  WatchRuntimeState,
  WatchSettings,
} from '../../features/onboarding/types';
import { PageHeading } from '../../features/dashboard/page-heading';
import { useOnboardingState } from '../../features/onboarding/hooks/use-onboarding-state';
import type { WatchHealthSummary } from '../../features/watch/types';
import { watchSettingsSchema } from '../../features/watch/schemas';
import { settingsSections } from '../../db/shared';
import { ProductSettings } from '../../features/settings/components/product-settings';
import type { DeviceReplacementActions } from '../../features/settings/components/device-settings';
import {
  clearSettingsSaveState,
  registerSettingsSaveRetry,
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

type SettingsBridge = ScholarBridge &
  DeviceReplacementBridge &
  WatchHealthBridge;

type AccountSnapshot<T> = { accountId: string; value: T };

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
  const [watchError, setWatchError] = useState<string | null>(null);
  const snapshotRevision = useRef(0);
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
  const bridge = window.scholar as SettingsBridge;
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
    ];
    return () => unregister.forEach((stop) => stop());
  }, [saveSettings, saveWatchSettings, state?.accountId]);

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
