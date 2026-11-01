import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCourseDetail: vi.fn(),
  getCoursesSnapshot: vi.fn(),
  getActivity: vi.fn(),
  getRefreshState: vi.fn(),
}));

vi.mock('../services/store', () => ({
  getCourseDetail: mocks.getCourseDetail,
  getCoursesSnapshot: mocks.getCoursesSnapshot,
}));
vi.mock('../../onboarding/services/academic-tasks', () => ({
  academicTasks: {
    getActivity: mocks.getActivity,
    getRefreshState: mocks.getRefreshState,
  },
}));

import { getCourseAction, getCoursesAction } from '../services/read-actions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCoursesSnapshot.mockReturnValue({
    courses: [],
    sources: [],
    lastSuccessfulAt: null,
  });
  mocks.getCourseDetail.mockReturnValue(null);
  mocks.getActivity.mockReturnValue([]);
  mocks.getRefreshState.mockReturnValue({ allCourses: false, courseIds: [] });
});

it('returns null for invalid course identifiers and missing courses', () => {
  expect(getCourseAction('student', '')).toBeNull();
  expect(getCourseAction('student', 'missing')).toBeNull();
  expect(mocks.getCourseDetail).toHaveBeenCalledOnce();
});

it('returns null when a detail store read fails', () => {
  mocks.getCourseDetail.mockImplementationOnce(() => {
    throw new Error('database unavailable');
  });
  expect(getCourseAction('student', 'course-1')).toBeNull();
});

it('returns null when a course store read fails', () => {
  mocks.getCoursesSnapshot.mockImplementationOnce(() => {
    throw new Error('database unavailable');
  });
  expect(getCoursesAction('student')).toBeNull();
});

it('returns null when activity assembly fails', () => {
  mocks.getActivity.mockImplementationOnce(() => {
    throw new Error('activity unavailable');
  });
  expect(getCoursesAction('student')).toBeNull();
});

it('preserves a successful empty course snapshot', () => {
  expect(getCoursesAction('student')).toEqual({
    courses: [],
    sources: [],
    lastSuccessfulAt: null,
    activity: [],
    refreshing: false,
  });
});
