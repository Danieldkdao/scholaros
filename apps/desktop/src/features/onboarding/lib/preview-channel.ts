import { errorMessage } from '../../../lib/error-message';
import type { PreviewState } from '../types';

type PreviewWatcherOptions = {
  accountId: string;
  fetchPreview: () => Promise<PreviewState>;
  subscribe: (listener: (state: PreviewState) => void) => () => void;
  onState: (state: PreviewState) => void;
  onNotice: (message: string | null) => void;
  onSessionExpired: (message: string) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  maxRetries?: number;
};

const retryDelays = [250, 600, 1200, 2000];

export const watchPreview = ({
  accountId,
  fetchPreview,
  subscribe,
  onState,
  onNotice,
  onSessionExpired,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelSchedule = (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  maxRetries = retryDelays.length - 1,
}: PreviewWatcherOptions) => {
  let active = true;
  let retries = 0;
  let handle: unknown = null;
  const accept = (state: PreviewState) => {
    if (!active || state.accountId !== accountId) return;
    retries = 0;
    onNotice(null);
    onState(state);
  };
  const unsubscribe = subscribe(accept);
  const load = async () => {
    handle = null;
    try {
      const state = await fetchPreview();
      if (!active) return;
      accept(state);
    } catch (error) {
      if (!active) return;
      const message = errorMessage(error, 'Preview progress is unavailable.');
      if (/sign in|session/i.test(message)) {
        onSessionExpired(
          'Your session expired. Sign in again to see progress.',
        );
        return;
      }
      if (retries >= maxRetries) {
        onNotice(message);
        return;
      }
      onNotice('Reconnecting to preview progress…');
      handle = schedule(
        () => void load(),
        retryDelays[retries] ?? retryDelays.at(-1)!,
      );
      retries += 1;
    }
  };
  void load();
  return {
    stop: () => {
      active = false;
      unsubscribe();
      cancelSchedule(handle);
    },
  };
};
