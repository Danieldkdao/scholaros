import { z } from 'zod';
import { idSchema, instantSchema, revisionSchema } from './product-contracts';
import { sourceReferenceSchema } from './context-contracts';

export const gradeScales = [
  'points',
  'percentage',
  'pass-fail',
  'letter',
  'other',
] as const;
export type GradeScale = (typeof gradeScales)[number];
export const passFailValues = ['pass', 'fail'] as const;
export type PassFailValue = (typeof passFailValues)[number];
export const observedGradeSchema = z.discriminatedUnion('scale', [
  z.strictObject({
    scale: z.literal('points'),
    earned: z.number().finite(),
    possible: z.number().finite().nullable(),
  }),
  z.strictObject({
    scale: z.literal('percentage'),
    earned: z.number().finite(),
  }),
  z.strictObject({
    scale: z.literal('pass-fail'),
    value: z.enum(passFailValues),
  }),
  z.strictObject({ scale: z.literal('letter'), value: z.string().max(100) }),
  z.strictObject({ scale: z.literal('other'), value: z.string().max(100) }),
]);
export type ObservedGradeSchema = z.infer<typeof observedGradeSchema>;
export type ObservedGrade = z.infer<typeof observedGradeSchema>;

export const gradeSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  notes: z.string().max(2000),
  revision: revisionSchema,
  collectedCount: z.number().int().nonnegative(),
  updatedAt: instantSchema,
});
export type GradeSettingsSchema = z.infer<typeof gradeSettingsSchema>;
export type GradeSettings = z.infer<typeof gradeSettingsSchema>;

export const gradeVerificationStates = [
  'active',
  'unknown',
  'verified-completed',
] as const;
export type GradeVerificationState = (typeof gradeVerificationStates)[number];
export const evidenceTriStates = ['yes', 'no', 'unknown'] as const;
export type EvidenceTriState = (typeof evidenceTriStates)[number];
export const gradeVerificationSchema = z.strictObject({
  courseId: idSchema,
  assignmentId: idSchema,
  state: z.enum(gradeVerificationStates),
  completion: z.enum(evidenceTriStates),
  grade: observedGradeSchema.nullable(),
  remainingOpportunity: z.enum(evidenceTriStates),
  feedback: z.string().max(8000).nullable(),
  observedAt: instantSchema.nullable(),
  consentRevision: revisionSchema,
  policyRevision: revisionSchema,
  sourceReferences: z.array(sourceReferenceSchema).max(20),
  reasonCode: z.string().max(100),
});
export type GradeVerificationSchema = z.infer<typeof gradeVerificationSchema>;
export type GradeVerificationDTO = z.infer<typeof gradeVerificationSchema>;

export const allowedAssistanceOperations = [
  'concept',
  'requirements',
  'bounded-hint',
  'distinct-practice',
  'source-feedback-review',
] as const;
export type AllowedAssistanceOperation =
  (typeof allowedAssistanceOperations)[number];
export const assistancePolicyStates = [
  'active',
  'unknown',
  'verified-completed',
  'original-practice',
] as const;
export type AssistancePolicyState = (typeof assistancePolicyStates)[number];
export const assistancePolicySchema = z.strictObject({
  state: z.enum(assistancePolicyStates),
  policyRevision: revisionSchema,
  consentRevision: revisionSchema,
  canonicalProtectionId: idSchema.nullable(),
  allowedOperations: z.array(z.enum(allowedAssistanceOperations)).max(5),
  reasonCode: z.string().max(100),
  priorAssistanceSummary: z.string().max(2000),
});
export type AssistancePolicySchema = z.infer<typeof assistancePolicySchema>;
export type AssistancePolicy = z.infer<typeof assistancePolicySchema>;
