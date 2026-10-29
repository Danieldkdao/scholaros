import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../lib/error-message';
import type { OnboardingState } from '../types';

export const useOnboardingState = () => {
  const [displayed, setDisplayed] = useState<OnboardingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Sign-out flips this so a bridge response still in flight cannot repaint the
  // previous account into the renderer.
  const accepting = useRef(true);

  const setState = useCallback((next: OnboardingState) => {
    if (!accepting.current) return;
    setDisplayed(next);
  }, []);

  const load = useCallback(async () => {
    accepting.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await window.scholar.getState();
      setState(loaded);
    } catch (cause) {
      if (!accepting.current) return;
      setLoadError(
        errorMessage(cause, 'Could not load your setup. Please try again.'),
      );
    } finally {
      if (accepting.current) setLoading(false);
    }
  }, [setState]);

  const reset = useCallback(() => {
    accepting.current = false;
    setDisplayed(null);
    setLoadError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      window.scholar.onBackgroundSyncChange(({ accountId, state: sync }) => {
        if (!accepting.current) return;
        setDisplayed((current) => {
          if (!current || current.accountId !== accountId) return current;
          return {
            ...current,
            preferences: {
              ...current.preferences,
              backgroundSync: {
                ...sync,
                lastSyncedAt:
                  sync.lastSyncedAt ?? current.discovery.discoveredAt,
              },
            },
          };
        });
      }),
    [],
  );

  return {
    state: displayed,
    setState,
    loading,
    loadError,
    reload: load,
    reset,
  };
};
