export type ResourceIdentityScope = {
  accountId: string;
  connectionId: string;
  courseId: string;
  kind: 'assignments' | 'announcements';
};

export type ResourceIdentityRecord = {
  title: string;
  sourceId: string | null;
  url: string | null;
  evidence: {
    sourceUrl: string;
    excerpts: readonly string[];
    targetIds?: readonly string[];
  };
  state?: string;
};

export type ResourceIdentityObservation<T extends ResourceIdentityRecord> = {
  scope: ResourceIdentityScope;
  resource: T;
};

export type ResourceIdentityCandidate<T extends ResourceIdentityRecord> = {
  scope: ResourceIdentityScope;
  aliases: string[];
  resources: T[];
};

export type ResourceIdentityAmbiguity<T extends ResourceIdentityRecord> = {
  scope: ResourceIdentityScope;
  reason: 'ambiguous-fallback' | 'conflicting-source-ids' | 'conflicting-state';
  resources: T[];
};

export type ResourceIdentityResult<T extends ResourceIdentityRecord> = {
  candidates: ResourceIdentityCandidate<T>[];
  ambiguities: ResourceIdentityAmbiguity<T>[];
};

export type ResourceIdentityKeys = {
  aliases: string[];
  sourceId: string | null;
  urlId: string | null;
  itemUrl: string | null;
  fallback: string | null;
};

type IdentifiedObservation<T extends ResourceIdentityRecord> = {
  observation: ResourceIdentityObservation<T>;
  scopeKey: string;
  aliases: string[];
  strongAliases: string[];
  verifiedSourceId: string | null;
  verifiedUrlId: string | null;
  verifiedItemUrl: string | null;
  fallbackAlias: string | null;
  identityConflict: boolean;
  state: string | null;
  stableKey: string;
};

const scopeKey = (scope: ResourceIdentityScope) =>
  JSON.stringify([
    scope.accountId,
    scope.connectionId,
    scope.courseId,
    scope.kind,
  ]);

const normalizeUrl = (value: string) => {
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
};

const normalizeTitle = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'evidence')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
};

const hasExactToken = (text: string, token: string) => {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
    'iu',
  ).test(text);
};

const sourceIdIsVerified = (resource: ResourceIdentityRecord) => {
  if (!resource.sourceId) return false;
  const sources = [
    resource.url,
    resource.evidence.sourceUrl,
    ...resource.evidence.excerpts,
  ].filter((value): value is string => !!value);
  return sources.some((source) => {
    let decoded = source;
    try {
      decoded = decodeURIComponent(source);
    } catch {
      // Malformed percent escapes remain comparable as written.
    }
    return hasExactToken(decoded, resource.sourceId!);
  });
};

const itemIdFromUrl = (value: string) => {
  try {
    const url = new URL(value);
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const collectionIndex = parts.findIndex((part) =>
      /^(?:assignment|assignments|announcement|announcements)$/i.test(part),
    );
    const queryIds = [...url.searchParams.entries()].flatMap(([key, id]) =>
      (/^(?:assignment_?id|announcement_?id)$/i.test(key) ||
        (key.toLowerCase() === 'id' && collectionIndex === parts.length - 1)) &&
      id
        ? [id]
        : [],
    );
    if (queryIds.length === 1) return queryIds[0]!;
    if (collectionIndex < 0 || collectionIndex !== parts.length - 2)
      return null;
    return parts.at(-1) ?? null;
  } catch {
    return null;
  }
};

const isVerifiedItemUrl = (itemUrl: string, sourcePageUrl: string | null) =>
  itemUrl !== sourcePageUrl || !!itemIdFromUrl(itemUrl);

