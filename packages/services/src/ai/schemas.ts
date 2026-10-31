import { z } from 'zod';

export const requestKinds = [
  'choose',
  'extract',
  'discover',
  'course-content',
] as const;
export type RequestKind = (typeof requestKinds)[number];
export const agentRequestSchema = z.object({
  kind: z.enum(requestKinds),
  goal: z.string().max(500),
  notes: z.string().max(2000),
  pages: z
    .array(
      z.object({
        url: z.url(),
        title: z.string().max(500),
        text: z.string().max(16000),
      }),
    )
    .min(1)
    .max(8),
  targets: z
    .array(
      z.object({
        id: z.string().max(20),
        label: z.string().max(300),
        context: z.string().max(500).optional(),
        url: z.url(),
      }),
    )
    .max(80)
    .optional(),
});
export type AgentRequestSchema = z.infer<typeof agentRequestSchema>;

export const navigationOperations = ['NAVIGATE', 'DONE', 'BLOCKED'] as const;
export type NavigationOperation = (typeof navigationOperations)[number];
export const navigationDecisionSchema = z.object({
  operation: z.enum(navigationOperations),
  target: z.string().max(20).nullable(),
});
export type NavigationDecisionSchema = z.infer<typeof navigationDecisionSchema>;

export const academicCardKinds = [
  'course',
  'assignment',
  'announcement',
] as const;
export type AcademicCardKind = (typeof academicCardKinds)[number];
export const academicEvidenceSchema = z.object({
  cards: z
    .array(
      z.object({
        kind: z.enum(academicCardKinds),
        title: z.string().min(1).max(180),
        course: z.string().max(180).nullable(),
        detail: z.string().max(600).nullable(),
        date: z.string().max(100).nullable(),
        sourceUrl: z.url(),
      }),
    )
    .max(20),
});
export type AcademicEvidenceSchema = z.infer<typeof academicEvidenceSchema>;

export const assignmentStates = [
  'active-unsubmitted',
  'submitted',
  'inactive',
  'unknown',
] as const;
export type AssignmentState = (typeof assignmentStates)[number];
export const contentCoverageValues = [
  'complete',
  'detail',
  'partial',
  'unavailable',
] as const;
export type ContentCoverage = (typeof contentCoverageValues)[number];
export const courseContentEvidenceSchema = z.object({
  cards: z.array(
    academicEvidenceSchema.shape.cards.element.extend({
      assignmentState: z.enum(assignmentStates),
    }),
  ),
  coverage: z.enum(contentCoverageValues),
});
export type CourseContentEvidenceSchema = z.infer<
  typeof courseContentEvidenceSchema
>;

export const courseDiscoverySchema = z.object({
  courseTargetIds: z.array(z.string().min(1).max(20)).max(30),
});
export type CourseDiscoverySchema = z.infer<typeof courseDiscoverySchema>;

export const connectionProviders = ['google', 'microsoft', 'unknown'] as const;
export type ConnectionProvider = (typeof connectionProviders)[number];
export const connectionCandidateSchema = z.object({
  name: z.string().trim().min(1).max(140),
  url: z.url().max(2048),
  provider: z.enum(connectionProviders),
});
export type ConnectionCandidateSchema = z.infer<
  typeof connectionCandidateSchema
>;
export const connectionSuggestionsSchema = z.object({
  candidates: z.array(connectionCandidateSchema).max(8),
});
export type ConnectionSuggestionsSchema = z.infer<
  typeof connectionSuggestionsSchema
>;
export const connectionResolveRequestSchema = z.object({
  kind: z.literal('resolve'),
  prompt: z.string().trim().min(1).max(500),
});
export type ConnectionResolveRequestSchema = z.infer<
  typeof connectionResolveRequestSchema
>;
