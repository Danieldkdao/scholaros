import { app, BrowserWindow, session, webContents } from 'electron';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createActivityAdversaryScript } from './activity-adversaries';

type FixtureConfig = {
  httpUrl: string;
  httpProbeUrl: string;
  webSocketUrl: string;
  stunUrl: string;
  tcpPort: number;
  filePath: string;
  authSchemeUrl: string;
  countsUrl: string;
  reportPath: string;
  runtimeBundlePath: string;
  electronBinaryDigest: string;
  fuseWire: { version: string; bytes: string };
};

type SinkCounters = {
  http: number;
  webSocket: number;
  tcp: number;
  udp: number;
};

let reportForFailure: Record<string, unknown> | null = null;

const argumentValue = (name: string) =>
  process.argv
    .find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const waitFor = async <T>(promise: Promise<T>, milliseconds: number) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting ${milliseconds}ms.`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const waitForProposalCount = async (
  proposals: Array<Record<string, unknown>>,
  count: number,
  milliseconds: number,
) => {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const proposal = proposals[count - 1];
    if (proposal) return proposal;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for activity proposal ${count}.`);
};

const readSinkCounters = async (countsUrl: string) => {
  const response = await fetch(countsUrl, {
    signal: AbortSignal.timeout(1000),
  });
  return (await response.json()) as SinkCounters;
};

const makePositiveControls = async (
  window: BrowserWindow,
  config: FixtureConfig,
) => {
  await window.webContents.session.cookies.set({
    url: config.httpUrl,
    name: 'activity-fixture-cookie',
    value: 'test-only',
    path: '/',
  });
  await window.loadURL(config.httpUrl);
  const browserControls = await window.webContents
    .executeJavaScript(`(async () => {
    const http = await fetch(${JSON.stringify(config.httpProbeUrl)}).then((response) => response.ok);
    const webSocket = await new Promise((resolve) => {
      const socket = new WebSocket(${JSON.stringify(config.webSocketUrl)});
      const timeout = setTimeout(() => { socket.close(); resolve(false); }, 3000);
      socket.addEventListener('open', () => { clearTimeout(timeout); socket.close(); resolve(true); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timeout); resolve(false); }, { once: true });
    });
    const udp = await new Promise((resolve) => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(config.stunUrl)} }] });
      peer.createDataChannel('positive-control');
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') { peer.close(); resolve(true); }
      });
      peer.createOffer().then((offer) => peer.setLocalDescription(offer)).catch(() => { peer.close(); resolve(false); });
      setTimeout(() => { peer.close(); resolve(false); }, 3000);
    });
    return { http, webSocket, udp };
  })()`);
  const tcp = await new Promise<boolean>((resolve) => {
    const socket = createConnection({
      host: new URL(config.httpUrl).hostname,
      port: config.tcpPort,
    });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1500);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.end('test-owned positive control');
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });

  return { ...browserControls, tcp };
};