const identify = <T extends ResourceIdentityRecord>(
  observation: ResourceIdentityObservation<T>,
): IdentifiedObservation<T> => {
  const { resource, scope } = observation;
  const sourcePageUrl = normalizeUrl(resource.evidence.sourceUrl);
  const itemUrl = resource.url ? normalizeUrl(resource.url) : null;
  const verifiedItemUrl =
    itemUrl && isVerifiedItemUrl(itemUrl, sourcePageUrl) ? itemUrl : null;
  const verifiedSourceId = sourceIdIsVerified(resource)
    ? resource.sourceId
    : null;
  const observedUrlId = verifiedItemUrl ? itemIdFromUrl(verifiedItemUrl) : null;
  const identityConflict =
    !!verifiedSourceId && !!observedUrlId && verifiedSourceId !== observedUrlId;
  const urlSourceId = identityConflict ? null : observedUrlId;
  const strongAliases = [
    ...(verifiedSourceId ? [`id:${verifiedSourceId}`] : []),
    ...(urlSourceId ? [`id:${urlSourceId}`] : []),
    ...(verifiedItemUrl ? [`url:${verifiedItemUrl}`] : []),
  ];
  const fallbackAlias =
    strongAliases.length === 0 && sourcePageUrl
      ? `fallback:${sourcePageUrl}:${normalizeTitle(resource.title)}`
      : null;
  const aliases = [
    ...new Set([...strongAliases, ...(fallbackAlias ? [fallbackAlias] : [])]),
  ].sort();
  const state =
    resource.state && resource.state !== 'unknown' ? resource.state : null;
  const stableKey = JSON.stringify([
    scopeKey(scope),
    aliases,
    stableValue(resource),
  ]);
  return {
    observation,
    scopeKey: scopeKey(scope),
    aliases,
    strongAliases: aliases.filter((alias) => !alias.startsWith('fallback:')),
    verifiedSourceId,
    verifiedUrlId: urlSourceId,
    verifiedItemUrl,
    fallbackAlias,
    identityConflict,
    state,
    stableKey,
  };
};

const intersects = (left: string[], right: string[]) =>
  left.some((value) => right.includes(value));

const sameFallbackCandidate = <T extends ResourceIdentityRecord>(
  left: IdentifiedObservation<T>,
  right: IdentifiedObservation<T>,
) => !!left.fallbackAlias && left.fallbackAlias === right.fallbackAlias;

const sameKnownState = <T extends ResourceIdentityRecord>(
  left: IdentifiedObservation<T>,
  right: IdentifiedObservation<T>,
) => !left.state || !right.state || left.state === right.state;

const relatedSourcePages = (left: string, right: string) => {
  try {
    const first = new URL(left);
    const second = new URL(right);
    first.hash = '';
    second.hash = '';
    if (first.href === second.href) return true;
    const isParent = (parent: URL, child: URL) =>
      parent.origin === child.origin &&
      parent.search === child.search &&
      child.pathname.startsWith(`${parent.pathname.replace(/\/+$/, '')}/`);
    return isParent(first, second) || isParent(second, first);
  } catch {
    return false;
  }
};

const resourceKey = (resource: ResourceIdentityRecord) =>
  JSON.stringify(stableValue(resource));

export const resourceIdentityKeys = <T extends ResourceIdentityRecord>(
  scope: ResourceIdentityScope,
  resource: T,
): ResourceIdentityKeys => {
  const identified = identify({ scope, resource });
  return {
    aliases: identified.aliases,
    sourceId: identified.verifiedSourceId,
    urlId: identified.verifiedUrlId,
    itemUrl: identified.verifiedItemUrl,
    fallback: identified.fallbackAlias,
  };
};

const isDetailResource = (resource: ResourceIdentityRecord) =>
  !!resource.url &&
  normalizeUrl(resource.url) === normalizeUrl(resource.evidence.sourceUrl) &&
  !!itemIdFromUrl(resource.url);

const fieldKey = (value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>;
    const { original, ...rest } = fields;
    const stableFields = stableValue(rest);
    return JSON.stringify({
      ...(stableFields as Record<string, unknown>),
      ...(fields.kind === 'unresolved' ? { original } : {}),
    });
  }
  return JSON.stringify(stableValue(value));
};

const hasConflictingFields = (resources: ResourceIdentityRecord[]) => {
  const fields = new Set(
    resources.flatMap((resource) => Object.keys(resource)),
  );
  fields.delete('evidence');
  fields.delete('sourceId');
  fields.delete('url');
  for (const field of fields) {
    const values = resources.flatMap((resource) => {
      const value = (resource as unknown as Record<string, unknown>)[field];
      if (
        value === null ||
        value === undefined ||
        value === '' ||
        (field === 'state' && value === 'unknown') ||
        Array.isArray(value)
      )
        return [];
      return [fieldKey(value)];
    });
    if (new Set(values).size > 1) return true;
  }
  return false;
};

