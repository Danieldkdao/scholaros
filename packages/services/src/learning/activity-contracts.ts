import { z } from 'zod';
import {
  jsonValueSchema,
  idSchema,
  instantSchema,
  revisionSchema,
} from './product-contracts';
import { sourceReferenceSchema } from './context-contracts';

export const activityPresentationValues = ['inline', 'expanded'] as const;
export type ActivityPresentation = (typeof activityPresentationValues)[number];
export const activityCandidateSchema = z
  .strictObject({
    title: z.string().max(160),
    objective: z.string().max(1000),
    html: z.string(),
    css: z.string(),
    javascript: z.string(),
    accessibleExplanation: z.string().max(8000),
    sourceReferences: z.array(sourceReferenceSchema).max(20),
    runtimeVersion: z.literal(1),
  })
  .superRefine((candidate, context) => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(candidate),
    ).byteLength;
    if (bytes > 512 * 1024)
      context.addIssue({
        code: 'custom',
        message: 'Activity candidate exceeds the byte limit.',
      });
  });
export type ActivityCandidateSchema = z.infer<typeof activityCandidateSchema>;
export type ActivityCandidate = z.infer<typeof activityCandidateSchema>;

export const artifactVersionSchema = z.strictObject({
  artifactId: idSchema,
  versionId: idSchema,
  title: z.string().max(160),
  objective: z.string().max(1000),
  runtimeVersion: z.number().int().positive(),
  contentDigest: z.string().max(128),
  createdAt: instantSchema,
  sourceReferences: z.array(sourceReferenceSchema).max(20),
  available: z.boolean(),
});
export type ArtifactVersionSchema = z.infer<typeof artifactVersionSchema>;
export type ArtifactVersionDTO = z.infer<typeof artifactVersionSchema>;

export const artifactStateSchema = z
  .strictObject({
    artifactId: idSchema,
    versionId: idSchema,
    attemptId: idSchema,
    stateRevision: revisionSchema,
    state: jsonValueSchema,
    updatedAt: instantSchema,
  })
  .superRefine((value, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(value.state)).byteLength >
      64 * 1024
    ) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'Activity state exceeds the byte limit.',
      });
    }
  });
export type ArtifactStateSchema = z.infer<typeof artifactStateSchema>;
export type ArtifactStateDTO = z.infer<typeof artifactStateSchema>;

export const activityMessageProtocolVersion = 1 as const;
export const activityRuntimeVersion = 'activity-runtime-v1' as const;
const activityMessageBase = {
  protocolVersion: z.literal(activityMessageProtocolVersion),
  runtimeVersion: z.literal(activityRuntimeVersion),
  source: z.literal('activity'),
  sessionId: idSchema,
  artifactId: idSchema,
  contentVersionId: idSchema,
  attemptId: idSchema,
  runId: idSchema,
  sequence: revisionSchema,
  baseStateRevision: revisionSchema,
};
export const activityMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...activityMessageBase,
    kind: z.literal('ready'),
    payload: z.strictObject({ contentDigest: z.string().max(128) }),
  }),
  z.strictObject({
    ...activityMessageBase,
    kind: z.literal('state-proposed'),
    payload: z.strictObject({ state: jsonValueSchema }),
  }),
  z.strictObject({
    ...activityMessageBase,
    kind: z.literal('interaction'),
    payload: z.strictObject({
      action: z.string().max(100),
      value: jsonValueSchema,
    }),
  }),
  z.strictObject({
    ...activityMessageBase,
    kind: z.literal('runtime-error'),
    payload: z.strictObject({ code: z.string().max(100) }),
  }),
]);
export type ActivityMessageSchema = z.infer<typeof activityMessageSchema>;
export type ActivityMessage = z.infer<typeof activityMessageSchema>;

export const activityMessageByteLimit = 16 * 1024;
export const activityStateEnvelopeByteLimit = 96 * 1024;
export const activityStateByteLimit = 64 * 1024;
export const activityQueueItemLimit = 8;
export const activityQueueByteLimit = 256 * 1024;
