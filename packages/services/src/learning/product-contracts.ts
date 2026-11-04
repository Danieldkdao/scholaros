import { z } from 'zod';
import type {
  ContextItemDTO,
  ContextPreview,
  ContextVersionDTO,
  SourceReference,
} from './context-contracts';
import type { GradeSettings, GradeVerificationDTO } from './grade-contracts';
import type {
  MemoryDTO,
  LearningProgress,
  PreferenceContent,
} from './memory-contracts';
import type { NotificationSettings } from './notification-contracts';
import type { PracticeSnapshot } from './practice-contracts';
import type {
  CreateStudySessionInput,
  StudySessionDTO,
  SessionSnapshot,
  StudyTimerDTO,
} from './study-contracts';
import type {
  ArtifactStateDTO,
  ArtifactVersionDTO,
} from './activity-contracts';
import type { Recommendation, TodayOverview } from './today-contracts';

export const watchTargetFailureCategories = [
  'needs-sign-in',
  'rate-limited',
  'network',
  'navigation',
  'scope-changed',
  'unknown',
] as const;
export type WatchTargetFailureCategory =
  (typeof watchTargetFailureCategories)[number];

export const safeErrorCodes = [
  'invalid-input',
  'not-found',
  'scope-denied',
  'session-changed',
  'permission-revoked',
  'busy',
  'revision-conflict',
  'cancelled',
  'offline',
  'needs-sign-in',
  'rate-limited',
  'capability-changed',
  'feature-unavailable',
  'unsupported',
  'unreadable',
  'limit-exceeded',
  'provider-failed',
  'storage-failed',
] as const;
export type SafeErrorCode = (typeof safeErrorCodes)[number];
export const safeErrorCodeSchema = z.enum(safeErrorCodes);
export type SafeErrorCodeSchema = z.infer<typeof safeErrorCodeSchema>;

export const idSchema = z.string().min(1).max(300);
export type IdSchema = z.infer<typeof idSchema>;
export type Id = z.infer<typeof idSchema>;
export const requestIdSchema = z.uuid();
export type RequestIdSchema = z.infer<typeof requestIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export const revisionSchema = z.number().int().nonnegative().safe();
export type RevisionSchema = z.infer<typeof revisionSchema>;
export type Revision = z.infer<typeof revisionSchema>;
export const instantSchema = z.iso.datetime({ offset: true });
export type InstantSchema = z.infer<typeof instantSchema>;
export type Instant = z.infer<typeof instantSchema>;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const isJsonValue = (value: unknown, depth = 0): value is JsonValue => {
  if (depth > 12) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      key !== '__proto__' &&
      key !== 'prototype' &&
      key !== 'constructor' &&
      isJsonValue(item, depth + 1),
  );
};

export const jsonValueSchema = z.custom<JsonValue>(isJsonValue, {
  message: 'Expected bounded JSON data.',
});
export type JsonValueSchema = z.infer<typeof jsonValueSchema>;