export const mergeResourceIdentityCandidate = <
  T extends ResourceIdentityRecord,
>(
  resources: T[],
): { resource: T | null; ambiguous: boolean } => {
  if (!resources.length) return { resource: null, ambiguous: false };
  const details = resources.filter(isDetailResource);
  const base = details[0] ?? resources[0]!;
  const ambiguous = hasConflictingFields(resources) && details.length !== 1;
  const merged = { ...base } as unknown as Record<string, unknown>;
  const fields = new Set(
    resources.flatMap((resource) => Object.keys(resource)),
  );
  fields.delete('evidence');
  fields.delete('sourceId');
  fields.delete('url');
  for (const field of fields) {
    const values = resources.flatMap((resource) => {
      const value = (resource as unknown as Record<string, unknown>)[field];
      return value === null ||
        value === undefined ||
        (field === 'state' && value === 'unknown')
        ? []
        : [value];
    });
    if (values.some(Array.isArray)) {
      merged[field] = [
        ...new Map(
          values.flatMap((value) =>
            Array.isArray(value)
              ? value.map(
                  (item) => [JSON.stringify(stableValue(item)), item] as const,
                )
              : [[JSON.stringify(stableValue(value)), value] as const],
          ),
        ).values(),
      ];
      continue;
    }
    if (
      values.length &&
      (merged[field] === null ||
        merged[field] === undefined ||
        (field === 'state' && merged[field] === 'unknown'))
    )
      merged[field] = values[0];
  }
  const verifiedSourceId = resources.find(sourceIdIsVerified)?.sourceId ?? null;
  const verifiedItemUrl =
    resources.find((resource) => {
      const itemUrl = resource.url ? normalizeUrl(resource.url) : null;
      const sourceUrl = normalizeUrl(resource.evidence.sourceUrl);
      return !!itemUrl && isVerifiedItemUrl(itemUrl, sourceUrl);
    })?.url ?? null;
  const sameSourcePage = resources.every(
    (resource) =>
      normalizeUrl(resource.evidence.sourceUrl) ===
      normalizeUrl(base.evidence.sourceUrl),
  );
  let evidence = base.evidence;
  if (sameSourcePage) {
    const excerpts = [
      ...new Set(resources.flatMap((resource) => resource.evidence.excerpts)),
    ];
    const targetIds = [
      ...new Set(
        resources.flatMap((resource) => resource.evidence.targetIds ?? []),
      ),
    ];
    if (excerpts.length > 4 || targetIds.length > 30)
      return { resource: null, ambiguous: true };
    evidence = {
      ...base.evidence,
      excerpts,
      ...(base.evidence.targetIds ? { targetIds } : {}),
    };
  }
  return {
    resource: {
      ...merged,
      sourceId: verifiedSourceId,
      url: verifiedItemUrl,
      evidence,
    } as T,
    ambiguous,
  };
};

