import { z } from 'zod';

export const onboardingSteps = [
  'welcome',
  'browser',
  'resources',
  'context',
  'preferences',
  'preview',
  'review',
] as const;
export type OnboardingStep = (typeof onboardingSteps)[number];
export const settingsUpdateSchema = z
  .object({
    step: z.enum(onboardingSteps).optional(),
    consent: z.boolean().optional(),
    launchAtLogin: z.boolean().optional(),
    backgroundSync: z.boolean().optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type SettingsUpdateSchema = z.infer<typeof settingsUpdateSchema>;
export const previewPrompts = [
  'courses',
  'assignments',
  'announcements',
] as const;
export type PreviewPrompt = (typeof previewPrompts)[number];
export const previewPromptSchema = z.enum(previewPrompts);
export type PreviewPromptSchema = z.infer<typeof previewPromptSchema>;
export const previewCardKinds = [
  'course',
  'assignment',
  'announcement',
] as const;
export type PreviewCardKind = (typeof previewCardKinds)[number];
export const previewResultSchema = z.object({
  cards: z
    .array(
      z.object({
        kind: z.enum(previewCardKinds),
        title: z.string().min(1).max(180),
        course: z.string().max(180).nullable(),
        detail: z.string().max(600).nullable(),
        date: z.string().max(100).nullable(),
        sourceUrl: z.url(),
      }),
    )
    .max(20),
});
export type PreviewResultSchema = z.infer<typeof previewResultSchema>;
