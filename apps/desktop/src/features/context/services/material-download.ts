import { randomUUID } from 'node:crypto';
import type { Page } from '@browserbasehq/stagehand';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';

const maxPdfBytes = 10 * 1024 * 1024;

type InPagePdfRequest =
  | { action: 'abort'; requestId: string }
  | {
      action?: 'fetch';
      requestId?: string;
      sourceOrigin?: string;
      targetUrl: string;
      maxBytes: number;
      timeoutMs?: number;
    };

type InPagePdfResult = {
  status?: number;
  contentType?: string;
  finalUrl?: string;
  base64?: string;
  reason?:
    | 'cross-origin'
    | 'too-large'
    | 'timeout'
    | 'redirect'
    | 'aborted'
    | 'fetch-failed';
  aborted?: boolean;
};

type PdfDownloadReason =
  | 'unobserved'
  | 'unsafe-url'
  | 'page-changed'
  | 'cross-origin'
  | 'too-large'
  | 'timeout'
  | 'http-error'
  | 'wrong-type'
  | 'redirect'
  | 'invalid-pdf'
  | 'fetch-failed';

export type PdfDownloadResult =
  | { status: 'complete'; url: string; bytes: Uint8Array }
  | { status: 'unreadable'; reason: PdfDownloadReason };

const unreadable = (reason: PdfDownloadReason): PdfDownloadResult => ({
  status: 'unreadable',
  reason,
});

const inPageFailureReason = (result: unknown): PdfDownloadReason => {
  if (!result || typeof result !== 'object' || !('reason' in result))
    return 'fetch-failed';
  switch (result.reason) {
    case 'cross-origin':
      return 'cross-origin';
    case 'too-large':
      return 'too-large';
    case 'timeout':
      return 'timeout';
    case 'redirect':
      return 'redirect';
    default:
      return 'fetch-failed';
  }
};

const isSamePdfTarget = (firstUrl: string, secondUrl: string) => {
  const firstIdentity = academicPageIdentity(firstUrl);
  const secondIdentity = academicPageIdentity(secondUrl);
  if (!firstIdentity || !secondIdentity) return false;
  try {
    const first = new URL(firstIdentity);
    const second = new URL(secondIdentity);
    first.hash = '';
    second.hash = '';
    return first.href === second.href;
  } catch {
    return false;
  }
};

