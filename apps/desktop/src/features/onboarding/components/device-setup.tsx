import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { Checkbox } from '@scholaros/ui/components/checkbox';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { academicDisclosure } from '../constants';
import { formatWorkspaceStatus } from '../lib/formatters';
import { BrowserStep } from './browser-step';
import type { OnboardingState } from '../types';

type DeviceSetupProps = {
  state: OnboardingState;
  busy: boolean;
  browserSelectionDisabled?: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  update: (state: OnboardingState) => void;
  onSelectBrowser?: (installationId: string) => Promise<OnboardingState | void>;
};

export const DeviceSetup = ({
  state,
  busy,
  browserSelectionDisabled = false,
  run,
  update,
  onSelectBrowser,
}: DeviceSetupProps) => {
  const [accepted, setAccepted] = useState(false);
  const description = state.workspace
    ? formatWorkspaceStatus(state.workspace.status).description
    : 'Choose an installed browser to create a separate academic workspace on this computer.';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          <MonitorSmartphone className="size-5 shrink-0 text-primary" />
          {state.settings.consent
            ? 'Set up your study browser here'
            : 'This computer isn’t set up yet'}
        </CardTitle>
        <CardDescription>
          {state.settings.consent
            ? description
            : 'Your ScholarOS account is ready; this computer needs its own separate study browser.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-5">
        {!state.settings.consent ? (
          <>
            <p className="text-base">{academicDisclosure}</p>
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
              <span className="text-base">
                I understand and allow ScholarOS to read the academic resources
                I connect on this computer.
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
          </>
        ) : (
          <BrowserStep
            state={state}
            busy={busy}
            browserSelectionDisabled={browserSelectionDisabled}
            run={run}
            update={update}
            onSelectBrowser={onSelectBrowser}
          />
        )}
      </CardContent>
    </Card>
  );
};
