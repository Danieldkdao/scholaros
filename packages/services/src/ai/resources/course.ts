import { z } from 'zod';
import { contentCoverageValues, sourceEvidenceSchema } from './shared';

export const extractedCourseSchema = z.object({
  name: z.string().min(1).max(300),
  code: z.string().max(100).nullable(),
  section: z.string().max(100).nullable(),
  term: z.string().max(150).nullable(),
  description: z.string().max(2000).nullable(),
  instructors: z.array(z.string().min(1).max(200)).max(20),
  sourceId: z.string().min(1).max(200).nullable(),
  url: z.url(),
  evidence: sourceEvidenceSchema,
});
export type ExtractedCourseSchema = z.infer<typeof extractedCourseSchema>;
export const extractedCoursesSchema = z.object({
  courses: z.array(extractedCourseSchema).max(30),
  coverage: z.enum(contentCoverageValues),
});
export type ExtractedCoursesSchema = z.infer<typeof extractedCoursesSchema>;
