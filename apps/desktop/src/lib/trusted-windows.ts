import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from 'electron';

type TrustedWindowEntry = {
  window: BrowserWindow;
  webContents: WebContents;
  expectedDocument: string;
  mainFrame: WebFrameMain | null;
  pendingFrame: WebFrameMain | null;
  navigationPending: boolean;
  dispose: () => void;
};
type FrameNavigationEvent = Electron.Event<{
  isMainFrame: boolean;
  url: string;
}>;
type NavigationStartedEvent =
  Electron.Event<Electron.WebContentsDidStartNavigationEventParams>;
type RedirectNavigationEvent = Electron.Event<{
  isMainFrame: boolean;
  url: string;
}>;
type MainNavigationEvent = Electron.Event<{ url: string }>;
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

const matchesTrustedEntry = (entry: TrustedWindowEntry) => {
  const { window, webContents, expectedDocument, mainFrame } = entry;
  return (
    !entry.navigationPending &&
    mainFrame !== null &&
    !window.isDestroyed() &&
    !webContents.isDestroyed() &&
    window.webContents === webContents &&
    webContents.mainFrame === mainFrame &&
    matchesDocument(webContents.getURL(), expectedDocument) &&
    matchesDocument(mainFrame.url, expectedDocument)
  );
};

export const isTrustedWebContents = (webContents: WebContents) => {
  const entry = trustedWindows.get(webContents.id);
  try {
    return (
      !!entry && entry.webContents === webContents && matchesTrustedEntry(entry)
    );
  } catch {
    return false;
  }
};

export const installTrustedFocusedWebContentsGuard = (api: {
  getFocusedWebContents: () => WebContents | null;
}) => {
  const original = api.getFocusedWebContents;
  const getFocusedWebContents = original.bind(api);
  const guarded = () => {
    const focused = getFocusedWebContents();
    return focused && isTrustedWebContents(focused) ? focused : null;
  };

  api.getFocusedWebContents = guarded;
  return () => {
    if (api.getFocusedWebContents === guarded)
      api.getFocusedWebContents = original;
  };
};

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

  const webContents = window.webContents;
  if (window.isDestroyed() || webContents.isDestroyed())
    throw new Error('Cannot register a destroyed application window.');

  const id = webContents.id;
  const existing = trustedWindows.get(id);
  if (existing) unregisterEntry(id, existing);

  const currentFrame = webContents.mainFrame;
  const entry: TrustedWindowEntry = {
    window,
    webContents,
    expectedDocument: canonicalExpectedDocument,
    mainFrame:
      matchesDocument(webContents.getURL(), canonicalExpectedDocument) &&
      matchesDocument(currentFrame.url, canonicalExpectedDocument)
        ? currentFrame
        : null,
    pendingFrame: null,
    navigationPending: false,
    dispose: () => undefined,
  };
  let disposed = false;

  const restorePendingFrame = () => {
    const frame = entry.pendingFrame;
    if (!frame) return;
    try {
      if (
        webContents.isDestroyed() ||
        webContents.mainFrame !== frame ||
        !matchesDocument(webContents.getURL(), canonicalExpectedDocument) ||
        !matchesDocument(frame.url, canonicalExpectedDocument)
      )
        return;
      entry.mainFrame = frame;
      entry.pendingFrame = null;
      entry.navigationPending = false;
    } catch {
      return;
    }
  };
  const onWillFrameNavigate = (details: FrameNavigationEvent) => {
    if (
      details.isMainFrame &&
      !matchesDocument(details.url, canonicalExpectedDocument)
    ) {
      details.preventDefault();
      restorePendingFrame();
    }
  };
  const onWillNavigate = (details: MainNavigationEvent) => {
    if (!matchesDocument(details.url, canonicalExpectedDocument)) {
      details.preventDefault();
      restorePendingFrame();
    }
  };
  const onWillRedirect = (details: RedirectNavigationEvent) => {
    if (
      details.isMainFrame &&
      !matchesDocument(details.url, canonicalExpectedDocument)
    ) {
      details.preventDefault();
      restorePendingFrame();
    }
  };
  const onDidStartNavigation = (details: NavigationStartedEvent) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    entry.pendingFrame ??= entry.mainFrame;
    entry.mainFrame = null;
    entry.navigationPending = true;
  };
  const onDidNavigate = (_event: Electron.Event, url: string) => {
    try {
      const currentFrame = webContents.mainFrame;
      if (
        !matchesDocument(url, canonicalExpectedDocument) ||
        !matchesDocument(webContents.getURL(), canonicalExpectedDocument) ||
        !matchesDocument(currentFrame.url, canonicalExpectedDocument)
      ) {
        unregisterEntry(id, entry);
        return;
      }
      entry.mainFrame = currentFrame;
      entry.pendingFrame = null;
      entry.navigationPending = false;
    } catch {
      unregisterEntry(id, entry);
    }
  };
  const onDidFailLoad = (
    _event: Electron.Event,
    _errorCode: number,
    _errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) restorePendingFrame();
  };
  const onDestroyed = () => unregisterEntry(id, entry);

  entry.dispose = () => {
    if (disposed) return;
    disposed = true;
    webContents.removeListener('will-frame-navigate', onWillFrameNavigate);
    webContents.removeListener('will-navigate', onWillNavigate);
    webContents.removeListener('will-redirect', onWillRedirect);
    webContents.removeListener('did-start-navigation', onDidStartNavigation);
    webContents.removeListener('did-navigate', onDidNavigate);
    webContents.removeListener('did-fail-load', onDidFailLoad);
    webContents.removeListener('destroyed', onDestroyed);
    window.removeListener('closed', onDestroyed);
  };

  trustedWindows.set(id, entry);
  webContents.on('will-frame-navigate', onWillFrameNavigate);
  webContents.on('will-navigate', onWillNavigate);
  webContents.on('will-redirect', onWillRedirect);
  webContents.on('did-start-navigation', onDidStartNavigation);
  webContents.on('did-navigate', onDidNavigate);
  webContents.on('did-fail-load', onDidFailLoad);
  webContents.once('destroyed', onDestroyed);
  window.once('closed', onDestroyed);

  return () => unregisterEntry(id, entry);
};

