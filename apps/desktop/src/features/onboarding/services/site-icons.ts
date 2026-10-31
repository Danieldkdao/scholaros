import { net } from 'electron';
import { isAcademicUrl } from '../lib/browser-policy';

const iconBudgetBytes = 64 * 1024;

const readableIconUrl = (declared: string | null) => {
  if (!declared) return null;
  try {
    const url = new URL(declared);
    // Branding may use a separate CDN, but its address must still pass
    // the public HTTPS checks.
    return isAcademicUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
};

const readIcon = async (url: string, signal?: AbortSignal) => {
  const response = await net.fetch(url, {
    credentials: 'omit',
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      : AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const contentType = (response.headers.get('content-type') ?? '').split(
    ';',
  )[0];
  if (!contentType?.startsWith('image/')) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > iconBudgetBytes) return null;
      chunks.push(value);
    }
    if (!size) return null;
    return `data:${contentType};base64,${Buffer.concat(chunks, size).toString('base64')}`;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

// Missing or oversized icons fall back to a globe; cancellation still stops
// the connection run instead of starting another request.
export const fetchSiteIcon = async (
  host: string,
  declaredIconUrl: string | null,
  signal?: AbortSignal,
): Promise<string | null> => {
  signal?.throwIfAborted();
  const declared = readableIconUrl(declaredIconUrl);
  const candidates = [
    ...(declared ? [declared] : []),
    `https://${host}/favicon.ico`,
  ];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      const icon = await readIcon(candidate, signal);
      signal?.throwIfAborted();
      if (icon) return icon;
    } catch {
      signal?.throwIfAborted();
      // Try the next address; the page is offline or does not serve one.
    }
  }
  return null;
};
