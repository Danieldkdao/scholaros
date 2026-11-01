import { z } from 'zod';

export const dateKinds = ['instant', 'local', 'date', 'unresolved'] as const;
export type DateKind = (typeof dateKinds)[number];
const original = z.string().min(1).max(200);
// A plain union emits anyOf; Meta rejects the oneOf emitted by discriminatedUnion.
export const academicDateSchema = z.union([
  z.object({
    kind: z.literal('instant'),
    instant: z.iso.datetime({ offset: true }),
    timezone: z.string().max(100).nullable(),
    original,
  }),
  z.object({
    kind: z.literal('local'),
    date: z.iso.date(),
    time: z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/),
    original,
  }),
  z.object({ kind: z.literal('date'), date: z.iso.date(), original }),
  z.object({
    kind: z.literal('unresolved'),
    original,
    reason: z.string().min(1).max(200),
  }),
]);
export type AcademicDateSchema = z.infer<typeof academicDateSchema>;
export const sourceEvidenceSchema = z.object({
  sourceUrl: z.url(),
  excerpts: z.array(z.string().min(1).max(350)).min(1).max(4),
  targetIds: z.array(z.string().min(1).max(20)).max(30),
});
export type SourceEvidenceSchema = z.infer<typeof sourceEvidenceSchema>;
export const resourceLinkSchema = z.object({
  targetId: z.string().min(1).max(20),
  label: z.string().min(1).max(300),
  url: z.url(),
});
export type ResourceLinkSchema = z.infer<typeof resourceLinkSchema>;
export const contentCoverageValues = [
  'complete',
  'detail',
  'partial',
  'unavailable',
] as const;
export type ContentCoverage = (typeof contentCoverageValues)[number];
export const assignmentStates = [
  'active-unsubmitted',
  'submitted',
  'inactive',
  'unknown',
] as const;
export type AssignmentState = (typeof assignmentStates)[number];
export const resourceKinds = [
  'courses',
  'assignments',
  'announcements',
] as const;
export type ResourceKind = (typeof resourceKinds)[number];
