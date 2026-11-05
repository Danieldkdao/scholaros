import { app, session, WebContentsView } from 'electron';
import type { BrowserWindow, Session, WebContents } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  activityConnectionAllowlistHeader,
  buildActivityDocument,
  createActivityContentDigest,
  type ActivityBundle,
} from './activity-policy';
import {
  activityMessageLimits,
  createActivityMailbox,
  decodeActivityMessage,
  isBoundedJsonValue,
  type ActivityMailbox,
  type ActivityMailboxBinding,
} from './activity-mailbox';
import {
  isActivitySchemeRegistered,
  registerActivitySchemeBeforeReady,
} from './activity-protocol';

export { createActivityContentDigest, registerActivitySchemeBeforeReady };

type ActivityTheme = {
  background?: string;
  foreground?: string;
  muted?: string;
  mutedForeground?: string;
  primary?: string;
  accent?: string;
  border?: string;
  colorScheme?: 'light' | 'dark';
};

const activityThemeProperties = [
  ['background', 'background'],
  ['foreground', 'foreground'],
  ['muted', 'muted'],
  ['mutedForeground', 'muted-foreground'],
  ['primary', 'primary'],
  ['accent', 'accent'],
  ['border', 'border'],
] as const;

export const readActivityTheme = async (
  host: WebContents,
): Promise<ActivityTheme> => {
  try {
    const value: unknown = await withTimeout(
      host.executeJavaScript(`(() => {
      const style = getComputedStyle(document.documentElement);
      const color = (token) => style.getPropertyValue('--' + token).trim();
      return {
        background: color('background'), foreground: color('foreground'),
        muted: color('muted'), mutedForeground: color('muted-foreground'),
        primary: color('primary'), accent: color('accent'), border: color('border'),
        colorScheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      };
    })()`),
      1000,
    );
    if (!value || typeof value !== 'object') return {};
    const source = value as Record<string, unknown>;
    const theme: ActivityTheme = {};
    for (const [key] of activityThemeProperties) {
      const color = source[key];
      if (
        typeof color === 'string' &&
        color.length <= 100 &&
        /^(?:#[a-f\d]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([a-z\d .,/%+-]+\))$/i.test(
          color,
        )
      )
        theme[key] = color;
    }
    if (source.colorScheme === 'light' || source.colorScheme === 'dark')
      theme.colorScheme = source.colorScheme;
    return theme;
  } catch {
    return {};
  }
};

export const createActivityThemeCss = (theme: ActivityTheme) => {
  const properties = activityThemeProperties.flatMap(([key, token]) =>
    theme[key] ? [`--${token}:${theme[key]}`] : [],
  );
  if (theme.colorScheme) properties.push(`color-scheme:${theme.colorScheme}`);
  const surface = [
    'font-family:ui-sans-serif,system-ui,sans-serif',
    theme.background ? 'background:var(--background)!important' : '',
    theme.foreground ? 'color:var(--foreground)!important' : '',
  ]
    .filter(Boolean)
    .join(';');
  const mutedText = theme.mutedForeground
    ? '.muted{color:var(--muted-foreground)!important}'
    : '';
  return `:root{${properties.join(';')}}html,body,#activity-root{${surface}}${mutedText}`;
};

export type ActivityMountInput = {
  hostWindow: BrowserWindow;
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  readOnly: boolean;
  bounds: ActivityBounds;
};

export type ActivityBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AuthorizedActivityRun = ActivityBundle & {
  runtimeVersion: 'activity-runtime-v1';
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  runId: string;
  contentDigest: string;
  runtimeDigest: string;
  initialState: unknown;
  stateRevision: number;
};

export type ActivityAuthorizationRequest = {
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  requestId: string;
};

export type ActivityStateProposal = {
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  runId: string;
  sequence: number;
  baseStateRevision: number;
  state: unknown;
};

export type ActivityRunRelease = {
  runId?: string;
  requestId: string;
};

type ActivityRuntimeDiagnostics = {
  runId: string;
  webContentsId: number;
  activityProcessId: number;
  trustedProcessIds: number[];
  contentDigest: string;
  guardCounters: Readonly<ActivityGuardCounters>;
};

type ActivityGuardCounters = {
  blockedRequests: number;
  blockedProtocolRequests: number;
  blockedNavigations: number;
  deniedPopups: number;
  cancelledDownloads: number;
  deniedPermissions: number;
  fileChooserEvents: number;
  connectionPolicyHeaderVerified: boolean;
};

export type ActivityManagerDependencies = {
  authorizeRun: (
    request: ActivityAuthorizationRequest,
  ) => Promise<AuthorizedActivityRun | null>;
  persistState: (
    proposal: ActivityStateProposal,
  ) => Promise<{ revision: number }>;
  releaseRun: (input: ActivityRunRelease) => Promise<void>;
  requireTrustedSender: (sender: WebContents) => boolean;
  getTrustedRenderers: () => readonly WebContents[];
  onDiagnostics?: (diagnostics: ActivityRuntimeDiagnostics) => void;
  onRuntimeReady?: (runId: string) => void;
  onStateAcknowledged?: (runId: string, revision: number) => void;
  onClosed?: (result: { runId: string; reason: string }) => void;
  onStateFailure?: (runId: string) => void;
  onInteraction?: (input: {
    runId: string;
    action: string;
    value: unknown;
  }) => Promise<void> | void;
};

