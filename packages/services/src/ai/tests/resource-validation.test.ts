import { expect, it } from 'vitest';
import { validateResourceExtraction } from '../resources/validation';
import type { AgentRequestSchema } from '../schemas';
import type { ExtractedAssignmentSchema } from '../resources/assignment';

const url = 'https://school.example/courses/1/assignments';
const input: AgentRequestSchema = {
  kind: 'assignments',
  goal: 'Read assignments',
  notes: '',
  context: {
    retrievedAt: '2026-10-31T12:00:00Z',
    observedTimezone: null,
    locale: null,
    courseUrl: 'https://school.example/courses/1',
    courseName: 'Biology',
    truncated: false,
  },
  pages: [
    {
      url,
      title: 'Assignments',
      text: 'Lab report due October 31. Essay due Friday.',
    },
  ],
  targets: [
    {
      id: '1',
      label: 'Lab report',
      url: 'https://school.example/assignments/123',
    },
  ],
};
const assignment = (
  overrides: Partial<ExtractedAssignmentSchema> = {},
): ExtractedAssignmentSchema => ({
  title: 'Lab report',
  description: null,
  kind: 'assignment',
  state: 'unknown',
  due: { kind: 'date', date: '2026-10-31', original: 'October 31' },
  availableFrom: null,
  availableUntil: null,
  pointsPossible: null,
  url: input.targets![0].url,
  sourceId: null,
  resources: [],
  evidence: {
    sourceUrl: url,
    excerpts: ['Lab report due October 31'],
    targetIds: ['1'],
  },
  ...overrides,
});
it('keeps unknown fields separate from complete collection coverage and preserves date-only precision', () => {
  const result = validateResourceExtraction(input, 'assignments', {
    assignments: [assignment()],
    coverage: 'complete',
  });
  expect(result).toMatchObject({
    coverage: 'complete',
    assignments: [
      { state: 'unknown', due: { kind: 'date', date: '2026-10-31' } },
    ],
  });
});
it('preserves valid records while invalid evidence or unobserved URLs makes the collection partial', () => {
  const result = validateResourceExtraction(input, 'assignments', {
    assignments: [
      assignment(),
      assignment({
        title: 'Invented',
        url: 'https://school.example/assignments/other',
      }),
    ],
    coverage: 'complete',
  });
  expect(result.assignments).toHaveLength(1);
  expect(result.coverage).toBe('partial');
});
it.each([
  { due: { kind: 'date', date: '2026-02-30', original: 'February 30' } },
  {
    due: {
      kind: 'local',
      date: '2026-10-31',
      time: '25:00',
      original: 'October 31 at 25:00',
    },
  },
  {
    due: {
      kind: 'instant',
      instant: '2026-10-31T23:59:00-05:00',
      timezone: null,
      original: 'October 31',
    },
  },
  {
    evidence: {
      sourceUrl: 'https://other.example',
      excerpts: ['Lab report'],
      targetIds: [],
    },
  },
  {
    evidence: {
      sourceUrl: url,
      excerpts: ['Invented requirement'],
      targetIds: [],
    },
  },
  {
    resources: [
      { targetId: '1', label: 'Resource', url: 'https://other.example' },
    ],
  },
])(
  'does not reconcile removals after invalid semantic facts: %j',
  (overrides) => {
    const result = validateResourceExtraction(input, 'assignments', {
      assignments: [{ ...assignment(), ...overrides }],
      coverage: 'complete',
    });
    expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
  },
);
it('makes known truncation and full batches partial even if inference claims complete', () => {
  expect(
    validateResourceExtraction(
      { ...input, context: { ...input.context!, truncated: true } },
      'assignments',
      { assignments: [], coverage: 'complete' },
    ).coverage,
  ).toBe('partial');
  expect(
    validateResourceExtraction(input, 'assignments', {
      assignments: Array.from({ length: 30 }, () => assignment()),
      coverage: 'complete',
    }).coverage,
  ).toBe('partial');
});
it('preserves local and unresolved dates without assigning the device timezone', () => {
  const due = {
    kind: 'unresolved',
    original: 'Friday',
    reason: 'No calendar context.',
  } as const;
  const item = assignment({
    title: 'Essay',
    url: null,
    due,
    evidence: {
      sourceUrl: url,
      excerpts: ['Essay due Friday.'],
      targetIds: [],
    },
  });
  expect(
    validateResourceExtraction(input, 'assignments', {
      assignments: [item],
      coverage: 'detail',
    }).assignments[0].due,
  ).toEqual(due);
});

it('accepts a source-established timezone without substituting the device timezone', () => {
  const context = {
    ...input,
    pages: [
      {
        ...input.pages[0],
        text: 'Lab report due October 31 at 11:59 PM. Course timezone America/Chicago.',
      },
    ],
  };
  const due = {
    kind: 'instant' as const,
    instant: '2026-10-31T23:59:00-05:00',
    timezone: 'America/Chicago',
    original: 'October 31 at 11:59 PM',
  };
  expect(
    validateResourceExtraction(context, 'assignments', {
      assignments: [assignment({ due })],
      coverage: 'complete',
    }).assignments[0]?.due,
  ).toEqual(due);
});

it('does not let a collection page URL become the unique item URL for every assignment', () => {
  const request = {
    ...input,
    targets: [...input.targets!, { id: '2', label: 'Assignments', url }],
  };
  const result = validateResourceExtraction(request, 'assignments', {
    coverage: 'complete',
    assignments: [
      assignment({
        url,
        evidence: { ...assignment().evidence, targetIds: ['2'] },
      }),
    ],
  });
  expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
});
