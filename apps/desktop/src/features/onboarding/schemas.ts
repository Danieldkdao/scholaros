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
    decisionTimeSeconds: z.number().min(0.5).max(5).optional(),
    blockedWords: z
      .array(z.string().trim().min(1).max(100).toLowerCase())
      .max(100)
      .optional(),
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
