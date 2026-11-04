import type {
  CourseRecordSchema,
  CreateCourseRecordSchema,
  ListCourseRecordSuppressionsSchema,
  RestoreCourseRecordSuppressionSchema,
  UpdateCourseRecordSchema,
} from '../courses/schemas';
import type {
  InputOf,
  LearningPublicMethod,
  ProductEventV1,
  ResultOf,
} from '@scholaros/services/learning/product-contracts';
import type {
  DictationAudioChunk,
  DictationEvent,
  DictationStartInput,
} from '@scholaros/services/learning/speech-contracts';
import type {
  AcademicReconnect,
  ActivityRuntimeChange,
  AuthMode,
  CloseActivityInput,
  ContextFileSelectionInput,
  ContextFileSelectionResult,
  DeleteLocalAcademicDataInput,
  MountActivityInput,
  UpdateActivityBoundsInput,
  WorkspaceReplacementCancelInput,
  WorkspaceReplacementCommitInput,
  WorkspaceReplacementInput,
} from '../../services/academic/contracts';
import type { ConnectRunState } from './services/connect-run';
import type { WorkspaceReplacementDTO } from './services/browser-workspace';
import type { ConnectionCandidateSchema } from '@scholaros/services/ai/schemas';
import type { CourseDetail, CoursesSnapshot } from '../courses/types';
import type { CourseRecordSuppressionView } from '../courses/services/store';
import type { OnboardingStep, PreviewCardKind, PreviewPrompt } from './schemas';
import type { BrowserNavigationMode } from '@scholaros/env/browser-navigation';
import type { WatchRuntimeStatus, WatchSettings } from '../watch/types';

export type { OnboardingStep, PreviewCardKind, PreviewPrompt };
export type { BrowserNavigationMode };

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  hasCompletedOnboarding: boolean;
  authMode?: AuthMode;
};
export type BrowserId = 'chrome' | 'edge' | 'brave';
export type BrowserInstallation = {
  id: string;
  browser: BrowserId;
  name: string;
  version: string;
  icon: string | null;
};
export type ConnectionStatus = 'verified' | 'confirmed' | 'needs-sign-in';

export type ConnectionNotesStatus = 'saved' | 'saving' | 'error';

export type AcademicConnection = {
  id: string;
  name: string;
  url: string;
  host: string;
  kind: 'canvas' | 'classroom' | 'resource';
  status: ConnectionStatus;
  verifiedAt: string | null;
  notes: string | null;
  favicon: string | null;
  isCourseResource: boolean;
};
// What the study browser is showing right now, before anything is stored.
export type PreviewedConnection = Pick<
  AcademicConnection,
  'name' | 'url' | 'host' | 'kind' | 'status'
>;
export type LaunchAtLoginPreference = {
  requested: boolean;
  applied: boolean;
  message: string | null;
};
export type BackgroundSyncStatus =
  | 'off'
  | 'waiting'
  | 'syncing'
  | 'paused'
  | 'blocked';
export type BackgroundSyncState = {
  status: BackgroundSyncStatus;
  message: string | null;
  lastSyncedAt: string | null;
};
export type BackgroundSyncChange = {
  accountId: string | null;
  state: BackgroundSyncState;
  discovery: AcademicDiscovery | null;
};
export type OnboardingPreferences = {
  launchAtLogin: LaunchAtLoginPreference;
  backgroundSync: BackgroundSyncState;
};
export type DiscoveryStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'partial'
  | 'empty'
  | 'inconclusive'
  | 'blocked'
  | 'needs-sign-in'
  | 'cancelled'
  | 'failed';
export type AcademicContextEntryRole = 'course' | 'resource';
export type ConnectionOutcome =
  | 'courses'
  | 'empty'
  | 'inconclusive'
  | 'blocked'
  | 'needs-sign-in'
  | 'skipped';
export type AcademicContextEntry = {
  id: string;
  connectionId: string;
  label: string;
  url: string;
  role: AcademicContextEntryRole;
  evidenceUrl: string;
  observedAt: string;
};
export type AcademicContextEntryDraft = Omit<
  AcademicContextEntry,
  'id' | 'observedAt'
