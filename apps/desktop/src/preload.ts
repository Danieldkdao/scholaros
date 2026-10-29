import { setupRenderer } from '@better-auth/electron/preload';
import { contextBridge, ipcRenderer } from 'electron';
import type {
  BackgroundSyncChange,
  PreviewState,
  ScholarBridge,
} from './features/onboarding/types';

setupRenderer();
const bridge: ScholarBridge = {
  getCurrentUser: () => ipcRenderer.invoke('scholar:getCurrentUser'),
  getState: () => ipcRenderer.invoke('scholar:getState'),
  saveSettings: (changes) =>
    ipcRenderer.invoke('scholar:saveSettings', changes),
  findBrowsers: () => ipcRenderer.invoke('scholar:findBrowsers'),
  chooseBrowser: () => ipcRenderer.invoke('scholar:chooseBrowser'),
  createWorkspace: (id) => ipcRenderer.invoke('scholar:createWorkspace', id),
  openResource: (id) => ipcRenderer.invoke('scholar:openResource', id),
  captureResource: () => ipcRenderer.invoke('scholar:captureResource'),
  confirmResource: (id) => ipcRenderer.invoke('scholar:confirmResource', id),
  removeResource: (id) => ipcRenderer.invoke('scholar:removeResource', id),
  setPrimaryLms: (id) => ipcRenderer.invoke('scholar:setPrimaryLms', id),
  discoverContext: () => ipcRenderer.invoke('scholar:discoverContext'),
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
