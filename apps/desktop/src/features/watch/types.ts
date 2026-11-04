import type { watchSettingsSchema, watchUrlInputSchema } from './schemas';
import type {
  WatchHealthSummarySchema,
  WatchTargetFailureSchema,
  WatchTargetStatusSchema,
} from './schemas';
import type { z } from 'zod';
import type {
  CourseCollectionInterruption,
  CourseCollectionKind,
  CourseScanStatus,
} from '../courses/types';
import type { WatchTargetFailureCategory } from '../../db/shared';

export type WatchUrlInput = z.infer<typeof watchUrlInputSchema>;
export type WatchSettings = z.infer<typeof watchSettingsSchema>;
export type WatchConnection = {
  id: string;
  host: string;
  isCourseResource: boolean;
};
export type ParsedWatchUrl = {
  url: string;
  identity: string;
  connectionId: string;
};
export type WatchTargetStatus = WatchTargetStatusSchema;
export const watchRuntimeStatuses = [
  'off',
  'starting',
  'watching',
  'checking',
  'updating',
  'paused',
  'needs-sign-in',
  'blocked',
] as const;
export type WatchRuntimeStatus = (typeof watchRuntimeStatuses)[number];

export type WatchHealthSummary = WatchHealthSummarySchema;
export type WatchRuntimeMetrics = {
  changesDetected: number;
  changesProcessed: number;
  pendingChangeAgeMs: number | null;
};
export type WatchPageSnapshot = {
  url: string;
  title: string;
  text: string;
  links: Array<{ label: string; url: string; context: string }>;
  statuses: string[];
  complete: boolean;
  recipeVersion: number;
};
export type PageMutationState = {
  revision: number;
  url: string;
  documentId: string;
  installed: boolean;
};
export type WatchTargetUpsert = {
  connectionId: string;
  courseId: string | null;
  requestedUrl: string;
  recipeVersion: number;
};
export type WatchObservation = {
  userId: string;
  targetId: string;
  fingerprint: string;
  checkedAt: string;
  nextCheckAt: string;
  verifiedUrl: string;
  recipeVersion: number;
};
export type WatchCheckSchedule = {
  userId: string;
  targetId: string;
  checkedAt: string;
  nextCheckAt: string;
  attempted?: boolean;
};
export type WatchProcessedRevision = {
  userId: string;
  targetId: string;
  fingerprint: string;
  processedAt: string;
  sessionEpoch?: number;
};
export type WatchFailureRecord = {
  userId: string;
  targetId: string;
  failedAt: string;
  retryAt: string | null;
  blocked: boolean;
  category: WatchTargetFailureCategory;
};
export type WatchRefreshResult =
  | boolean
  | 'busy'
  | 'superseded'
  | 'needs-sign-in'
  | 'source-failed';

export type AcademicTaskOutcome<T = void> =
  | {
      outcome: 'settled';
      status: Exclude<CourseScanStatus, 'pending'> | 'failed';
      value: T;
      interruption?: CourseCollectionInterruption | null;
    }
  | { outcome: 'deferred'; reason: 'busy' };

export type InternalWatchCoveredRevision = {
  targetId: string;
  fingerprint: string;
};

export type InternalWatchExecutionCoverageReceipt = {
  runId: string;
  sessionEpoch: number;
  coveredRevisions: InternalWatchCoveredRevision[];
  collectionCoverage: Array<{
    courseId: string;
    collectionKind: CourseCollectionKind;
    status: CourseScanStatus;
  }>;
};

export type WatchTargetFailure = WatchTargetFailureSchema;
