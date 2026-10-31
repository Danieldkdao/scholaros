import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../../lib/error-message';
import type { CourseDetail } from '../types';

export const useCourse = (courseId: string) => {
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const attempt = ++request.current;
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await window.scholar.getCourse(courseId);
      if (attempt === request.current) setCourse(loaded);
    } catch (cause) {
      if (attempt === request.current)
        setLoadError(errorMessage(cause, 'Could not load this course.'));
    } finally {
      if (attempt === request.current) setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    setCourse(null);
    void load();
    return () => {
      request.current += 1;
    };
  }, [load]);

  return { course, loading, loadError, reload: load };
};