// This function is serialized by Stagehand, so it only uses arguments and page globals.
export const readPdfInPage = async (
  request: InPagePdfRequest,
  fetcher: typeof fetch = fetch,
): Promise<InPagePdfResult> => {
  const pageGlobal = globalThis as typeof globalThis & {
    __scholarosPdfFetchControllers?: Map<string, AbortController>;
  };
  const controllers =
    pageGlobal.__scholarosPdfFetchControllers ??
    (pageGlobal.__scholarosPdfFetchControllers = new Map());
  const requestId =
    request.requestId ?? `pdf-fetch-${Date.now()}-${Math.random()}`;
  if (request.action === 'abort') {
    const controller = controllers.get(requestId);
    controller?.abort();
    return { aborted: controller !== undefined };
  }
  let target: URL;
  try {
    target = new URL(request.targetUrl);
  } catch {
    return { reason: 'fetch-failed' };
  }
  const byteLimit = 10 * 1024 * 1024;
  if (target.protocol !== 'https:' || !target.hostname)
    return { reason: 'fetch-failed' };
  if (!Number.isFinite(request.maxBytes) || request.maxBytes < 1)
    return { reason: 'too-large' };
  const maxBytes = Math.max(
    1,
    Math.min(byteLimit, Math.floor(request.maxBytes)),
  );
  const timeoutMs = Number.isFinite(request.timeoutMs)
    ? Math.max(1, Math.min(15000, Math.floor(request.timeoutMs!)))
    : 15000;
  const controller = new AbortController();
  let timedOut = false;
  controllers.set(requestId, controller);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const sourceOrigin = request.sourceOrigin
      ? new URL(request.sourceOrigin).origin
      : target.origin;
    const response = await fetcher(target.href, {
      credentials: sourceOrigin === target.origin ? 'same-origin' : 'include',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
    const responseContentType = (response: Response) =>
      (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]!
        .trim()
        .toLowerCase();
    if (
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      return { reason: 'redirect' };
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      return {
        status: response.status,
        contentType: responseContentType(response),
        finalUrl: response.url || target.href,
      };
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
      controller.abort();
      return { reason: 'too-large' };
    }
    if (!response.body) return { reason: 'fetch-failed' };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.abort();
        return { reason: 'too-large' };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let binary = '';
    for (let start = 0; start < bytes.length; start += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return {
      status: response.status,
      contentType: (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]!
        .trim()
        .toLowerCase(),
      finalUrl: response.url || target.href,
      base64: btoa(binary),
    };
  } catch {
    return {
      reason: timedOut
        ? 'timeout'
        : controller.signal.aborted
          ? 'aborted'
          : 'fetch-failed',
    };
  } finally {
    clearTimeout(timeout);
    controllers.delete(requestId);
  }
};

const waitForEvaluation = async <T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) return operation;
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

export const downloadPdfFromObservedLink = async ({
  page,
  observedPage,
  targetUrl,
  allowedHosts,
  signal,
  beforeFetch,
}: {
  page: Pick<Page, 'url' | 'evaluate'>;
  observedPage: ObservedPage;
  targetUrl: string;
  allowedHosts: string[];
  signal?: AbortSignal;
  beforeFetch?: (targetUrl: string) => Promise<void>;
}): Promise<PdfDownloadResult> => {
  const targetIdentity = academicPageIdentity(targetUrl);
  if (
    !targetIdentity ||
    !isReadNavigation(targetUrl, allowedHosts) ||
    !observedPage.links.some(
      (link) => academicPageIdentity(link.url) === targetIdentity,
    )
  )
    return unreadable(
      targetIdentity &&
        !observedPage.links.some(
          (link) => academicPageIdentity(link.url) === targetIdentity,
        )
        ? 'unobserved'
        : 'unsafe-url',
    );

  const currentUrl = await page.url();
  if (
    academicPageIdentity(currentUrl) !==
      academicPageIdentity(observedPage.url) ||
    !isReadNavigation(currentUrl, allowedHosts)
  )
    return unreadable('page-changed');

  await beforeFetch?.(targetIdentity);
  signal?.throwIfAborted();
  const latestUrl = await page.url();
  if (
    academicPageIdentity(latestUrl) !==
      academicPageIdentity(observedPage.url) ||
    !isReadNavigation(latestUrl, allowedHosts)
  )
    return unreadable('page-changed');

  const requestId = randomUUID();
  const request: InPagePdfRequest = {
    action: 'fetch',
    requestId,
    sourceOrigin: new URL(latestUrl).origin,
    targetUrl: targetIdentity,
    maxBytes: maxPdfBytes,
    timeoutMs: 15000,
  };
  const abortInPage = () => {
    void page
      .evaluate(readPdfInPage, {
        action: 'abort',
        requestId,
      })
      .catch(() => undefined);
  };
  signal?.addEventListener('abort', abortInPage, { once: true });
  let raw: InPagePdfResult;
  try {
    signal?.throwIfAborted();
    raw = await waitForEvaluation(
      page.evaluate(readPdfInPage, request),
      signal,
    );
  } finally {
    signal?.removeEventListener('abort', abortInPage);
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('status' in raw) ||
    !('contentType' in raw) ||
    !('finalUrl' in raw) ||
    !('base64' in raw)
  )
    return unreadable(inPageFailureReason(raw));

  const result = raw as InPagePdfResult;
  if (
    typeof result.status !== 'number' ||
    result.status < 200 ||
    result.status >= 300
  )
    return unreadable('http-error');
  if (
    !['application/pdf', 'application/octet-stream'].includes(
      result.contentType ?? '',
    )
  )
    return unreadable('wrong-type');
  if (
    typeof result.finalUrl !== 'string' ||
    !isReadNavigation(result.finalUrl, allowedHosts) ||
    !isSamePdfTarget(result.finalUrl, targetIdentity)
  )
    return unreadable('redirect');
  if (
    typeof result.base64 !== 'string' ||
    result.base64.length > Math.ceil((maxPdfBytes * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      result.base64,
    )
  )
    return unreadable('too-large');
  const bytes = Uint8Array.from(Buffer.from(result.base64, 'base64'));
  if (bytes.byteLength > maxPdfBytes) return unreadable('too-large');
  if (!new TextDecoder().decode(bytes.subarray(0, 8)).startsWith('%PDF-'))
    return unreadable('invalid-pdf');
  return { status: 'complete', url: result.finalUrl, bytes };
};
