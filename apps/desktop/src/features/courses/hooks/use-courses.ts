import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../lib/error-message';
import type { CoursesSnapshot } from '../types';

export const useCourses = (accountId: string | null) => {
  const [snapshot, setSnapshot] = useState<CoursesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const scope = useRef(0);
  const request = useRef(0);

  const load = useCallback(async () => {
    const attempt = ++request.current;
    if (!accountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await window.scholar.getCourses();
      if (attempt === request.current) setSnapshot(loaded);
    } catch (cause) {
      if (attempt === request.current)
        setLoadError(errorMessage(cause, 'Could not load your courses.'));
    } finally {
      if (attempt === request.current) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    setSnapshot(null);
    setRefreshing(false);
    setRefreshError(null);
    void load();
    return () => {
      scope.current += 1;
      request.current += 1;
    };
  }, [load]);

  // A scheduled refresh finishes without this page asking, so its completion
  // event is what brings the saved catalog back up to date.
  useEffect(() => {
    if (!accountId) return;
    return window.scholar.onBackgroundSyncChange(
      ({ accountId: changed, state }) => {
        if (changed !== accountId || state.status === 'syncing') return;
        void load();
      },
    );
  }, [accountId, load]);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    const generation = scope.current;
    const attempt = ++request.current;
    setLoading(false);
    setRefreshing(true);
    setRefreshError(null);
    try {
      const refreshed = await window.scholar.refreshCourses();
      if (attempt === request.current) setSnapshot(refreshed);
    } catch (cause) {
      if (generation === scope.current) {
        setRefreshError(errorMessage(cause, 'Could not refresh your courses.'));
        await load();
      }
    } finally {
      if (generation === scope.current) setRefreshing(false);
    }
  }, [accountId, load]);

  const cancel = useCallback(async () => {
    // Stopping is best effort; the run reports its own outcome.
    await window.scholar.cancelCourseRefresh().catch(() => undefined);
  }, []);

  return {
    snapshot,
    loading,
    loadError,
    reload: load,
    refreshing,
    refreshError,
    refresh,
    cancel,
  };
};
