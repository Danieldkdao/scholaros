import { watchTargetStatuses } from '../features/watch/constants';

export {
  activityMessageProtocolVersion,
  activityMessageByteLimit,
  activityPresentationValues,
  activityQueueByteLimit,
  activityQueueItemLimit,
  activityRuntimeVersion,
  activityStateByteLimit,
  activityStateEnvelopeByteLimit,
} from '@scholaros/services/learning/activity-contracts';
export type { ActivityPresentation } from '@scholaros/services/learning/activity-contracts';

export {
  contextImageMimeTypes,
  contextKinds,
  contextPreviewUnavailableReasons,
  contextProvenances,
  ingestionStatuses,
  locatorKinds,
  sourceKinds,
  sourceStates,
} from '@scholaros/services/learning/context-contracts';
export type {
  ContextImageMimeType,
  ContextKind,
  ContextPreviewUnavailableReason,
  ContextProvenance,
  IngestionStatus,
  Locator,
  LocatorKind,
  SourceKind,
  SourceState,
} from '@scholaros/services/learning/context-contracts';

export {
  allowedAssistanceOperations,
  assistancePolicyStates,
  evidenceTriStates,
  gradeScales,
  gradeVerificationStates,
  passFailValues,
} from '@scholaros/services/learning/grade-contracts';
export type {
  AllowedAssistanceOperation,
  AssistancePolicyState,
  EvidenceTriState,
  GradeScale,
  GradeVerificationState,
  ObservedGrade,
  PassFailValue,
} from '@scholaros/services/learning/grade-contracts';

export {
  safeErrorCodes,
  watchTargetFailureCategories,
} from '@scholaros/services/learning/product-contracts';
export type {
  Id,
  JsonValue,
  Revision,
  SafeErrorCode,
  WatchTargetFailureCategory,
} from '@scholaros/services/learning/product-contracts';

export {
  conceptRelationshipKinds,
  learningObservationKinds,
  memoryProvenances,
  memoryTypes,
  observationOutcomes,
  preferenceFields,
} from '@scholaros/services/learning/memory-contracts';
export type {
  ConceptRelationshipKind,
  LearningObservationKind,
  MemoryContent,
  MemoryProvenance,
  MemoryType,
  ObservationOutcome,
  PreferenceField,
} from '@scholaros/services/learning/memory-contracts';

export {
  notificationCategories,
  notificationStatuses,
  notificationTargetKinds,
  settingsSections,
} from '@scholaros/services/learning/notification-contracts';
export type {
  NotificationCategory,
  NotificationStatus,
  NotificationTargetKind,
  SafeRoute,
  SettingsSection,
} from '@scholaros/services/learning/notification-contracts';

export {
  practiceFeedbackModes,
  practiceModes,
  practiceQuestionKinds,
  practiceStatuses,
} from '@scholaros/services/learning/practice-contracts';
export type {
  PracticeFeedbackMode,
  PracticeMode,
  PracticeQuestionKind,
  PracticeStatus,
} from '@scholaros/services/learning/practice-contracts';

export {
  studyActivities,
  studyMessageRoles,
  studyMessageStatuses,
  studySessionStatuses,
  studyTurnStatuses,
} from '@scholaros/services/learning/study-contracts';
export type {
  StudyActivity,
  StudyMessageRole,
  StudyMessageStatus,
  StudySessionStatus,
  StudyTurnStatus,
} from '@scholaros/services/learning/study-contracts';

export {
  attentionKinds,
  freshnessStatuses,
} from '@scholaros/services/learning/today-contracts';
export type {
  AttentionKind,
  FreshnessStatus,
} from '@scholaros/services/learning/today-contracts';

export { materialSourceTypes } from '@scholaros/services/ai/resources/material';
export type {
  MaterialSourceType,
  MaterialSourceType as CourseMaterialSourceType,
} from '@scholaros/services/ai/resources/material';
export {
  courseMaterialExtractionStatuses,
  courseMaterialUsableStatuses,
} from '../features/context/types';
export type {
  CourseMaterialExtractionStatus,
  CourseMaterialUsableStatus,
} from '../features/context/types';

export { courseScanStatuses } from '../features/courses/types';
export type { CourseScanStatus } from '../features/courses/types';
export { watchTargetStatuses };
export type WatchTargetStatus = (typeof watchTargetStatuses)[number];

export const courseRecordTombstoneKinds = [
  'courses',
  'assignments',
  'announcements',
] as const;
export type CourseRecordTombstoneKind =
  (typeof courseRecordTombstoneKinds)[number];