export type ActivityManager = {
  mount: (input: ActivityMountInput) => Promise<{ runId: string }>;
  updateBounds: (
    runId: string,
    bounds: ActivityBounds,
    visible: boolean,
  ) => void;
  hide: (runId: string) => void;
  retryCheckpoint: (input: { runId: string }) => Promise<void>;
  close: (runId: string) => Promise<void>;
  dispose: () => Promise<void>;
};

type RuntimeInstance = {
  run: AuthorizedActivityRun;
  binding: ActivityMailboxBinding;
  session: Session;
  view: WebContentsView;
  hostWindow: BrowserWindow;
  url: string;
  origin: string;
  mailbox: ActivityMailbox;
  counters: ActivityGuardCounters;
  cleanups: Array<() => void>;
  closed: boolean;
  closing: boolean;
  closePromise: Promise<void> | null;
  releasePromise: Promise<void> | null;
  initialized: boolean;
  pollInFlight: boolean;
  checkpointInFlight: Promise<'acknowledged' | 'failed' | 'close'> | null;
  checkpointRetryPromise: Promise<void> | null;
  lastFailedProposal: ActivityStateProposal | null;
  authorizationRequestId: string;
  hostSequence: number;
  consecutivePollFailures: number;
  cpuOverLimitSamples: number;
  bootstrapTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  metricsTimer: NodeJS.Timeout | null;
  debuggerAttached: boolean;
  initialBounds: ActivityBounds;
  activityProcessId: number;
};

const activityWorldId = 1001;
const activityPartitionPrefix = 'scholar-activity-';
const activityScheme = 'scholar-activity';
const bootstrapTimeoutMs = 5000;
const mailboxPollIntervalMs = 250;
const mailboxPollTimeoutMs = 450;
const mailboxFailureLimit = 5;
const maximumActivityCpuPercent = 80;
const maximumActivityWorkingSetKilobytes = 256 * 1024;
const activityBundleBytes = 512 * 1024;

type ActivityResourceMetric = {
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
};

export const isActivityResourceLimitExceeded = (
  metric: ActivityResourceMetric,
  cpuOverLimitSamples: number,
) =>
  metric.memory.workingSetSize > maximumActivityWorkingSetKilobytes ||
  cpuOverLimitSamples >= 5;

export const canForcefullyTerminateActivityRenderer = (
  activityProcessId: number,
  trustedProcessIds: readonly number[],
) => activityProcessId > 0 && !trustedProcessIds.includes(activityProcessId);

export const createActivityWebPreferences = (activitySession: Session) => ({
  session: activitySession,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  plugins: false,
  experimentalFeatures: false,
  webgl: false,
  enableWebSQL: false,
  disableDialogs: true,
  disableWakeLocks: true,
  navigateOnDragDrop: false,
  backgroundThrottling: true,
  devTools: false,
  spellcheck: false,
  v8CacheOptions: 'none' as const,
});

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Activity runtime operation timed out.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const validateAuthorizedRun = (
  request: ActivityAuthorizationRequest,
  run: AuthorizedActivityRun,
) => {
  const invalidFields: string[] = [];
  if (run.runtimeVersion !== 'activity-runtime-v1')
    invalidFields.push('runtime-version');
  if (run.sessionId !== request.sessionId) invalidFields.push('session');
  if (run.artifactId !== request.artifactId) invalidFields.push('artifact');
  if (run.versionId !== request.versionId) invalidFields.push('version');
  if (run.attemptId !== request.attemptId) invalidFields.push('attempt');
  if (
    typeof run.runId !== 'string' ||
    run.runId.length === 0 ||
    run.runId.length > 300
  )
    invalidFields.push('run');
  if (!/^[a-f0-9]{64}$/.test(run.contentDigest))
    invalidFields.push('artifact-digest-format');
  if (!/^[a-f0-9]{64}$/.test(run.runtimeDigest))
    invalidFields.push('runtime-digest-format');
  if (
    run.runtimeDigest !==
    createActivityContentDigest({
      html: run.html,
      css: run.css,
      sdk: run.sdk,
      javascript: run.javascript,
    })
  )
    invalidFields.push('runtime-digest-mismatch');
  if (!Number.isSafeInteger(run.stateRevision) || run.stateRevision < 0)
    invalidFields.push('state-revision');
  if (!isBoundedJsonValue(run.initialState, activityMessageLimits.stateBytes))
    invalidFields.push('initial-state');

  const bundleBytes = Buffer.byteLength(
    JSON.stringify({
      html: run.html,
      css: run.css,
      sdk: run.sdk,
      javascript: run.javascript,
    }),
    'utf8',
  );
  if (bundleBytes > activityBundleBytes) invalidFields.push('content-limit');
  if (invalidFields.length > 0)
    throw new Error(
      `The authorized activity failed validation: ${invalidFields.join(',')}.`,
    );
};

const boundedBounds = (bounds: ActivityBounds, window: BrowserWindow) => {
  const [contentWidth, contentHeight] = window.getContentSize();
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every((value) => Number.isFinite(value)))
    throw new Error('Activity bounds must be finite numbers.');

  const x = Math.min(contentWidth, Math.max(0, Math.trunc(bounds.x)));
  const y = Math.min(contentHeight, Math.max(0, Math.trunc(bounds.y)));
  const width = Math.max(
    0,
    Math.min(Math.trunc(bounds.width), contentWidth - x),
  );
  const height = Math.max(
    0,
    Math.min(Math.trunc(bounds.height), contentHeight - y),
  );
  return { x, y, width, height };
};

