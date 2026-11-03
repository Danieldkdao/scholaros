import type { ConnectRunState } from './features/onboarding/services/connect-run';
import { dictationEventSchema } from '@scholaros/services/learning/speech-contracts';
import { productEventV1Schema } from '@scholaros/services/learning/product-contracts';
import { setupRenderer } from '@better-auth/electron/preload';
import { contextBridge, ipcRenderer } from 'electron';
import { academicReconnectSchema } from './services/academic/contracts';
import type {
  BackgroundSyncChange,
  PreviewState,
  ScholarBridge,
  WatchRuntimeChange,
} from './features/onboarding/types';

setupRenderer();
const bridge: ScholarBridge = {
  onProductEvent: (listener) => {
    const handler = (_event: unknown, value: unknown) => {
      const parsed = productEventV1Schema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on('scholar:productEvent', handler);
    return () => ipcRenderer.removeListener('scholar:productEvent', handler);
  },
  onAcademicReconnect: (listener) => {
    const handler = (_event: unknown, value: unknown) => {
      const parsed = academicReconnectSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on('scholar:academicReconnect', handler);
    return () =>
      ipcRenderer.removeListener('scholar:academicReconnect', handler);
  },
  onDictationEvent: (listener) => {
    const handler = (_event: unknown, value: unknown) => {
      const parsed = dictationEventSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on('scholar:native:dictationEvent', handler);
    return () =>
      ipcRenderer.removeListener('scholar:native:dictationEvent', handler);
  },
  listContextItems: (input) =>
    ipcRenderer.invoke('scholar:listContextItems', input),
  getContextItem: (input) =>
    ipcRenderer.invoke('scholar:getContextItem', input),
  createContextNote: (input) =>
    ipcRenderer.invoke('scholar:createContextNote', input),
  updateContextItem: (input) =>
    ipcRenderer.invoke('scholar:updateContextItem', input),
  linkContextItem: (input) =>
    ipcRenderer.invoke('scholar:linkContextItem', input),
  removeContextItem: (input) =>
    ipcRenderer.invoke('scholar:removeContextItem', input),
  retryContextIngestion: (input) =>
    ipcRenderer.invoke('scholar:retryContextIngestion', input),
  cancelContextIngestion: (input) =>
    ipcRenderer.invoke('scholar:cancelContextIngestion', input),
  readContextPreview: (input) =>
    ipcRenderer.invoke('scholar:readContextPreview', input),
  getGradeSettings: () => ipcRenderer.invoke('scholar:getGradeSettings', {}),
  saveGradeSettings: (input) =>
    ipcRenderer.invoke('scholar:saveGradeSettings', input),
  verifyCoursework: (input) =>
    ipcRenderer.invoke('scholar:verifyCoursework', input),
  getVerifiedCourseworkEvidence: (input) =>
    ipcRenderer.invoke('scholar:getVerifiedCourseworkEvidence', input),
  createStudySession: (input) =>
    ipcRenderer.invoke('scholar:createStudySession', input),
  listStudySessions: (input) =>
    ipcRenderer.invoke('scholar:listStudySessions', input),
  getStudySession: (input) =>
    ipcRenderer.invoke('scholar:getStudySession', input),
  renameStudySession: (input) =>
    ipcRenderer.invoke('scholar:renameStudySession', input),
  saveStudyDraft: (input) =>
    ipcRenderer.invoke('scholar:saveStudyDraft', input),
  deleteStudySession: (input) =>
    ipcRenderer.invoke('scholar:deleteStudySession', input),
  reconcileStudyDeadline: (input) =>
    ipcRenderer.invoke('scholar:reconcileStudyDeadline', input),
  finishStudySession: (input) =>
    ipcRenderer.invoke('scholar:finishStudySession', input),
  extendStudySession: (input) =>
    ipcRenderer.invoke('scholar:extendStudySession', input),
  continueStudyUntimed: (input) =>
    ipcRenderer.invoke('scholar:continueStudyUntimed', input),
  sendStudyTurn: (input) => ipcRenderer.invoke('scholar:sendStudyTurn', input),
  retryStudyTurn: (input) =>
    ipcRenderer.invoke('scholar:retryStudyTurn', input),
  cancelStudyTurn: (input) =>
    ipcRenderer.invoke('scholar:cancelStudyTurn', input),
  getArtifactVersion: (input) =>
    ipcRenderer.invoke('scholar:getArtifactVersion', input),
  getArtifactState: (input) =>
    ipcRenderer.invoke('scholar:getArtifactState', input),
  resetArtifactAttempt: (input) =>
    ipcRenderer.invoke('scholar:resetArtifactAttempt', input),
  saveArtifactToContext: (input) =>
    ipcRenderer.invoke('scholar:saveArtifactToContext', input),
  getPracticeAttempt: (input) =>
    ipcRenderer.invoke('scholar:getPracticeAttempt', input),
  savePracticeAnswer: (input) =>
    ipcRenderer.invoke('scholar:savePracticeAnswer', input),
  submitPracticeAttempt: (input) =>
    ipcRenderer.invoke('scholar:submitPracticeAttempt', input),
  switchPracticeToGuided: (input) =>
    ipcRenderer.invoke('scholar:switchPracticeToGuided', input),
  retryPracticeAttempt: (input) =>
    ipcRenderer.invoke('scholar:retryPracticeAttempt', input),
  listMemories: (input) => ipcRenderer.invoke('scholar:listMemories', input),
  upsertExplicitPreference: (input) =>
    ipcRenderer.invoke('scholar:upsertExplicitPreference', input),
  correctMemory: (input) => ipcRenderer.invoke('scholar:correctMemory', input),
  deleteMemory: (input) => ipcRenderer.invoke('scholar:deleteMemory', input),
  getLearningProgress: (input) =>
    ipcRenderer.invoke('scholar:getLearningProgress', input),
  getTodayOverview: (input) =>
    ipcRenderer.invoke('scholar:getTodayOverview', input),
  getStudyRecommendations: (input) =>
    ipcRenderer.invoke('scholar:getStudyRecommendations', input),
  getNotificationSettings: () =>
    ipcRenderer.invoke('scholar:getNotificationSettings', {}),
  saveNotificationSettings: (input) =>
    ipcRenderer.invoke('scholar:saveNotificationSettings', input),
  getCurrentUser: () => ipcRenderer.invoke('scholar:getCurrentUser'),
  onCoursesChange: (listener) => {
    const handler = (
      _event: unknown,
      change: { accountId: string; courseId: string | null },
    ) => listener(change);
    ipcRenderer.on('scholar:coursesChange', handler);
    return () => {
      ipcRenderer.removeListener('scholar:coursesChange', handler);
    };
  },
  resolveConnections: (prompt) =>
    ipcRenderer.invoke('scholar:resolveConnections', prompt),
  reviseConnectionProposal: (proposal) =>
    ipcRenderer.invoke('scholar:reviseConnectionProposal', proposal),
  approveConnectionProposal: (proposal) =>
    ipcRenderer.invoke('scholar:approveConnectionProposal', proposal),
  startConnectRun: (id) => ipcRenderer.invoke('scholar:startConnectRun', id),
  getConnectRun: () => ipcRenderer.invoke('scholar:getConnectRun'),
  resumeConnectRun: () => ipcRenderer.invoke('scholar:resumeConnectRun'),
  cancelConnectRun: () => ipcRenderer.invoke('scholar:cancelConnectRun'),
  onConnectChange: (listener) => {
    const handler = (_event: unknown, state: ConnectRunState) =>
      listener(state);
    ipcRenderer.on('scholar:connectChange', handler);
    return () => ipcRenderer.removeListener('scholar:connectChange', handler);
  },
  getState: () => ipcRenderer.invoke('scholar:getState'),
  getWatchSettings: () => ipcRenderer.invoke('scholar:getWatchSettings'),
  saveWatchSettings: (settings) =>
    ipcRenderer.invoke('scholar:saveWatchSettings', settings),
  getWatchRuntimeState: () =>
    ipcRenderer.invoke('scholar:getWatchRuntimeState'),
  onWatchChange: (listener) => {
    const handler = (_event: unknown, change: WatchRuntimeChange) =>
      listener(change);
    ipcRenderer.on('scholar:watchChange', handler);
    return () => ipcRenderer.removeListener('scholar:watchChange', handler);
  },
  saveSettings: (changes) =>
    ipcRenderer.invoke('scholar:saveSettings', changes),
  findBrowsers: () => ipcRenderer.invoke('scholar:findBrowsers'),
  chooseBrowser: () => ipcRenderer.invoke('scholar:chooseBrowser'),
  createWorkspace: (id) => ipcRenderer.invoke('scholar:createWorkspace', id),
  openResource: (id) => ipcRenderer.invoke('scholar:openResource', id),
  captureResource: () => ipcRenderer.invoke('scholar:captureResource'),
  previewResource: () => ipcRenderer.invoke('scholar:previewResource'),
  saveConnectionNotes: (id, notes) =>
    ipcRenderer.invoke('scholar:saveConnectionNotes', { id, notes }),
  setCourseResource: (id, isCourseResource) =>
    ipcRenderer.invoke('scholar:setCourseResource', { id, isCourseResource }),
  confirmResource: (id) => ipcRenderer.invoke('scholar:confirmResource', id),
  removeResource: (id) => ipcRenderer.invoke('scholar:removeResource', id),
  setPrimaryLms: (id) => ipcRenderer.invoke('scholar:setPrimaryLms', id),
  discoverContext: () => ipcRenderer.invoke('scholar:discoverContext'),
  createCourseRecord: (input) =>
    ipcRenderer.invoke('scholar:createCourseRecord', input),
  updateCourseRecord: (input) =>
    ipcRenderer.invoke('scholar:updateCourseRecord', input),
  deleteCourseRecord: (input) =>
    ipcRenderer.invoke('scholar:deleteCourseRecord', input),
  getCourses: () => ipcRenderer.invoke('scholar:getCourses'),
  getCourse: (courseId) => ipcRenderer.invoke('scholar:getCourse', courseId),
  refreshCourses: () => ipcRenderer.invoke('scholar:refreshCourses'),
  refreshCourse: (courseId) =>
    ipcRenderer.invoke('scholar:refreshCourse', courseId),
  cancelCourseRefresh: (courseId) =>
    ipcRenderer.invoke('scholar:cancelCourseRefresh', courseId),
  pauseBackgroundSync: () => ipcRenderer.invoke('scholar:pauseBackgroundSync'),
  resumeBackgroundSync: () =>
    ipcRenderer.invoke('scholar:resumeBackgroundSync'),
  onBackgroundSyncChange: (listener) => {
    const handler = (_event: unknown, change: BackgroundSyncChange) =>
      listener(change);
    ipcRenderer.on('scholar:backgroundSyncChange', handler);
    return () => {
      ipcRenderer.removeListener('scholar:backgroundSyncChange', handler);
    };
  },
  startPreview: (prompt) => ipcRenderer.invoke('scholar:startPreview', prompt),
  getPreview: (accountId) =>
    ipcRenderer.invoke('scholar:getPreview', accountId),
  cancelPreview: (accountId) =>
    ipcRenderer.invoke('scholar:cancelPreview', accountId),
  onPreviewChange: (listener) => {
    const handler = (_event: unknown, state: PreviewState) => listener(state);
    ipcRenderer.on('scholar:previewChange', handler);
    return () => {
      ipcRenderer.removeListener('scholar:previewChange', handler);
    };
  },
  completeOnboarding: () => ipcRenderer.invoke('scholar:completeOnboarding'),
  signOut: () => ipcRenderer.invoke('scholar:signOut'),
  openSource: (url) => ipcRenderer.invoke('scholar:openSource', url),
  stageWorkspaceReplacement: (input) =>
    ipcRenderer.invoke('scholar:stageWorkspaceReplacement', input),
  commitWorkspaceReplacement: (input) =>
    ipcRenderer.invoke('scholar:commitWorkspaceReplacement', input),
  cancelWorkspaceReplacement: (input) =>
    ipcRenderer.invoke('scholar:cancelWorkspaceReplacement', input),
  deleteLocalAcademicData: (input) =>
    ipcRenderer.invoke('scholar:deleteLocalAcademicData', input),
  chooseContextFiles: (input) =>
    ipcRenderer.invoke('scholar:native:chooseContextFiles', input),
  mountActivity: (input) =>
    ipcRenderer.invoke('scholar:native:mountActivity', input),
  updateActivityBounds: (input) =>
    ipcRenderer.invoke('scholar:native:updateActivityBounds', input),
  closeActivity: (input) =>
    ipcRenderer.invoke('scholar:native:closeActivity', input),
  startDictation: (input) =>
    ipcRenderer.invoke('scholar:native:startDictation', input),
  appendDictationAudio: (input) =>
    ipcRenderer.invoke('scholar:native:appendDictationAudio', input),
  stopDictation: (input) =>
    ipcRenderer.invoke('scholar:native:stopDictation', input),
  cancelDictation: (input) =>
    ipcRenderer.invoke('scholar:native:cancelDictation', input),
  requestMicrophonePermission: (input) =>
    ipcRenderer.invoke('scholar:native:requestMicrophonePermission', input),
  requestNotificationPermission: (input) =>
    ipcRenderer.invoke('scholar:native:requestNotificationPermission', input),
};
contextBridge.exposeInMainWorld('scholar', bridge);
