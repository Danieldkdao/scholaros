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

const mandatoryActionTokens = new Set([
  'accept',
  'add',
  'archive',
  'cancel',
  'checkout',
  'compose',
  'create',
  'delete',
  'destroy',
  'discard',
  'drop',
  'edit',
  'enroll',
  'erase',
  'finalize',
  'logoff',
  'logout',
  'new',
  'override',
  'post',
  'purge',
  'reject',
  'remove',
  'reply',
  'respond',
  'save',
  'send',
  'signoff',
  'signout',
  'start',
  'submit',
  'take',
  'unenroll',
  'update',
  'upload',
  'withdraw',
]);
const actionParameterNames = new Set([
  'action',
  'cmd',
  'command',
  'do',
  'function',
  'intent',
  'method',
  'op',
  'operation',
  'task',
]);
const safeReadActionNames = new Set([
  'browse',
  'fetch',
  'find',
  'get',
  'load',
  'list',
  'open',
  'preview',
  'read',
  'search',
  'show',
  'view',
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

const hasMandatoryActionToken = (value: string) => {
  const decoded = decodeRepeatedly(value);
  return (
    decoded === null ||
    segmentTokens(decoded).some((token) => mandatoryActionTokens.has(token))
  );
};

const isUnsafeActionParameter = (name: string, value: string) => {
  const normalizedName = decodeRepeatedly(name);
  const normalizedValue = decodeRepeatedly(value);
  if (normalizedName === null || normalizedValue === null) return true;
  const nameTokens = segmentTokens(normalizedName);
  if (nameTokens.some((token) => mandatoryActionTokens.has(token))) return true;
  if (!nameTokens.some((token) => actionParameterNames.has(token)))
    return false;
  const valueTokens = segmentTokens(normalizedValue);
  const words = valueTokens.length > 1 ? valueTokens.slice(0, -1) : valueTokens;
  if (words.some((token) => mandatoryActionTokens.has(token))) return true;
  if (
    nameTokens.includes('method') &&
    ['get', 'head', 'options'].includes(normalizedValue.trim().toLowerCase())
  )
    return false;
  return !words.length || !safeReadActionNames.has(words[0]!);
};

const pathHasMandatoryAction = (value: string) => {
  const decoded = decodeRepeatedly(value);
  if (decoded === null) return true;
  return decoded
    .split(/[/?#&=]+/)
    .filter(Boolean)
    .some(hasMandatoryActionToken);
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
  const fragment = decodeRepeatedly(url.hash);
  const fragmentQuery = fragment?.includes('?')
    ? fragment.slice(fragment.indexOf('?') + 1)
    : '';
  const queryEntries = [
    ...new URLSearchParams(url.search),
    ...new URLSearchParams(fragmentQuery),
  ];
  for (const [name, parameterValue] of queryEntries) {
    names.push(name);
    values.push(parameterValue);
    if (hasCredentialName(name)) credential = true;
  }
  const unsafe =
    decodedPath.includes('..') ||
    pathHasMandatoryAction(url.pathname) ||
    pathHasMandatoryAction(url.hash) ||
    queryEntries.some(([name, parameterValue]) =>
      isUnsafeActionParameter(name, parameterValue),
    ) ||
    namesAction([url.pathname, url.hash, ...names, ...values]);
  return { url, host, unsafe, credential };
};

export const isReadNavigation = (value: string, hosts: string[]): boolean => {
  const inspected = inspectUrl(value);
  if (!inspected || inspected.unsafe || inspected.credential) return false;
  return hosts.includes(inspected.host);
};

export const isReadOnlyEmbed = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (
      url.hostname !== 'docs.google.com' ||
      !/^\/presentation\/(?:u\/\d+\/)?d\/(?:e\/)?[\w-]+\/(?:embed|pubembed|preview)\/?$/.test(
        url.pathname,
      )
    )
      return false;
    const startValues = url.searchParams.getAll('start');
    if (startValues.length === 1 && startValues[0] === 'false')
      url.searchParams.delete('start');
    return isReadNavigation(url.href, ['docs.google.com']);
  } catch {
    return false;
  }
};

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

export const safeAcademicUrlPath = (value: string): string | null => {
  const inspected = inspectUrl(value);
  if (!inspected || inspected.unsafe) return null;
  const decodedPath = decodeRepeatedly(inspected.url.pathname);
  if (decodedPath === null || decodedPath.split('/').some(hasCredentialName))
    return null;
  return inspected.url.pathname.slice(0, 512);
};

export type CourseNavigationScope = {
  courseUrl: string;
  observedResourceRelationships: readonly {
    parentUrl: string;
    targetUrl: string;
  }[];
};

const courseRouteIdentity = (value: string) => {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean);
    const index = segments.findIndex((segment) =>
      [
        'c',
        'class',
        'classes',
        'course',
        'courses',
        'section',
        'sections',
      ].includes(segment.toLowerCase()),
    );
    if (index < 0) return null;
    const routeMarker = segments[index]!.toLowerCase();
    const marker =
      routeMarker === 'classes'
        ? 'class'
        : routeMarker === 'sections'
          ? 'section'
          : routeMarker === 'courses'
            ? 'course'
            : routeMarker;
    const pathId = segments[index + 1] ?? null;
    const queryIdName =
      marker === 'section'
        ? 'sectionid'
        : marker === 'class'
          ? 'classid'
          : 'courseid';
    const explicitQueryIds = [...url.searchParams.entries()]
      .filter(
        ([name]) => name.toLowerCase().replace(/[_-]/g, '') === queryIdName,
      )
      .map(([, id]) => id);
    const genericQueryIds = [...url.searchParams.entries()]
      .filter(([name]) => name.toLowerCase() === 'id')
      .map(([, id]) => id);
    const queryIds =
      explicitQueryIds.length > 0
        ? explicitQueryIds
        : pathId === null
          ? genericQueryIds
          : [];
    const queryId = queryIds[0] ?? null;
    const ids = [...(pathId === null ? [] : [pathId]), ...queryIds];
    return {
      origin: url.origin,
      marker,
      id: queryId ?? pathId,
      conflicted: new Set(ids).size > 1,
    };
  } catch {
    return null;
  }
};

