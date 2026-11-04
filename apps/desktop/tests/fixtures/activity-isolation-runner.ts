import { app, BrowserWindow, session, webContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../src/db/schema';
import {
  CourseTable,
  StudySessionTable,
  StudyTurnTable,
} from '../../src/db/schema';
import { createArtifactStore } from '../../src/features/study/services/artifact-store';
import type {
  ActivityManager,
  ActivityManagerDependencies,
} from '../../src/features/study/services/activity-runtime';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import { createAcademicActivityAdapter } from '../../src/services/academic/activity-adapter';
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
  migrationsFolder: string;
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
let cleanupForFailure: (() => Promise<void>) | undefined;

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

const createP20StoreFixture = async (config: FixtureConfig) => {
  const sqlite = new Database(
    join(dirname(config.reportPath), 'activity.sqlite'),
  );
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: config.migrationsFolder });
  const timestamp = '2026-11-03T00:00:00.000Z';
  const userId = 'activity-fixture-user';
  const courseId = 'activity-fixture-course';
  const sessionId = 'activity-fixture-session';
  const turnId = 'activity-fixture-turn';
  const controller = new AbortController();
  const context: AuthorizedContext = {
    userId,
    epoch: 1,
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted,
  };
  const store = createArtifactStore({ db });
  const candidate = {
    title: 'Explore a wave',
    objective: 'Predict how frequency changes wavelength.',
    html: '<main><label for="frequency">Frequency</label><input id="frequency" type="range" aria-label="Frequency"><output aria-live="polite"></output></main>',
    css: '',
    javascript:
      "const frequency = document.querySelector('#frequency'); const output = document.querySelector('output'); frequency.addEventListener('input', () => { output.textContent = frequency.value; });",
    accessibleExplanation:
      'Change frequency and observe the wavelength feedback.',
    sourceReferences: [],
    runtimeVersion: 1 as const,
  };

  try {
    db.insert(CourseTable)
      .values({
        id: courseId,
        userId,
        connectionId: null,
        sourceKey: 'manual:activity-fixture-course',
        sourceName: 'Manual',
        sourceHost: '',
        name: 'Physics',
        url: '',
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      })
      .run();
    db.insert(StudySessionTable)
      .values({
        id: sessionId,
        userId,
        courseId,
        title: 'Wave study',
        activity: 'understand-topic',
        status: 'in-progress',
        revision: 0,
        generationEpoch: 0,
        draftText: '',
        draftRevision: 0,
        deadlineAt: null,
        timerRevision: 0,
        expiredRevision: null,
        resolvedExpiredRevision: null,
        finishedAt: null,
        deletedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastOpenedAt: timestamp,
      })
      .run();
    db.insert(StudyTurnTable)
      .values({
        id: turnId,
        userId,
        sessionId,
        requestId: randomUUID(),
        payloadHash: 'activity-fixture-turn-payload',
        generationEpoch: 0,
        status: 'checking',
        attemptNumber: 1,
        policyRevision: 1,
        contextRevision: 0,
        errorCode: null,
        startedAt: timestamp,
        settledAt: null,
      })
      .run();

    let unsafeCandidateRejected = false;
    try {
      await store.createArtifactVersion(context, {
        sessionId,
        turnId,
        candidate: {
          ...candidate,
          html: `<main><label for="frequency">Frequency</label><input id="frequency" type="range"><img src="${config.httpProbeUrl}"><output aria-live="polite"></output></main>`,
        },
        policyDecision: { allowed: true, reasonCode: 'allowed', revision: 1 },
        requestId: randomUUID(),
      });
    } catch {
      unsafeCandidateRejected = true;
    }
    if (!unsafeCandidateRejected)
      throw new Error('P20 accepted a candidate with an external image URL.');

    const created = await store.createArtifactVersion(context, {
      sessionId,
      turnId,
      candidate,
      policyDecision: { allowed: true, reasonCode: 'allowed', revision: 1 },
      requestId: randomUUID(),
    });
    const adapter = createAcademicActivityAdapter({ store });
    return {
      context,
      store,
      adapter,
      created,
      sessionId,
      unsafeCandidateRejected,
      close: async () => {
        await adapter.dispose();
        store.dispose();
        sqlite.close();
      },
    };
  } catch (error) {
    store.dispose();
    sqlite.close();
    throw error;
  }
};