const run = async () => {
  const configPath = argumentValue('--activity-fixture-config');
  if (!configPath) throw new Error('Missing activity fixture config path.');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as FixtureConfig;
  const runtime = require(config.runtimeBundlePath) as {
    registerActivitySchemeBeforeReady: () => void;
    createActivityManager: (dependencies: Record<string, unknown>) => {
      mount: (input: Record<string, unknown>) => Promise<{ runId: string }>;
      updateBounds: (
        runId: string,
        bounds: { x: number; y: number; width: number; height: number },
        visible: boolean,
      ) => void;
      hide: (runId: string) => void;
      close: (runId: string) => Promise<void> | void;
      dispose: () => Promise<void>;
    };
    createActivityContentDigest: (input: {
      html: string;
      css: string;
      sdk: string;
      javascript: string;
    }) => string;
  };
  runtime.registerActivitySchemeBeforeReady();

  const report: Record<string, unknown> = {
    startedAt: Date.now(),
    stage: 'positive-controls',
    processVersions: process.versions,
    electronMainPid: process.pid,
    electronBinaryDigest: config.electronBinaryDigest,
    fuseWire: config.fuseWire,
    runtimeBundleDigest: createHash('sha256')
      .update(readFileSync(config.runtimeBundlePath))
      .digest('hex'),
  };
  reportForFailure = report;

  await app.whenReady();
  if (process.platform === 'darwin') app.dock?.hide();
  const hostWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 640,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  hostWindow.webContents.on('render-process-gone', () => {
    report.trustedRendererSurvived = false;
  });
  report.stage = 'trusted-renderer';
  await hostWindow.loadURL(config.httpUrl);
  report.trustedRendererProcessId = hostWindow.webContents.getOSProcessId();
  if (report.trustedRendererProcessId === 0)
    throw new Error('Trusted test renderer did not start.');

  const positiveSession = session.fromPartition('activity-positive-control', {
    cache: false,
  });
  const positiveControlWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 640,
    webPreferences: {
      session: positiveSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  report.stage = 'positive-controls';
  const positiveControls = await makePositiveControls(
    positiveControlWindow,
    config,
  );
  const sinkCountersBeforeRuntime = await readSinkCounters(config.countsUrl);
  report.positiveControls = {
    ...positiveControls,
    udp: sinkCountersBeforeRuntime.udp > 0,
  };
  report.sinkCountersBeforeRuntime = sinkCountersBeforeRuntime;
  if (!positiveControlWindow.isDestroyed()) positiveControlWindow.destroy();
  report.stage = 'positive-controls-complete';

  const diagnostics: Array<Record<string, unknown>> = [];
  const closures: Array<Record<string, unknown>> = [];
  const proposals: Array<Record<string, unknown>> = [];
  const activityConsoleMessages: Array<Record<string, unknown>> = [];
  report.diagnostics = diagnostics;
  report.closures = closures;
  report.proposals = proposals;
  report.activityConsoleMessages = activityConsoleMessages;
  let stateProposalResolve:
    | ((value: Record<string, unknown>) => void)
    | undefined;
  let runtimeClosedResolve:
    | ((value: Record<string, unknown>) => void)
    | undefined;
  let stateProposal = new Promise<Record<string, unknown>>((resolve) => {
    stateProposalResolve = resolve;
  });
  let runtimeClosed = new Promise<Record<string, unknown>>((resolve) => {
    runtimeClosedResolve = resolve;
  });
  let currentAttack = 0;
  let persistedState: unknown = { restored: true };
  let persistedRevision = 0;
  const manager = runtime.createActivityManager({
    getTrustedRenderers: () =>
      hostWindow.isDestroyed() ? [] : [hostWindow.webContents],
    requireTrustedSender: (sender: {
      id?: number;
      isDestroyed?: () => boolean;
    }) =>
      !hostWindow.isDestroyed() &&
      sender.id === hostWindow.webContents.id &&
      sender.isDestroyed?.() !== true,
    authorizeRun: async (request: Record<string, string>) => {
      const binding = {
        sessionId: request.sessionId,
        artifactId: request.artifactId,
        contentVersionId: request.versionId,
        attemptId: request.attemptId,
        runId: request.runId,
      };
      const targets = {
        httpUrl: config.httpProbeUrl,
        webSocketUrl: config.webSocketUrl,
        stunUrl: config.stunUrl,
        turnTcpUrl: `turn:127.0.0.1:${config.tcpPort}?transport=tcp`,
        fileUrl: pathToFileURL(config.filePath).href,
        authSchemeUrl: config.authSchemeUrl,
      };
      const html = `<main><h1>Test-only activity</h1><img src="${config.httpProbeUrl}"><iframe src="${config.httpProbeUrl}"></iframe></main>`;
      const css = `main { background-image: url("${config.httpProbeUrl}"); }`;
      const sdk = 'window.activitySdkReady = true;';
      const javascript = createActivityAdversaryScript(
        targets,
        binding,
        request.attemptId === 'fixture-attempt-1',
      );
      return {
        ...binding,
        versionId: request.versionId,
        runtimeVersion: 'activity-runtime-v1',
        contentDigest: runtime.createActivityContentDigest({
          html,
          css,
          sdk,
          javascript,
        }),
        html,
        css,
        sdk,
        javascript,
        initialState: persistedState,
        stateRevision: persistedRevision,
      };
    },
    persistState: async (proposal: Record<string, unknown>) => {
      report.lastStatePersistedAt = Date.now();
      persistedState = proposal.state;
      persistedRevision = Number(proposal.baseStateRevision) + 1;
      if (
        currentAttack === 1 &&
        typeof proposal.state === 'object' &&
        proposal.state !== null &&
        (proposal.state as Record<string, unknown>).webrtcState === 'attempted'
      )
        report.stressStatePersistedAt = Date.now();
      proposals.push(proposal);
      stateProposalResolve?.(proposal);
      return {
        revision: Number(proposal.baseStateRevision) + 1,
      };
    },
    onDiagnostics: (value: Record<string, unknown>) => {
      diagnostics.push(value);
      const activityContents = webContents.fromId(Number(value.webContentsId));
      activityContents?.on('console-message', (_event) => {
        const { level, message, lineNumber, sourceId } = _event;
        if (level === 'error')
          activityConsoleMessages.push({
            level,
            message: message.slice(0, 500),
            line: lineNumber,
            sourceId,
          });
      });
    },
    onClosed: (value: Record<string, unknown>) => {
      closures.push({ ...value, closedAt: Date.now() });
      runtimeClosedResolve?.(value);
    },
    onRuntimeReady: () => undefined,
  });

  const mount = async (attemptId: string) => {
    currentAttack += 1;
    if (currentAttack > 1) {
      stateProposal = new Promise<Record<string, unknown>>((resolve) => {
        stateProposalResolve = resolve;
      });
      runtimeClosed = new Promise<Record<string, unknown>>((resolve) => {
        runtimeClosedResolve = resolve;
      });
    }
    return manager.mount({
      hostWindow,
      sessionId: 'fixture-session',
      artifactId: 'fixture-artifact',
      versionId: 'fixture-version',
      attemptId,
      bounds: { x: 12, y: 12, width: 700, height: 500 },
    });
  };

  report.stage = 'first-mount';
  const first = await waitFor(mount('fixture-attempt-1'), 10_000);
  const firstDiagnostic = diagnostics.at(-1) ?? {};
  const activityContents = webContents.fromId(
    Number(firstDiagnostic.webContentsId),
  );
  if (!activityContents)
    throw new Error(
      'Activity WebContents was not available in the test runner.',
    );
  const activityFrame = activityContents.mainFrame.framesInSubtree.find(
    (frame) => frame !== activityContents.mainFrame,
  );
  if (!activityFrame)
    throw new Error(
      'Sandboxed activity frame was not present in the test runner.',
    );
  report.stage = 'first-state-proposal';
  let firstProposal: Record<string, unknown>;
  try {
    firstProposal = await waitFor(stateProposal, 10_000);
  } catch (error) {
    report.activityFrameState = await waitFor(
      activityFrame.executeJavaScript(
        `({ phase: document.documentElement?.dataset.activityPhase ?? null, activitySdkReady: window.activitySdkReady === true })`,
      ),
      1500,
    ).catch((probeError: unknown) => ({
      error: probeError instanceof Error ? probeError.message : 'probe-failed',
    }));
    throw error;
  }
  report.firstProposal = firstProposal;
  report.stage = 'user-gesture-file-picker';
  const filePickerFiles = await activityFrame.executeJavaScript(
    `(() => { const input = document.createElement('input'); input.type = 'file'; document.body.appendChild(input); input.click(); return input.files?.length ?? -1; })()`,
    true,
  );
  report.filePickerFilesAfterUserGesture = filePickerFiles;
  report.webRequestHttpBlocked = await activityContents.session
    .fetch(config.httpProbeUrl)
    .then(
      () => false,
      () => true,
    );
  manager.updateBounds(
    first.runId,
    { x: 18, y: 20, width: 500, height: 320 },
    true,
  );
  manager.hide(first.runId);
  manager.updateBounds(
    first.runId,
    { x: 4, y: 8, width: 720, height: 560 },
    true,
  );
  report.presentation = {
    runId: first.runId,
    webContentsId: firstDiagnostic.webContentsId,
    processId: firstDiagnostic.activityProcessId,
    trustedProcessIds: firstDiagnostic.trustedProcessIds,
    sameRunAfterResize:
      diagnostics.at(-1)?.webContentsId === firstDiagnostic.webContentsId,
    numberOfActivityViews: hostWindow.contentView.children.filter(
      (view) => 'webContents' in view,
    ).length,
  };
  report.stage = 'webrtc-attempt-state';
  const webRtcStateProposal = await waitForProposalCount(proposals, 2, 10_000);
  const firstRuntimeClose = await waitFor(runtimeClosed, 8_000);
  report.crashRecovery = {
    ...firstRuntimeClose,
    elapsedMs:
      Number(firstRuntimeClose.closedAt ?? Date.now()) -
      Number(report.stressStatePersistedAt ?? Date.now()),
    trustedRendererSurvived: !hostWindow.webContents.isDestroyed(),
  };

  const savedState = structuredClone(persistedState);
  const recoveryStartedAt = Date.now();
  report.stage = 'recovery-mount';
  const second = await waitFor(mount('fixture-attempt-2'), 10_000);
  report.stage = 'recovered-state-proposal';
  const recoveredProposal = await waitFor(stateProposal, 10_000);
  const recoveredState = recoveredProposal.state as Record<string, unknown>;
  report.recovery = {
    elapsedMs: Date.now() - recoveryStartedAt,
    runId: second.runId,
    proposalPersisted: proposals.includes(recoveredProposal),
    savedStateRestored:
      JSON.stringify(recoveredState.restoredState) ===
      JSON.stringify(savedState),
    trustedRendererSurvived: !hostWindow.webContents.isDestroyed(),
  };
  await manager.close(second.runId);

  report.diagnostics = diagnostics;
  report.closures = closures;
  report.proposalCount = proposals.length;
  report.proposalState = proposals[0]?.state ?? firstProposal.state;
  report.webrtcStateProposal = webRtcStateProposal.state;
  report.recoveredState = recoveredProposal.state;
  report.sinkCountersAfterRuntime = await readSinkCounters(config.countsUrl);
  report.finishedAt = Date.now();
  report.recoveryMs =
    Number((firstRuntimeClose.closedAt as number | undefined) ?? Date.now()) -
    Number(report.stressStatePersistedAt ?? recoveryStartedAt);

  await manager.dispose();
  if (!hostWindow.isDestroyed()) hostWindow.destroy();
  writeFileSync(config.reportPath, JSON.stringify(report));
  app.quit();
};

void run().catch((error: unknown) => {
  const configPath = argumentValue('--activity-fixture-config');
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  if (configPath) {
    try {
      const config = JSON.parse(
        readFileSync(configPath, 'utf8'),
      ) as FixtureConfig;
      writeFileSync(
        config.reportPath,
        JSON.stringify({ ...reportForFailure, error: detail }),
      );
    } catch {
      process.stderr.write(detail);
    }
  } else {
    process.stderr.write(detail);
  }
  app.exit(1);
});
