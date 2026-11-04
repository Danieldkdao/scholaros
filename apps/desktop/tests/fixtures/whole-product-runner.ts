import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  academicEndpointFileSchema,
  type AcademicEndpointSchema,
} from '../../src/services/academic/contracts';
import { academicRequest } from '../../src/services/academic/transport';
import type { PdfContentResult } from '../../src/features/context/services/pdf-content';

export type EvidenceStatus = 'passed' | 'blocked' | 'failed';

type EvidenceRecord = {
  status: EvidenceStatus;
  evidence_paths: string[];
  blocking: boolean;
  reason: string;
};

type EvidenceCheck = {
  id: string;
  command_or_journey: string;
  result: EvidenceStatus;
  evidence_path: string | null;
  blocking: boolean;
  reason: string;
};

type EvidenceManifest = {
  tested_head_sha: string | null;
  requirements: Record<string, EvidenceRecord>;
  checks: EvidenceCheck[];
};

type ValidationOptions = {
  expectedHeadSha: string | null;
  expectedRequirementIds: string[];
  fileExists?: (filePath: string) => boolean;
};

export type PackagedAcademicService = {
  userDataDirectory: string;
  testApiUrl: string;
  runtimeVersions: Record<string, string>;
  pdfProbe: { complete: PdfContentResult; bounded: PdfContentResult } | null;
  endpointRequestCount: () => number;
  request: (method: string, input?: unknown) => Promise<unknown>;
  shutdown: () => Promise<void>;
  dispose: () => Promise<void>;
};

const runtimeVersionsPrefix = 'SCHOLAROS_RUNTIME_VERSIONS=';
const testApiUrlPrefix = 'SCHOLAROS_TEST_API_URL=';
const pdfProbePrefix = 'SCHOLAROS_PACKAGED_PDF_RESULT=';

export const parseAcademicEndpointFile = (
  data: unknown,
): AcademicEndpointSchema => {
  const { version, address, token } = academicEndpointFileSchema.parse(data);
  return { version, address, token };
};

export const createPdfFixture = (pages: string[]) => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages
      .map((_, index) => `${4 + index * 2} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  for (const [index, text] of pages.entries()) {
    const contentId = 5 + index * 2;
    const escaped = text
      .replaceAll('\\', '\\\\')
      .replaceAll('(', '\\(')
      .replaceAll(')', '\\)');
    const stream = `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
};

export const parseRuntimeVersions = (output: string) => {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(runtimeVersionsPrefix));
  if (!line)
    throw new Error('Packaged Electron did not report process.versions.');

  const parsed: unknown = JSON.parse(line.slice(runtimeVersionsPrefix.length));
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Packaged Electron reported invalid process.versions.');

  const versions = parsed as Record<string, unknown>;
  for (const field of ['electron', 'node', 'chrome', 'v8', 'modules'])
    if (typeof versions[field] !== 'string')
      throw new Error(
        'Packaged Electron reported incomplete process.versions.',
      );

  return parsed as Record<string, string>;
};

export const parsePackagedTestApiUrl = (output: string) => {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(testApiUrlPrefix));
  if (!line)
    throw new Error('Packaged Electron did not report its test API URL.');

  const value = line.slice(testApiUrlPrefix.length);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Packaged Electron reported an invalid test API URL.');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Packaged Electron reported an explicit 127.0.0.1 test origin.',
    );
  return value;
};

export const parsePackagedPdfProbe = (output: string) => {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(pdfProbePrefix));
  if (!line) throw new Error('Packaged Electron did not report its PDF probe.');

  const parsed: unknown = JSON.parse(line.slice(pdfProbePrefix.length));
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Packaged Electron reported an invalid PDF probe.');
  const result = parsed as {
    complete?: PdfContentResult;
    bounded?: PdfContentResult;
  };
  for (const item of [result.complete, result.bounded])
    if (
      !item ||
      !['complete', 'partial', 'unreadable'].includes(item.status) ||
      !Number.isInteger(item.pageCount) ||
      typeof item.text !== 'string'
    )
      throw new Error('Packaged Electron reported an incomplete PDF probe.');
  return result as {
    complete: PdfContentResult;
    bounded: PdfContentResult;
  };
};

const createTestProfile = async () => {
  // Keep the profile path short for macOS UNIX-domain socket limits.
  const directory = await mkdtemp(
    path.join(
      process.env.SCHOLAROS_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? tmpdir(),
      'p-',
    ),
  );
  let removed = false;

  return {
    directory,
    remove: async () => {
      if (removed) return;
      await rm(directory, { recursive: true, force: true });
      removed = true;
    },
  };
};