>;
export type AcademicDiscovery = {
  status: DiscoveryStatus;
  message: string | null;
  discoveredAt: string | null;
  coverage: Record<string, ConnectionOutcome>;
  entries: AcademicContextEntry[];
};
export type OnboardingSettings = {
  step: OnboardingStep;
  consent: boolean;
  launchAtLogin: boolean;
  backgroundSync: boolean;
  decisionTimeSeconds: number;
  blockedWords: string[];
  notes: string;
  localSetupCompletedAt: string | null;
};
export type BrowserWorkspaceStatus =
  | 'ready'
  | 'browser-missing'
  | 'profile-missing'
  | 'unverified';
export type BrowserWorkspace = {
  browser: BrowserId;
  browserName: string;
  ready: boolean;
  status: BrowserWorkspaceStatus;
  verifiedAt: string | null;
};
export type OnboardingState = {
  accountId: string;
  settings: OnboardingSettings;
  workspace: BrowserWorkspace | null;
  connections: AcademicConnection[];
  primaryLms: string | null;
  discovery: AcademicDiscovery;
  preferences: OnboardingPreferences;
  watch?: { enabled: boolean; status: WatchRuntimeStatus };
};
export type WatchRuntimeState = {
  enabled: boolean;
  status: WatchRuntimeStatus;
};
export type WatchRuntimeChange = WatchRuntimeState & { accountId: string };
export type { WatchSettings };
export type ActivityType =
  | 'waiting'
  | 'opening'
  | 'navigating'
  | 'reading'
  | 'checking'
  | 'complete'
  | 'blocked'
  | 'cancelled';
export type AgentActivity = { type: ActivityType; detail?: string };
export type PreviewCard = {
  kind: PreviewCardKind;
  title: string;
  course: string | null;
  detail: string | null;
  date: string | null;
  sourceUrl: string;
  excerpt: string;
  courseVerified: boolean;
  dateVerified: boolean;
};
export type EvidencePage = {
  url: string;
  title: string;
  text: string;
  retrievedAt?: string;
  locale?: string | null;
};
export type PreviewState = {
  accountId: string | null;
  status: 'idle' | 'running' | 'complete' | 'blocked' | 'cancelled';
  events: AgentActivity[];
  cards: PreviewCard[];
  message: string | null;
};
export type ConnectionProposal = {
  id: string;
  candidates: ConnectionCandidateSchema[];
};

export type DeviceReplacementDTO = WorkspaceReplacementDTO;

type LearningBridge = {
  [Method in LearningPublicMethod]: (
    input: InputOf<Method>,
  ) => Promise<ResultOf<Method>>;
};

