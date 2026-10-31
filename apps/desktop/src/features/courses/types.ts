export const courseScanStatuses = [
  'pending',
  'complete',
  'partial',
  'needs-sign-in',
  'blocked',
  'cancelled',
] as const;
export type CourseScanStatus = (typeof courseScanStatuses)[number];

// A scan only counts as successful when it read the whole list, so 'complete'
// is the one status that may retire records it did not see.
export const courseScanSucceeded = (status: CourseScanStatus) =>
  status === 'complete';

export type CourseSourceState = 'connected' | 'unmarked' | 'removed';

export type CourseChildItem = {
  title: string;
  body: string | null;
  dateValue: string | null;
  dateText: string | null;
  url: string;
};

export type CourseChildScan = {
  status: CourseScanStatus;
  items: CourseChildItem[];
  inactiveItems?: CourseChildItem[];
};

export type ObservedCourse = {
  externalId: string | null;
  name: string;
  code: string | null;
  term: string | null;
  instructor: string | null;
  description: string | null;
  url: string;
  overview: CourseScanStatus;
  announcements: CourseChildScan;
  assignments: CourseChildScan;
};

export type CourseSourceScan = {
  connectionId: string;
  outcome: CourseScanStatus;
  message: string | null;
  courses: ObservedCourse[];
};

export type CourseSummary = {
  announcementCount: number;
  assignmentCount: number;
  id: string;
  name: string;
  code: string | null;
  term: string | null;
  url: string;
  active: boolean;
  sourceName: string;
  sourceHost: string;
  sourceState: CourseSourceState;
  lastSeenAt: string;
  overviewSyncedAt: string | null;
  announcementsStatus: CourseScanStatus;
  announcementsSyncedAt: string | null;
  assignmentsStatus: CourseScanStatus;
  assignmentsSyncedAt: string | null;
};

export type SavedCourseChild = CourseChildItem & {
  id: string;
  active: boolean;
  lastSeenAt: string;
};

export type CourseDetail = CourseSummary & {
  instructor: string | null;
  description: string | null;
  announcements: SavedCourseChild[];
  assignments: SavedCourseChild[];
};

export type CourseSourceStatus = {
  connectionId: string;
  outcome: CourseScanStatus;
  message: string | null;
  lastAttemptedAt: string;
  lastSuccessfulAt: string | null;
};

export type CoursesSnapshot = {
  courses: CourseSummary[];
  sources: CourseSourceStatus[];
  lastSuccessfulAt: string | null;
};
