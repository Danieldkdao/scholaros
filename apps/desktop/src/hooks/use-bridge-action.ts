import { useCallback, useState } from 'react';
import { errorMessage } from '../lib/error-message';

const defaultFallback = 'Something went wrong. Please try again.';

export const useBridgeAction = (fallback = defaultFallback) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (cause) {
        setError(errorMessage(cause, fallback));
      } finally {
        setBusy(false);
      }
    },
    [fallback],
  );
  return { busy, error, run, setError };
};
