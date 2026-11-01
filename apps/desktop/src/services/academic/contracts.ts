import { z } from 'zod';

export const academicMethods = [
  'health',
  'subscribe',
  'getCurrentUser',
  'signOut',
  'getState',
  'saveSettings',
  'findBrowsers',
  'chooseBrowser',
  'createWorkspace',
  'resolveConnections',
  'reviseConnectionProposal',
  'approveConnectionProposal',
  'startConnectRun',
  'getConnectRun',
  'resumeConnectRun',
  'cancelConnectRun',
  'openResource',
  'captureResource',
  'previewResource',
  'saveConnectionNotes',
  'setCourseResource',
  'confirmResource',
  'removeResource',
  'setPrimaryLms',
  'discoverContext',
  'getCourses',
  'getCourse',
  'refreshCourses',
  'refreshCourse',
  'createCourseRecord',
  'updateCourseRecord',
  'deleteCourseRecord',
  'cancelCourseRefresh',
  'pauseBackgroundSync',
  'resumeBackgroundSync',
  'startPreview',
  'getPreview',
  'cancelPreview',
  'openSource',
  'completeOnboarding',
  'shutdown',
] as const;
export type AcademicMethod = (typeof academicMethods)[number];
export const academicRequestSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(100),
  token: z.string().min(1).max(200),
  method: z.enum(academicMethods),
  input: z.unknown().optional(),
});
export type AcademicRequestSchema = z.infer<typeof academicRequestSchema>;
export const academicEndpointSchema = z.object({
  version: z.literal(1),
  address: z.string().min(1).max(300),
  token: z.string().length(64),
});
export type AcademicEndpointSchema = z.infer<typeof academicEndpointSchema>;
export const academicEventChannels = [
  'scholar:backgroundSyncChange',
  'scholar:connectChange',
  'scholar:previewChange',
  'scholar:coursesChange',
] as const;
export type AcademicEventChannel = (typeof academicEventChannels)[number];
export const academicMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('result'),
    id: z.string(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal('event'),
    channel: z.enum(academicEventChannels),
    value: z.unknown().optional(),
  }),
]);
export type AcademicMessageSchema = z.infer<typeof academicMessageSchema>;
export type AcademicAction = (input: unknown) => unknown;
