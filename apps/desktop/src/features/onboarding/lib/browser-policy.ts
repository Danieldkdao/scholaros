const literalAddressPattern = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/;
const reservedHostSuffixes = [
  '.local',
  '.localhost',
  '.internal',
  '.localdomain',
  '.lan',
];

const credentialParameterNames = new Set([
  'access_token',
  'api_key',
  'apikey',
  'aspnet_sessionid',
  'auth',
  'authorization',
  'authtoken',
  'bearer',
  'code',
  'cookie',
  'id_token',
  'jsessionid',
  'key',
  'logout_token',
  'oauth_verifier',
  'pass',
  'passwd',
  'password',
  'phpsessid',
  'refresh_token',
  'secret',
  'session',
  'sessionid',
  'sid',
  'sig',
  'signature',
  'sso_ticket',
  'state',
  'ticket',
  'token',
]);

let blockedWords: string[] = [];

export const configureBrowserPolicy = (words: string[]) => {
  blockedWords = words.map((word) => word.trim().toLowerCase()).filter(Boolean);
};

const decodeRepeatedly = (value: string) => {
  let current = value;
  for (let pass = 0; pass < 6; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
};

const segmentTokens = (value: string) => {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const separated = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const joined = normalized.replace(/[^a-z0-9]+/g, '');
  return joined ? [...separated, joined] : separated;
};

const namesAction = (segments: string[]) =>
  segments.some((segment) => {
    const decoded = decodeRepeatedly(segment);
    if (decoded === null) return true;
    return segmentTokens(decoded).some((token) => blockedWords.includes(token));
  });

export const isAcademicUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443') &&
      host.includes('.') &&
      host !== 'localhost' &&
      !reservedHostSuffixes.some((suffix) => host.endsWith(suffix)) &&
      // Literal addresses, including loopback, link-local and metadata ranges.
      !literalAddressPattern.test(host)
    );
  } catch {
    return false;
  }
};

// Match on name tokens so access_key and session_id are caught too.
const hasCredentialName = (name: string) => {
  const decoded = decodeRepeatedly(name);
  return (
    decoded === null ||
    segmentTokens(decoded).some((token) => credentialParameterNames.has(token))
  );
};

const fragmentHasCredentials = (fragment: string) => {
  const decoded = decodeRepeatedly(fragment);
  if (decoded === null) return true;
  const query = decoded.includes('?')
    ? decoded.slice(decoded.indexOf('?') + 1)
    : decoded.slice(1);
  return [...new URLSearchParams(query).keys()].some(hasCredentialName);
};

type UrlInspection = {
  url: URL;
  host: string;
  unsafe: boolean;
  credential: boolean;
};

const inspectUrl = (value: string): UrlInspection | null => {
  if (!isAcademicUrl(value)) return null;
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const decodedPath = decodeRepeatedly(url.pathname);
  const decodedSearch = decodeRepeatedly(url.search);
  // An undecodable path or query is refused rather than guessed at.
  if (decodedPath === null || decodedSearch === null)
    return { url, host, unsafe: true, credential: false };
  const names: string[] = [];
  const values: string[] = [];
  let credential = fragmentHasCredentials(url.hash);
  for (const [name, parameterValue] of new URLSearchParams(url.search)) {
    names.push(name);
    values.push(parameterValue);
    if (hasCredentialName(name)) credential = true;
  }
  const unsafe =
    decodedPath.includes('..') ||
    namesAction([url.pathname, url.hash, ...names, ...values]);
  return { url, host, unsafe, credential };
};

export const isReadNavigation = (value: string, hosts: string[]): boolean => {
  const inspected = inspectUrl(value);
  if (!inspected || inspected.unsafe || inspected.credential) return false;
  return hosts.includes(inspected.host);
};

export const isReadOnlyEmbed = (value: string): boolean =>
  isReadNavigation(value, ['docs.google.com']) &&
  /^\/presentation\/(?:u\/\d+\/)?d\/(?:e\/)?[\w-]+\/(?:embed|pubembed|preview)\/?$/.test(
    new URL(value).pathname,
  );

// Identity is compared across navigation, snapshots, source validation, and
// persistence, so query and fragment parts that distinguish pages are kept and
// only credential-bearing parameters are removed.
export const academicPageIdentity = (value: string): string | null => {
  const inspected = inspectUrl(value);
  if (!inspected || inspected.unsafe) return null;
  const { url } = inspected;
  if (fragmentHasCredentials(url.hash)) return null;
  if (inspected.credential)
    url.search = new URLSearchParams(
      [...url.searchParams].filter(([name]) => !hasCredentialName(name)),
    ).toString();
  url.hash = url.hash.slice(0, 512);
  return url.href.slice(0, 2_048);
};
