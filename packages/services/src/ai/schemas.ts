import { z } from 'zod';

export const requestKinds = ['choose', 'extract', 'discover'] as const;
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

export const courseDiscoverySchema = z.object({
  courseTargetIds: z.array(z.string().min(1).max(20)).max(30),
});
export type CourseDiscoverySchema = z.infer<typeof courseDiscoverySchema>;
