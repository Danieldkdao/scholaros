import type { watchSettingsSchema, watchUrlInputSchema } from './schemas';
import type { WatchTargetStatusSchema } from './schemas';
import type { z } from 'zod';

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
export type WatchRuntimeStatus =
  | 'off'
  | 'starting'
  | 'watching'
  | 'checking'
  | 'updating'
  | 'paused'
  | 'needs-sign-in'
  | 'blocked';
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
};
export type WatchFailureRecord = {
  userId: string;
  targetId: string;
  failedAt: string;
  retryAt: string | null;
  blocked: boolean;
};
export type WatchRefreshResult = boolean | 'busy';
