import { z } from 'zod';
import { idSchema, instantSchema, revisionSchema } from './product-contracts';
import { sourceReferenceSchema } from './context-contracts';

export const memoryTypes = [
  'explicit-preference',
  'provisional-preference',
  'learning-observation',
] as const;
export type MemoryType = (typeof memoryTypes)[number];
export const memoryProvenances = [
  'student-explicit',
  'meta-inferred',
  'practice-evidence',
] as const;
export type MemoryProvenance = (typeof memoryProvenances)[number];
export const preferenceFields = [
  'explanation-length',
  'vocabulary',
  'example-style',
  'learning-level',
] as const;
export type PreferenceField = (typeof preferenceFields)[number];
export const preferenceContentSchema = z.strictObject({
  field: z.enum(preferenceFields),
  value: z.string().max(300),
});
export type PreferenceContentSchema = z.infer<typeof preferenceContentSchema>;
export type PreferenceContent = z.infer<typeof preferenceContentSchema>;
export const observationOutcomes = [
  'independent-success',
  'assisted-success',
  'difficulty',
  'uncertain',
] as const;
export type ObservationOutcome = (typeof observationOutcomes)[number];
export const learningObservationKinds = [
  'practice-response',
  'tutor-interaction',
  'confidence-check',
] as const;
export type LearningObservationKind = (typeof learningObservationKinds)[number];
export const conceptRelationshipKinds = ['prerequisite', 'related'] as const;
export type ConceptRelationshipKind = (typeof conceptRelationshipKinds)[number];
export const observationSummarySchema = z.strictObject({
  conceptId: idSchema.nullable(),
  outcome: z.enum(observationOutcomes),
  summary: z.string().max(1000),
});
export type ObservationSummarySchema = z.infer<typeof observationSummarySchema>;
export type ObservationSummary = z.infer<typeof observationSummarySchema>;

export const memoryContentSchema = z.union([
  preferenceContentSchema,
  observationSummarySchema,
]);
export type MemoryContentSchema = z.infer<typeof memoryContentSchema>;
export type MemoryContent = z.infer<typeof memoryContentSchema>;
export const memorySchema = z.strictObject({
  id: idSchema,
  courseId: idSchema.nullable(),
  type: z.enum(memoryTypes),
  content: memoryContentSchema,
  provenance: z.enum(memoryProvenances),
  evidenceIds: z.array(idSchema).max(50),
  confidence: z.number().min(0).max(1).nullable(),
  revision: revisionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type MemorySchema = z.infer<typeof memorySchema>;
export type MemoryDTO = z.infer<typeof memorySchema>;

export const personalContextSchema = z.strictObject({
  preferences: z.array(memorySchema).max(20),
  observations: z.array(memorySchema).max(10),
  revision: revisionSchema,
});
export type PersonalContextSchema = z.infer<typeof personalContextSchema>;
export type PersonalContext = z.infer<typeof personalContextSchema>;

export const progressItemSchema = z.strictObject({
  conceptId: idSchema.nullable(),
  label: z.string().max(160),
  summary: z.string().max(500),
  evidenceIds: z.array(idSchema).max(50),
  assisted: z.boolean(),
  sourceReferences: z.array(sourceReferenceSchema).max(20),
});
export type ProgressItemSchema = z.infer<typeof progressItemSchema>;
export type ProgressItem = z.infer<typeof progressItemSchema>;
export const learningProgressSchema = z.strictObject({
  courseId: idSchema.nullable(),
  strengths: z.array(progressItemSchema).max(10),
  practiceTopics: z.array(progressItemSchema).max(10),
  recentChanges: z.array(progressItemSchema).max(10),
  unknownCount: z.number().int().nonnegative(),
  revision: revisionSchema,
});
export type LearningProgressSchema = z.infer<typeof learningProgressSchema>;
export type LearningProgress = z.infer<typeof learningProgressSchema>;
