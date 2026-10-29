import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { Checkbox } from '@scholaros/ui/components/checkbox';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { academicDisclosure } from '../constants';
import { formatWorkspaceStatus } from '../lib/formatters';
import { BrowserStep } from './browser-step';
import type { OnboardingState } from '../types';

type DeviceSetupProps = {
  state: OnboardingState;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  update: (state: OnboardingState) => void;
};

export const DeviceSetup = ({ state, busy, run, update }: DeviceSetupProps) => {
  const [accepted, setAccepted] = useState(false);
  if (!state.settings.consent)
    return (
      <div className="flex flex-col gap-5 rounded-xl border bg-card p-5">
        <div className="flex items-start gap-3">
          <MonitorSmartphone className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">This computer isn’t set up yet</p>
            <p className="text-muted-foreground">
              Your ScholarOS account is ready; this computer needs its own
              separate study browser.
            </p>
          </div>
        </div>
        <p>{academicDisclosure}</p>
        <label
          htmlFor="device-consent"
          className="flex items-start gap-3 rounded-lg bg-muted/50 p-4"
        >
          <Checkbox
            id="device-consent"
            checked={accepted}
            disabled={busy}
            onCheckedChange={(checked) => setAccepted(checked === true)}
            className="mt-1"
          />
          <span>
            I understand and allow ScholarOS to read the academic resources I
            connect on this computer.
          </span>
        </label>
        <Button
          className="self-start text-base"
          disabled={!accepted || busy}
          onClick={() =>
            void run(async () => {
              update(await window.scholar.saveSettings({ consent: true }));
            })
          }
        >
          <LoadingSwap isLoading={busy}>Agree and continue</LoadingSwap>
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-5 rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <MonitorSmartphone className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">Set up your study browser here</p>
          <p className="text-muted-foreground">
            {state.workspace
              ? formatWorkspaceStatus(state.workspace.status).description
              : 'Choose an installed browser to create a separate academic workspace on this computer.'}
          </p>
        </div>
      </div>
      <BrowserStep state={state} busy={busy} run={run} update={update} />
    </div>
  );
};