export const createTestEnvironment = (profileDirectory: string) => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR'])
    if (process.env[key]) environment[key] = process.env[key];

  // Preserve macOS HOME for packaged startup; isolate Electron data and temp paths.
  environment.HOME =
    process.platform === 'darwin' ? process.env.HOME : profileDirectory;
  environment.USERPROFILE = profileDirectory;
  environment.TMPDIR = profileDirectory;
  environment.TMP = profileDirectory;
  environment.TEMP = profileDirectory;
  environment.VITE_API_URL = process.env.VITE_API_URL;
  environment.APPDATA = path.join(profileDirectory, 'AppData', 'Roaming');
  environment.LOCALAPPDATA = path.join(profileDirectory, 'AppData', 'Local');
  return environment;
};

const startTestEndpoint = async () => {
  const configuredUrl = process.env.VITE_API_URL;
  if (!configuredUrl)
    throw new Error(
      'VITE_API_URL must point to the test-owned loopback endpoint.',
    );

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error('VITE_API_URL is not a valid test endpoint URL.');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('VITE_API_URL must be an explicit 127.0.0.1 test origin.');

  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    response.setHeader('connection', 'close');
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = () => {
      server.removeListener('listening', onListening);
      reject(new Error('The test-owned API endpoint could not bind.'));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  return {
    requestCount: () => requestCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
};

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }

    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });

