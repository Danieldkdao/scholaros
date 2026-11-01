import { z } from 'zod';

export const requestKinds = [
  'choose',
  'discover',
  'courses',
  'assignments',
  'announcements',
] as const;
export type RequestKind = (typeof requestKinds)[number];
export const agentRequestSchema = z.object({
  kind: z.enum(requestKinds),
  goal: z.string().max(500),
  context: z
    .object({
      retrievedAt: z.iso.datetime({ offset: true }),
      observedTimezone: z.string().max(100).nullable(),
      locale: z.string().max(100).nullable(),
      courseUrl: z.url().nullable(),
      courseName: z.string().max(300).nullable(),
      truncated: z.boolean(),
    })
    .optional(),
  notes: z.string().max(2000),
  pages: z
    .array(
      z.object({
        url: z.url(),
        retrievedAt: z.iso.datetime({ offset: true }).optional(),
        locale: z.string().max(100).nullable().optional(),
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

export { assignmentStates, contentCoverageValues } from './resources/shared';
export type { AssignmentState, ContentCoverage } from './resources/shared';

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
