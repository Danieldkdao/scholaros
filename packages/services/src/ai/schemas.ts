import { z } from 'zod';
import { browserNavigationModeSchema } from '@scholaros/env/browser-navigation';

export const requestKinds = [
  'choose',
  'discover',
  'courses',
  'assignments',
  'announcements',
  'materials',
] as const;
export type RequestKind = (typeof requestKinds)[number];
export const agentRequestSchema = z.object({
  kind: z.enum(requestKinds),
  browserNavigationMode: browserNavigationModeSchema.optional(),
  goal: z.string().max(500),
  memory: z
    .object({
      navigation: z.string().max(8000),
      resources: z
        .array(
          z.object({
            id: z.string().max(300),
            title: z.string().max(300),
            sourceId: z.string().max(300).nullable(),
            url: z.url().max(2048).nullable(),
            active: z.boolean(),
          }),
        )
        .max(40),
      truncated: z.boolean(),
    })
    .optional(),
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

export const agentOperationSources = ['browser', 'synthetic-material'] as const;
export type AgentOperationSource = (typeof agentOperationSources)[number];

export const configurationRevisionSchema = z
  .string()
  .regex(/^v1-[a-f0-9]{24}$/);
export type ConfigurationRevisionSchema = z.infer<
  typeof configurationRevisionSchema
>;

export const browserAgentRequestSchema = agentRequestSchema
  .extend({
    browserNavigationMode: browserNavigationModeSchema,
    configurationRevision: configurationRevisionSchema.optional(),
  })
  .strict();
export type BrowserAgentRequestSchema = z.infer<
  typeof browserAgentRequestSchema
>;

const syntheticMaterialMaxPages = 4;
const syntheticMaterialMaxCharacters = 24_000;
const syntheticMaterialAgentRequestSchema = z
  .strictObject({
    ...agentRequestSchema.shape,
    kind: z.literal('materials'),
    browserNavigationMode: z.never().optional(),
    targets: z.never().optional(),
  })
  .superRefine((request, context) => {
    if (request.pages.length > syntheticMaterialMaxPages)
      context.addIssue({
        code: 'custom',
        message: 'Synthetic material exceeds the page limit.',
      });
    const characters = request.pages.reduce(
      (total, page) => total + page.title.length + page.text.length,
      0,
    );
    if (characters > syntheticMaterialMaxCharacters)
      context.addIssue({
        code: 'custom',
        message: 'Synthetic material exceeds the content limit.',
      });
  });

// Internal host envelope; never parse renderer or model payloads as this type.
export const internalAgentOperationSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal(agentOperationSources[0]),
    request: browserAgentRequestSchema,
  }),
  z.strictObject({
    source: z.literal(agentOperationSources[1]),
    request: syntheticMaterialAgentRequestSchema,
  }),
]);
export type InternalAgentOperationSchema = z.infer<
  typeof internalAgentOperationSchema
>;

export const navigationOperations = ['NAVIGATE', 'DONE', 'BLOCKED'] as const;
export type NavigationOperation = (typeof navigationOperations)[number];
export const navigationDecisionSchema = z.object({
  operation: z.enum(navigationOperations),
  target: z.string().max(20).nullable(),
});
export type NavigationDecisionSchema = z.infer<typeof navigationDecisionSchema>;

export { assignmentStates, contentCoverageValues } from './resources/shared';
export type {
  AssignmentState,
  ContentCoverage,
  ContentCoverage as ModelContentCoverage,
} from './resources/shared';

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
export const connectionResolveRequestSchema = z.strictObject({
  kind: z.literal('resolve'),
  prompt: z.string().trim().min(1).max(500),
});
export type ConnectionResolveRequestSchema = z.infer<
  typeof connectionResolveRequestSchema
>;
