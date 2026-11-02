import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { PageHeading } from '../../features/dashboard/page-heading';
import { AgentSettings } from '../../features/dashboard/agent-settings';
import { useOnboardingState } from '../../features/onboarding/hooks/use-onboarding-state';
import { WatchSettings } from '../../features/watch/components/watch-settings';
import type {
  WatchRuntimeState,
  WatchSettings as WatchSettingsValue,
} from '../../features/onboarding/types';

const SettingsPage = () => {
  const search = Route.useSearch();
  const { state, loading, loadError } = useOnboardingState();
  const [watchSnapshot, setWatchSnapshot] = useState<{
    accountId: string;
    settings: WatchSettingsValue;
  } | null>(null);
  const [watchRuntimeSnapshot, setWatchRuntimeSnapshot] = useState<{
    accountId: string;
    runtime: WatchRuntimeState;
  } | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const watchSettings =
    state && watchSnapshot?.accountId === state.accountId
      ? watchSnapshot.settings
      : null;
  const watchRuntime =
    state && watchRuntimeSnapshot?.accountId === state.accountId
      ? watchRuntimeSnapshot.runtime
      : null;

  useEffect(() => {
    if (!state) {
      setWatchSnapshot(null);
      setWatchRuntimeSnapshot(null);
      setWatchError(null);
      return;
    }
    let active = true;
    const accountId = state.accountId;
    setWatchSnapshot(null);
    setWatchRuntimeSnapshot(null);
    setWatchError(null);
    const unsubscribe = window.scholar.onWatchChange((change) => {
      if (!active || change.accountId !== accountId) return;
      setWatchRuntimeSnapshot({
        accountId,
        runtime: { enabled: change.enabled, status: change.status },
      });
    });
    const reloadWatchSnapshot = async () => {
      if ((await window.scholar.getCurrentUser())?.id !== accountId)
        return null;
      const [settings, runtime] = await Promise.all([
        window.scholar.getWatchSettings(),
        window.scholar.getWatchRuntimeState(),
      ]);
      if ((await window.scholar.getCurrentUser())?.id !== accountId)
        return null;
      return { settings, runtime };
    };
    const applySnapshot = async () => {
      const snapshot = await reloadWatchSnapshot();
      if (!active || !snapshot) return;
      setWatchSnapshot({ accountId, settings: snapshot.settings });
      setWatchRuntimeSnapshot({ accountId, runtime: snapshot.runtime });
      setWatchError(null);
    };
    const unsubscribeCourses = window.scholar.onCoursesChange((change) => {
      if (!active || change.accountId !== accountId) return;
      void applySnapshot().catch(() => undefined);
    });
    void applySnapshot().catch((error: unknown) => {
      if (!active) return;
      setWatchError(
        error instanceof Error
          ? error.message
          : 'Could not load course page watching.',
      );
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeCourses();
    };
  }, [state?.accountId]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading page="settings" />
      {loading && <p role="status">Loading settings</p>}
      {loadError && (
        <p role="alert" className="text-destructive">
          {loadError}
        </p>
      )}
      {watchError && (
        <p role="alert" className="text-destructive">
          {watchError}
        </p>
      )}
      {state && (
        <AgentSettings
          key={state.accountId}
          accountId={state.accountId}
          decisionTimeSeconds={state.settings.decisionTimeSeconds}
          blockedWords={state.settings.blockedWords}
          onSave={async (changes) => {
            if ((await window.scholar.getCurrentUser())?.id !== state.accountId)
              throw new Error('Your session changed; sign in again.');
            await window.scholar.saveSettings(changes);
          }}
        >
          {watchSettings && (
            <WatchSettings
              accountId={state.accountId}
              settings={watchSettings}
              connections={state.connections}
              status={watchRuntime?.status ?? state.watch?.status ?? 'off'}
              focusOnMount={search.section === 'watch'}
              onSave={async (settings) => {
                if (
                  (await window.scholar.getCurrentUser())?.id !==
                  state.accountId
                )
                  throw new Error('Your session changed; sign in again.');
                const saved = await window.scholar.saveWatchSettings(settings);
                if (
                  (await window.scholar.getCurrentUser())?.id !==
                  state.accountId
                )
                  throw new Error('Your session changed; sign in again.');
                setWatchSnapshot({
                  accountId: state.accountId,
                  settings: saved,
                });
                return saved;
              }}
            />
          )}
        </AgentSettings>
      )}
    </div>
  );
};

export const Route = createFileRoute('/dashboard/settings')({
  validateSearch: z.object({ section: z.enum(['watch']).optional() }),
  component: SettingsPage,
});
