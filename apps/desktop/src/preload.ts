import type { ConnectRunState } from './features/onboarding/services/connect-run';
import { setupRenderer } from '@better-auth/electron/preload';
import { contextBridge, ipcRenderer } from 'electron';
import type {
  BackgroundSyncChange,
  PreviewState,
  ScholarBridge,
} from './features/onboarding/types';

setupRenderer();
const bridge: ScholarBridge = {
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
  getCurrentUser: () => ipcRenderer.invoke('scholar:getCurrentUser'),
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
};
contextBridge.exposeInMainWorld('scholar', bridge);