export const hasCourseRouteIdentity = (value: string) => {
  const route = courseRouteIdentity(value);
  return !!route && (!!route.id || route.conflicted);
};

const isSiblingCoursePath = (courseUrl: string, targetUrl: string) => {
  const course = courseRouteIdentity(courseUrl);
  const target = courseRouteIdentity(targetUrl);
  if (!course || !target || course.origin !== target.origin) return false;
  if (course.conflicted || target.conflicted) return true;
  if (course.marker !== target.marker) return false;
  if (course.id === null) return target.id !== null;
  return target.id !== null && course.id !== target.id;
};

const pathIsWithinCourse = (courseUrl: string, targetUrl: string) => {
  try {
    const course = new URL(courseUrl);
    const target = new URL(targetUrl);
    const path = course.pathname.replace(/\/+$/, '') || '/';
    return (
      course.origin === target.origin &&
      (target.pathname === path ||
        (path !== '/' && target.pathname.startsWith(`${path}/`)))
    );
  } catch {
    return false;
  }
};

export const isCourseNavigationTarget = (
  value: string,
  scope: CourseNavigationScope,
  hosts: string[],
) => {
  const targetIdentity = academicPageIdentity(value);
  const courseIdentity = academicPageIdentity(scope.courseUrl);
  if (
    !targetIdentity ||
    !courseIdentity ||
    !isReadNavigation(scope.courseUrl, hosts) ||
    !isReadNavigation(value, hosts) ||
    isSiblingCoursePath(scope.courseUrl, value)
  )
    return false;
  const isPathMember = (url: string) =>
    !isSiblingCoursePath(scope.courseUrl, url) &&
    pathIsWithinCourse(scope.courseUrl, url);
  if (isPathMember(value)) return true;
  const related = new Set<string>([courseIdentity]);
  for (
    let pass = 0;
    pass < scope.observedResourceRelationships.length;
    pass += 1
  ) {
    let changed = false;
    for (const relationship of scope.observedResourceRelationships) {
      const parentIdentity = academicPageIdentity(relationship.parentUrl);
      const relatedIdentity = academicPageIdentity(relationship.targetUrl);
      if (
        !parentIdentity ||
        !relatedIdentity ||
        (!related.has(parentIdentity) &&
          !isPathMember(relationship.parentUrl)) ||
        isSiblingCoursePath(scope.courseUrl, relationship.targetUrl) ||
        !isReadNavigation(relationship.targetUrl, hosts)
      )
        continue;
      if (!related.has(relatedIdentity)) {
        related.add(relatedIdentity);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return related.has(targetIdentity);
};