export const startPackagedAcademicService = async (
  executablePath: string,
  options: { pdfFixture?: Uint8Array } = {},
): Promise<PackagedAcademicService> => {
  if (!path.isAbsolute(executablePath))
    throw new Error('Packaged executable path must be absolute.');

  const profile = await createTestProfile();
  let testEndpoint: Awaited<ReturnType<typeof startTestEndpoint>> | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let endpoint: AcademicEndpointSchema | null = null;
  let runtimeTestApiUrl: string | null = null;
  let testApiUrlMismatch = false;
  let runtimeVersions: Record<string, string> | null = null;
  let pdfProbe: {
    complete: PdfContentResult;
    bounded: PdfContentResult;
  } | null = null;
  let runtimeOutput = '';
  let stderrOutput = '';
  let spawnFailed = false;
  let endpointFileSeen = false;
  let lastHealthReady: boolean | null = null;
  let lastHealthFailure: string | null = null;
  let lastHealthSocketExists: boolean | null = null;
  const sanitizedStderr = () =>
    stderrOutput
      .replaceAll(profile.directory, '<test-profile>')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
      .join(' | ');
  const sanitizedStdout = () =>
    runtimeOutput
      .replaceAll(profile.directory, '<test-profile>')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
      .join(' | ');

  const stopChild = async () => {
    if (
      !child ||
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    child.kill('SIGTERM');
    if (!(await waitForExit(child, 5_000))) child.kill('SIGKILL');
    if (!(await waitForExit(child, 5_000)))
      throw new Error(
        'Test-owned packaged process did not exit after termination.',
      );
  };

  try {
    testEndpoint = await startTestEndpoint();
    const pdfFixturePath = options.pdfFixture
      ? path.join(profile.directory, 'pdf-probe.pdf')
      : null;
    if (pdfFixturePath && options.pdfFixture)
      await writeFile(pdfFixturePath, options.pdfFixture, {
        flag: 'wx',
        mode: 0o600,
      });

    const arguments_ = [
      '--academic-service',
      `--user-data-dir=${profile.directory}`,
    ];
    if (pdfFixturePath)
      arguments_.push(`--scholaros-pdf-probe=${pdfFixturePath}`);

    child = spawn(executablePath, arguments_, {
      env: createTestEnvironment(profile.directory),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', () => {
      spawnFailed = true;
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      runtimeOutput = `${runtimeOutput}${chunk}`.slice(-128 * 1024);
      try {
        runtimeTestApiUrl = parsePackagedTestApiUrl(runtimeOutput);
        testApiUrlMismatch = runtimeTestApiUrl !== process.env.VITE_API_URL;
      } catch {
        // The marker may arrive in a later stdout chunk.
      }
      try {
        runtimeVersions = parseRuntimeVersions(runtimeOutput);
      } catch {
        // The marker may arrive in a later stdout chunk.
      }
      if (pdfFixturePath) {
        try {
          pdfProbe = parsePackagedPdfProbe(runtimeOutput);
        } catch {
          // The PDF marker may arrive after the runtime versions marker.
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrOutput = `${stderrOutput}${chunk}`.slice(-8 * 1024);
    });

    const endpointPath = path.join(
      profile.directory,
      'academic-service',
      'endpoint.json',
    );
    const configuredStartTimeout = Number(
      process.env.SCHOLAROS_TEST_STARTUP_TIMEOUT_MS,
    );
    const startupTimeout =
      Number.isSafeInteger(configuredStartTimeout) && configuredStartTimeout > 0
        ? Math.min(configuredStartTimeout, 60_000)
        : 20_000;
    const deadline = Date.now() + startupTimeout;
    while (!endpoint && Date.now() < deadline) {
      if (testApiUrlMismatch)
        throw new Error(
          'The packaged API URL does not match the test-owned endpoint.',
        );
      if (spawnFailed || child.exitCode !== null) {
        const diagnostic = sanitizedStderr();
        throw new Error(
          `Test-owned packaged Electron process failed to start.${diagnostic ? ` stderr: ${diagnostic}` : ''}`,
        );
      }

      try {
        const endpointData = JSON.parse(await readFile(endpointPath, 'utf8'));
        endpointFileSeen = true;
        const candidate = parseAcademicEndpointFile(endpointData);
        lastHealthSocketExists = existsSync(candidate.address);
        const health = (await academicRequest(
          candidate,
          'health',
          undefined,
          1_000,
        )) as { ready?: unknown };
        lastHealthReady = health?.ready === true;
        lastHealthFailure = null;
        if (lastHealthReady) endpoint = candidate;
      } catch (error) {
        lastHealthReady = null;
        lastHealthFailure =
          error instanceof Error
            ? error.message.replaceAll(profile.directory, '<test-profile>')
            : 'UnknownError';
        await delay(100);
      }
    }

    if (!endpoint) {
      const diagnostic = sanitizedStderr();
      const stdout = sanitizedStdout();
      throw new Error(
        `Test-owned packaged academic service did not become ready (endpoint file: ${endpointFileSeen}, socket exists: ${lastHealthSocketExists}, health ready: ${lastHealthReady}, health failure: ${lastHealthFailure}, local API requests: ${testEndpoint?.requestCount() ?? 'not started'}, compiled API origin: ${runtimeTestApiUrl ?? 'not reported'}, runtime probe: ${runtimeVersions !== null}, PDF probe: ${pdfProbe !== null}).${diagnostic ? ` stderr: ${diagnostic}` : ''}${stdout ? ` stdout: ${stdout}` : ''}`,
      );
    }

    const runtimeDeadline = Date.now() + 5_000;
    while (!runtimeVersions && Date.now() < runtimeDeadline) await delay(25);
    if (!runtimeVersions)
      throw new Error('Packaged Electron did not report process.versions.');
    if (!runtimeTestApiUrl)
      throw new Error('Packaged Electron did not report its test API URL.');
    if (runtimeTestApiUrl !== process.env.VITE_API_URL)
      throw new Error(
        'The packaged API URL does not match the test-owned endpoint.',
      );
    const pdfDeadline = Date.now() + 20_000;
    while (pdfFixturePath && !pdfProbe && Date.now() < pdfDeadline) {
      if (runtimeOutput.includes('SCHOLAROS_PACKAGED_PDF_PROBE_FAILED'))
        throw new Error('Packaged Electron PDF.js probe failed.');
      await delay(25);
    }
    if (pdfFixturePath && !pdfProbe)
      throw new Error('Packaged Electron did not complete its PDF probe.');

    let shutdown = false;
    let disposed = false;
    const shutdownService = async () => {
      if (shutdown) return;
      await academicRequest(endpoint!, 'shutdown', undefined, 5_000).catch(
        () => undefined,
      );
      if (!(await waitForExit(child!, 10_000))) await stopChild();
      if (child!.exitCode === null && child!.signalCode === null)
        throw new Error('Test-owned packaged process is still running.');
      shutdown = true;
    };

    return {
      userDataDirectory: profile.directory,
      testApiUrl: runtimeTestApiUrl,
      runtimeVersions,
      pdfProbe,
      request: (method, input) =>
        academicRequest(endpoint!, method, input, 5_000),
      endpointRequestCount: () => testEndpoint!.requestCount(),
      shutdown: shutdownService,
      dispose: async () => {
        if (disposed) return;
        await shutdownService();
        await testEndpoint!.close();
        await profile.remove();
        disposed = true;
      },
    };
  } catch (error) {
    let cleanupError: unknown;
    try {
      await stopChild();
    } catch (error) {
      cleanupError = error;
    }
    const processExited =
      !child ||
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null;
    if (processExited) await profile.remove();
    await testEndpoint?.close().catch(() => undefined);
    if (cleanupError)
      throw new AggregateError(
        [error, cleanupError],
        'Packaged test cleanup failed.',
      );
    if (processExited) throw error;
    throw new Error(
      'Packaged process is live; its test profile was retained.',
      {
        cause: error,
      },
    );
  }
};

const addEvidencePathError = (
  errors: string[],
  id: string,
  filePath: string,
  fileExists: (filePath: string) => boolean,
) => {
  if (!path.isAbsolute(filePath)) {
    errors.push(`${id}: evidence path must be absolute`);
    return;
  }
  if (!fileExists(filePath)) errors.push(`${id}: evidence path does not exist`);
};

export const validateEvidenceManifest = (
  manifest: EvidenceManifest,
  options: ValidationOptions,
) => {
  const errors: string[] = [];
  const fileExists = options.fileExists ?? existsSync;

  if (manifest.tested_head_sha !== options.expectedHeadSha)
    errors.push('manifest: tested head does not match the expected head');

  const actualRequirementIds = Object.keys(manifest.requirements).sort();
  const expectedRequirementIds = [...options.expectedRequirementIds].sort();
  for (const id of expectedRequirementIds)
    if (!manifest.requirements[id])
      errors.push(`${id}: evidence row is missing`);
  for (const id of actualRequirementIds)
    if (!expectedRequirementIds.includes(id))
      errors.push(`${id}: unexpected evidence row`);

  for (const [id, record] of Object.entries(manifest.requirements)) {
    if (!['passed', 'blocked', 'failed'].includes(record.status)) {
      errors.push(`${id}: invalid evidence status`);
      continue;
    }
    if (!Array.isArray(record.evidence_paths)) {
      errors.push(`${id}: evidence_paths must be an array`);
      continue;
    }
    if (typeof record.blocking !== 'boolean')
      errors.push(`${id}: blocking must be boolean`);
    if (typeof record.reason !== 'string' || !record.reason.trim())
      errors.push(`${id}: reason is required`);

    if (record.status === 'failed')
      errors.push(`${id}: failed result blocks release`);
    if (record.status === 'blocked' && record.blocking)
      errors.push(`${id}: blocking item is blocked`);
    if (record.status === 'passed' && record.evidence_paths.length === 0)
      errors.push(`${id}: passed result requires existing evidence`);
    if (record.status === 'failed' && record.evidence_paths.length === 0)
      errors.push(`${id}: failed result requires evidence`);
    if (
      record.status === 'blocked' &&
      !record.blocking &&
      record.evidence_paths.length === 0
    )
      errors.push(`${id}: nonblocking limitation requires evidence`);

    for (const filePath of record.evidence_paths)
      addEvidencePathError(errors, id, filePath, fileExists);
  }

  for (const check of manifest.checks) {
    if (!check.command_or_journey.trim())
      errors.push(`${check.id}: command_or_journey is required`);
    if (!['passed', 'blocked', 'failed'].includes(check.result)) {
      errors.push(`${check.id}: invalid check result`);
      continue;
    }
    if (typeof check.blocking !== 'boolean')
      errors.push(`${check.id}: blocking must be boolean`);
    if (typeof check.reason !== 'string' || !check.reason.trim())
      errors.push(`${check.id}: reason is required`);
    if (check.result === 'failed')
      errors.push(`${check.id}: failed result blocks release`);
    if (check.result === 'blocked' && check.blocking)
      errors.push(`${check.id}: blocking check is blocked`);
    if (check.result === 'passed' && !check.evidence_path)
      errors.push(`${check.id}: passed check requires existing evidence`);
    if (check.result === 'failed' && !check.evidence_path)
      errors.push(`${check.id}: failed check requires evidence`);
    if (check.result === 'blocked' && !check.blocking && !check.evidence_path)
      errors.push(`${check.id}: nonblocking limitation requires evidence`);
    if (check.evidence_path)
      addEvidencePathError(errors, check.id, check.evidence_path, fileExists);
  }

  return errors;
};