export type ScholarBridge = LearningBridge & {
  onProductEvent: (listener: (event: ProductEventV1) => void) => () => void;
  onAcademicReconnect: (
    listener: (change: AcademicReconnect) => void,
  ) => () => void;
  onDictationEvent: (listener: (event: DictationEvent) => void) => () => void;
  onCoursesChange: (
    listener: (change: { accountId: string; courseId: string | null }) => void,
  ) => () => void;
  getCurrentUser: () => Promise<CurrentUser | null>;
  resolveConnections: (prompt: string) => Promise<ConnectionProposal>;
  reviseConnectionProposal: (
    proposal: ConnectionProposal,
  ) => Promise<ConnectionProposal>;
  approveConnectionProposal: (proposal: ConnectionProposal) => Promise<void>;
  startConnectRun: (proposalId: string) => Promise<void>;
  getConnectRun: () => Promise<ConnectRunState>;
  resumeConnectRun: () => Promise<void>;
  cancelConnectRun: () => Promise<void>;
  onConnectChange: (listener: (state: ConnectRunState) => void) => () => void;
  getState: () => Promise<OnboardingState>;
  getWatchSettings: () => Promise<WatchSettings>;
  saveWatchSettings: (settings: WatchSettings) => Promise<WatchSettings>;
  getWatchRuntimeState: () => Promise<WatchRuntimeState>;
  onWatchChange: (listener: (change: WatchRuntimeChange) => void) => () => void;
  saveSettings: (
    changes: Partial<
      Pick<
        OnboardingSettings,
        'step' | 'consent' | 'launchAtLogin' | 'backgroundSync' | 'notes'
      >
    >,
  ) => Promise<OnboardingState>;
  findBrowsers: () => Promise<BrowserInstallation[]>;
  chooseBrowser: () => Promise<BrowserInstallation | null>;
  createWorkspace: (installationId: string) => Promise<OnboardingState>;
  openResource: (resourceId: string) => Promise<void>;
  captureResource: () => Promise<AcademicConnection>;
  previewResource: () => Promise<PreviewedConnection | null>;
  saveConnectionNotes: (
    connectionId: string,
    notes: string,
  ) => Promise<OnboardingState>;
  setCourseResource: (
    connectionId: string,
    isCourseResource: boolean,
  ) => Promise<OnboardingState>;
  confirmResource: (connectionId: string) => Promise<OnboardingState>;
  removeResource: (connectionId: string) => Promise<OnboardingState>;
  setPrimaryLms: (connectionId: string) => Promise<OnboardingState>;
  discoverContext: () => Promise<OnboardingState>;
  createCourseRecord: (input: CreateCourseRecordSchema) => Promise<string>;
  updateCourseRecord: (input: UpdateCourseRecordSchema) => Promise<void>;
  deleteCourseRecord: (input: CourseRecordSchema) => Promise<void>;
  listCourseRecordSuppressions: (
    input: ListCourseRecordSuppressionsSchema,
  ) => Promise<CourseRecordSuppressionView[] | null>;
  restoreCourseRecordSuppression: (
    input: RestoreCourseRecordSuppressionSchema,
  ) => Promise<void>;
  getCourses: () => Promise<CoursesSnapshot | null>;
  getCourse: (courseId: string) => Promise<CourseDetail | null>;
  refreshCourses: () => Promise<CoursesSnapshot>;
  refreshCourse: (courseId: string) => Promise<CourseDetail | null>;
  cancelCourseRefresh: (courseId?: string) => Promise<void>;
  pauseBackgroundSync: () => Promise<OnboardingState>;
  resumeBackgroundSync: () => Promise<OnboardingState>;
  onBackgroundSyncChange: (
    listener: (change: BackgroundSyncChange) => void,
  ) => () => void;
  startPreview: (prompt: PreviewPrompt) => Promise<void>;
  getPreview: (accountId: string) => Promise<PreviewState>;
  cancelPreview: (accountId?: string) => Promise<void>;
  onPreviewChange: (listener: (state: PreviewState) => void) => () => void;
  completeOnboarding: () => Promise<void>;
  signOut: () => Promise<void>;
  openSource: (url: string) => Promise<void>;
  stageWorkspaceReplacement: (
    input: WorkspaceReplacementInput,
  ) => Promise<DeviceReplacementDTO>;
  commitWorkspaceReplacement: (
    input: WorkspaceReplacementCommitInput,
  ) => Promise<DeviceReplacementDTO>;
  cancelWorkspaceReplacement: (
    input: WorkspaceReplacementCancelInput,
  ) => Promise<DeviceReplacementDTO>;
  deleteLocalAcademicData: (
    input: DeleteLocalAcademicDataInput,
  ) => Promise<void>;
  chooseContextFiles: (
    input: ContextFileSelectionInput,
  ) => Promise<ContextFileSelectionResult>;
  mountActivity: (input: MountActivityInput) => Promise<{ runId: string }>;
  updateActivityBounds: (input: UpdateActivityBoundsInput) => Promise<void>;
  closeActivity: (input: CloseActivityInput) => Promise<void>;
  retryActivityCheckpoint: (input: CloseActivityInput) => Promise<void>;
  onActivityChange: (
    runId: string,
    listener: (change: ActivityRuntimeChange) => void,
  ) => () => void;
  startDictation: (
    input: DictationStartInput,
  ) => Promise<{ operationId: string }>;
  appendDictationAudio: (
    input: DictationAudioChunk,
  ) => Promise<{ acceptedSequence: number }>;
  stopDictation: (input: { operationId: string }) => Promise<void>;
  cancelDictation: (input: { operationId: string }) => Promise<void>;
  requestMicrophonePermission: (input: { sessionId: string }) => Promise<{
    state: 'granted' | 'denied' | 'unsupported';
  }>;
  requestNotificationPermission: (input: Record<string, never>) => Promise<{
    state: 'granted' | 'denied' | 'unsupported' | 'unknown';
  }>;
};

declare global {
  interface Window {
    scholar: ScholarBridge;
  }
}
