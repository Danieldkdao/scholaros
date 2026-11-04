import { z } from 'zod';
import {
  idSchema,
  instantSchema,
  jsonValueSchema,
  revisionSchema,
} from './product-contracts';
import { sourceReferenceSchema } from './context-contracts';

export const practiceQuestionKinds = [
  'multiple-choice',
  'numeric',
  'short-explanation',
] as const;
export type PracticeQuestionKind = (typeof practiceQuestionKinds)[number];
export const practiceModes = ['quiz', 'exam', 'guided'] as const;
export type PracticeMode = (typeof practiceModes)[number];
export const practiceFeedbackModes = ['end', 'per-answer'] as const;
export type PracticeFeedbackMode = (typeof practiceFeedbackModes)[number];
export const practiceStatuses = [
  'in-progress',
  'submitted',
  'evaluated',
  'interrupted',
] as const;
export type PracticeStatus = (typeof practiceStatuses)[number];

export const practiceQuestionSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(practiceQuestionKinds),
  prompt: z.string().max(4000),
  options: z
    .array(z.strictObject({ id: idSchema, text: z.string().max(1000) }))
    .max(10)
    .nullable(),
  unit: z.string().max(100).nullable(),
  objectiveIds: z.array(idSchema).max(20),
  sourceReferences: z.array(sourceReferenceSchema).max(20),
});
export type PracticeQuestionSchema = z.infer<typeof practiceQuestionSchema>;
export type PracticeQuestionDTO = z.infer<typeof practiceQuestionSchema>;

export const practiceEvaluationOutcomes = [
  'correct',
  'incorrect',
  'uncertain',
] as const;
export type PracticeEvaluationOutcome =
  (typeof practiceEvaluationOutcomes)[number];
export const practiceEvaluationSchema = z.strictObject({
  questionId: idSchema,
  outcome: z.enum(practiceEvaluationOutcomes),
  explanation: z.string().max(4000),
  acceptedAlternatives: z.array(z.string().max(1000)).max(10),
  sourceReferences: z.array(sourceReferenceSchema).max(20),
  rubricVersion: idSchema,
  assisted: z.boolean(),
});
export type PracticeEvaluationSchema = z.infer<typeof practiceEvaluationSchema>;
export type PracticeEvaluationDTO = z.infer<typeof practiceEvaluationSchema>;

export const practiceAnswerSchema = z.strictObject({
  questionId: idSchema,
  revision: revisionSchema,
  value: jsonValueSchema,
  savedAt: instantSchema,
});
export type PracticeAnswerSchema = z.infer<typeof practiceAnswerSchema>;
export type PracticeAnswerDTO = z.infer<typeof practiceAnswerSchema>;

export const practiceSnapshotSchema = z.strictObject({
  id: idSchema,
  courseId: idSchema,
  sessionId: idSchema.nullable(),
  mode: z.enum(practiceModes),
  feedbackMode: z.enum(practiceFeedbackModes),
  status: z.enum(practiceStatuses),
  revision: revisionSchema,
  assisted: z.boolean(),
  priorAttemptId: idSchema.nullable(),
  questions: z.array(practiceQuestionSchema).max(20),
  answers: z.array(practiceAnswerSchema).max(20),
  feedback: z.array(practiceEvaluationSchema).max(20),
});
export type PracticeSnapshotSchema = z.infer<typeof practiceSnapshotSchema>;
export type PracticeSnapshot = z.infer<typeof practiceSnapshotSchema>;
