import type { ConnectRunState } from './services/connect-run';
import type { ConnectionCandidateSchema } from '@scholaros/services/ai/schemas';
import type { CourseDetail, CoursesSnapshot } from '../courses/types';
import type { OnboardingStep, PreviewCardKind, PreviewPrompt } from './schemas';

export type { OnboardingStep, PreviewCardKind, PreviewPrompt };

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  hasCompletedOnboarding: boolean;
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
};
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
export type EvidencePage = { url: string; title: string; text: string };
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
export type ScholarBridge = {
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
  getCourses: () => Promise<CoursesSnapshot>;
  getCourse: (courseId: string) => Promise<CourseDetail | null>;
  refreshCourses: () => Promise<CoursesSnapshot>;
  cancelCourseRefresh: () => Promise<void>;
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
};

declare global {
  interface Window {
    scholar: ScholarBridge;
  }
}
