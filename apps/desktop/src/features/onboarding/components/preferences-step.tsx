import { CircleAlert, MonitorUp, RefreshCw } from 'lucide-react';
import { Switch } from '@scholaros/ui/components/switch';
import {
  formatBackgroundSyncStatus,
  formatLaunchAtLogin,
  formatObservedAt,
} from '../lib/formatters';
import type { OnboardingSettings, OnboardingState } from '../types';

type PreferencesStepProps = {
  state: OnboardingState;
  busy: boolean;
  onChange: (
    changes: Partial<
      Pick<OnboardingSettings, 'launchAtLogin' | 'backgroundSync'>
    >,
  ) => void;
};

export const PreferencesStep = ({
  state,
  busy,
  onChange,
}: PreferencesStepProps) => {
  const launchAtLogin = formatLaunchAtLogin(state.settings.launchAtLogin);
  const background = formatBackgroundSyncStatus(
    state.preferences.backgroundSync.status,
  );
  const backgroundEnabled =
    state.settings.backgroundSync &&
    state.settings.consent &&
    state.workspace?.ready === true &&
    state.connections.some(
      (connection) => connection.status !== 'needs-sign-in',
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-5 rounded-xl border bg-card p-5 cursor-pointer">
        <div className="flex items-start gap-3">
          <MonitorUp className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="flex flex-col gap-1">
            <label htmlFor="launch-at-login" className="font-medium">
              Launch ScholarOS when I sign in
            </label>
            <p className="text-muted-foreground">
              This applies to this computer; the ScholarOS account in use
              controls it.
            </p>
            <p className="flex items-center gap-2 text-muted-foreground">
              <launchAtLogin.Icon className="size-4" />
              {launchAtLogin.label}
            </p>
            {!state.preferences.launchAtLogin.applied && (
              <p
                role="status"
                className="flex items-center gap-2 text-destructive"
              >
                <CircleAlert className="size-4" />
                {state.preferences.launchAtLogin.message ??
                  'This computer did not apply launch at login.'}
              </p>
            )}
          </div>
        </div>
        <Switch
          id="launch-at-login"
          checked={state.settings.launchAtLogin}
          disabled={busy}
          onCheckedChange={(checked) =>
            onChange({ launchAtLogin: checked === true })
          }
        />
      </div>
      <div className="flex items-start justify-between gap-5 rounded-xl border bg-card p-5 cursor-pointer">
        <div className="flex items-start gap-3">
          <RefreshCw className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="flex flex-col gap-1">
            <label htmlFor="background-sync" className="font-medium">
              Sync course information in the background
            </label>
            <p className="text-muted-foreground">
              After setup, check connected course resources using your approved
              AI providers.
            </p>
            <p className="flex items-center gap-2 text-muted-foreground">
              <background.Icon className="size-4" />
              {background.label}
            </p>
            {state.preferences.backgroundSync.message && (
              <p className="text-muted-foreground">
                {state.preferences.backgroundSync.message}
              </p>
            )}
            {state.preferences.backgroundSync.lastSyncedAt && (
              <p className="text-muted-foreground">
                Last synced{' '}
                {formatObservedAt(
                  state.preferences.backgroundSync.lastSyncedAt,
                )}
              </p>
            )}
            {state.settings.backgroundSync && !backgroundEnabled && (
              <p className="text-muted-foreground">
                Waiting for a verified study browser and a confirmed resource.
              </p>
            )}
          </div>
        </div>
        <Switch
          id="background-sync"
          checked={state.settings.backgroundSync}
          disabled={busy}
          onCheckedChange={(checked) =>
            onChange({ backgroundSync: checked === true })
          }
        />
      </div>
    </div>
  );
};
