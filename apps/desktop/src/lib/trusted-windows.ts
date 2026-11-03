import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

type TrustedWindowEntry = {
  window: BrowserWindow;
  expectedDocument: string;
  dispose: () => void;
};
type NavigationEvent = Electron.Event<{ isMainFrame: boolean; url: string }>;
type IpcSenderEvent = IpcMainEvent | IpcMainInvokeEvent;

const trustedWindows = new Map<number, TrustedWindowEntry>();

const canonicalDocument = (value: string) => {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
};

const matchesDocument = (value: string, expectedDocument: string) =>
  canonicalDocument(value) === expectedDocument;

const unregisterEntry = (id: number, entry: TrustedWindowEntry) => {
  entry.dispose();
  if (trustedWindows.get(id) === entry) trustedWindows.delete(id);
};

export const registerTrustedWindow = (
  window: BrowserWindow,
  expectedDocument: string,
) => {
  const canonicalExpectedDocument = canonicalDocument(expectedDocument);
  if (!canonicalExpectedDocument)
    throw new Error('Expected a valid application document URL.');

  const { webContents } = window;
  const id = webContents.id;
  const existing = trustedWindows.get(id);
  if (existing) unregisterEntry(id, existing);

  const onWillNavigate = (details: NavigationEvent) => {
    if (
      details.isMainFrame &&
      !matchesDocument(details.url, canonicalExpectedDocument)
    )
      details.preventDefault();
  };
  const onDestroyed = () => unregisterTrustedWindow(id);
  const entry: TrustedWindowEntry = {
    window,
    expectedDocument: canonicalExpectedDocument,
    dispose: () => {
      webContents.removeListener('will-frame-navigate', onWillNavigate);
      webContents.removeListener('will-redirect', onWillNavigate);
      webContents.removeListener('destroyed', onDestroyed);
      window.removeListener('closed', onDestroyed);
    },
  };

  trustedWindows.set(id, entry);
  webContents.on('will-frame-navigate', onWillNavigate);
  webContents.on('will-redirect', onWillNavigate);
  webContents.once('destroyed', onDestroyed);
  window.once('closed', onDestroyed);

  return () => unregisterTrustedWindow(id);
};

export const unregisterTrustedWindow = (id: number) => {
  const entry = trustedWindows.get(id);
  if (entry) unregisterEntry(id, entry);
};

export const getTrustedWindows = () =>
  [...trustedWindows.values()]
    .filter(({ window, expectedDocument }) => {
      const { webContents } = window;
      return (
        !window.isDestroyed() &&
        !webContents.isDestroyed() &&
        matchesDocument(webContents.getURL(), expectedDocument) &&
        matchesDocument(webContents.mainFrame.url, expectedDocument)
      );
    })
    .map(({ window }) => window);

export const getTrustedWindow = () => getTrustedWindows()[0] ?? null;

export const requireTrustedSender = (event: IpcSenderEvent) => {
  const entry = trustedWindows.get(event.sender.id);
  if (!entry) throw new Error('Untrusted application frame.');

  const { window, expectedDocument } = entry;
  try {
    if (
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      window.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame ||
      !matchesDocument(event.sender.getURL(), expectedDocument) ||
      !matchesDocument(event.senderFrame.url, expectedDocument)
    )
      throw new Error('Untrusted application frame.');
  } catch {
    throw new Error('Untrusted application frame.');
  }

  return window;
};