export const pageInputSchema = z.strictObject({
  query: z.string().max(200).optional(),
  courseId: idSchema.nullable().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type PageInputSchema = z.infer<typeof pageInputSchema>;
export type PageInput = z.infer<typeof pageInputSchema>;
export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  revision: Revision;
};

export const productEventOutcomes = [
  'completed',
  'failed',
  'cancelled',
  'attention',
] as const;
export type ProductEventOutcome = (typeof productEventOutcomes)[number];
export const productEventResources = [
  'context',
  'study',
  'grades',
  'memory',
  'today',
  'notifications',
  'device',
] as const;
export type ProductEventResource = (typeof productEventResources)[number];
export const productEventV1Schema = z.strictObject({
  version: z.literal(1),
  accountId: idSchema,
  revision: revisionSchema,
  resource: z.enum(productEventResources),
  targetId: idSchema.nullable(),
  outcome: z.enum(productEventOutcomes).optional(),
  operationId: idSchema.optional(),
});
export type ProductEventV1Schema = z.infer<typeof productEventV1Schema>;
export type ProductEventV1 = z.infer<typeof productEventV1Schema>;

export type AuthorizedContext = {
  userId: Id;
  epoch: number;
  isCurrent: () => boolean;
  signal: AbortSignal;
};

export type LearningMethodContracts = {
  listContextItems: { input: PageInput; result: Page<ContextItemDTO> | null };
  getContextItem: {
    input: { itemId: Id; versionId?: Id };
    result: {
      item: ContextItemDTO;
      versions: ContextVersionDTO[];
      preview: ContextPreview;
    } | null;
  };
  createContextNote: {
    input: {
      requestId: RequestId;
      title: string;
      text: string;
      kind: 'note' | 'preference';
      courseId?: Id;
    };
    result: ContextItemDTO;
  };
  updateContextItem: {
    input: {
      itemId: Id;
      expectedRevision: Revision;
      title?: string;
      text?: string;
      courseId?: Id | null;
    };
    result: ContextItemDTO;
  };
  linkContextItem: {
    input: {
      itemId: Id;
      courseId: Id | null;
      sessionId?: Id;
      retainInLibrary?: boolean;
    };
    result: ContextItemDTO;
  };
  removeContextItem: {
    input: { itemId: Id; expectedRevision: Revision };
    result: void;
  };
  retryContextIngestion: {
    input: { itemId: Id; requestId: RequestId };
    result: { operationId: Id };
  };
  cancelContextIngestion: { input: { operationId: Id }; result: void };
  readContextPreview: {
    input: { itemId: Id; versionId?: Id; sessionId?: Id };
    result: ContextPreview;
  };
  getGradeSettings: { input: Record<string, never>; result: GradeSettings };
  saveGradeSettings: {
    input: {
      enabled: boolean;
      notes: string;
      expectedRevision: Revision;
      deleteCollected?: boolean;
    };
    result: GradeSettings;
  };
  verifyCoursework: {
    input: { courseId: Id; assignmentId: Id; requestId: RequestId };
    result: GradeVerificationDTO;
  };
  getVerifiedCourseworkEvidence: {
    input: { courseId: Id; assignmentId: Id };
    result: GradeVerificationDTO | null;
  };
  createStudySession: {
    input: CreateStudySessionInput;
    result: StudySessionDTO;
  };
  listStudySessions: {
    input: PageInput & { status?: StudySessionDTO['status'] };
    result: Page<StudySessionDTO> | null;
  };
  getStudySession: {
    input: { sessionId: Id; beforeSequence?: number; limit?: number };
    result: SessionSnapshot | null;
  };
  renameStudySession: {
    input: { sessionId: Id; title: string; expectedRevision: Revision };
    result: StudySessionDTO;
  };
  saveStudyDraft: {
    input: { sessionId: Id; text: string; expectedDraftRevision: Revision };
    result: { draftRevision: Revision };
  };
  deleteStudySession: {
    input: { sessionId: Id; expectedRevision: Revision; requestId: RequestId };
    result: void;
  };
  reconcileStudyDeadline: { input: { sessionId: Id }; result: StudyTimerDTO };
  finishStudySession: {
    input: {
      sessionId: Id;
      requestId: RequestId;
      expectedTimerRevision: Revision;
    };
    result: StudySessionDTO;
  };
  extendStudySession: {
    input: {
      sessionId: Id;
      requestId: RequestId;
      expectedTimerRevision: Revision;
      durationMinutes: number;
    };
    result: StudyTimerDTO;
  };
  continueStudyUntimed: {
    input: {
      sessionId: Id;
      requestId: RequestId;
      expectedTimerRevision: Revision;
    };
    result: StudyTimerDTO;
  };
  sendStudyTurn: {
    input: {
      sessionId: Id;
      requestId: RequestId;
      expectedDraftRevision: Revision;
      text: string;
      attachmentIds: Id[];
    };
    result: { turnId: Id; revision: Revision; draftRevision?: Revision };
  };
  retryStudyTurn: {
    input: { sessionId: Id; turnId: Id; requestId: RequestId };
    result: { turnId: Id; revision: Revision };
  };
  cancelStudyTurn: { input: { sessionId: Id; turnId: Id }; result: void };
  getArtifactVersion: {
    input: { artifactId: Id; versionId: Id };
    result: ArtifactVersionDTO | null;
  };
  getArtifactState: {
    input: { artifactId: Id; versionId: Id; attemptId: Id };
    result: ArtifactStateDTO | null;
  };
  resetArtifactAttempt: {
    input: {
      artifactId: Id;
      versionId: Id;
      attemptId: Id;
      requestId: RequestId;
    };
    result: ArtifactStateDTO;
  };
  saveArtifactToContext: {
    input: {
      artifactId: Id;
      versionId: Id;
      courseId?: Id | null;
      requestId: RequestId;
    };
    result: ContextItemDTO;
  };
  getPracticeAttempt: { input: { attemptId: Id }; result: PracticeSnapshot };
  savePracticeAnswer: {
    input: {
      attemptId: Id;
      questionId: Id;
      expectedRevision: Revision;
      value: JsonValue;
      requestId: RequestId;
    };
    result: PracticeSnapshot;
  };
  submitPracticeAttempt: {
    input: { attemptId: Id; expectedRevision: Revision; requestId: RequestId };
    result: PracticeSnapshot;
  };
  switchPracticeToGuided: {
    input: { attemptId: Id; expectedRevision: Revision; requestId: RequestId };
    result: PracticeSnapshot;
  };
  retryPracticeAttempt: {
    input: { attemptId: Id; requestId: RequestId };
    result: PracticeSnapshot;
  };
  listMemories: {
    input: PageInput & { type?: MemoryDTO['type'] };
    result: Page<MemoryDTO> | null;
  };
  upsertExplicitPreference: {
    input: {
      requestId: RequestId;
      preference: PreferenceContent;
      courseId?: Id;
    };
    result: MemoryDTO;
  };
  correctMemory: {
    input: {
      memoryId: Id;
      expectedRevision: Revision;
      preference: PreferenceContent;
    };
    result: MemoryDTO;
  };
  deleteMemory: {
    input: { memoryId: Id; expectedRevision: Revision };
    result: void;
  };
  getLearningProgress: {
    input: { courseId?: Id };
    result: LearningProgress | null;
  };
  getTodayOverview: { input: { limit?: number }; result: TodayOverview };
  getStudyRecommendations: {
    input: { limit?: number };
    result: Recommendation[];
  };
  getNotificationSettings: {
    input: Record<string, never>;
    result: NotificationSettings;
  };
  saveNotificationSettings: {
    input: {
      settings: Omit<NotificationSettings, 'revision'>;
      expectedRevision: Revision;
    };
    result: NotificationSettings;
  };
};

export type ProductPreferences = {
  grades: { enabled: boolean; notes: string; revision: Revision };
  notifications: NotificationSettings;
  learning: {
    educationLevel: string | null;
    appearance: 'system' | 'light' | 'dark';
    accessibility: { reduceMotion: boolean; highContrast: boolean };
    revision: Revision;
  };
};

export type LearningPublicMethod = keyof LearningMethodContracts;
export type InputOf<M extends LearningPublicMethod> =
  LearningMethodContracts[M]['input'];
export type ResultOf<M extends LearningPublicMethod> =
  LearningMethodContracts[M]['result'];
export type ActionCleanup = () => Promise<void>;

export type LearningLifecycle = {
  readonly signal: AbortSignal;
  readonly epoch: number;
  isCurrent(epoch: number): boolean;
  now(): number;
  registerOperation(
    key: string,
    operationId: Id,
    controller: AbortController,
  ): () => void;
  onTeardown(cleanup: () => void | Promise<void>): void;
};

export type AuthorizedRegistrar = {
  handle<M extends LearningPublicMethod>(
    name: M,
    handler: (
      context: AuthorizedContext,
      input: InputOf<M>,
    ) => Promise<ResultOf<M>>,
  ): void;
  publish(event: ProductEventV1): void;
  readonly lifecycle: LearningLifecycle;
};

export type ContextSourceReference = SourceReference;
