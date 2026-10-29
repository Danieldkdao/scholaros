import { Pause, Play } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import type { OnboardingState } from '../onboarding/types';

type BackgroundSyncControlsProps = {
  state: OnboardingState;
  busy: boolean;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
};

// The preference card above already reports the sync status, so this only offers
// the reversible control.
export const BackgroundSyncControls = ({
  state,
  busy,
  onPause,
  onResume,
}: BackgroundSyncControlsProps) => {
  const { status } = state.preferences.backgroundSync;
  if (status === 'off') return null;
  const paused = status === 'paused';
  return (
    <Button
      variant="ghost"
      className="self-start text-base"
      disabled={busy}
      onClick={() => void (paused ? onResume() : onPause())}
    >
      <LoadingSwap isLoading={busy}>
        <span className="flex items-center gap-2">
          {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
          {paused ? 'Resume background sync' : 'Pause background sync'}
        </span>
      </LoadingSwap>
    </Button>
  );
};
