import { expect, it } from 'vitest';
import {
  mergeResourceIdentityCandidate,
  reconcileResourceIdentities,
  resourceIdentityKeys,
  type ResourceIdentityScope,
} from '../resources/identity';

const biologyScope = {
  accountId: 'account-1',
  connectionId: 'connection-1',
  courseId: 'biology-101',
  kind: 'assignments' as const,
};

type IdentityRecord = {
  title: string;
  sourceId: string | null;
  url: string | null;
  state: string;
  due: string | null;
  evidence: {
    sourceUrl: string;
    excerpts: string[];
    targetIds?: string[];
  };
};

const record = (
  title: string,
  overrides: Partial<IdentityRecord> = {},
): IdentityRecord => ({
  title,
  sourceId: null,
  url: null,
  state: 'active-unsubmitted',
  due: null,
  evidence: {
    sourceUrl: 'https://school.example/courses/biology/assignments',
    excerpts: [`${title} details`],
  },
  ...overrides,
});

const observation = (
  resource: IdentityRecord,
  scope: ResourceIdentityScope = biologyScope,
) => ({ scope, resource });

it('keeps required nullable fields when no observation supplies a value', () => {
  const resource = record('Worksheet', { due: null });

  expect(mergeResourceIdentityCandidate([resource]).resource).toMatchObject({
    due: null,
  });
});

it('preserves a same-page detail URL when supporting targets are present', () => {
  const detailUrl = 'https://school.example/assignments/123';
  const detail = record('Worksheet 123', {
    url: detailUrl,
    evidence: {
      sourceUrl: detailUrl,
      excerpts: ['Worksheet 123'],
      targetIds: ['supporting-link'],
    },
  });

  const merged = mergeResourceIdentityCandidate([detail]);

  expect(merged.resource?.url).toBe(detailUrl);
  expect(
    resourceIdentityKeys(biologyScope, merged.resource!).aliases,
  ).toContain('id:123');
});

it('does not treat a conflicting URL-derived ID as an alias for an explicit ID', () => {
  const conflicting = record('Worksheet', {
    sourceId: 'source-a',
    url: 'https://school.example/assignments/url-b',
    evidence: {
      sourceUrl: 'https://school.example/courses/biology/assignments',
      excerpts: ['Worksheet source-a'],
      targetIds: [],
    },
  });

  const keys = resourceIdentityKeys(biologyScope, conflicting);
  const result = reconcileResourceIdentities([observation(conflicting)]);

  expect(keys.sourceId).toBe('source-a');
  expect(keys.urlId).toBeNull();
  expect(keys.aliases).not.toContain('id:url-b');
  expect(result.ambiguities).toContainEqual(
    expect.objectContaining({ reason: 'conflicting-source-ids' }),
  );
});

it('reconciles all duplicate pairs in a batch independent of their order', () => {
  const first = record('Lab report', {
    sourceId: 'a1',
    url: 'https://school.example/assignments/a1',
    evidence: {
      sourceUrl: 'https://school.example/courses/biology/assignments',
      excerpts: ['Lab report a1 details'],
    },
  });
  const second = record('Reading quiz', {
    sourceId: 'a2',
    url: 'https://school.example/assignments/a2',
    evidence: {
      sourceUrl: 'https://school.example/courses/biology/assignments',
      excerpts: ['Reading quiz a2 details'],
    },
  });
  const input = [first, second, first, second].map((resource) =>
    observation(resource),
  );
  const reconciled = reconcileResourceIdentities(input);
  const reversed = reconcileResourceIdentities([...input].reverse());

  expect(reconciled.candidates).toHaveLength(2);
  expect(reconciled.candidates.map((candidate) => candidate.resources)).toEqual(
    reversed.candidates.map((candidate) => candidate.resources),
  );
  expect(reconciled.candidates.map((candidate) => candidate.resources)).toEqual(
    [
      [first, first],
      [second, second],
    ],
  );
});

it('connects verified ID-only and individual-URL observations', () => {
  const byId = record('Worksheet 1', {
    sourceId: 'wk-1',
    evidence: {
      sourceUrl: 'https://school.example/courses/biology/assignments',
      excerpts: ['Worksheet 1 wk-1'],
    },
  });
  const byUrl = record('Worksheet 1', {
    url: 'https://school.example/assignments/wk-1',
    evidence: {
      sourceUrl: 'https://school.example/courses/biology/assignments',
      excerpts: ['Worksheet 1'],
    },
  });

  const result = reconcileResourceIdentities([
    observation(byId),
    observation(byUrl),
  ]);

  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.resources).toHaveLength(2);
});

it('does not treat a shared collection URL as each assignment URL', () => {
  const collectionUrl = 'https://school.example/courses/biology/assignments';
  const first = record('Worksheet 1', {
    url: collectionUrl,
    evidence: {
      sourceUrl: collectionUrl,
      excerpts: ['Worksheet 1'],
      targetIds: [],
    },
  });
  const second = record('Worksheet 2', {
    url: collectionUrl,
    evidence: {
      sourceUrl: collectionUrl,
      excerpts: ['Worksheet 2'],
      targetIds: [],
    },
  });

  const result = reconcileResourceIdentities([
    observation(first),
    observation(second),
  ]);

  expect(result.candidates).toHaveLength(2);
  expect(result.candidates.map((candidate) => candidate.aliases)).toEqual([
    ['fallback:https://school.example/courses/biology/assignments:worksheet 1'],
    ['fallback:https://school.example/courses/biology/assignments:worksheet 2'],
  ]);
});

