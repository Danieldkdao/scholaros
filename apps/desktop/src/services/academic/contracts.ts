import type { ActivityPresentation } from '@scholaros/services/learning/activity-contracts';
import { ingestionStatuses } from '@scholaros/services/learning/context-contracts';
import type {
  AuthorizedRegistrar,
  Id,
  LearningPublicMethod,
  RequestId,
  Revision,
} from '@scholaros/services/learning/product-contracts';
import { z } from 'zod';

export const learningMethods = [
  'listContextItems',
  'getContextItem',
  'createContextNote',
  'updateContextItem',
  'linkContextItem',
  'removeContextItem',
  'retryContextIngestion',
  'cancelContextIngestion',
  'readContextPreview',
  'getGradeSettings',
  'saveGradeSettings',
  'verifyCoursework',
  'getVerifiedCourseworkEvidence',
  'createStudySession',
  'listStudySessions',
  'getStudySession',
  'renameStudySession',
  'saveStudyDraft',
  'deleteStudySession',
  'reconcileStudyDeadline',
  'finishStudySession',
  'extendStudySession',
  'continueStudyUntimed',
  'sendStudyTurn',
  'retryStudyTurn',
  'cancelStudyTurn',
  'getArtifactVersion',
  'getArtifactState',
  'resetArtifactAttempt',
  'saveArtifactToContext',
  'getPracticeAttempt',
  'savePracticeAnswer',
  'submitPracticeAttempt',
  'switchPracticeToGuided',
  'retryPracticeAttempt',
  'listMemories',
  'upsertExplicitPreference',
  'correctMemory',
  'deleteMemory',
  'getLearningProgress',
  'getTodayOverview',
  'getStudyRecommendations',
  'getNotificationSettings',
  'saveNotificationSettings',
] as const satisfies readonly LearningPublicMethod[];

type AssertNever<Value extends never> = Value;
export type LearningMethodContractCoverage = AssertNever<
  Exclude<LearningPublicMethod, (typeof learningMethods)[number]>
>;
export type LearningMethod = (typeof learningMethods)[number];

export const serviceControlMethods = [
  'health',
  'subscribe',
  'shutdown',
] as const;
export const internalAcademicMethods = [
  'registerSelectedContextFiles',
  'authorizeActivityRun',
  'checkpointArtifactState',
  'claimDueNotifications',
  'purgeGradeDerivedStudyContent',
] as const;

export const legacyRendererMethods = [
  'getCurrentUser',
  'signOut',
  'getState',
  'getWatchSettings',
  'saveWatchSettings',
  'getWatchRuntimeState',
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
] as const;

export const rendererProductMethods = [
  'stageWorkspaceReplacement',
  'commitWorkspaceReplacement',
  'cancelWorkspaceReplacement',
  'deleteLocalAcademicData',
] as const;

export const rendererAcademicMethods = [
  ...legacyRendererMethods,
  ...learningMethods,
  ...rendererProductMethods,
] as const;
export type RendererAcademicMethod = (typeof rendererAcademicMethods)[number];
export type InternalAcademicMethod = (typeof internalAcademicMethods)[number];
export const academicMethods = [
  ...serviceControlMethods,
  ...rendererAcademicMethods,
  ...internalAcademicMethods,
] as const;
export type AcademicMethod = (typeof academicMethods)[number];
export const offlineReadMethods = [
  'getCurrentUser',
  'getState',
  'getWatchSettings',
  'getWatchRuntimeState',
  'getConnectRun',
  'getCourses',
  'getCourse',
  'listContextItems',
  'getContextItem',
  'readContextPreview',
  'getGradeSettings',
  'listStudySessions',
  'getStudySession',
  'getArtifactVersion',
  'getArtifactState',
  'getPracticeAttempt',
  'listMemories',
  'getLearningProgress',
  'getTodayOverview',
  'getStudyRecommendations',
  'getNotificationSettings',
] as const satisfies readonly RendererAcademicMethod[];
export type OfflineReadMethod = (typeof offlineReadMethods)[number];
export const academicRequestSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1).max(100),
  token: z.string().min(1).max(200),
  method: z.enum(academicMethods),
  input: z.unknown().optional(),
});
export type AcademicRequestSchema = z.infer<typeof academicRequestSchema>;
export const academicEndpointSchema = z.strictObject({
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
  'scholar:watchChange',
  'scholar:productEvent',
] as const;
export type AcademicEventChannel = (typeof academicEventChannels)[number];
export const academicMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('result'),
    id: z.string(),
    value: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal('event'),
    channel: z.enum(academicEventChannels),
    value: z.unknown().optional(),
  }),
]);
export type AcademicMessageSchema = z.infer<typeof academicMessageSchema>;
export type AcademicAction = (input: unknown) => unknown;
export type LearningActionRegistrar = AuthorizedRegistrar;
export const academicReconnectSchema = z.strictObject({
  accountId: z.string().min(1).max(300).nullable(),
});
export type AcademicReconnect = z.infer<typeof academicReconnectSchema>;
export type AuthMode = 'online' | 'offline-local';
export type WorkspaceReplacementInput = {
  requestId: RequestId;
  browserId: Id;
};
export type WorkspaceReplacementCommitInput = {
  operationId: Id;
  expectedRevision: Revision;
};
export type WorkspaceReplacementCancelInput = { operationId: Id };
export type DeleteLocalAcademicDataInput = {
  requestId: RequestId;
  scope: 'account-local';
};
export const contextFileSelectionSchema = z.strictObject({
  sessionId: z.string().min(1).max(300).optional(),
  courseId: z.string().min(1).max(300).optional(),
  saveToLibrary: z.boolean(),
});
export type ContextFileSelectionInput = z.infer<
  typeof contextFileSelectionSchema
>;
export const registerSelectedContextFilesInputSchema = z.strictObject({
  filePaths: z.array(z.string().min(1).max(4096)).min(1).max(8),
  sessionId: z.string().min(1).max(300).optional(),
  courseId: z.string().min(1).max(300).optional(),
  saveToLibrary: z.boolean(),
});
export type RegisterSelectedContextFilesInput = z.infer<
  typeof registerSelectedContextFilesInputSchema
>;
export const contextFileSelectionResultSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        itemId: z.string().min(1).max(300),
        operationId: z.string().min(1).max(300),
        status: z.enum(ingestionStatuses),
      }),
    )
    .max(8),
  cancelled: z.boolean(),
});
export type ContextFileSelectionResult = z.infer<
  typeof contextFileSelectionResultSchema
>;
export const requestMicrophonePermissionSchema = z.strictObject({
  sessionId: z.string().min(1).max(300),
});
export type RequestMicrophonePermissionInput = z.infer<
  typeof requestMicrophonePermissionSchema
>;
export const requestNotificationPermissionSchema = z.strictObject({});
export type RequestNotificationPermissionInput = z.infer<
  typeof requestNotificationPermissionSchema
>;
export type ActivityBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type MountActivityInput = {
  sessionId: Id;
  artifactId: Id;
  versionId: Id;
  attemptId: Id;
  presentation: ActivityPresentation;
  bounds: ActivityBounds;
};
export type UpdateActivityBoundsInput = {
  runId: Id;
  bounds: ActivityBounds;
  visible: boolean;
};
export type CloseActivityInput = { runId: Id };
