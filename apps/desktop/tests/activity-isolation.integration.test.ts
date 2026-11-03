import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { getCurrentFuseWire } from '@electron/fuses';
import { build, type InlineConfig } from 'vite';
import { describe, expect, it } from 'vitest';

type SinkCounters = {
  http: number;
  webSocket: number;
  tcp: number;
  udp: number;
};

type ActivityIntegrationReport = {
  error?: string;
  processVersions?: Record<string, string>;
  electronMainPid?: number;
  electronBinaryDigest?: string;
  fuseWire?: { version: string; bytes: string };
  positiveControls?: {
    http: boolean;
    webSocket: boolean;
    udp: boolean;
    tcp: boolean;
  };
  trustedRendererProcessId?: number;
  filePickerFilesAfterUserGesture?: number;
  webRequestHttpBlocked?: boolean;
  sinkCountersBeforeRuntime?: SinkCounters;
  sinkCountersAfterRuntime?: SinkCounters;
  presentation?: {
    runId: string;
    webContentsId: number;
    processId: number;
    trustedProcessIds: number[];
    sameRunAfterResize: boolean;
    numberOfActivityViews: number;
  };
  diagnostics?: Array<{
    activityProcessId?: number;
    trustedProcessIds?: number[];
    guardCounters?: Record<string, number>;
    contentDigest?: string;
  }>;
  closures?: Array<{ reason?: string; closedAt?: number }>;
  proposalState?: Record<string, unknown>;
  proposalCount?: number;
  recovery?: {
    elapsedMs?: number;
    proposalPersisted?: boolean;
    savedStateRestored?: boolean;
    trustedRendererSurvived?: boolean;
  };
  crashRecovery?: {
    reason?: string;
    elapsedMs?: number;
    trustedRendererSurvived?: boolean;
  };
  webrtcStateProposal?: Record<string, unknown>;
  recoveredState?: Record<string, unknown>;
  activityConsoleMessages?: Array<{
    level: string;
    message: string;
    line?: number;
    sourceId?: string;
  }>;
  recoveryMs?: number;
};

const enabled = process.env.RUN_ACTIVITY_INTEGRATION === '1';
const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = resolve(desktopDirectory, 'tests/fixtures');
const nodeRequire = createRequire(import.meta.url);
const electronBinary = nodeRequire('electron') as string;

const digestFile = async (path: string) =>
  new Promise<string>((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveDigest(hash.digest('hex')));
  });

type LoopbackServer = {
  once: (event: 'error', listener: (error: Error) => void) => unknown;
  listen: (port: number, host: string, listener: () => void) => unknown;
  address: () => unknown;
};

const listen = (server: LoopbackServer, port = 0) =>
  new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object' || !('port' in address)) {
        reject(new Error('Test sink did not receive a loopback port.'));
        return;
      }
      resolvePort(Number(address.port));
    });
  });

const createLoopbackSinks = async () => {
  const counters: SinkCounters = { http: 0, webSocket: 0, tcp: 0, udp: 0 };
  const httpServer = createHttpServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host}`)
      .pathname;
    if (path === '/__counts') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(counters));
      return;
    }
    if (path === '/probe') counters.http += 1;
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.end(
      path === '/page'
        ? '<!doctype html><title>fixture</title><main id="trusted-host-secret">test-only host</main>'
        : 'test-only sink',
    );
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
  });
  httpServer.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host}`)
      .pathname;
    if (path !== '/socket') {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      counters.webSocket += 1;
      webSocketServer.emit('connection', webSocket, request);
      webSocket.close(1000, 'fixture complete');
    });
  });
  const tcpServer = createTcpServer((socket) => {
    counters.tcp += 1;
    socket.on('data', () => socket.end('test-only TCP sink'));
  });
  const udpServer = createSocket('udp4');
  udpServer.on('message', () => {
    counters.udp += 1;
  });

  const [httpPort, tcpPort] = await Promise.all([
    listen(httpServer),
    listen(tcpServer),
    new Promise<void>((resolveUdp, reject) => {
      udpServer.once('error', reject);
      udpServer.bind(0, '127.0.0.1', resolveUdp);
    }),
  ]).then((values) => [values[0], values[1]] as const);
  const udpAddress = udpServer.address();
  if (!udpAddress || typeof udpAddress === 'string')
    throw new Error('Test UDP sink did not receive a loopback port.');
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const config = {
    httpUrl: `${baseUrl}/page`,
    httpProbeUrl: `${baseUrl}/probe`,
    webSocketUrl: `ws://127.0.0.1:${httpPort}/socket`,
    stunUrl: `stun:127.0.0.1:${udpAddress.port}`,
    tcpPort,
    authSchemeUrl: 'ai.scholaros.desktop://fixture/callback',
    countsUrl: `${baseUrl}/__counts`,
  };

  return {
    config,
    counters,
    close: async () => {
      webSocketServer.clients.forEach((client) => client.terminate());
      await new Promise<void>((resolveClose) =>
        webSocketServer.close(() => resolveClose()),
      );
      await Promise.all([
        new Promise<void>((resolveClose) =>
          httpServer.close(() => resolveClose()),
        ),
        new Promise<void>((resolveClose) =>
          tcpServer.close(() => resolveClose()),
        ),
        new Promise<void>((resolveClose) =>
          udpServer.close(() => resolveClose()),
        ),
      ]);
    },
  };
};

