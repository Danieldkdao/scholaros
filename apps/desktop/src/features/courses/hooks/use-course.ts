import { toast } from '@scholaros/ui/components/toast';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../lib/error-message';
import type { CourseDetail } from '../types';

const pendingRefreshes = new Map<string, Promise<CourseDetail | null>>();

export const useCourse = (courseId: string, accountId: string | null) => {
  const key = JSON.stringify([accountId, courseId]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const scope = useRef(0);
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!accountId) return;
    const attempt = ++request.current;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await window.scholar.getCourse(courseId);
      if (attempt === request.current) {
        setCourse(loaded);
        if (loaded?.refreshing !== undefined) setRefreshing(loaded.refreshing);
      }
    } catch (cause) {
      if (attempt === request.current)
        setLoadError(errorMessage(cause, 'Could not load this course.'));
    } finally {
      if (attempt === request.current) setLoading(false);
    }
  }, [courseId, accountId]);

  useEffect(() => {
    if (!accountId) return;
    return window.scholar.onCoursesChange(
      ({ accountId: changed, courseId: changedCourse }) => {
        if (
          changed !== accountId ||
          (changedCourse !== null && changedCourse !== courseId)
        )
          return;
        void load();
      },
    );
  }, [accountId, load, courseId]);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    const generation = scope.current;
    setLoading(false);
    setRefreshing(true);
    setRefreshError(null);
    try {
      let pending = pendingRefreshes.get(key);
      if (!pending) {
        pending = window.scholar
          .refreshCourse(courseId)
          .finally(() => pendingRefreshes.delete(key));
        pendingRefreshes.set(key, pending);
      }
      const refreshed = await pending;
      if (generation === scope.current) {
        request.current += 1;
        setLoading(false);
        setCourse(refreshed);
      }
    } catch (cause) {
      if (generation === scope.current) {
        setRefreshError(errorMessage(cause, 'Could not refresh this course.'));
        if (!/abort|cancel|stopped/i.test(errorMessage(cause, '')))
          toast.error(errorMessage(cause, 'Could not refresh this course.'), {
            id: `course-refresh-${courseId}`,
          });
        await load();
      }
    } finally {
      if (generation === scope.current) setRefreshing(false);
    }
  }, [accountId, courseId, key, load]);

  useEffect(() => {
    setCourse(null);
    setRefreshing(false);
    setRefreshError(null);
    void load();
    if (pendingRefreshes.has(key)) void refresh();
    return () => {
      scope.current += 1;
      request.current += 1;
    };
  }, [key, load, refresh]);

  return {
    course,
    loading,
    loadError,
    reload: load,
    refreshing,
    refreshError,
    refresh,
    stop: async () => {
      try {
        await window.scholar.cancelCourseRefresh(courseId);
      } catch (cause) {
        toast.error(errorMessage(cause, 'Could not stop this refresh.'));
      }
    },
  };
};