export const reconcileResourceIdentities = <T extends ResourceIdentityRecord>(
  observations: ResourceIdentityObservation<T>[],
): ResourceIdentityResult<T> => {
  const identified = observations
    .map(identify)
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey));
  const parents = identified.map((_, index) => index);
  const sourceIds = identified.map(
    (item) => new Set(item.verifiedSourceId ? [item.verifiedSourceId] : []),
  );
  const states = identified.map(
    (item) => new Set(item.state ? [item.state] : []),
  );
  const find = (index: number): number => {
    if (parents[index] !== index) parents[index] = find(parents[index]!);
    return parents[index]!;
  };
  const ambiguities = new Map<string, ResourceIdentityAmbiguity<T>>();
  for (const item of identified)
    if (item.identityConflict) {
      const resource = item.observation.resource;
      const key = JSON.stringify([
        item.scopeKey,
        'conflicting-source-ids',
        [resourceKey(resource)],
      ]);
      ambiguities.set(key, {
        scope: item.observation.scope,
        reason: 'conflicting-source-ids',
        resources: [resource],
      });
    }
  const addAmbiguity = (
    left: IdentifiedObservation<T>,
    right: IdentifiedObservation<T>,
    reason: ResourceIdentityAmbiguity<T>['reason'],
  ) => {
    const resources = [
      left.observation.resource,
      right.observation.resource,
    ].sort((first, second) =>
      resourceKey(first).localeCompare(resourceKey(second)),
    );
    const key = JSON.stringify([
      left.scopeKey,
      reason,
      resources.map(resourceKey),
    ]);
    ambiguities.set(key, {
      scope: left.observation.scope,
      reason,
      resources,
    });
  };

  for (let leftIndex = 0; leftIndex < identified.length; leftIndex += 1) {
    const left = identified[leftIndex]!;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < identified.length;
      rightIndex += 1
    ) {
      const right = identified[rightIndex]!;
      if (left.scopeKey !== right.scopeKey) continue;
      const sharedUrl =
        !!left.verifiedItemUrl &&
        left.verifiedItemUrl === right.verifiedItemUrl;
      if (
        sharedUrl &&
        left.verifiedSourceId &&
        right.verifiedSourceId &&
        left.verifiedSourceId !== right.verifiedSourceId
      ) {
        addAmbiguity(left, right, 'conflicting-source-ids');
        continue;
      }
      const sharesStrongIdentity = intersects(
        left.strongAliases,
        right.strongAliases,
      );
      if (sharesStrongIdentity && !sameKnownState(left, right)) {
        addAmbiguity(left, right, 'conflicting-state');
        continue;
      }
      if (sharesStrongIdentity) {
        const leftRoot = find(leftIndex);
        const rightRoot = find(rightIndex);
        const mergedSourceIds = new Set([
          ...sourceIds[leftRoot]!,
          ...sourceIds[rightRoot]!,
        ]);
        const mergedStates = new Set([
          ...states[leftRoot]!,
          ...states[rightRoot]!,
        ]);
        if (mergedSourceIds.size > 1) {
          addAmbiguity(left, right, 'conflicting-source-ids');
          continue;
        }
        if (mergedStates.size > 1) {
          addAmbiguity(left, right, 'conflicting-state');
          continue;
        }
        if (leftRoot !== rightRoot) {
          parents[rightRoot] = leftRoot;
          sourceIds[leftRoot] = mergedSourceIds;
          states[leftRoot] = mergedStates;
        }
        continue;
      }
      if (sameFallbackCandidate(left, right)) {
        if (
          resourceKey(left.observation.resource) ===
          resourceKey(right.observation.resource)
        ) {
          const leftRoot = find(leftIndex);
          const rightRoot = find(rightIndex);
          if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
        } else addAmbiguity(left, right, 'ambiguous-fallback');
        continue;
      }
      const sameTitleAndRelatedPage =
        normalizeTitle(left.observation.resource.title) ===
          normalizeTitle(right.observation.resource.title) &&
        relatedSourcePages(
          left.observation.resource.evidence.sourceUrl,
          right.observation.resource.evidence.sourceUrl,
        );
      if (
        sameTitleAndRelatedPage &&
        (left.strongAliases.length === 0 || right.strongAliases.length === 0)
      )
        addAmbiguity(left, right, 'ambiguous-fallback');
    }
  }

  const groups = new Map<number, IdentifiedObservation<T>[]>();
  identified.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(item);
    groups.set(root, group);
  });
  const candidates = [...groups.values()]
    .map((group) => ({
      scope: group[0]!.observation.scope,
      aliases: [...new Set(group.flatMap((item) => item.aliases))].sort(),
      resources: group
        .map((item) => item.observation.resource)
        .sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
      key: group.map((item) => item.stableKey).sort()[0]!,
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key: _key, ...candidate }) => candidate);

  return {
    candidates,
    ambiguities: [...ambiguities.values()].sort((left, right) =>
      JSON.stringify([
        left.reason,
        left.resources.map(resourceKey),
      ]).localeCompare(
        JSON.stringify([right.reason, right.resources.map(resourceKey)]),
      ),
    ),
  };
};