const buildFixtureApp = async (appDirectory: string) => {
  const runtimeEntry = resolve(
    desktopDirectory,
    'src/features/study/services/activity-runtime.ts',
  );
  const runnerEntry = resolve(fixtureDirectory, 'activity-isolation-runner.ts');
  const bundleOptions: InlineConfig = {
    configFile: false,
    root: desktopDirectory,
    logLevel: 'error',
    build: {
      lib: { formats: ['cjs'] },
      emptyOutDir: false,
      outDir: appDirectory,
      rollupOptions: { external: ['electron', /^node:/] },
    },
  };

  const buildEntry = (entry: string, fileName: string): InlineConfig => ({
    ...bundleOptions,
    build: {
      ...bundleOptions.build,
      lib: { entry, formats: ['cjs'], fileName },
    },
  });

  await build(buildEntry(runtimeEntry, 'activity-runtime'));
  await build(buildEntry(runnerEntry, 'activity-isolation-runner'));
};

const fuseWireToReport = async (path: string) => {
  const fuseWire = await getCurrentFuseWire(path);
  const fuseRecord = fuseWire as unknown as Record<string, unknown>;
  const bytes = Object.entries(fuseRecord)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, value]) => String.fromCharCode(Number(value)))
    .join('');
  return { version: String(fuseRecord.version ?? 'unknown'), bytes };
};

const stopOwnedProcessGroup = async (pid: number | undefined) => {
  if (!pid) return;
  const target = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(target, 'SIGTERM');
  } catch {
    return;
  }
  await delay(350);
  try {
    process.kill(target, 'SIGKILL');
  } catch {
    return;
  }
};

