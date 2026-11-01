import { z } from 'zod';
import { academicTasks } from '../../onboarding/services/academic-tasks';
import type { CourseDetail, CoursesSnapshot } from '../types';
import { getCourseDetail, getCoursesSnapshot } from './store';

const courseIdSchema = z.string().min(1).max(300);
export type CourseIdSchema = z.infer<typeof courseIdSchema>;

export const getCoursesAction = (userId: string): CoursesSnapshot | null => {
  try {
    const existingCourses = getCoursesSnapshot(userId);
    const active = academicTasks.getRefreshState(userId);
    return {
      ...existingCourses,
      activity: academicTasks.getActivity(userId),
      courses: existingCourses.courses.map((course) => ({
        ...course,
        refreshing: active.allCourses || active.courseIds.includes(course.id),
      })),
      refreshing: active.allCourses || active.courseIds.length > 0,
    };
  } catch {
    return null;
  }
};

export const getCourseAction = (
  userId: string,
  input: unknown,
): CourseDetail | null => {
  try {
    const courseId = courseIdSchema.parse(input);
    const course = getCourseDetail(userId, courseId);
    if (!course) return null;
    const active = academicTasks.getRefreshState(userId);
    return {
      ...course,
      activity: academicTasks
        .getActivity(userId)
        .filter((run) => run.key === 'courses' || run.key === courseId),
      refreshing: active.allCourses || active.courseIds.includes(courseId),
    };
  } catch {
    return null;
  }
};