const isolatedWorldMailboxSource = (
  binding: ActivityMailboxBinding,
  wrapperOrigin: string,
) => `(() => {
  const binding = ${JSON.stringify(binding)};
  const wrapperOrigin = ${JSON.stringify(wrapperOrigin)};
  if (globalThis.__scholarActivityMailbox) return true;
  const queue = [];
  let queueBytes = 0;
  let overflow = false;
  const maximumEntries = ${activityMessageLimits.queueEntries};
  const maximumBytes = ${activityMessageLimits.queueBytes};
  const maximumMessageBytes = ${activityMessageLimits.stateEnvelopeBytes};
  const maximumHostMessageBytes = 700000;
  const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;
  const listener = (event) => {
    if (event.source !== window || (event.origin !== 'null' && event.origin !== wrapperOrigin) || typeof event.data !== 'string') return;
    const bytes = utf8Bytes(event.data);
    if (bytes > maximumHostMessageBytes) { overflow = true; return; }
    let message;
    try { message = JSON.parse(event.data); } catch { overflow = true; return; }
    if (message.source === 'scholar-host') return;
    if (bytes > maximumMessageBytes || queue.length >= maximumEntries || queueBytes + bytes > maximumBytes) {
      overflow = true;
      return;
    }
    if (message.source !== 'activity' || message.protocolVersion !== 1 || message.runtimeVersion !== binding.runtimeVersion || message.sessionId !== binding.sessionId || message.artifactId !== binding.artifactId || message.contentVersionId !== binding.contentVersionId || message.attemptId !== binding.attemptId || message.runId !== binding.runId) {
      overflow = true;
      return;
    }
    queue.push({ value: event.data, bytes });
    queueBytes += bytes;
  };
  window.addEventListener('message', listener, true);
  globalThis.__scholarActivityMailbox = Object.freeze({
    readNext: () => {
      if (overflow) return JSON.stringify({ mailboxOverflow: true });
      const entry = queue.shift();
      if (!entry) return null;
      queueBytes -= entry.bytes;
      return entry.value;
    },
    send: (serializedMessage) => window.postMessage(serializedMessage, '*'),
    dispose: () => {
      window.removeEventListener('message', listener, true);
      queue.length = 0;
      queueBytes = 0;
      delete globalThis.__scholarActivityMailbox;
    },
  });
  return true;
})();`;

const registerActivitySessionGuards = (
  activitySession: Session,
  url: string,
  counters: ActivityGuardCounters,
  cleanups: Array<() => void>,
) => {
  activitySession.webRequest.onBeforeRequest((details, callback) => {
    const allowedBootstrap =
      details.url === url &&
      details.method === 'GET' &&
      details.resourceType === 'mainFrame';
    if (allowedBootstrap) {
      callback({ cancel: false });
      return;
    }
    counters.blockedRequests += 1;
    callback({ cancel: true });
  });
  cleanups.push(() => activitySession.webRequest.onBeforeRequest(null));

  activitySession.webRequest.onHeadersReceived((details, callback) => {
    const connectionAllowlist = Object.entries(
      details.responseHeaders ?? {},
    ).find(([name]) => name.toLowerCase() === 'connection-allowlist')?.[1];
    const verified =
      details.url === url &&
      details.resourceType === 'mainFrame' &&
      connectionAllowlist?.length === 1 &&
      connectionAllowlist[0] === activityConnectionAllowlistHeader;
    if (verified) counters.connectionPolicyHeaderVerified = true;
    callback({ cancel: !verified });
  });
  cleanups.push(() => activitySession.webRequest.onHeadersReceived(null));

  const onDownload = (event: Electron.Event) => {
    counters.cancelledDownloads += 1;
    event.preventDefault();
  };
  activitySession.on('will-download', onDownload);
  cleanups.push(() =>
    activitySession.removeListener('will-download', onDownload),
  );

  activitySession.setPermissionCheckHandler(() => {
    counters.deniedPermissions += 1;
    return false;
  });
  activitySession.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      counters.deniedPermissions += 1;
      callback(false);
    },
  );
  activitySession.setDevicePermissionHandler(() => {
    counters.deniedPermissions += 1;
    return false;
  });
  activitySession.setDisplayMediaRequestHandler((_request, callback) => {
    counters.deniedPermissions += 1;
    callback(null);
  });
};

