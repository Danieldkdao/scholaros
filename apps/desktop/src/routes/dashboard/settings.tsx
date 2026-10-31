import { createFileRoute } from '@tanstack/react-router';
import { PageHeading } from '../../features/dashboard/page-heading';
import { AgentSettings } from '../../features/dashboard/agent-settings';
import { useOnboardingState } from '../../features/onboarding/hooks/use-onboarding-state';

const SettingsPage = () => {
  const { state, loading, loadError } = useOnboardingState();
  return (
    <div className="flex flex-col gap-6">
      <PageHeading page="settings" />
      {loading && <p role="status">Loading settings</p>}
      {loadError && (
        <p role="alert" className="text-destructive">
          {loadError}
        </p>
      )}
      {state && (
        <AgentSettings
          key={state.accountId}
          decisionTimeSeconds={state.settings.decisionTimeSeconds}
          blockedWords={state.settings.blockedWords}
          onSave={async (changes) => {
            if ((await window.scholar.getCurrentUser())?.id !== state.accountId)
              throw new Error('Your session changed; sign in again.');
            await window.scholar.saveSettings(changes);
          }}
        />
      )}
    </div>
  );
};

export const Route = createFileRoute('/dashboard/settings')({
  component: SettingsPage,
});
