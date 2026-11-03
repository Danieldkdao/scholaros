import type { ExtractedAssignmentSchema } from '@scholaros/services/ai/resources/assignment';
import type { ExtractedAnnouncementSchema } from '@scholaros/services/ai/resources/announcement';
import type { ExtractedCourseSchema } from '@scholaros/services/ai/resources/course';

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

export type CourseSourceState = 'connected' | 'unmarked' | 'removed' | 'manual';

export type CourseChildItem = {
  retrievedAt?: string;
  content?: ExtractedAssignmentSchema | ExtractedAnnouncementSchema | null;
  contentChangedAt?: string | null;
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
  metrics?: CourseChildScanMetrics;
};

export type CourseChildScanMetrics = {
  candidatesExtracted: number;
  duplicatesReconciled: number;
  ambiguousIdentityConflicts: number;
  knownDestinationsReused: number;
  navigationRepairs: number;
};

export type ObservedCourse = {
  content?: ExtractedCourseSchema | null;
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
  connectionId: string | null;
  instructor?: string | null;
  description?: string | null;
  refreshing?: boolean;
  contentChangedAt?: string | null;
  content?: ExtractedCourseSchema | null;
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
  activity?: CourseRefreshActivity[];
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
  activity?: CourseRefreshActivity[];
  refreshing?: boolean;
  courses: CourseSummary[];
  sources: CourseSourceStatus[];
  lastSuccessfulAt: string | null;
};

export type CourseRefreshActivity = {
  id: string;
  key: string;
  status: 'running' | 'complete' | 'sign-in-required' | 'cancelled' | 'failed';
  events: string[];
  metrics?: CourseRefreshMetrics;
};

export type CourseRefreshMetrics = {
  pagesOpened: number;
  modelCalls: number;
  knownDestinationsReused: number;
  navigationRepairs: number;
  candidatesExtracted: number;
  duplicatesReconciled: number;
  ambiguousIdentityConflicts: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsRetired: number;
  firstFindingMs: number | null;
  durationMs: number | null;
};

export type CourseRefreshMetricName = Exclude<
  keyof CourseRefreshMetrics,
  'durationMs' | 'firstFindingMs'
>;
