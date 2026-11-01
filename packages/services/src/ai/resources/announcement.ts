import { z } from 'zod';
import {
  academicDateSchema,
  contentCoverageValues,
  resourceLinkSchema,
  sourceEvidenceSchema,
} from './shared';

export const extractedAnnouncementSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(2000).nullable(),
  author: z.string().max(200).nullable(),
  published: academicDateSchema.nullable(),
  updated: academicDateSchema.nullable(),
  url: z.url().nullable(),
  sourceId: z.string().min(1).max(200).nullable(),
  resources: z.array(resourceLinkSchema).max(30),
  evidence: sourceEvidenceSchema,
});
export type ExtractedAnnouncementSchema = z.infer<
  typeof extractedAnnouncementSchema
>;
export const extractedAnnouncementsSchema = z.object({
  announcements: z.array(extractedAnnouncementSchema).max(30),
  coverage: z.enum(contentCoverageValues),
});
export type ExtractedAnnouncementsSchema = z.infer<
  typeof extractedAnnouncementsSchema
>;
