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
  let loadingTask;
  let pageCount = 0;
  let text = '';
  try {
    const { pathToFileURL } = require('node:url');
    const { getDocument } = await import(pathToFileURL(workerData.modulePath).href);
    loadingTask = getDocument({
      data: new Uint8Array(workerData.bytes),
      verbosity: 0,
      useWasm: false,
    });
    const document = await loadingTask.promise;
    pageCount = document.numPages;
    const pages = [];
    let characters = 0;
    const pageLimit = Math.min(document.numPages, workerData.maxPages);
    let partial = document.numPages > pageLimit;
    for (let number = 1; number <= pageLimit; number += 1) {
      if (characters >= workerData.maxCharacters) {
        partial = true;
        break;
      }
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter((item) => typeof item.str === 'string')
        .map((item) => item.str)
        .join(' ')
        .replace(/\\s+/g, ' ')
        .trim();
      page.cleanup();
      const separator = number > 1 ? '\\f' : '';
      const remaining = workerData.maxCharacters - characters - separator.length;
      if (remaining < 0) {
        partial = true;
        break;
      }
      const selected = pageText.slice(0, Math.max(0, remaining));
      if (selected.length < pageText.length) partial = true;
      pages.push(separator + selected);
      characters += separator.length + selected.length;
      text = pages.join('');
      parentPort.postMessage({ type: 'progress', pageCount, text });
      if (selected.length < pageText.length) break;
      if (characters >= workerData.maxCharacters && number < pageLimit) {
        partial = true;
        break;
      }
    }
    const readableText = text.replace(/\\f/g, '').trim();
    parentPort.postMessage({
      status: readableText ? (partial ? 'partial' : 'complete') : 'unreadable',
      pageCount,
      text: readableText ? text : '',
    });
  } catch {
    const readableText = text.replace(/\\f/g, '').trim();
    parentPort.postMessage(
      readableText
        ? { status: 'partial', pageCount, text }
        : { status: 'unreadable', pageCount: 0, text: '' },
    );
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
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
    let lastProgress: PdfContentResult | null = null;
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
    const timer = setTimeout(() => {
      if (lastProgress?.text.replace(/\f/g, '').trim())
        finish({ ...lastProgress, status: 'partial' });
      else finish(unreadable());
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    worker.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) {
        finish(unreadable());
        return;
      }
      if (
        'type' in message &&
        message.type === 'progress' &&
        'pageCount' in message &&
        Number.isSafeInteger(message.pageCount) &&
        Number(message.pageCount) >= 0 &&
        'text' in message &&
        typeof message.text === 'string'
      ) {
        lastProgress = {
          status: 'partial',
          pageCount: Number(message.pageCount),
          text: message.text,
        };
        return;
      }
      if (
        'status' in message &&
        ['complete', 'partial', 'unreadable'].includes(
          String(message.status),
        ) &&
        'pageCount' in message &&
        Number.isSafeInteger(message.pageCount) &&
        Number(message.pageCount) >= 0 &&
        'text' in message &&
        typeof message.text === 'string'
      ) {
        finish(message as PdfContentResult);
        return;
      }
      finish(unreadable());
    });
    worker.once('error', () =>
      finish(
        lastProgress?.text.replace(/\f/g, '').trim()
          ? { ...lastProgress, status: 'partial' }
          : unreadable(),
      ),
    );
    worker.once('exit', (code) => {
      if (code !== 0)
        finish(
          lastProgress?.text.replace(/\f/g, '').trim()
            ? { ...lastProgress, status: 'partial' }
            : unreadable(),
        );
    });
  });
};
