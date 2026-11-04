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

  const updateConnectionNotes = useCallback((id: string, notes: string) => {
    if (!accepting.current) return;
    setDisplayed((current) =>
      current
        ? {
            ...current,
            connections: current.connections.map((connection) =>
              connection.id === id ? { ...connection, notes } : connection,
            ),
          }
        : current,
    );
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

  useEffect(
    () =>
      window.scholar.onBackgroundSyncChange(
        ({ accountId, state: sync, discovery }) => {
          if (!accepting.current) return;
          setDisplayed((current) => {
            if (!current || current.accountId !== accountId) return current;
            // A finished refresh republishes the course map it just saved.
            const refreshed = discovery ?? current.discovery;
            return {
              ...current,
              discovery: refreshed,
              preferences: {
                ...current.preferences,
                backgroundSync: {
                  ...sync,
                  lastSyncedAt: sync.lastSyncedAt ?? refreshed.discoveredAt,
                },
              },
            };
          });
        },
      ),
    [],
  );

  useEffect(
    () =>
      window.scholar.onWatchChange?.((change) => {
        if (!accepting.current) return;
        setDisplayed((current) => {
          if (!current || current.accountId !== change.accountId)
            return current;
          return {
            ...current,
            watch: { enabled: change.enabled, status: change.status },
          };
        });
      }) ?? (() => undefined),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return {
    state: displayed,
    setState,
    updateConnectionNotes,
    loading,
    loadError,
    reload: load,
    reset,
  };
};
