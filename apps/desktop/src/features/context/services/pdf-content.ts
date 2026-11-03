import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const maxPdfBytes = 10 * 1024 * 1024;
const maxPdfPages = 200;
const maxPdfCharacters = 1_000_000;
const maxParseTime = 15_000;
const pdfModulePath = createRequire(
  path.join(app.getAppPath(), 'package.json'),
).resolve('pdfjs-dist/legacy/build/pdf.mjs');

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { pathToFileURL } = require('node:url');
  const { getDocument } = await import(pathToFileURL(workerData.modulePath).href);
  const loadingTask = getDocument({
    data: new Uint8Array(workerData.bytes),
    verbosity: 0,
    useWasm: false,
  });
  try {
    const document = await loadingTask.promise;
    const text = [];
    let characters = 0;
    const pageLimit = Math.min(document.numPages, workerData.maxPages);
    let partial = document.numPages > pageLimit;
    for (let number = 1; number <= pageLimit && characters < workerData.maxCharacters; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item) => typeof item.str === 'string')
        .map((item) => item.str)
        .join(' ')
        .replace(/\\s+/g, ' ')
        .trim();
      page.cleanup();
      const separator = text.length ? '\\f' : '';
      const remaining = workerData.maxCharacters - characters - separator.length;
      const selected = pageText.slice(0, Math.max(0, remaining));
      if (selected.length < pageText.length) partial = true;
      if (selected) text.push(separator + selected);
      characters += separator.length + selected.length;
      if (selected.length < pageText.length) break;
    }
    parentPort.postMessage({
      status: partial ? 'partial' : 'complete',
      pageCount: document.numPages,
      text: text.join(''),
    });
    await loadingTask.destroy();
  } catch {
    await loadingTask.destroy().catch(() => undefined);
    parentPort.postMessage({ status: 'unreadable', pageCount: 0, text: '' });
  }
})().catch(() => parentPort.postMessage({ status: 'unreadable', pageCount: 0, text: '' }));
`;

export type PdfContentResult = {
  status: 'complete' | 'partial' | 'unreadable';
  pageCount: number;
  text: string;
};

type PdfContentOptions = {
  signal?: AbortSignal;
  maxPages?: number;
  maxCharacters?: number;
  timeoutMs?: number;
};

const unreadable = (): PdfContentResult => ({
  status: 'unreadable',
  pageCount: 0,
  text: '',
});

export const extractPdfContent = async (
  bytes: Uint8Array,
  options: PdfContentOptions = {},
): Promise<PdfContentResult> => {
  const { signal } = options;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maxPdfBytes ||
    !new TextDecoder().decode(bytes.subarray(0, 8)).startsWith('%PDF-')
  )
    return unreadable();

  const maxPages = Number.isFinite(options.maxPages)
    ? Math.max(1, Math.min(maxPdfPages, Math.floor(options.maxPages!)))
    : maxPdfPages;
  const maxCharacters = Number.isFinite(options.maxCharacters)
    ? Math.max(
        1,
        Math.min(maxPdfCharacters, Math.floor(options.maxCharacters!)),
      )
    : maxPdfCharacters;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(maxParseTime, Math.floor(options.timeoutMs!)))
    : maxParseTime;
  const worker = new Worker(workerSource, {
    eval: true,
    name: 'scholaros-pdf-reader',
    workerData: {
      bytes,
      modulePath: pdfModulePath,
      maxPages,
      maxCharacters,
    },
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 8,
    },
  });

  return new Promise<PdfContentResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate().catch(() => undefined);
    };
    const finish = (result: PdfContentResult) => {
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
    const timer = setTimeout(() => finish(unreadable()), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.once('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'status' in message &&
        ['complete', 'partial', 'unreadable'].includes(
          String(message.status),
        ) &&
        'pageCount' in message &&
        typeof message.pageCount === 'number' &&
        'text' in message &&
        typeof message.text === 'string'
      )
        finish(message as PdfContentResult);
      else finish(unreadable());
    });
    worker.once('error', () => finish(unreadable()));
    worker.once('exit', (code) => {
      if (code !== 0) finish(unreadable());
    });
  });
};