export const unregisterTrustedWindow = (id: number) => {
  const entry = trustedWindows.get(id);
  if (entry) unregisterEntry(id, entry);
};

const isDestroyed = (entry: TrustedWindowEntry) => {
  try {
    return entry.window.isDestroyed() || entry.webContents.isDestroyed();
  } catch {
    return true;
  }
};

const hasUnexpectedCommittedDocument = (entry: TrustedWindowEntry) => {
  if (entry.navigationPending || entry.mainFrame === null) return false;
  try {
    return (
      entry.webContents.mainFrame !== entry.mainFrame ||
      !matchesDocument(entry.webContents.getURL(), entry.expectedDocument) ||
      !matchesDocument(entry.mainFrame.url, entry.expectedDocument)
    );
  } catch {
    return true;
  }
};

export const getTrustedWindows = () => {
  const windows: BrowserWindow[] = [];
  for (const [id, entry] of trustedWindows) {
    if (isDestroyed(entry) || hasUnexpectedCommittedDocument(entry)) {
      unregisterEntry(id, entry);
      continue;
    }
    if (isTrustedWebContents(entry.webContents)) windows.push(entry.window);
  }
  return windows;
};

export const getTrustedWindow = () => getTrustedWindows()[0] ?? null;

export const requireTrustedSender = (event: IpcSenderEvent) => {
  const entry = trustedWindows.get(event.sender.id);
  if (!entry) throw new Error('Untrusted application frame.');

  try {
    if (
      entry.webContents !== event.sender ||
      event.senderFrame !== entry.mainFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !matchesTrustedEntry(entry)
    )
      throw new Error('Untrusted application frame.');
  } catch {
    throw new Error('Untrusted application frame.');
  }

  return entry.window;
};