it('marks a same-title collection and detail route as ambiguous without identity evidence', () => {
  const collectionUrl = 'https://school.example/courses/biology/assignments';
  const collection = record('Worksheet 1', {
    evidence: { sourceUrl: collectionUrl, excerpts: ['Worksheet 1'] },
  });
  const detail = record('Worksheet 1', {
    url: `${collectionUrl}/123`,
    evidence: {
      sourceUrl: `${collectionUrl}/123`,
      excerpts: ['Worksheet 1'],
      targetIds: [],
    },
  });

  const result = reconcileResourceIdentities([
    observation(collection),
    observation(detail),
  ]);

  expect(result.candidates).toHaveLength(2);
  expect(result.ambiguities).toContainEqual(
    expect.objectContaining({ reason: 'ambiguous-fallback' }),
  );
});

it('keeps same-title records distinct and reports an ambiguous fallback collision', () => {
  const first = record('Weekly reflection', { due: 'Friday' });
  const second = record('Weekly reflection', { due: 'Monday' });

  const result = reconcileResourceIdentities([
    observation(first),
    observation(second),
  ]);

  expect(result.candidates).toHaveLength(2);
  expect(result.ambiguities).toContainEqual(
    expect.objectContaining({ reason: 'ambiguous-fallback' }),
  );
});

it('does not merge distinct explicit IDs, scopes, or resource kinds', () => {
  const first = record('Weekly reflection', {
    sourceId: 'reflection-1',
    url: 'https://school.example/assignments/reflection-1',
    evidence: {
      sourceUrl: 'https://school.example/courses/biology/assignments',
      excerpts: ['Weekly reflection reflection-1'],
    },
  });
  const second = record('Weekly reflection', {
    sourceId: 'reflection-2',
    url: 'https://school.example/assignments/reflection-2',
    evidence: {
      sourceUrl: 'https://school.example/courses/biology/assignments',
      excerpts: ['Weekly reflection reflection-2'],
    },
  });

  const result = reconcileResourceIdentities([
    observation(first),
    observation(second),
    observation(first, { ...biologyScope, courseId: 'chemistry-202' }),
    observation(first, { ...biologyScope, accountId: 'account-2' }),
    observation(first, { ...biologyScope, kind: 'announcements' }),
  ]);

  expect(result.candidates).toHaveLength(5);
  expect(result.ambiguities).toHaveLength(0);
});

it('preserves records that share a URL but have conflicting IDs or states', () => {
  const sharedUrl = 'https://school.example/assignments/shared';
  const sourceUrl = 'https://school.example/courses/biology/assignments';
  const first = record('Lab report', {
    sourceId: 'a1',
    url: sharedUrl,
    evidence: { sourceUrl, excerpts: ['Lab report a1'] },
  });
  const second = record('Lab report', {
    sourceId: 'a2',
    url: sharedUrl,
    evidence: { sourceUrl, excerpts: ['Lab report a2'] },
  });
  const submitted = record('Lab report', {
    ...first,
    state: 'submitted',
  });

  const result = reconcileResourceIdentities([
    observation(first),
    observation(second),
    observation(submitted),
  ]);

  expect(result.candidates).toHaveLength(3);
  expect(result.ambiguities.map((ambiguity) => ambiguity.reason)).toEqual(
    expect.arrayContaining(['conflicting-source-ids', 'conflicting-state']),
  );
});

it('does not infer the same item ID from a shared intermediate route segment', () => {
  const result = reconcileResourceIdentities(
    ['first', 'second'].map((name) =>
      observation(
        record('Weekly reflection', {
          url: `https://school.example/assignments/groups/${name}`,
        }),
      ),
    ),
  );

  expect(result.candidates).toHaveLength(2);
  expect(
    result.candidates.flatMap((candidate) => candidate.aliases),
  ).not.toContain('id:groups');
});

it('does not infer item identity from an unrelated generic query parameter', () => {
  const result = reconcileResourceIdentities(
    ['first', 'second'].map((name) =>
      observation(
        record('Weekly reflection', {
          url: `https://school.example/materials/${name}?id=course-1`,
        }),
      ),
    ),
  );

  expect(result.candidates).toHaveLength(2);
});

it('never merges distinct explicit IDs through a URL-only bridge', () => {
  const url = 'https://school.example/assignments/shared';
  const records = ['first', null, 'second'].map((sourceId) =>
    observation(
      record('Weekly reflection', {
        sourceId,
        url,
        evidence: {
          sourceUrl: 'https://school.example/courses/biology/assignments',
          excerpts: [sourceId ?? 'Weekly reflection'],
        },
      }),
    ),
  );

  const result = reconcileResourceIdentities(records);

  expect(
    result.candidates.every(
      (candidate) =>
        new Set(
          candidate.resources.flatMap((resource) =>
            resource.sourceId ? [resource.sourceId] : [],
          ),
        ).size <= 1,
    ),
  ).toBe(true);
  expect(result.ambiguities).toContainEqual(
    expect.objectContaining({ reason: 'conflicting-source-ids' }),
  );
});

it('keeps contradictory states separate when an unknown-state observation bridges them', () => {
  const result = reconcileResourceIdentities(
    ['active-unsubmitted', 'unknown', 'submitted'].map((state) =>
      observation(
        record('Worksheet', {
          url: 'https://school.example/assignments/123',
          state,
        }),
      ),
    ),
  );

  expect(
    result.candidates.every(
      (candidate) =>
        new Set(
          candidate.resources
            .map((resource) => resource.state)
            .filter((state) => state !== 'unknown'),
        ).size <= 1,
    ),
  ).toBe(true);
  expect(result.ambiguities).toContainEqual(
    expect.objectContaining({ reason: 'conflicting-state' }),
  );
});
