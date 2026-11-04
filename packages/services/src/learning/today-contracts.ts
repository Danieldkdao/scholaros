import { z } from 'zod';
import { academicDateSchema } from '../ai/resources/shared';
import {
  freshnessStatuses,
  studyActivities,
  studySessionSchema,
} from './study-contracts';
import { learningProgressSchema } from './memory-contracts';
import { idSchema, instantSchema, revisionSchema } from './product-contracts';
import { sourceReferenceSchema } from './context-contracts';
import { safeRouteSchema } from './notification-contracts';

export { freshnessStatuses };
export type { FreshnessStatus } from './study-contracts';

export const attentionKinds = [
  'device',
  'connection',
  'sync',
  'context',
  'permission',
] as const;
export type AttentionKind = (typeof attentionKinds)[number];
export const attentionItemSchema = z.strictObject({
  kind: z.enum(attentionKinds),
  code: z.string().max(100),
  label: z.string().max(160),
  route: safeRouteSchema,
});
export type AttentionItemSchema = z.infer<typeof attentionItemSchema>;
export type AttentionItem = z.infer<typeof attentionItemSchema>;
export const freshnessItemSchema = z.strictObject({
  courseId: idSchema,
  status: z.enum(freshnessStatuses),
  lastSuccessfulAt: instantSchema.nullable(),
  pendingCount: z.number().int().nonnegative(),
});
export type FreshnessItemSchema = z.infer<typeof freshnessItemSchema>;
export type FreshnessItem = z.infer<typeof freshnessItemSchema>;
export const upcomingItemSchema = z.strictObject({
  resourceId: idSchema,
  courseId: idSchema,
  title: z.string().max(300),
  date: academicDateSchema.nullable(),
  sourceReference: sourceReferenceSchema,
});
export type UpcomingItemSchema = z.infer<typeof upcomingItemSchema>;
export type UpcomingItem = z.infer<typeof upcomingItemSchema>;
export const announcementSummarySchema = z.strictObject({
  id: idSchema,
  courseId: idSchema,
  courseName: z.string().max(300).optional(),
  title: z.string().max(300),
  preview: z.string().max(500).nullable().optional(),
  publishedAt: instantSchema.nullable(),
  sourceReference: sourceReferenceSchema,
});
export type AnnouncementSummarySchema = z.infer<
  typeof announcementSummarySchema
>;
export type AnnouncementSummary = z.infer<typeof announcementSummarySchema>;
export const todayCourseSummarySchema = z.strictObject({
  id: idSchema,
  name: z.string().max(300),
  code: z.string().max(100).nullable(),
  term: z.string().max(200).nullable(),
  connectionId: idSchema.nullable(),
  active: z.boolean(),
  sourceName: z.string().max(200),
  sourceHost: z.string().max(253),
  lastSeenAt: instantSchema,
  assignmentCount: z.number().int().nonnegative(),
  announcementCount: z.number().int().nonnegative(),
});
export type TodayCourseSummarySchema = z.infer<typeof todayCourseSummarySchema>;
export type TodayCourseSummary = z.infer<typeof todayCourseSummarySchema>;
export const recommendationSchema = z.strictObject({
  id: idSchema,
  courseId: idSchema,
  activity: z.enum(studyActivities),
  targetAssignmentId: idSchema.nullable(),
  topic: z.string().max(1000).nullable(),
  reason: z.string().max(500),
  sourceReferences: z.array(sourceReferenceSchema).max(20),
  inputsRevision: revisionSchema,
});
export type RecommendationSchema = z.infer<typeof recommendationSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export const todayOverviewSchema = z.strictObject({
  attention: z.array(attentionItemSchema).max(10),
  freshness: z.array(freshnessItemSchema).max(20),
  upcoming: z.array(upcomingItemSchema).max(20),
  announcements: z.array(announcementSummarySchema).max(10),
  recentCourses: z.array(todayCourseSummarySchema).max(10),
  recentMaterials: z.array(sourceReferenceSchema).max(10),
  recentSessions: z.array(studySessionSchema).max(10),
  progress: learningProgressSchema,
  recommendations: z.array(recommendationSchema).max(5),
  revision: revisionSchema,
});
export type TodayOverviewSchema = z.infer<typeof todayOverviewSchema>;
export type TodayOverview = z.infer<typeof todayOverviewSchema>;