const runElectronFixture = async (
  appDirectory: string,
  userDataDirectory: string,
  configPath: string,
  reportPath: string,
) => {
  const child = spawn(
    electronBinary,
    [
      appDirectory,
      `--user-data-dir=${userDataDirectory}`,
      `--activity-fixture-config=${configPath}`,
    ],
    {
      cwd: appDirectory,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString('utf8')}`.slice(-100_000);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-100_000);
  });
  let timer: NodeJS.Timeout | undefined;
  let timeoutPid: number | undefined;
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveClose, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveClose({ code, signal }));
  });
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutPid = child.pid;
      reject(
        new Error('Electron fixture exceeded its parent-watchdog deadline.'),
      );
    }, 30_000);
  });

  try {
    const exit = await Promise.race([closed, watchdog]);
    if (exit.code !== 0) {
      const fixtureReport = await readFile(reportPath, 'utf8').catch(() => '');
      throw new Error(
        `Electron fixture exited ${exit.code}: ${fixtureReport}\n${stderr || stdout}`,
      );
    }
  } catch (error) {
    await stopOwnedProcessGroup(timeoutPid ?? child.pid);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${stderr}\n${stdout}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (child.pid && child.exitCode === null)
      await stopOwnedProcessGroup(child.pid);
  }
  return { stdout, stderr };
};

describe.skipIf(!enabled)('actual Electron activity isolation', () => {
  it('proves the installed Electron boundary with real loopback positive and negative controls', async () => {
    const scratchDirectory = process.env.TMPDIR;
    if (!scratchDirectory)
      throw new Error('TMPDIR must point to the task-owned scratch directory.');
    const temporaryRoot = await mkdtemp(
      join(scratchDirectory, 'activity-isolation-'),
    );
    const appDirectory = join(temporaryRoot, 'electron-app');
    const userDataDirectory = join(temporaryRoot, 'electron-user-data');
    const filePath = join(temporaryRoot, 'fixture-only-file.txt');
    const reportPath = join(temporaryRoot, 'activity-report.json');
    const configPath = join(temporaryRoot, 'activity-config.json');
    const sinks = await createLoopbackSinks();

    try {
      await Promise.all([
        mkdir(appDirectory, { recursive: true, mode: 0o700 }),
        mkdir(userDataDirectory, { recursive: true, mode: 0o700 }),
        writeFile(filePath, 'fixture-only file sentinel', { mode: 0o600 }),
        writeFile(
          join(appDirectory, 'package.json'),
          JSON.stringify({
            name: 'scholaros-activity-isolation-fixture',
            version: '1.0.0',
            main: 'activity-isolation-runner.js',
          }),
        ),
      ]);
      await buildFixtureApp(appDirectory);
      const fuseWire = await fuseWireToReport(electronBinary);
      const config = {
        ...sinks.config,
        reportPath,
        runtimeBundlePath: join(appDirectory, 'activity-runtime.js'),
        filePath,
        electronBinaryDigest: await digestFile(electronBinary),
        fuseWire,
      };
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

      await runElectronFixture(
        appDirectory,
        userDataDirectory,
        configPath,
        reportPath,
      );
      const report = JSON.parse(
        await readFile(reportPath, 'utf8'),
      ) as ActivityIntegrationReport;
      expect(report.error).toBeUndefined();
      expect(report.processVersions?.electron).toBeTruthy();
      expect(report.processVersions?.chrome).toBeTruthy();
      expect(report.electronBinaryDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(report.fuseWire?.version).not.toBe('unknown');
      expect(report.fuseWire?.bytes).not.toBe('');

      expect(report.filePickerFilesAfterUserGesture).toBe(0);
      expect(report.webRequestHttpBlocked).toBe(true);
      expect(
        report.diagnostics?.[0].guardCounters?.blockedRequests,
        JSON.stringify({
          webRequestHttpBlocked: report.webRequestHttpBlocked,
          guardCounters: report.diagnostics?.[0].guardCounters,
          activityConsoleMessages: report.activityConsoleMessages?.filter(
            ({ message }) => message.includes(config.httpProbeUrl ?? 'probe'),
          ),
        }),
      ).toBeGreaterThan(0);
      expect(
        report.positiveControls?.udp,
        JSON.stringify({
          positiveControls: report.positiveControls,
          sinkCountersBeforeRuntime: report.sinkCountersBeforeRuntime,
        }),
      ).toBe(true);
      const before = report.sinkCountersBeforeRuntime!;
      const after = report.sinkCountersAfterRuntime!;
      expect(before.http).toBeGreaterThan(0);
      expect(before.webSocket).toBeGreaterThan(0);
      expect(before.tcp).toBeGreaterThan(0);
      expect(before.udp).toBeGreaterThan(0);
      expect(after.http - before.http).toBe(0);
      expect(after.webSocket - before.webSocket).toBe(0);
      expect(after.tcp - before.tcp).toBe(0);
      expect(after.udp - before.udp).toBe(0);

      const state = report.proposalState!;
      expect(state.origin).toBe('null');
      expect(state.protocol).toBe('about:');
      expect(state.parentIsSelf).toBe(false);
      expect(state.parentDomBlocked).toBe(true);
      expect(state.frameCount).toBe(0);
      expect(state.requireType).toBe('undefined');
      expect(state.processType).toBe('undefined');
      expect(state.bufferType).toBe('undefined');
      expect(state.moduleType).toBe('undefined');
      expect(state.scholarType).toBe('undefined');
      expect(state.authTypes).toEqual([
        'undefined',
        'undefined',
        'undefined',
        'undefined',
      ]);
      expect(state.cookie).toBe('unavailable');
      expect(state.localStorage).toBe('unavailable');
      expect(state.attackError).toBeNull();
      expect(state.fetchBlocked).toBe(true);
      expect(state.websocketBlocked).toBe(true);
      expect(state.imageBlocked).toBe(true);
      expect(state.fileBlocked).toBe(true);
      expect(state.authSchemeBlocked).toBe(true);
      expect(state.filePickerHadNoFiles).toBe(true);
      expect(state.fileSystemApiBlocked).toBe(true);
      expect(state.pasteSawNoFiles).toBe(true);
      expect(state.dropSawNoFiles).toBe(true);
      expect(state.workerBlocked).toBe(true);
      expect(state.popupWasDenied).toBe(true);
      expect(report.webrtcStateProposal?.webrtcState).toBe('attempted');
      expect(report.crashRecovery?.reason).toMatch(
        /^(renderer-gone|activity-resource-watchdog|mailbox-watchdog-timeout|renderer-unresponsive)$/,
      );
      expect(report.crashRecovery?.trustedRendererSurvived).toBe(true);

      const presentation = report.presentation!;
      expect(presentation.processId).not.toBe(report.trustedRendererProcessId);
      expect(presentation.trustedProcessIds).not.toContain(
        presentation.processId,
      );
      expect(presentation.sameRunAfterResize).toBe(true);
      expect(presentation.numberOfActivityViews).toBe(1);
      expect(report.proposalCount).toBe(3);
      expect(report.recovery?.proposalPersisted).toBe(true);
      expect(report.recovery?.savedStateRestored).toBe(true);
      expect(report.recoveredState?.restoredState).toEqual(
        report.webrtcStateProposal,
      );
      expect(report.recovery?.trustedRendererSurvived).toBe(true);
      expect(report.recoveryMs).toBeGreaterThanOrEqual(0);
      expect(report.recoveryMs).toBeLessThan(8_000);
      const evidencePath = process.env.ACTIVITY_INTEGRATION_REPORT_PATH;
      if (evidencePath) {
        await mkdir(dirname(evidencePath), { recursive: true });
        await writeFile(evidencePath, JSON.stringify(report, null, 2));
      }
    } finally {
      await sinks.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
