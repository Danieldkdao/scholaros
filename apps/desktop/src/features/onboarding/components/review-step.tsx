import { useEffect, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  Globe,
  Link as LinkIcon,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  formatBackgroundSyncStatus,
  formatBrowser,
  formatConnectionStatus,
  formatPreviewStatus,
  formatToggle,
  formatWorkspaceStatus,
} from '../lib/formatters';
import type { OnboardingState, PreviewState } from '../types';

type ReviewStepProps = { state: OnboardingState };

const PreviewSummary = ({ accountId }: { accountId: string }) => {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  useEffect(() => {
    let active = true;
    void window.scholar
      .getPreview(accountId)
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  if (!preview || preview.status === 'idle')
    return <p className="text-muted-foreground">Skipped for now.</p>;
  const status = formatPreviewStatus(preview.status);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <status.Icon className="size-5 text-primary" />
        <span>{status.label}</span>
      </div>
      {preview.status === 'complete' && (
        <p className="text-muted-foreground">
          {preview.cards.length} result
          {preview.cards.length === 1 ? '' : 's'} checked against your course
          pages; preview results stay in this session only.
        </p>
      )}
      {preview.message && (
        <p className="text-muted-foreground">{preview.message}</p>
      )}
    </div>
  );
};

export const ReviewStep = ({ state }: ReviewStepProps) => {
  const browser = state.workspace
    ? formatBrowser(state.workspace.browser)
    : null;
  const workspaceStatus = state.workspace
    ? formatWorkspaceStatus(state.workspace.status)
    : null;
  const launchAtLogin = formatToggle(state.settings.launchAtLogin);
  const backgroundSync = formatBackgroundSyncStatus(
    state.preferences.backgroundSync.status,
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">Access and data handling</p>
          <p className="text-muted-foreground">
            You approved ScholarOS to read the academic resources you connect.
          </p>
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
        <Globe className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">Study browser</p>
          {state.workspace?.ready && browser ? (
            <p className="text-muted-foreground">
              {state.workspace.browserName || browser.label} is ready with a
              separate academic profile.
            </p>
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground">
              {workspaceStatus ? (
                <workspaceStatus.Icon className="size-4" />
              ) : (
                <CircleAlert className="size-4" />
              )}
              {workspaceStatus?.description ??
                'Not ready yet; go back to prepare a study browser.'}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
        <LinkIcon className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-2">
          <p className="font-medium">Academic resources</p>
          {state.connections.length === 0 && (
            <p className="text-muted-foreground">
              None connected yet; you can connect them from your dashboard.
            </p>
          )}
          {state.connections.map((connection) => {
            const status = formatConnectionStatus(connection.status);
            return (
              <div
                key={connection.id}
                className="flex flex-wrap items-center gap-2"
              >
                <status.Icon className="size-4 text-primary" />
                <span>{connection.name}</span>
                <span className="text-muted-foreground">{status.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
        <SlidersHorizontal className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-2">
          <p className="font-medium">Preferences</p>
          <p className="flex items-center gap-2 text-muted-foreground">
            <launchAtLogin.Icon className="size-4" />
            Launch at login: {launchAtLogin.label}
          </p>
          {!state.preferences.launchAtLogin.applied && (
            <p className="flex items-center gap-2 text-destructive">
              <CircleAlert className="size-4" />
              {state.preferences.launchAtLogin.message ??
                'This computer did not apply launch at login.'}
            </p>
          )}
          <p className="flex items-center gap-2 text-muted-foreground">
            <backgroundSync.Icon className="size-4" />
            {backgroundSync.label}
          </p>
          {state.preferences.backgroundSync.message && (
            <p className="text-muted-foreground">
              {state.preferences.backgroundSync.message}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-2">
          <p className="font-medium">AI preview</p>
          <PreviewSummary accountId={state.accountId} />
        </div>
      </div>
    </div>
  );
};
