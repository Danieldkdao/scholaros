import { z } from 'zod';
import {
  academicDateSchema,
  assignmentStates,
  contentCoverageValues,
  resourceLinkSchema,
  sourceEvidenceSchema,
} from './shared';

export const assignmentKinds = [
  'assignment',
  'quiz',
  'exam',
  'discussion',
  'unknown',
] as const;
export type AssignmentKind = (typeof assignmentKinds)[number];
export const extractedAssignmentSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(2000).nullable(),
  kind: z.enum(assignmentKinds),
  state: z.enum(assignmentStates),
  due: academicDateSchema.nullable(),
  availableFrom: academicDateSchema.nullable(),
  availableUntil: academicDateSchema.nullable(),
  pointsPossible: z.number().min(0).max(1_000_000).nullable(),
  url: z.url().nullable(),
  sourceId: z.string().min(1).max(200).nullable(),
  resources: z.array(resourceLinkSchema).max(30),
  evidence: sourceEvidenceSchema,
});
export type ExtractedAssignmentSchema = z.infer<
  typeof extractedAssignmentSchema
>;
export const extractedAssignmentsSchema = z.object({
  assignments: z.array(extractedAssignmentSchema).max(30),
  coverage: z.enum(contentCoverageValues),
});
export type ExtractedAssignmentsSchema = z.infer<
  typeof extractedAssignmentsSchema
>;
