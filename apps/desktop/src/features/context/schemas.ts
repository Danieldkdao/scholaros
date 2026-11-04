import { z } from 'zod';
import { materialSourceTypes } from '@scholaros/services/ai/resources/material';
import {
  courseMaterialExtractionStatuses,
  courseMaterialUsableStatuses,
  navigationDestinationKinds,
  navigationFailureClasses,
  navigationLocationStatuses,
  navigationPurposes,
  resourceIdentityKinds,
} from './types';

export const navigationPurposeSchema = z.enum(navigationPurposes);
export type NavigationPurposeSchema = z.infer<typeof navigationPurposeSchema>;

export const navigationLocationStatusSchema = z.enum(
  navigationLocationStatuses,
);
export type NavigationLocationStatusSchema = z.infer<
  typeof navigationLocationStatusSchema
>;

export const navigationDestinationKindSchema = z.enum(
  navigationDestinationKinds,
);
export type NavigationDestinationKindSchema = z.infer<
  typeof navigationDestinationKindSchema
>;

export const navigationFailureClassSchema = z.enum(navigationFailureClasses);
export type NavigationFailureClassSchema = z.infer<
  typeof navigationFailureClassSchema
>;

export const courseMaterialSourceTypeSchema = z.enum(materialSourceTypes);
export type CourseMaterialSourceTypeSchema = z.infer<
  typeof courseMaterialSourceTypeSchema
>;

export const courseMaterialExtractionStatusSchema = z.enum(
  courseMaterialExtractionStatuses,
);
export type CourseMaterialExtractionStatusSchema = z.infer<
  typeof courseMaterialExtractionStatusSchema
>;

export const courseMaterialAttemptSchema = z.strictObject({
  status: courseMaterialExtractionStatusSchema,
  attemptedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CourseMaterialAttemptSchema = z.infer<
  typeof courseMaterialAttemptSchema
>;

export const courseMaterialCurrentVersionSchema = z.strictObject({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(courseMaterialUsableStatuses),
  sourceUrl: z.string().url().max(2048),
  retrievedAt: z.iso.datetime({ offset: true }).nullable(),
  verifiedAt: z.iso.datetime({ offset: true }).nullable(),
  contentChangedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CourseMaterialCurrentVersionSchema = z.infer<
  typeof courseMaterialCurrentVersionSchema
>;

export const courseMaterialStateSchema = z.strictObject({
  latestAttempt: courseMaterialAttemptSchema.nullable(),
  currentVersion: courseMaterialCurrentVersionSchema.nullable(),
});
export type CourseMaterialStateSchema = z.infer<
  typeof courseMaterialStateSchema
>;

export const courseMaterialSummaryEvidenceSchema = z.strictObject({
  sourceUrl: z.string().url().max(2048),
  excerpts: z.array(z.string().trim().min(1).max(500)).max(8),
  locator: z.string().trim().min(1).max(500).nullable(),
});
export type CourseMaterialSummaryEvidenceSchema = z.infer<
  typeof courseMaterialSummaryEvidenceSchema
>;

export const courseMaterialSourceSchema = z.strictObject({
  url: z.string().url().max(2048),
  title: z.string().trim().min(1).max(300),
  sourceType: courseMaterialSourceTypeSchema,
  extractionStatus: courseMaterialExtractionStatusSchema,
  completeness: z.number().int().min(0).max(100),
  summary: z.string().trim().min(1).max(2000).nullable(),
  summaryEvidence: z.array(courseMaterialSummaryEvidenceSchema).max(8),
  retrievedAt: z.iso.datetime({ offset: true }),
  verifiedAt: z.iso.datetime({ offset: true }),
});
export type CourseMaterialSourceSchema = z.infer<
  typeof courseMaterialSourceSchema
>;

export const courseMaterialPassageSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(20_000),
  heading: z.string().trim().min(1).max(500).nullable(),
  locator: z.string().trim().min(1).max(500).nullable(),
  text: z.string().trim().min(1).max(4000),
  sourceUrl: z.string().url().max(2048),
});
export type CourseMaterialPassageSchema = z.infer<
  typeof courseMaterialPassageSchema
>;

export const courseMaterialSearchPassageSchema = z.strictObject({
  id: z.string().min(1).max(200),
  materialId: z.string().min(1).max(200),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  ordinal: z.number().int().min(0).max(20_000),
  heading: z.string().max(500).nullable(),
  locator: z.string().max(500).nullable(),
  text: z.string().trim().min(1).max(4000),
  sourceUrl: z.string().url().max(2048),
  title: z.string().min(1).max(300),
  sourceType: courseMaterialSourceTypeSchema,
  extractionStatus: courseMaterialExtractionStatusSchema,
  retrievedAt: z.string().datetime().nullable(),
  verifiedAt: z.string().datetime().nullable(),
  contentChangedAt: z.string().datetime().nullable(),
  score: z.number(),
});
export type CourseMaterialSearchPassageSchema = z.infer<
  typeof courseMaterialSearchPassageSchema
>;

export const courseMaterialReadPassageSchema =
  courseMaterialSearchPassageSchema.omit({ score: true });
export type CourseMaterialReadPassageSchema = z.infer<
  typeof courseMaterialReadPassageSchema
>;

export const courseMaterialSearchResultSchema = z.strictObject({
  passages: z.array(courseMaterialSearchPassageSchema).max(8),
  characters: z.number().int().min(0).max(16_000),
  truncated: z.boolean(),
  retrievalMs: z.number().nonnegative(),
});
export type CourseMaterialSearchResultSchema = z.infer<
  typeof courseMaterialSearchResultSchema
>;

export const courseMaterialPassageSelectionSchema = z.strictObject({
  id: z.string().min(1).max(200),
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CourseMaterialPassageSelectionSchema = z.infer<
  typeof courseMaterialPassageSelectionSchema
>;

export const courseMaterialSearchInputSchema = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  connectionId: z.string().trim().min(1).max(200),
  courseId: z.string().trim().min(1).max(200),
  query: z.string().max(2000),
  limit: z.number().int().min(1).max(8).optional(),
  maxCharacters: z.number().int().min(0).max(16_000).optional(),
});
export type CourseMaterialSearchInputSchema = z.infer<
  typeof courseMaterialSearchInputSchema
>;

export const courseMaterialPassageReadInputSchema = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  connectionId: z.string().trim().min(1).max(200),
  courseId: z.string().trim().min(1).max(200),
  selections: z.array(courseMaterialPassageSelectionSchema).min(1).max(8),
});
export type CourseMaterialPassageReadInputSchema = z.infer<
  typeof courseMaterialPassageReadInputSchema
