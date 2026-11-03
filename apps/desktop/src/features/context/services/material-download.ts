import type { Page } from '@browserbasehq/stagehand';
import {
  academicPageIdentity,
  isReadNavigation,
} from '../../onboarding/lib/browser-policy';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';

const maxPdfBytes = 10 * 1024 * 1024;

type InPagePdfRequest = {
  sourceOrigin: string;
  targetUrl: string;
  maxBytes: number;
};

type InPagePdfResult = {
  status?: number;
  contentType?: string;
  finalUrl?: string;
  base64?: string;
  reason?: 'cross-origin' | 'too-large' | 'fetch-failed';
};

type PdfDownloadReason =
  | 'unobserved'
  | 'unsafe-url'
  | 'page-changed'
  | 'cross-origin'
  | 'too-large'
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

// This function is serialized by Stagehand, so it only uses arguments and page globals.
export const readPdfInPage = async (
  request: InPagePdfRequest,
  fetcher: typeof fetch = fetch,
): Promise<InPagePdfResult> => {
  let target: URL;
  try {
    target = new URL(request.targetUrl);
  } catch {
    return { reason: 'fetch-failed' };
  }
  const byteLimit = 10 * 1024 * 1024;
  if (target.origin !== request.sourceOrigin) return { reason: 'cross-origin' };
  const maxBytes = Math.max(
    1,
    Math.min(byteLimit, Math.floor(request.maxBytes)),
  );
  try {
    const response = await fetcher(target.href, {
      credentials: 'same-origin',
      redirect: 'follow',
      cache: 'no-store',
    });
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body?.cancel();
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
    return { reason: 'fetch-failed' };
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

  const current = new URL(currentUrl);
  const target = new URL(targetIdentity);
  if (current.origin !== target.origin) return unreadable('cross-origin');

  await beforeFetch?.(targetIdentity);
  signal?.throwIfAborted();
  const latestUrl = await page.url();
  if (
    academicPageIdentity(latestUrl) !==
      academicPageIdentity(observedPage.url) ||
    !isReadNavigation(latestUrl, allowedHosts)
  )
    return unreadable('page-changed');
  if (new URL(latestUrl).origin !== target.origin)
    return unreadable('cross-origin');

  const raw = await waitForEvaluation(
    page.evaluate(readPdfInPage, {
      sourceOrigin: current.origin,
      targetUrl: targetIdentity,
      maxBytes: maxPdfBytes,
    }),
    signal,
  );
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('status' in raw) ||
    !('contentType' in raw) ||
    !('finalUrl' in raw) ||
    !('base64' in raw)
  )
    return unreadable(
      raw &&
        typeof raw === 'object' &&
        'reason' in raw &&
        raw.reason === 'cross-origin'
        ? 'cross-origin'
        : raw &&
            typeof raw === 'object' &&
            'reason' in raw &&
            raw.reason === 'too-large'
          ? 'too-large'
          : 'fetch-failed',
    );

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
    !isReadNavigation(result.finalUrl, allowedHosts)
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
