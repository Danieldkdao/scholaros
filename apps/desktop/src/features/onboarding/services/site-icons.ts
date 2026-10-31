import { net } from 'electron';
import { isAcademicUrl } from '../lib/browser-policy';

const iconBudgetBytes = 64 * 1024;

const readableIconUrl = (declared: string | null) => {
  if (!declared) return null;
  try {
    const url = new URL(declared);
    // The page chooses its own branding host, so the address is checked the
    // same way every other outbound navigation is rather than pinned to the
    // site it was declared on.
    return isAcademicUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
};

const readIcon = async (url: string) => {
  const response = await net.fetch(url, {
    credentials: 'omit',
    redirect: 'follow',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return null;
  const contentType = (response.headers.get('content-type') ?? '').split(
    ';',
  )[0];
  if (!contentType?.startsWith('image/')) return null;
  const body = await response.arrayBuffer();
  if (!body.byteLength || body.byteLength > iconBudgetBytes) return null;
  return `data:${contentType};base64,${Buffer.from(body).toString('base64')}`;
};

// Best-effort by design: a missing or oversized icon must never fail a connect
// run, so every path reports null and the card falls back to a globe.
export const fetchSiteIcon = async (
  host: string,
  declaredIconUrl: string | null,
): Promise<string | null> => {
  const declared = readableIconUrl(declaredIconUrl);
  const candidates = [
    ...(declared ? [declared] : []),
    `https://${host}/favicon.ico`,
  ];
  for (const candidate of candidates) {
    try {
      const icon = await readIcon(candidate);
      if (icon) return icon;
    } catch {
      // Try the next address; the page is offline or does not serve one.
    }
  }
  return null;
};