>;

export const existingResourceIdentityInputSchema = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  connectionId: z.string().trim().min(1).max(200),
  courseId: z.string().trim().min(1).max(200),
  kind: z.enum(resourceIdentityKinds),
});
export type ExistingResourceIdentityInputSchema = z.infer<
  typeof existingResourceIdentityInputSchema
>;

export const navigationContextQuerySchema = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  connectionId: z.string().trim().min(1).max(200),
  courseId: z.string().trim().min(1).max(200).nullable(),
  purpose: navigationPurposeSchema,
});
export type NavigationContextQuerySchema = z.infer<
  typeof navigationContextQuerySchema
>;

export const courseMaterialContentSchema = z.strictObject({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  normalizedText: z.string().max(5_000_000),
  passages: z.array(courseMaterialPassageSchema).max(2000),
});
export type CourseMaterialContentSchema = z.infer<
  typeof courseMaterialContentSchema
>;

export const saveCourseMaterialInputSchema = z.strictObject({
  userId: z.string().trim().min(1).max(200),
  connectionId: z.string().trim().min(1).max(200),
  courseId: z.string().trim().min(1).max(200),
  source: courseMaterialSourceSchema,
  content: courseMaterialContentSchema,
});
export type SaveCourseMaterialInputSchema = z.infer<
  typeof saveCourseMaterialInputSchema
>;

export const navigationRecipeStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('open-url'),
    url: z.string().url().max(2048),
  }),
  z.strictObject({
    kind: z.literal('click-link'),
    label: z.string().trim().min(1).max(200),
    url: z.string().url().max(2048),
  }),
  z.strictObject({
    kind: z.literal('reveal-section'),
    label: z.string().trim().min(1).max(200),
    targetId: z.string().trim().min(1).max(100),
  }),
]);
export type NavigationRecipeStepSchema = z.infer<
  typeof navigationRecipeStepSchema
>;

export const navigationRecipeSchema = z.strictObject({
  version: z.literal(1),
  steps: z.array(navigationRecipeStepSchema).max(12),
});
export type NavigationRecipeSchema = z.infer<typeof navigationRecipeSchema>;

export const navigationEvidenceSchema = z.strictObject({
  sourceUrl: z.string().url().max(2048),
  excerpts: z.array(z.string().trim().min(1).max(500)).max(4),
  targetIds: z.array(z.string().trim().min(1).max(100)).max(30),
});
export type NavigationEvidenceSchema = z.infer<typeof navigationEvidenceSchema>;

export const navigationLocationObservationSchema = z.strictObject({
  courseId: z.string().trim().min(1).max(200).nullable().optional(),
  purpose: navigationPurposeSchema,
  destinationUrl: z.string().url().max(2048),
  parentUrl: z.string().url().max(2048).nullable().optional(),
  recipe: navigationRecipeSchema.nullable().optional(),
  label: z.string().trim().min(1).max(200).nullable().optional(),
  evidence: navigationEvidenceSchema.optional(),
  status: navigationLocationStatusSchema,
  destinationKind: navigationDestinationKindSchema,
  observedAt: z.string().datetime().optional(),
  verifiedAt: z.string().datetime().nullable().optional(),
});
export type NavigationLocationObservationSchema = z.infer<
  typeof navigationLocationObservationSchema
>;

export const navigationLocationRowSchema = z.strictObject({
  id: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
  connectionId: z.string().min(1).max(200),
  courseId: z.string().min(1).max(200).nullable(),
  purpose: navigationPurposeSchema,
  destinationUrl: z.string().url().max(2048),
  parentUrl: z.string().url().max(2048).nullable(),
  recipe: navigationRecipeSchema.nullable().catch(null),
  label: z.string().max(200).nullable(),
  evidence: navigationEvidenceSchema,
  status: navigationLocationStatusSchema,
  destinationKind: navigationDestinationKindSchema,
  observedAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable(),
  failureCount: z.number().int().min(0),
  lastFailureClass: navigationFailureClassSchema.nullable(),
});
export type NavigationLocationRowSchema = z.infer<
  typeof navigationLocationRowSchema
>;