const registerPageGuards = (
  instance: RuntimeInstance,
  closeInstance: (reason: string) => Promise<void>,
) => {
  const { view, counters } = instance;
  const contents = view.webContents;
  const addCleanup = (cleanup: () => void) => instance.cleanups.push(cleanup);

  const onWindowOpen = () => {
    counters.deniedPopups += 1;
    return { action: 'deny' as const };
  };
  contents.setWindowOpenHandler(onWindowOpen);

  const onFailedMainFrameNavigation = (
    _event: Electron.Event,
    _errorCode: number,
    _errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean,
  ) => {
    if (
      !isMainFrame ||
      (validatedUrl === instance.url && !instance.initialized) ||
      instance.closed ||
      instance.closing
    )
      return;
    counters.blockedNavigations += 1;
    void closeInstance('blocked-navigation');
  };
  contents.on('did-fail-load', onFailedMainFrameNavigation);
  addCleanup(() =>
    contents.removeListener('did-fail-load', onFailedMainFrameNavigation),
  );

  const blockNavigation = (event: Electron.Event) => {
    event.preventDefault();
    counters.blockedNavigations += 1;
    void closeInstance('blocked-navigation');
  };
  contents.on('will-navigate', blockNavigation);
  addCleanup(() => contents.removeListener('will-navigate', blockNavigation));
  let sandboxedFrameNavigationAllowed = false;
  const onFrameNavigate = (
    details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
  ) => {
    if (
      !details.isMainFrame &&
      details.url === 'about:srcdoc' &&
      !sandboxedFrameNavigationAllowed
    ) {
      sandboxedFrameNavigationAllowed = true;
      return;
    }
    blockNavigation(details);
  };
  contents.on('will-frame-navigate', onFrameNavigate);
  addCleanup(() =>
    contents.removeListener('will-frame-navigate', onFrameNavigate),
  );
  contents.on('will-redirect', blockNavigation);
  addCleanup(() => contents.removeListener('will-redirect', blockNavigation));

  const onAttachWebview = (event: Electron.Event) => {
    event.preventDefault();
    void closeInstance('webview-attach-blocked');
  };
  contents.on('will-attach-webview', onAttachWebview);
  addCleanup(() =>
    contents.removeListener('will-attach-webview', onAttachWebview),
  );

  const onPreventUnload = (event: Electron.Event) => event.preventDefault();
  contents.on('will-prevent-unload', onPreventUnload);
  addCleanup(() =>
    contents.removeListener('will-prevent-unload', onPreventUnload),
  );

  const onUnresponsive = () => void closeInstance('renderer-unresponsive');
  contents.on('unresponsive', onUnresponsive);
  addCleanup(() => contents.removeListener('unresponsive', onUnresponsive));

  const onRenderProcessGone = () => void closeInstance('renderer-gone');
  contents.on('render-process-gone', onRenderProcessGone);
  addCleanup(() =>
    contents.removeListener('render-process-gone', onRenderProcessGone),
  );

  const onFileChooser = (_event: Electron.Event, method: string) => {
    if (method === 'Page.fileChooserOpened') counters.fileChooserEvents += 1;
  };
  contents.debugger.on('message', onFileChooser);
  addCleanup(() => contents.debugger.removeListener('message', onFileChooser));
};