const run = async () => {
  const configPath = argumentValue('--activity-fixture-config');
  if (!configPath) throw new Error('Missing activity fixture config path.');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as FixtureConfig;
  const runtime = require(config.runtimeBundlePath) as {
    registerActivitySchemeBeforeReady: () => void;
    createActivityManager: (
      dependencies: ActivityManagerDependencies,
    ) => ActivityManager;
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
  app.on('window-all-closed', () => undefined);
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
  let stateFailureResolve:
    | ((value: Record<string, unknown>) => void)
    | undefined;
  const stateFailure = new Promise<Record<string, unknown>>((resolve) => {
    stateFailureResolve = resolve;
  });
  let runtimeClosedResolve:
    | ((value: Record<string, unknown>) => void)
    | undefined;
  let stateProposal = new Promise<Record<string, unknown>>((resolve) => {
    stateProposalResolve = resolve;
  });
  let runtimeClosed = new Promise<Record<string, unknown>>((resolve) => {
    runtimeClosedResolve = resolve;
  });
  const p20Fixture = await createP20StoreFixture(config);
  const authorizedActivity = p20Fixture.created.version;
  const activityTargets = {
    httpUrl: config.httpProbeUrl,
    webSocketUrl: config.webSocketUrl,
    stunUrl: config.stunUrl,
    turnTcpUrl: `turn:127.0.0.1:${config.tcpPort}?transport=tcp`,
    fileUrl: pathToFileURL(config.filePath).href,
    authSchemeUrl: config.authSchemeUrl,
  };
  report.p20Boundary = {
    unsafeCandidateRejected: p20Fixture.unsafeCandidateRejected,
    artifactId: authorizedActivity.artifactId,
    versionId: authorizedActivity.versionId,
    attemptId: p20Fixture.created.attemptId,
    contentDigest: authorizedActivity.contentDigest,
  };
  let currentAttack = 0;
  let lostCheckpointResponse = false;
  let firstWriteCommittedBeforeLostResponse = false;
  const checkpointWriteCounts = new Map<number, number>();
  const checkpointAttempts: Array<Record<string, unknown>> = [];
  const proposalKeys = new Set<string>();
  const interactionEvents: Array<Record<string, unknown>> = [];
  const navigationEvents: Array<Record<string, unknown>> = [];
  const releaseCalls = new Map<
    string,
    { requestId: string; runId: string | null; count: number }
  >();
  const stateAcknowledgements: Array<Record<string, unknown>> = [];
  const authorizationRuns: Array<{ requestId: string; runId: string }> = [];
  const manager = runtime.createActivityManager({
    getTrustedRenderers: () =>
      hostWindow.isDestroyed() ? [] : [hostWindow.webContents],
    requireTrustedSender: (sender) =>
      !hostWindow.isDestroyed() &&
      sender.id === hostWindow.webContents.id &&
      !sender.isDestroyed(),
    authorizeRun: async (request) => {
      const authorizedRun = await p20Fixture.adapter.authorizeActivityRun(
        p20Fixture.context,
        request,
      );
      authorizationRuns.push({
        requestId: request.requestId,
        runId: authorizedRun.runId,
      });
      return authorizedRun;
    },
    persistState: async (proposal) => {
      const checkpoint = await p20Fixture.adapter.checkpointArtifactState(
        p20Fixture.context,
        proposal,
      );
      report.lastStatePersistedAt = Date.now();
      const sequence = proposal.sequence;
      checkpointWriteCounts.set(
        sequence,
        (checkpointWriteCounts.get(sequence) ?? 0) + 1,
      );
      checkpointAttempts.push({ ...proposal });
      const proposalKey = `${proposal.runId}:${proposal.sequence}`;
      if (!proposalKeys.has(proposalKey)) {
        proposalKeys.add(proposalKey);
        proposals.push({ ...proposal });
        stateProposalResolve?.({ ...proposal });
      }
      if (
        currentAttack === 1 &&
        typeof proposal.state === 'object' &&
        proposal.state !== null &&
        'webrtcState' in proposal.state &&
        proposal.state.webrtcState === 'attempted'
      )
        report.stressStatePersistedAt = Date.now();
      if (currentAttack === 1 && !lostCheckpointResponse) {
        lostCheckpointResponse = true;
        firstWriteCommittedBeforeLostResponse = true;
        stateFailureResolve?.({ ...proposal });
        throw new Error(
          'Fixture lost the checkpoint response after P20 commit.',
        );
      }
      return { revision: checkpoint.stateRevision };
    },
    releaseRun: (request) => {
      const previous = releaseCalls.get(request.requestId);
      releaseCalls.set(request.requestId, {
        requestId: request.requestId,
        runId: request.runId ?? null,
        count: (previous?.count ?? 0) + 1,
      });
      return p20Fixture.adapter.releaseActivityRun(request);
    },
    onDiagnostics: (value) => {
      diagnostics.push({ ...value });
      const activityContents = webContents.fromId(value.webContentsId);
      activityContents?.on('console-message', (event) => {
        const { level, message, lineNumber, sourceId } = event;
        if (level === 'error')
          activityConsoleMessages.push({
            level,
            message: message.slice(0, 500),
            line: lineNumber,
            sourceId,
          });
      });
    },
    onClosed: (value) => {
      closures.push({ ...value, closedAt: Date.now() });
      runtimeClosedResolve?.({ ...value });
    },
    onStateFailure: (runId) => {
      stateFailureResolve?.({ runId });
    },
    onStateAcknowledged: (runId, revision) => {
      stateAcknowledgements.push({ runId, revision });
    },
    onInteraction: (value) => {
      interactionEvents.push({ ...value });
    },
    onRuntimeReady: () => undefined,
  });
  cleanupForFailure = async () => {
    await manager.dispose();
    await p20Fixture.close();
  };

  const releaseCountForRun = (runId: string) =>
    [...releaseCalls.values()].find((release) => release.runId === runId)
      ?.count ?? 0;

  const mount = async () => {
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
      sessionId: p20Fixture.sessionId,
      artifactId: authorizedActivity.artifactId,
      versionId: authorizedActivity.versionId,
      attemptId: p20Fixture.created.attemptId,
      readOnly: false,
      bounds: { x: 12, y: 12, width: 700, height: 500 },
    });
  };

  report.stage = 'first-mount';
  const first = await waitFor(mount(), 10_000);
  const firstDiagnostic = diagnostics.at(-1) ?? {};
  const activityContents = webContents.fromId(
    Number(firstDiagnostic.webContentsId),
  );
  if (!activityContents)
    throw new Error(
      'Activity WebContents was not available in the test runner.',
    );
  report.wrapperOrigin =
    await activityContents.executeJavaScript('location.origin');
  const activityFrame = activityContents.mainFrame.framesInSubtree.find(
    (frame) => frame !== activityContents.mainFrame,
  );
  if (!activityFrame)
    throw new Error(
      'Sandboxed activity frame was not present in the test runner.',
    );
  report.sdkParentOrigin = await activityFrame.executeJavaScript(
    'window.__scholarActivityParentOrigin',
  );
  await activityFrame.executeJavaScript(
    createActivityAdversaryScript(
      activityTargets,
      {
        sessionId: p20Fixture.sessionId,
        artifactId: authorizedActivity.artifactId,
        contentVersionId: authorizedActivity.versionId,
        attemptId: p20Fixture.created.attemptId,
        runId: first.runId,
      },
      true,
    ),
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
  await waitFor(stateFailure, 3_000);
  await manager.retryCheckpoint({ runId: first.runId });
  report.checkpointRetry = {
    firstWriteCommittedBeforeLostResponse,
    retryWriteCount:
      checkpointWriteCounts.get(Number(firstProposal.sequence)) ?? 0,
    acknowledgedRevision: Number(
      await activityFrame.executeJavaScript(
        'window.ScholarActivity.acknowledgedRevision',
      ),
    ),
  };
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

  const savedState = await p20Fixture.store.getArtifactState(
    p20Fixture.context,
    {
      artifactId: authorizedActivity.artifactId,
      versionId: authorizedActivity.versionId,
      attemptId: p20Fixture.created.attemptId,
    },
  );
  if (!savedState) throw new Error('P20 did not retain the checkpoint state.');
  const recoveryStartedAt = Date.now();
  report.stage = 'recovery-mount';
  const second = await waitFor(mount(), 10_000);
  const secondDiagnostic = diagnostics.at(-1) ?? {};
  const secondContents = webContents.fromId(
    Number(secondDiagnostic.webContentsId),
  );
  if (!secondContents)
    throw new Error('Recovered activity WebContents was not available.');
  const secondFrame = secondContents.mainFrame.framesInSubtree.find(
    (frame) => frame !== secondContents.mainFrame,
  );
  if (!secondFrame)
    throw new Error('Recovered sandboxed activity frame was not present.');
  await secondFrame.executeJavaScript(
    createActivityAdversaryScript(
      activityTargets,
      {
        sessionId: p20Fixture.sessionId,
        artifactId: authorizedActivity.artifactId,
        contentVersionId: authorizedActivity.versionId,
        attemptId: p20Fixture.created.attemptId,
        runId: second.runId,
      },
      false,
    ),
  );
  report.stage = 'recovered-state-proposal';
  const recoveredProposal = await waitFor(stateProposal, 10_000);
  const recoveredState = recoveredProposal.state as Record<string, unknown>;
  report.recovery = {
    elapsedMs: Date.now() - recoveryStartedAt,
    runId: second.runId,
    proposalPersisted: proposals.some(
      (proposal) =>
        JSON.stringify(proposal) === JSON.stringify(recoveredProposal),
    ),
    savedStateRestored:
      JSON.stringify(recoveredState.restoredState) ===
      JSON.stringify(savedState.state),
    trustedRendererSurvived: !hostWindow.webContents.isDestroyed(),
  };
  await manager.close(second.runId);

  const navigationRun = await waitFor(mount(), 10_000);
  const navigationContents = webContents.fromId(
    Number(diagnostics.at(-1)?.webContentsId),
  );
  const navigationFrame = navigationContents?.mainFrame.framesInSubtree.find(
    (frame) => frame !== navigationContents.mainFrame,
  );
  if (!navigationContents || !navigationFrame)
    throw new Error('Navigation fixture activity frame was not present.');
  navigationContents.on('will-navigate', (_event, url) =>
    navigationEvents.push({ kind: 'will-navigate', url }),
  );
  navigationContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) =>
      navigationEvents.push({
        kind: 'did-fail-load',
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      }),
  );
  await navigationFrame
    .executeJavaScript(`location.href = ${JSON.stringify(config.httpUrl)}`)
    .catch(() => undefined);
  await navigationContents.loadURL(config.httpUrl).catch(() => undefined);
  const navigationClose = await waitFor(runtimeClosed, 8_000);
  report.navigationClose = {
    runId: navigationRun.runId,
    reason: String(navigationClose.reason ?? ''),
    releaseCount: releaseCountForRun(navigationRun.runId),
  };

  const hostWindowRun = await waitFor(mount(), 10_000);
  hostWindow.destroy();
  const hostWindowClose = await waitFor(runtimeClosed, 8_000);
  report.hostWindowClose = {
    runId: hostWindowRun.runId,
    reason: String(hostWindowClose.reason ?? ''),
    releaseCount: releaseCountForRun(hostWindowRun.runId),
    hostWindowDestroyed: hostWindow.isDestroyed(),
  };

  report.diagnostics = diagnostics;
  report.closures = closures;
  report.proposalCount = proposals.length;
  report.proposalState = proposals[0]?.state ?? firstProposal.state;
  report.webrtcStateProposal = webRtcStateProposal.state;
  report.recoveredState = recoveredProposal.state;
  report.hostInteractions = interactionEvents;
  report.navigationEvents = navigationEvents;
  report.authorizationRuns = authorizationRuns;
  report.releaseCalls = [...releaseCalls.values()];
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

void run().catch(async (error: unknown) => {
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
  await cleanupForFailure?.().catch((cleanupError: unknown) => {
    process.stderr.write(
      cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError),
    );
  });
  app.exit(1);
});
