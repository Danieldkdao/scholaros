import { useState } from 'react';
import { useConfirm } from '../../../hooks/use-confirm';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@scholaros/ui/components/alert-dialog';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { errorMessage } from '../../../lib/error-message';
import { formatWorkspaceReplacementError } from '../lib/formatters';
import { DeviceSetup } from '../../onboarding/components/device-setup';
import type { OnboardingState } from '../../onboarding/types';
import type { WorkspaceReplacementErrorCode } from '../lib/formatters';

type DeviceReplacementResult = {
  operationId: string;
  state:
    | 'staged'
    | 'verifying'
    | 'ready'
    | 'committed'
    | 'cancelled'
    | 'failed'
    | 'needs-sign-in';
  browserId: string;
  errorCode: WorkspaceReplacementErrorCode | null;
  revision: number;
};

type CompletedDeviceReplacement = Omit<DeviceReplacementResult, 'state'> & {
  state: 'committed' | 'needs-sign-in';
};

const isCompletedReplacement = (
  result: DeviceReplacementResult,
): result is CompletedDeviceReplacement =>
  result.state === 'committed' || result.state === 'needs-sign-in';

export type DeviceReplacementActions = {
  stage: (input: {
    requestId: string;
    browserId: string;
  }) => Promise<DeviceReplacementResult>;
  commit: (input: {
    operationId: string;
    expectedRevision: number;
  }) => Promise<DeviceReplacementResult>;
  cancel: (input: { operationId: string }) => Promise<DeviceReplacementResult>;
};

type DeviceSettingsProps = {
  state: OnboardingState;
  onStateChange: (state: OnboardingState) => void;
  replacementActions: DeviceReplacementActions | null;
};

export const DeviceSettings = ({
  state,
  onStateChange,
  replacementActions,
}: DeviceSettingsProps) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const confirmation = useConfirm<DeviceReplacementResult>();
  const browserSelectionDisabled = Boolean(
    state.workspace && !replacementActions,
  );

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause, 'Could not update this device setup.'));
    } finally {
      setBusy(false);
    }
  };

  const selectBrowser = async (browserId: string) => {
    if (!state.workspace) {
      const nextState = await window.scholar.createWorkspace(browserId);
      onStateChange(nextState);
      return;
    }
    if (!replacementActions)
      throw new Error(
        'Safe browser replacement is unavailable right now; your current workspace is unchanged.',
      );

    const staged = await replacementActions.stage({
      requestId: window.crypto.randomUUID(),
      browserId,
    });
    if (staged.state !== 'ready') {
      throw new Error(
        staged.errorCode
          ? formatWorkspaceReplacementError(staged.errorCode)
          : 'The new browser could not be verified; your current workspace is unchanged.',
      );
    }
    confirmation.request(staged);
  };

  const completeReplacement = async (result: CompletedDeviceReplacement) => {
    const nextState = await window.scholar.getState();
    onStateChange(nextState);
    confirmation.cancel();
    setNotice(
      result.state === 'needs-sign-in'
        ? 'Browser replaced. Sign in to your school again in the study browser.'
        : 'Study browser replaced.',
    );
  };

  const cancelReplacement = async () => {
    const replacement = confirmation.pending;
    if (!replacement || !replacementActions) return;
    await run(async () => {
      const result = await replacementActions.cancel({
        operationId: replacement.operationId,
      });
      if (result.state === 'failed')
        throw new Error(
          result.errorCode
            ? formatWorkspaceReplacementError(result.errorCode)
            : 'The candidate browser could not be closed safely.',
        );
      if (isCompletedReplacement(result)) {
        await completeReplacement(result);
        return;
      }
      if (result.state !== 'cancelled')
        throw new Error(
          'Browser replacement is still being verified; your current study browser remains selected.',
        );
      confirmation.cancel();
      setNotice('Your current study browser remains selected.');
    });
  };

  const commitReplacement = async () => {
    const replacement = confirmation.pending;
    if (!replacement || !replacementActions) return;
    await run(async () => {
      const result = await replacementActions.commit({
        operationId: replacement.operationId,
        expectedRevision: replacement.revision,
      });
      if (result.state === 'cancelled') {
        confirmation.cancel();
        setNotice(
          'Browser replacement was cancelled; your current study browser is unchanged.',
        );
        return;
      }
      if (result.state === 'failed') {
        confirmation.cancel();
        throw new Error(
          result.errorCode
            ? formatWorkspaceReplacementError(result.errorCode)
            : 'The browser could not be replaced; review Settings and try again.',
        );
      }
      if (!isCompletedReplacement(result))
        throw new Error(
          'Browser replacement is still being verified; your current study browser remains selected.',
        );
      await completeReplacement(result);
    });
  };

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="device-settings-title"
    >
      <div className="flex flex-col gap-1">
        <h3 id="device-settings-title" className="text-lg font-medium">
          Device and study browser
        </h3>
        <p className="text-base text-muted-foreground">
          Each computer has its own study browser and school sign-in; local
          course data is not synced from your account.
        </p>
      </div>
      <DeviceSetup
        state={state}
        busy={busy}
        browserSelectionDisabled={browserSelectionDisabled}
        run={run}
        update={onStateChange}
        onSelectBrowser={selectBrowser}
      />
      {browserSelectionDisabled && (
        <p role="status" className="text-base text-muted-foreground">
          Safe browser replacement is unavailable right now; your saved browser
          choice is unchanged.
        </p>
      )}
      {error && (
        <p role="alert" className="text-base text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-base text-muted-foreground">
          {notice}
        </p>
      )}
      <AlertDialog
        open={confirmation.pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) void cancelReplacement();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace study browser?</AlertDialogTitle>
            <AlertDialogDescription>
              The new browser passed local readiness checks. Your current
              browser stays selected unless you confirm, and you may need to
              sign in to your school again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              Keep current browser
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void commitReplacement();
              }}
            >
              <LoadingSwap isLoading={busy}>Replace browser</LoadingSwap>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
};