export const createActivityManager = (
  dependencies: ActivityManagerDependencies,
): ActivityManager => {
  let active: RuntimeInstance | null = null;
  let disposed = false;
  const instances = new Map<string, RuntimeInstance>();
  const pendingMounts = new Set<Promise<{ runId: string }>>();
  let mountQueue: Promise<void> = Promise.resolve();

  const releaseInstance = (instance: RuntimeInstance) => {
    if (!instance.releasePromise) {
      instance.releasePromise = dependencies.releaseRun({
        runId: instance.run.runId,
        requestId: instance.authorizationRequestId,
      });
    }
    return instance.releasePromise;
  };

  const closeInstance = (
    instance: RuntimeInstance,
    reason: string,
  ): Promise<void> => {
    if (instance.closePromise) return instance.closePromise;
    if (instance.closed) return Promise.resolve();
    instance.closing = true;
    instance.closed = true;
    if (active === instance) active = null;

    if (instance.bootstrapTimer) clearTimeout(instance.bootstrapTimer);
    if (instance.pollTimer) clearInterval(instance.pollTimer);
    if (instance.metricsTimer) clearInterval(instance.metricsTimer);
    instance.mailbox.clear();

    const closePromise = (async () => {
      await instance.checkpointInFlight?.catch(() => 'close');
      for (const cleanup of instance.cleanups.splice(0)) {
        try {
          cleanup();
        } catch {
          // Cleanup is best-effort after the owned renderer is already closing.
        }
      }

      try {
        instance.session.protocol.unhandle(activityScheme);
      } catch {
        // A missing handler is already closed to the activity.
      }
      try {
        await instance.session.closeAllConnections();
      } catch {
        // The session is private to this run and is not reused.
      }

      if (!instance.hostWindow.isDestroyed()) {
        try {
          instance.hostWindow.contentView.removeChildView(instance.view);
        } catch {
          // The parent can close before its child view.
        }
      }
      try {
        instance.view.setVisible(false);
        instance.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      } catch {
        // The WebContentsView may already have been disposed.
      }
      if (
        instance.debuggerAttached &&
        instance.view.webContents.debugger.isAttached()
      ) {
        try {
          instance.view.webContents.debugger.detach();
        } catch {
          // Debugger detach can race renderer teardown.
        }
      }
      const contents = instance.view.webContents;
      if (!contents.isDestroyed()) {
        let resolveDestroyed: (() => void) | undefined;
        const destroyed = new Promise<void>((resolve) => {
          resolveDestroyed = resolve;
          contents.once('destroyed', resolve);
        });
        try {
          contents.close({ waitForBeforeUnload: false });
        } catch {
          // An activity cannot veto main-owned teardown.
        }

        const watchdogTermination =
          reason === 'mailbox-watchdog-timeout' ||
          reason === 'activity-resource-watchdog' ||
          reason === 'renderer-unresponsive';
        const rendererProcessId = contents.getOSProcessId();
        const trustedProcessIds = dependencies
          .getTrustedRenderers()
          .filter((trustedContents) => !trustedContents.isDestroyed())
          .map((trustedContents) => trustedContents.getOSProcessId())
          .filter((pid) => pid > 0);
        const canForceTerminate = canForcefullyTerminateActivityRenderer(
          rendererProcessId,
          trustedProcessIds,
        );
        if (watchdogTermination && canForceTerminate && !contents.isDestroyed())
          contents.forcefullyCrashRenderer();
        if (!contents.isDestroyed()) {
          const destroyedInTime = await withTimeout(
            destroyed.then(() => true),
            1000,
          ).catch(() => false);
          if (!destroyedInTime && !contents.isDestroyed() && canForceTerminate)
            contents.forcefullyCrashRenderer();
          if (!contents.isDestroyed())
            await withTimeout(destroyed, 1000).catch(() => undefined);
        }
        if (resolveDestroyed)
          contents.removeListener('destroyed', resolveDestroyed);
      }

      let releaseError: unknown;
      try {
        await releaseInstance(instance);
      } catch (error) {
        releaseError = error;
      }
      instances.delete(instance.run.runId);
      try {
        dependencies.onClosed?.({ runId: instance.run.runId, reason });
      } catch {
        // Teardown completion is independent from status-event delivery.
      }
      instance.closing = false;
      if (releaseError) throw releaseError;
    })();
    instance.closePromise = closePromise;
    return closePromise;
  };

  const closeByRunId = async (runId: string, reason = 'closed') => {
    const instance = instances.get(runId);
    if (instance) await closeInstance(instance, reason);
  };

  const sendIsolatedWorldMessage = async (
    instance: RuntimeInstance,
    message: Record<string, unknown>,
  ) => {
    const serializedMessage = JSON.stringify(message);
    const expression = `globalThis.__scholarActivityMailbox.send(${JSON.stringify(serializedMessage)})`;
    await withTimeout(
      instance.view.webContents.executeJavaScriptInIsolatedWorld(
        activityWorldId,
        [{ code: expression }],
      ),
      mailboxPollTimeoutMs,
    );
  };

  const sendHostMessage = (
    instance: RuntimeInstance,
    kind: string,
    payload: Record<string, unknown>,
  ) =>
    sendIsolatedWorldMessage(instance, {
      protocolVersion: 1,
      runtimeVersion: instance.run.runtimeVersion,
      source: 'scholar-host',
      sessionId: instance.run.sessionId,
      artifactId: instance.run.artifactId,
      contentVersionId: instance.run.versionId,
      attemptId: instance.run.attemptId,
      runId: instance.run.runId,
      sequence: ++instance.hostSequence,
      kind,
      ...payload,
    });

  const persistProposal = async (
    instance: RuntimeInstance,
    proposal: ActivityStateProposal,
  ): Promise<'acknowledged' | 'failed' | 'close'> => {
    if (instance.closed || instance.closing) return 'close';
    try {
      const result = await dependencies.persistState(proposal);
      if (instance.closed || instance.closing) return 'close';
      if (
        !Number.isSafeInteger(result.revision) ||
        result.revision !== proposal.baseStateRevision + 1
      )
        throw new Error('Activity state acknowledgement revision is invalid.');
      instance.mailbox.acknowledge(result.revision);
      instance.lastFailedProposal = null;
      await sendHostMessage(instance, 'state-acknowledged', {
        acknowledgedSequence: proposal.sequence,
        stateRevision: result.revision,
      });
      try {
        dependencies.onStateAcknowledged?.(instance.run.runId, result.revision);
      } catch {
        // Persistence acknowledgement does not depend on status-event delivery.
      }
      return 'acknowledged';
    } catch {
      if (instance.closed || instance.closing) return 'close';
      instance.lastFailedProposal = proposal;
      try {
        dependencies.onStateFailure?.(instance.run.runId);
      } catch {
        // The host rejection must still reach the runtime.
      }
      try {
        await sendHostMessage(instance, 'state-rejected', {
          acknowledgedSequence: proposal.sequence,
          stateRevision: instance.mailbox.stateRevision,
        });
        return 'failed';
      } catch {
        return 'close';
      }
    }
  };

  const executeCheckpoint = async (
    instance: RuntimeInstance,
    proposal: ActivityStateProposal,
  ) => {
    const checkpoint = persistProposal(instance, proposal);
    instance.checkpointInFlight = checkpoint;
    try {
      return await checkpoint;
    } finally {
      if (instance.checkpointInFlight === checkpoint)
        instance.checkpointInFlight = null;
    }
  };

  const retryCheckpoint = async (input: { runId: string }) => {
    const instance = instances.get(input.runId);
    if (
      !instance ||
      instance.closed ||
      instance.closing ||
      instance.binding.readOnly
    )
      throw new Error('The activity checkpoint is not retryable.');
    if (instance.checkpointRetryPromise) return instance.checkpointRetryPromise;
    const retry = (async () => {
      if (instance.checkpointInFlight)
        await instance.checkpointInFlight.catch(() => 'close');
      if (instance.closed || instance.closing)
        throw new Error('The activity run is closing.');
      const proposal = instance.lastFailedProposal;
      if (!proposal) return;
      const result = await executeCheckpoint(instance, proposal);
      if (result === 'close') {
        await closeInstance(instance, 'checkpoint-retry-transport-failed');
        throw new Error(
          'The activity checkpoint retry could not be acknowledged.',
        );
      }
      if (result === 'failed')
        throw new Error('The activity checkpoint retry failed.');
    })();
    instance.checkpointRetryPromise = retry;
    try {
      await retry;
    } finally {
      if (instance.checkpointRetryPromise === retry)
        instance.checkpointRetryPromise = null;
    }
  };

  const pollMailbox = async (instance: RuntimeInstance) => {
    if (instance.closed || instance.closing || instance.pollInFlight) return;
    instance.pollInFlight = true;
    try {
      const serializedMessage = await withTimeout(
        instance.view.webContents.executeJavaScriptInIsolatedWorld(
          activityWorldId,
          [{ code: 'globalThis.__scholarActivityMailbox.readNext()' }],
        ),
        mailboxPollTimeoutMs,
      );
      instance.consecutivePollFailures = 0;
      if (serializedMessage === null) return;
      if (typeof serializedMessage !== 'string') {
        await closeInstance(instance, 'mailbox-protocol-invalid');
        return;
      }
      if (serializedMessage === '{"mailboxOverflow":true}') {
        await closeInstance(instance, 'mailbox-overflow');
        return;
      }
      if (!instance.mailbox.enqueue(serializedMessage)) {
        await closeInstance(instance, 'mailbox-message-rejected');
        return;
      }
      const queuedMessage = instance.mailbox.readNext();
      if (!queuedMessage) return;
      const message = decodeActivityMessage(
        queuedMessage,
        instance.binding,
        instance.mailbox.stateRevision,
      );
      if (!message) {
        await closeInstance(instance, 'mailbox-message-invalid');
        return;
      }

      if (message.kind === 'ready') {
        if (message.payload.contentDigest !== instance.run.contentDigest) {
          await closeInstance(instance, 'activity-digest-mismatch');
          return;
        }
        instance.initialized = true;
        if (instance.bootstrapTimer) clearTimeout(instance.bootstrapTimer);
        instance.bootstrapTimer = null;
        const bounds = boundedBounds(
          instance.initialBounds,
          instance.hostWindow,
        );
        instance.view.setBounds(bounds);
        instance.view.setVisible(bounds.width > 0 && bounds.height > 0);
        dependencies.onRuntimeReady?.(instance.run.runId);
        return;
      }
      if (message.kind === 'state-proposed') {
        const result = await executeCheckpoint(instance, {
          sessionId: instance.run.sessionId,
          artifactId: instance.run.artifactId,
          versionId: instance.run.versionId,
          attemptId: instance.run.attemptId,
          runId: instance.run.runId,
          sequence: message.sequence,
          baseStateRevision: message.baseStateRevision,
          state: message.payload.state,
        });
        if (result === 'close')
          await closeInstance(instance, 'state-acknowledgement-failed');
        return;
      }
      if (message.kind === 'interaction') {
        try {
          await dependencies.onInteraction?.({
            runId: instance.run.runId,
            action: message.payload.action,
            value: message.payload.value,
          });
          await sendHostMessage(instance, 'interaction-acknowledged', {
            acknowledgedSequence: message.sequence,
          });
        } catch {
          await closeInstance(instance, 'interaction-acknowledgement-failed');
        }
        return;
      }
      if (message.kind === 'runtime-error')
        await closeInstance(instance, 'activity-runtime-error');
    } catch {
      if (instance.closed || instance.closing) return;
      instance.consecutivePollFailures += 1;
      if (instance.consecutivePollFailures >= mailboxFailureLimit)
        await closeInstance(instance, 'mailbox-watchdog-timeout');
    } finally {
      instance.pollInFlight = false;
    }
  };

  const mountActivity = async (
    input: ActivityMountInput,
    request: ActivityAuthorizationRequest,
  ) => {
    if (disposed) throw new Error('The activity manager has been disposed.');
    if (
      input.hostWindow.isDestroyed() ||
      !dependencies.requireTrustedSender(input.hostWindow.webContents)
    )
      throw new Error(
        'Only a registered trusted app window can mount an activity.',
      );
    if (!isActivitySchemeRegistered())
      throw new Error(
        'The activity protocol was not registered before app ready.',
      );
    if (active) await closeInstance(active, 'replaced');

    let authorizedRun: AuthorizedActivityRun | null = null;
    try {
      authorizedRun = await dependencies.authorizeRun(request);
      if (!authorizedRun)
        throw new Error('The activity run is no longer authorized.');
      if (
        disposed ||
        input.hostWindow.isDestroyed() ||
        !dependencies.requireTrustedSender(input.hostWindow.webContents)
      )
        throw new Error('The activity mount authorization became stale.');
      validateAuthorizedRun(request, authorizedRun);
    } catch (error) {
      await dependencies.releaseRun({
        ...(authorizedRun ? { runId: authorizedRun.runId } : {}),
        requestId: request.requestId,
      });
      throw error;
    }

    let activitySession: Session | null = null;
    let instance: RuntimeInstance | null = null;
    try {
      const theme = await readActivityTheme(input.hostWindow.webContents);
      const themeCss = createActivityThemeCss(theme);
      const nonce = randomBytes(32).toString('hex');
      const activityHost = randomUUID();
      const url = `${activityScheme}://${activityHost}/document`;
      const origin = `${activityScheme}://${activityHost}`;
      // The CSP-sandboxed wrapper has an opaque postMessage origin.
      const document = buildActivityDocument(authorizedRun, nonce, 'null');
      const runSession = session.fromPartition(
        `${activityPartitionPrefix}${randomUUID()}`,
        { cache: false },
      );
      activitySession = runSession;
      const counters: ActivityGuardCounters = {
        blockedRequests: 0,
        blockedProtocolRequests: 0,
        blockedNavigations: 0,
        deniedPopups: 0,
        cancelledDownloads: 0,
        deniedPermissions: 0,
        fileChooserEvents: 0,
        connectionPolicyHeaderVerified: false,
      };
      const binding: ActivityMailboxBinding = {
        runtimeVersion: authorizedRun.runtimeVersion,
        sessionId: authorizedRun.sessionId,
        artifactId: authorizedRun.artifactId,
        contentVersionId: authorizedRun.versionId,
        attemptId: authorizedRun.attemptId,
        runId: authorizedRun.runId,
        readOnly: input.readOnly,
      };
      const mailbox = createActivityMailbox({
        binding,
        stateRevision: authorizedRun.stateRevision,
      });
      let bootstrapServed = false;
      runSession.protocol.handle(activityScheme, (request) => {
        if (
          request.url !== url ||
          request.method !== 'GET' ||
          bootstrapServed
        ) {
          counters.blockedProtocolRequests += 1;
          return new Response('Not found.', { status: 404 });
        }
        bootstrapServed = true;
        return new Response(document.body, {
          status: 200,
          headers: document.headers,
        });
      });
      const cleanups: Array<() => void> = [];
      registerActivitySessionGuards(runSession, url, counters, cleanups);
      const view = new WebContentsView({
        webPreferences: createActivityWebPreferences(runSession),
      });
      view.setVisible(false);
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      view.webContents.setAudioMuted(true);

      const runtimeInstance: RuntimeInstance = {
        run: authorizedRun,
        binding,
        session: runSession,
        view,
        hostWindow: input.hostWindow,
        url,
        origin,
        mailbox,
        counters,
        cleanups,
        closed: false,
        closing: false,
        closePromise: null,
        releasePromise: null,
        initialized: false,
        pollInFlight: false,
        checkpointInFlight: null,
        checkpointRetryPromise: null,
        lastFailedProposal: null,
        authorizationRequestId: request.requestId,
        hostSequence: 1,
        consecutivePollFailures: 0,
        cpuOverLimitSamples: 0,
        bootstrapTimer: null,
        pollTimer: null,
        metricsTimer: null,
        debuggerAttached: false,
        initialBounds: input.bounds,
        activityProcessId: 0,
      };
      instance = runtimeInstance;
      active = runtimeInstance;
      instances.set(authorizedRun.runId, runtimeInstance);

      registerPageGuards(runtimeInstance, (reason) =>
        closeInstance(runtimeInstance, reason),
      );
      const onDebuggerDetach = () => {
        if (!runtimeInstance.closing && !runtimeInstance.closed)
          void closeInstance(runtimeInstance, 'file-chooser-guard-detached');
      };
      view.webContents.debugger.on('detach', onDebuggerDetach);
      runtimeInstance.cleanups.push(() =>
        view.webContents.debugger.removeListener('detach', onDebuggerDetach),
      );
      view.webContents.debugger.attach('1.3');
      runtimeInstance.debuggerAttached = true;
      const fileChooserGuard = view.webContents.debugger
        .sendCommand('Page.setInterceptFileChooserDialog', {
          enabled: true,
          cancel: true,
        })
        .then(
          () => ({ supported: true as const }),
          () => ({ supported: false as const }),
        );

      const onHostClosed = () =>
        void closeInstance(runtimeInstance, 'host-window-closed');
      input.hostWindow.once('closed', onHostClosed);
      runtimeInstance.cleanups.push(() =>
        input.hostWindow.removeListener('closed', onHostClosed),
      );
      input.hostWindow.contentView.addChildView(view);

      await withTimeout(view.webContents.loadURL(url), bootstrapTimeoutMs);
      await withTimeout(
        view.webContents.insertCSS(themeCss),
        mailboxPollTimeoutMs,
      );
      if (!counters.connectionPolicyHeaderVerified)
        throw new Error(
          'The activity connection allowlist header was not verified.',
        );
      const fileChooserResult = await withTimeout(fileChooserGuard, 3000);
      if (!fileChooserResult.supported)
        throw new Error(
          'The Electron file chooser interception is unsupported.',
        );
      const activityProcessId = view.webContents.getOSProcessId();
      const trustedProcessIds = dependencies
        .getTrustedRenderers()
        .filter((contents) => !contents.isDestroyed())
        .map((contents) => contents.getOSProcessId())
        .filter((pid) => pid > 0);
      if (
        activityProcessId <= 0 ||
        trustedProcessIds.includes(activityProcessId)
      )
        throw new Error(
          'The activity renderer is not process-isolated from the app.',
        );
      runtimeInstance.activityProcessId = activityProcessId;

      const mailboxSource = isolatedWorldMailboxSource(binding, origin);
      await withTimeout(
        view.webContents.executeJavaScriptInIsolatedWorld(activityWorldId, [
          { code: mailboxSource },
        ]),
        mailboxPollTimeoutMs,
      );
      dependencies.onDiagnostics?.({
        runId: authorizedRun.runId,
        webContentsId: view.webContents.id,
        activityProcessId,
        trustedProcessIds,
        contentDigest: authorizedRun.contentDigest,
        guardCounters: counters,
      });
      runtimeInstance.bootstrapTimer = setTimeout(
        () => void closeInstance(runtimeInstance, 'activity-bootstrap-timeout'),
        bootstrapTimeoutMs,
      );
      runtimeInstance.pollTimer = setInterval(
        () => void pollMailbox(runtimeInstance),
        mailboxPollIntervalMs,
      );
      runtimeInstance.metricsTimer = setInterval(() => {
        if (runtimeInstance.closed || runtimeInstance.closing) return;
        const metric = app
          .getAppMetrics()
          .find((entry) => entry.pid === activityProcessId);
        if (!metric) return;
        runtimeInstance.cpuOverLimitSamples =
          metric.cpu.percentCPUUsage > maximumActivityCpuPercent
            ? runtimeInstance.cpuOverLimitSamples + 1
            : 0;
        if (
          isActivityResourceLimitExceeded(
            metric,
            runtimeInstance.cpuOverLimitSamples,
          )
        )
          void closeInstance(runtimeInstance, 'activity-resource-watchdog');
      }, 1000);

      const bootstrapMessage = JSON.stringify({
        source: 'scholar-host',
        kind: 'activity-bootstrap',
        protocolVersion: 1,
        runtimeVersion: authorizedRun.runtimeVersion,
        nonce,
        sessionId: authorizedRun.sessionId,
        artifactId: authorizedRun.artifactId,
        contentVersionId: authorizedRun.versionId,
        attemptId: authorizedRun.attemptId,
        runId: authorizedRun.runId,
        contentDigest: authorizedRun.contentDigest,
        stateRevision: authorizedRun.stateRevision,
        initialState: authorizedRun.initialState,
        theme,
        readOnly: input.readOnly,
        css: `${authorizedRun.css}\n${themeCss}`,
        sdk: authorizedRun.sdk,
        javascript: authorizedRun.javascript,
      });
      await withTimeout(
        view.webContents.executeJavaScriptInIsolatedWorld(activityWorldId, [
          {
            code: `window.postMessage(${JSON.stringify(bootstrapMessage)}, '*')`,
          },
        ]),
        mailboxPollTimeoutMs,
      );

      const readyDeadline = Date.now() + bootstrapTimeoutMs;
      while (
        !runtimeInstance.initialized &&
        !runtimeInstance.closed &&
        Date.now() < readyDeadline
      )
        await delay(20);
      if (!runtimeInstance.initialized)
        throw new Error(
          'The accepted activity did not report a valid ready message.',
        );
      return { runId: authorizedRun.runId };
    } catch (error) {
      if (instance) await closeInstance(instance, 'activity-mount-failed');
      else {
        if (activitySession) {
          try {
            activitySession.protocol.unhandle(activityScheme);
          } catch {
            // A handler was not installed.
          }
        }
        await dependencies.releaseRun({
          runId: authorizedRun.runId,
          requestId: request.requestId,
        });
      }
      throw error;
    }
  };

  const mount = async (input: ActivityMountInput) => {
    if (disposed) throw new Error('The activity manager has been disposed.');
    const request: ActivityAuthorizationRequest = {
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      versionId: input.versionId,
      attemptId: input.attemptId,
      requestId: randomUUID(),
    };
    const operation = mountQueue.then(() => mountActivity(input, request));
    mountQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    pendingMounts.add(operation);
    try {
      return await operation;
    } finally {
      pendingMounts.delete(operation);
    }
  };

  const updateBounds = (
    runId: string,
    bounds: ActivityBounds,
    visible: boolean,
  ) => {
    const instance = instances.get(runId);
    if (!instance || instance.closed || instance.closing) return;
    const clamped = boundedBounds(bounds, instance.hostWindow);
    instance.view.setBounds(clamped);
    instance.view.setVisible(
      visible && clamped.width > 0 && clamped.height > 0,
    );
  };

  const hide = (runId: string) => {
    const instance = instances.get(runId);
    if (!instance || instance.closed || instance.closing) return;
    instance.view.setVisible(false);
  };

  const close = async (runId: string) => closeByRunId(runId, 'closed');

  const dispose = async () => {
    disposed = true;
    const closingInstances = [...instances.values()].map((instance) =>
      closeInstance(instance, 'manager-disposed'),
    );
    const pendingMountResults = await Promise.allSettled(pendingMounts);
    const errors = pendingMountResults.flatMap((result) =>
      result.status === 'rejected' &&
      !(
        result.reason instanceof Error &&
        (result.reason.message === 'The activity manager has been disposed.' ||
          result.reason.message ===
            'The activity mount authorization became stale.')
      )
        ? [result.reason]
        : [],
    );
    const closeResults = await Promise.allSettled([
      ...closingInstances,
      ...[...instances.values()].map((instance) =>
        closeInstance(instance, 'manager-disposed'),
      ),
    ]);
    errors.push(
      ...closeResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      ),
    );
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        'The activity manager did not fully dispose.',
      );
  };

  return { mount, updateBounds, hide, retryCheckpoint, close, dispose };
};
