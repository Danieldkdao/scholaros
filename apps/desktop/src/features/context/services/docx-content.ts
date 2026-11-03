import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Locator } from '@scholaros/services/learning/context-contracts';
import { inspectDocxArchive } from './file-validation';

const maxDocxBytes = 10 * 1024 * 1024;
const maxExtractedCharacters = 1_000_000;
const maxParseTimeMs = 15_000;
const mammothModulePath = createRequire(
  path.join(app.getAppPath(), 'package.json'),
).resolve('mammoth');

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const mammoth = require(workerData.mammothModulePath);
    const result = await mammoth.extractRawText({
      buffer: Buffer.from(workerData.bytes),
    });
    if (!result || typeof result.value !== 'string') {
      parentPort.postMessage({ status: 'unreadable', text: '' });
      return;
    }
    const partial = result.value.length > workerData.maxCharacters;
    let text = result.value.slice(0, workerData.maxCharacters);
    if (text.length > 0 && /[\\uD800-\\uDBFF]/.test(text.at(-1)))
      text = text.slice(0, -1);
    parentPort.postMessage({ status: partial ? 'partial' : 'complete', text });
  } catch {
    parentPort.postMessage({ status: 'unreadable', text: '' });
  }
})().catch(() => parentPort.postMessage({ status: 'unreadable', text: '' }));
`;

export type DocxContentResult = {
  status: 'complete' | 'partial' | 'unreadable' | 'unsupported';
  text: string;
  locators: Locator[];
  uncertainty: string | null;
};

export type DocxContentOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type WorkerResult = {
  status: 'complete' | 'partial' | 'unreadable';
  text: string;
};

const emptyResult = (
  status: 'unreadable' | 'unsupported',
): DocxContentResult => ({
  status,
  text: '',
  locators: [],
  uncertainty: null,
});

const paragraphLocators = (text: string): Locator[] => {
  const locators: Locator[] = [];
  for (const [index, paragraph] of text.split(/\n{2,}/).entries()) {
    if (!paragraph.trim()) continue;
    if (locators.length >= 2_000) break;
    locators.push({ kind: 'paragraph', ordinal: index + 1 });
  }
  return locators;
};

const parseLimit = (value: number | undefined) =>
  Number.isFinite(value)
    ? Math.max(1, Math.min(maxParseTimeMs, Math.floor(value!)))
    : maxParseTimeMs;

export const extractDocxContent = async (
  bytes: Uint8Array,
  options: DocxContentOptions = {},
): Promise<DocxContentResult> => {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (bytes.byteLength === 0 || bytes.byteLength > maxDocxBytes)
    return emptyResult('unsupported');

  const archive = inspectDocxArchive(bytes);
  if (archive.status !== 'valid')
    return emptyResult(
      archive.status === 'unsupported' ? 'unsupported' : 'unreadable',
    );

  // Resource limits bound parsing work but do not create an OS sandbox.
  const worker = new Worker(workerSource, {
    eval: true,
    name: 'scholaros-docx-reader',
    workerData: {
      bytes: Buffer.from(bytes),
      mammothModulePath,
      maxCharacters: maxExtractedCharacters,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 8,
    },
  });

  return new Promise<DocxContentResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => undefined);
    };
    const finish = (result: DocxContentResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(
      () => finish(emptyResult('unreadable')),
      parseLimit(options.timeoutMs),
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    worker.once('message', (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('status' in message) ||
        !('text' in message) ||
        typeof message.text !== 'string' ||
        message.text.length > maxExtractedCharacters ||
        !['complete', 'partial', 'unreadable'].includes(String(message.status))
      ) {
        finish(emptyResult('unreadable'));
        return;
      }
      const result = message as WorkerResult;
      finish({
        status: result.status,
        text: result.text,
        locators: paragraphLocators(result.text),
        uncertainty:
          result.status === 'unreadable'
            ? null
            : 'DOCX text is extracted without preserving visual formatting or heading hierarchy.',
      });
    });
    worker.once('error', () => finish(emptyResult('unreadable')));
    worker.once('exit', (code) => {
      if (code !== 0) finish(emptyResult('unreadable'));
    });
  });
};

export { inspectDocxArchive } from './file-validation';
