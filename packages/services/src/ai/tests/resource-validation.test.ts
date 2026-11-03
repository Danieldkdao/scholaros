import { expect, it } from 'vitest';
import { validateResourceExtraction } from '../resources/validation';
import type { AgentRequestSchema } from '../schemas';
import type { ExtractedAssignmentSchema } from '../resources/assignment';
import type { ExtractedAnnouncementSchema } from '../resources/announcement';

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
      text: 'Lab report due October 31, 2026. Essay due Friday.',
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
  due: { kind: 'date', date: '2026-10-31', original: 'October 31, 2026' },
  availableFrom: null,
  availableUntil: null,
  pointsPossible: null,
  url: input.targets![0].url,
  sourceId: null,
  resources: [],
  evidence: {
    sourceUrl: url,
    excerpts: ['Lab report due October 31, 2026'],
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
it('reconciles exact duplicate records across one extracted batch', () => {
  const item = assignment({
    sourceId: '123',
    evidence: {
      sourceUrl: url,
      excerpts: ['Lab report due October 31, 2026'],
      targetIds: ['1'],
    },
  });

  const result = validateResourceExtraction(input, 'assignments', {
    assignments: [item, assignment({ ...item })],
    coverage: 'complete',
  });

  expect(result).toMatchObject({ coverage: 'complete' });
  expect(result.assignments).toHaveLength(1);
});
it('preserves conflicting verified IDs sharing a URL and downgrades coverage', () => {
  const conflictingInput = {
    ...input,
    pages: [
      {
        ...input.pages[0]!,
        text: `${input.pages[0]!.text} Lab report 123. Essay 456.`,
      },
    ],
  };
  const first = assignment({
    sourceId: '123',
    due: null,
    evidence: {
      sourceUrl: url,
      excerpts: ['Lab report 123'],
      targetIds: ['1'],
    },
  });
  const second = assignment({
    title: 'Essay',
    sourceId: '456',
    due: null,
    evidence: {
      sourceUrl: url,
      excerpts: ['Essay 456'],
      targetIds: ['1'],
    },
  });

  const result = validateResourceExtraction(conflictingInput, 'assignments', {
    assignments: [first, second],
    coverage: 'complete',
  });

  expect(result.coverage).toBe('partial');
  expect(result.assignments).toHaveLength(2);
});

it('keeps an explicit ID separate from a conflicting URL ID and lowers coverage', () => {
  const detailUrl = 'https://school.example/assignments/456';
  const detailInput: AgentRequestSchema = {
    ...input,
    pages: [{ ...input.pages[0]!, text: 'Lab report source-123.' }],
    targets: [{ id: '456', label: 'Lab report', url: detailUrl }],
  };
  const item = assignment({
    sourceId: 'source-123',
    url: detailUrl,
    due: null,
    evidence: {
      sourceUrl: url,
      excerpts: ['Lab report source-123'],
      targetIds: ['456'],
    },
  });

  const result = validateResourceExtraction(detailInput, 'assignments', {
    assignments: [item],
    coverage: 'complete',
  });

  expect(result.coverage).toBe('partial');
  expect(result.assignments).toEqual([item]);
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
        text: 'Lab report due October 31, 2026 at 11:59 PM. Course timezone America/Chicago.',
      },
    ],
  };
  const due = {
    kind: 'instant' as const,
    instant: '2026-10-31T23:59:00-05:00',
    timezone: 'America/Chicago',
    original: 'October 31, 2026 at 11:59 PM',
  };
  expect(
    validateResourceExtraction(context, 'assignments', {
      assignments: [
        assignment({
          due,
          evidence: {
            sourceUrl: url,
            excerpts: [
              'Lab report due October 31, 2026 at 11:59 PM.',
              'Course timezone America/Chicago.',
            ],
            targetIds: ['1'],
          },
        }),
      ],
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

it.each([
  {
    part: 'text',
    text: 'Lab report due October 31, 2026. '.repeat(600).slice(0, 16_000),
    targets: [],
  },
  {
    part: 'targets',
    text: 'Lab report due October 31, 2026.',
    targets: Array.from({ length: 80 }, (_, index) => ({
      id: String(index + 1),
      label: `Course link ${index + 1}`,
      url: `https://school.example/course-links/${index + 1}`,
    })),
  },
])(
  'retains a validated detail record after $part truncation on repeated validation',
  ({ text, targets }) => {
    const detailInput: AgentRequestSchema = {
      ...input,
      context: { ...input.context!, truncated: true },
      pages: [
        {
          url,
          title: 'Lab report',
          text,
        },
      ],
      targets,
    };
    const detailAssignment = assignment({
      url,
      evidence: {
        sourceUrl: url,
        excerpts: ['Lab report due October 31, 2026.'],
        targetIds: [],
      },
    });
    const first = validateResourceExtraction(detailInput, 'assignments', {
      assignments: [detailAssignment],
      coverage: 'detail',
    });
    const second = validateResourceExtraction(
      detailInput,
      'assignments',
      first,
    );

    expect(first).toMatchObject({
      coverage: 'partial',
      assignments: [detailAssignment],
    });
    expect(second).toMatchObject({
      coverage: 'partial',
      assignments: [detailAssignment],
    });
  },
);

it('rejects a normalized date that contradicts its item-specific source wording', () => {
  const dateInput = {
    ...input,
    pages: [
      {
        ...input.pages[0],
        text: 'Lab report due 2026-11-02.',
      },
    ],
  };
  const result = validateResourceExtraction(dateInput, 'assignments', {
    assignments: [
      assignment({
        due: {
          kind: 'date',
          date: '2026-11-09',
          original: '2026-11-02',
        },
        url: null,
        evidence: {
          sourceUrl: url,
          excerpts: ['Lab report due 2026-11-02.'],
          targetIds: [],
        },
      }),
    ],
    coverage: 'complete',
  });

  expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
});

it('does not let an assignment borrow a neighboring item’s date', () => {
  const dateInput = {
    ...input,
    pages: [
      {
        ...input.pages[0],
        text: 'Lab report due October 31. Essay due Friday.',
      },
    ],
    targets: [],
  };
  const result = validateResourceExtraction(dateInput, 'assignments', {
    assignments: [
      assignment({
        title: 'Essay',
        due: { kind: 'date', date: '2026-10-31', original: 'October 31' },
        url: null,
        evidence: {
          sourceUrl: url,
          excerpts: ['Essay due Friday.'],
          targetIds: [],
        },
      }),
    ],
    coverage: 'complete',
  });

  expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
});

it('does not use an exam date in an announcement body as its publication date', () => {
  const announcement: ExtractedAnnouncementSchema = {
    title: 'Weekly update',
    body: 'Exam Friday, November 6.',
    author: null,
    published: { kind: 'date', date: '2026-11-06', original: 'November 6' },
    updated: null,
    url: null,
    sourceId: null,
    resources: [],
    evidence: {
      sourceUrl: url,
      excerpts: ['Exam Friday, November 6.'],
      targetIds: [],
    },
  };
  const result = validateResourceExtraction(
    {
      ...input,
      pages: [
        {
          ...input.pages[0],
          text: 'Weekly update posted October 30. Exam Friday, November 6.',
        },
      ],
      targets: [],
    },
    'announcements',
    { announcements: [announcement], coverage: 'complete' },
  );

  expect(result).toMatchObject({ coverage: 'partial', announcements: [] });
});

it('does not borrow a publication role for a neighboring exam date in one excerpt', () => {
  const excerpt = 'Welcome posted 2026-11-01. Exam 2026-11-09.';
  const announcement: ExtractedAnnouncementSchema = {
    title: 'Welcome',
    body: 'Exam 2026-11-09.',
    author: null,
    published: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
    updated: null,
    url: null,
    sourceId: null,
    resources: [],
    evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
  };
  const result = validateResourceExtraction(
    {
      ...input,
      pages: [{ ...input.pages[0], text: excerpt }],
      targets: [],
    },
    'announcements',
    { announcements: [announcement], coverage: 'complete' },
  );

  expect(result).toMatchObject({ coverage: 'partial', announcements: [] });
});

it('rejects a date excerpt that belongs to a different assignment', () => {
  const pageText = 'Lab report due 2026-11-02. Essay due 2026-11-09.';
  const result = validateResourceExtraction(
    { ...input, pages: [{ ...input.pages[0], text: pageText }], targets: [] },
    'assignments',
    {
      assignments: [
        assignment({
          title: 'Essay',
          due: {
            kind: 'date',
            date: '2026-11-02',
            original: '2026-11-02',
          },
          url: null,
          evidence: {
            sourceUrl: url,
            excerpts: ['Lab report due 2026-11-02.'],
            targetIds: [],
          },
        }),
      ],
      coverage: 'complete',
    },
  );

  expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
});

it('accepts an assignment date from its own uniquely identified collection region', () => {
  const excerpt = 'Essay due 2026-11-09.';
  const result = validateResourceExtraction(
    {
      ...input,
      pages: [
        {
          ...input.pages[0],
          text: 'Lab report due 2026-11-02. Essay due 2026-11-09.',
        },
      ],
      targets: [],
    },
    'assignments',
    {
      assignments: [
        assignment({
          title: 'Essay',
          due: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
          url: null,
          evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
        }),
      ],
      coverage: 'complete',
    },
  );

  expect(result.coverage).toBe('complete');
  expect(result.assignments[0]?.due).toEqual({
    kind: 'date',
    date: '2026-11-09',
    original: '2026-11-09',
  });
});

it.each([
  {
    label: 'an omitted neighboring record',
    records: 'essay-only',
    expectedCoverage: 'complete',
  },
  {
    label: 'a malformed neighboring record',
    records: 'malformed-other',
    expectedCoverage: 'partial',
  },
  {
    label: 'a neighboring record placed first',
    records: 'other-first',
    expectedCoverage: 'complete',
  },
] as const)(
  'keeps target-context evidence stable with $label',
  ({ records, expectedCoverage }) => {
    const essayUrl = 'https://school.example/assignments/essay';
    const context = 'Essay due 2026-11-09. Other due 2026-11-10.';
    const request: AgentRequestSchema = {
      ...input,
      pages: [{ ...input.pages[0], text: context }],
      targets: [{ id: 'essay', label: 'Essay', context, url: essayUrl }],
    };
    const essay = assignment({
      title: 'Essay',
      due: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
      url: essayUrl,
      evidence: {
        sourceUrl: url,
        excerpts: ['Essay due 2026-11-09.'],
        targetIds: ['essay'],
      },
    });
    const other = assignment({
      title: 'Other',
      due: { kind: 'date', date: '2026-11-10', original: '2026-11-10' },
      url: null,
      evidence: {
        sourceUrl: url,
        excerpts: ['Other due 2026-11-10.'],
        targetIds: [],
      },
    });
    const assignments =
      records === 'essay-only'
        ? [essay]
        : records === 'malformed-other'
          ? [essay, { title: 'Other' }]
          : [other, essay];
    const result = validateResourceExtraction(request, 'assignments', {
      assignments,
      coverage: 'complete',
    });
    const repeated = validateResourceExtraction(request, 'assignments', result);

    expect(
      result.assignments.find(({ title }) => title === 'Essay'),
    ).toMatchObject({
      due: { kind: 'date', date: '2026-11-09' },
    });
    expect(result.coverage).toBe(expectedCoverage);
    expect(repeated).toEqual(result);
    if (records === 'malformed-other') {
      expect(result.coverage).toBe('partial');
      expect(repeated.assignments).toHaveLength(1);
    }
  },
);

it('keeps a separately verified requirements excerpt from invalidating the item date', () => {
  const dateExcerpt = 'Essay due 2026-11-09.';
  const requirementsExcerpt = 'Submit as PDF.';
  const request: AgentRequestSchema = {
    ...input,
    pages: [
      {
        ...input.pages[0],
        text: `${dateExcerpt} ${requirementsExcerpt}`,
      },
    ],
    targets: [],
  };
  const result = validateResourceExtraction(request, 'assignments', {
    assignments: [
      assignment({
        title: 'Essay',
        due: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
        url: null,
        evidence: {
          sourceUrl: url,
          excerpts: [dateExcerpt, requirementsExcerpt],
          targetIds: [],
        },
      }),
    ],
    coverage: 'complete',
  });
  const repeated = validateResourceExtraction(request, 'assignments', result);

  expect(result).toMatchObject({
    coverage: 'complete',
    assignments: [{ due: { kind: 'date', date: '2026-11-09' } }],
  });
  expect(repeated).toEqual(result);
});

it('does not use a neighboring item’s supporting excerpt as date evidence', () => {
  const request: AgentRequestSchema = {
    ...input,
    pages: [
      {
        ...input.pages[0],
        text: 'Essay due Friday. Other due 2026-11-10. Submit as PDF.',
      },
    ],
    targets: [],
  };
  const result = validateResourceExtraction(request, 'assignments', {
    assignments: [
      assignment({
        title: 'Essay',
        due: { kind: 'date', date: '2026-11-10', original: '2026-11-10' },
        url: null,
        evidence: {
          sourceUrl: url,
          excerpts: ['Essay due Friday.', 'Other due 2026-11-10.'],
          targetIds: [],
        },
      }),
    ],
    coverage: 'complete',
  });

  expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
});

it('uses a verified item target context to join a heading to separate date metadata', () => {
  const targetUrl = 'https://school.example/assignments/essay';
  const result = validateResourceExtraction(
    {
      ...input,
      pages: [{ ...input.pages[0], text: 'Essay Due 2026-11-09.' }],
      targets: [
        {
          id: 'essay',
          label: 'Essay',
          context: 'Essay Due 2026-11-09.',
          url: targetUrl,
        },
      ],
    },
    'assignments',
    {
      assignments: [
        assignment({
          title: 'Essay',
          due: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
          url: targetUrl,
          evidence: {
            sourceUrl: url,
            excerpts: ['Due 2026-11-09.'],
            targetIds: ['essay'],
          },
        }),
      ],
      coverage: 'complete',
    },
  );

  expect(result.coverage).toBe('complete');
  expect(result.assignments).toHaveLength(1);
});

it('keeps a detail-page heading related to separate due-date metadata', () => {
  const detailInput = {
    ...input,
    pages: [
      {
        ...input.pages[0],
        title: 'Essay - Biology 101',
        text: 'Due 2026-11-09.',
      },
    ],
    targets: [],
  };
  const result = validateResourceExtraction(detailInput, 'assignments', {
    assignments: [
      assignment({
        title: 'Essay',
        due: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
        url,
        evidence: {
          sourceUrl: url,
          excerpts: ['Due 2026-11-09.'],
          targetIds: [],
        },
      }),
    ],
    coverage: 'detail',
  });

  expect(result.coverage).toBe('detail');
  expect(result.assignments).toHaveLength(1);
});

it('rejects repeated collection titles when no target distinguishes their regions', () => {
  const pageText = 'Essay\nDue 2026-11-09\nEssay\nDue 2026-11-12';
  const result = validateResourceExtraction(
    { ...input, pages: [{ ...input.pages[0], text: pageText }], targets: [] },
    'assignments',
    {
      assignments: [
        assignment({
          title: 'Essay',
          due: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
          url: null,
          evidence: {
            sourceUrl: url,
            excerpts: ['Essay', 'Due 2026-11-09'],
            targetIds: [],
          },
        }),
      ],
      coverage: 'complete',
    },
  );

  expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
});

it('rejects an excerpt that combines two assignments and their separate deadlines', () => {
  const excerpt = 'Lab report due 2026-11-02. Essay due 2026-11-09.';
  const result = validateResourceExtraction(
    { ...input, pages: [{ ...input.pages[0], text: excerpt }], targets: [] },
    'assignments',
    {
      assignments: [
        assignment({
          title: 'Essay',
          due: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
          url: null,
          evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
        }),
      ],
      coverage: 'complete',
    },
  );

  expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
});

it('accepts announcement publication metadata without borrowing its exam date', () => {
  const excerpt = 'Welcome posted 2026-11-01. Exam 2026-11-09.';
  const announcement: ExtractedAnnouncementSchema = {
    title: 'Welcome',
    body: 'Exam 2026-11-09.',
    author: null,
    published: { kind: 'date', date: '2026-11-01', original: '2026-11-01' },
    updated: null,
    url: null,
    sourceId: null,
    resources: [],
    evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
  };
  const result = validateResourceExtraction(
    { ...input, pages: [{ ...input.pages[0], text: excerpt }], targets: [] },
    'announcements',
    { announcements: [announcement], coverage: 'complete' },
  );

  expect(result.coverage).toBe('complete');
  expect(result.announcements[0]?.published).toEqual(announcement.published);
});

it('does not treat the exam date in an announcement excerpt as publication metadata', () => {
  const excerpt = 'Welcome posted 2026-11-01. Exam 2026-11-09.';
  const announcement: ExtractedAnnouncementSchema = {
    title: 'Welcome',
    body: 'Exam 2026-11-09.',
    author: null,
    published: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
    updated: null,
    url: null,
    sourceId: null,
    resources: [],
    evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
  };
  const result = validateResourceExtraction(
    { ...input, pages: [{ ...input.pages[0], text: excerpt }], targets: [] },
    'announcements',
    { announcements: [announcement], coverage: 'complete' },
  );

  expect(result).toMatchObject({ coverage: 'partial', announcements: [] });
});

it.each([
  {
    label: 'an ISO UTC marker',
    original: '2026-11-02T23:59:00Z',
    instant: '2026-11-02T23:59:00Z',
    timezone: null,
    observedTimezone: null,
    expectedTimezone: 'UTC',
  },
  {
    label: 'an equivalent ISO numeric offset',
    original: '2026-11-02T23:59:00Z',
    instant: '2026-11-03T00:59:00+01:00',
    timezone: null,
    observedTimezone: null,
    expectedTimezone: 'UTC',
  },
  {
    label: 'explicit UTC despite an observed Chicago timezone',
    original: '2026-11-02T23:59:00Z',
    instant: '2026-11-02T23:59:00Z',
    timezone: null,
    observedTimezone: 'America/Chicago',
    expectedTimezone: 'UTC',
  },
  {
    label: 'textual UTC wording',
    original: 'November 2, 2026 at 11:59 PM UTC',
    instant: '2026-11-02T23:59:00Z',
    timezone: null,
    observedTimezone: null,
    expectedTimezone: 'UTC',
  },
  {
    label: 'a textual numeric offset',
    original: 'November 2, 2026 at 11:59 PM -05:00',
    instant: '2026-11-03T04:59:00Z',
    timezone: null,
    observedTimezone: null,
    expectedTimezone: '-05:00',
  },
  {
    label: 'the observed course timezone',
    original: 'November 2, 2026 at 11:59 PM',
    instant: '2026-11-03T05:59:00Z',
    timezone: 'America/Chicago',
    observedTimezone: 'America/Chicago',
    expectedTimezone: 'America/Chicago',
  },
  {
    label: 'the observed course timezone when extraction omits its name',
    original: 'November 2, 2026 at 11:59 PM',
    instant: '2026-11-03T05:59:00Z',
    timezone: null,
    observedTimezone: 'America/Chicago',
    expectedTimezone: 'America/Chicago',
  },
])(
  'accepts an exact source instant using $label and remains stable on revalidation',
  ({ original, instant, timezone, observedTimezone, expectedTimezone }) => {
    const excerpt = `Work due ${original}.`;
    const due = { kind: 'instant' as const, instant, timezone, original };
    const dateInput: AgentRequestSchema = {
      ...input,
      context: { ...input.context!, observedTimezone },
      pages: [{ ...input.pages[0], text: excerpt }],
      targets: [],
    };
    const extracted = {
      assignments: [
        assignment({
          title: 'Work',
          due,
          url: null,
          evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
        }),
      ],
      coverage: 'complete' as const,
    };
    const result = validateResourceExtraction(
      dateInput,
      'assignments',
      extracted,
    );
    const repeated = validateResourceExtraction(
      dateInput,
      'assignments',
      result,
    );

    expect(result.coverage).toBe('complete');
    expect(result.assignments[0]?.due).toEqual({
      ...due,
      timezone: expectedTimezone,
    });
    expect(repeated).toEqual(result);
  },
);

it.each([
  {
    label: 'UTC',
    original: '2026-11-09T23:59:00Z',
    instant: '2026-11-10T08:59:00+09:00',
    expectedTimezone: 'UTC',
  },
  {
    label: 'a negative numeric offset',
    original: '2026-11-09T23:59:00-05:00',
    instant: '2026-11-10T04:59:00Z',
    expectedTimezone: '-05:00',
  },
  {
    label: 'a positive numeric offset',
    original: '2026-11-09T23:59:00+01:00',
    instant: '2026-11-09T22:59:00Z',
    expectedTimezone: '+01:00',
  },
])(
  'derives ISO timestamp timezone metadata from the source $label offset',
  ({ original, instant, expectedTimezone }) => {
    const excerpt = `Essay due ${original}.`;
    const request: AgentRequestSchema = {
      ...input,
      context: { ...input.context!, observedTimezone: 'America/Chicago' },
      pages: [{ ...input.pages[0], text: excerpt }],
      targets: [],
    };
    const result = validateResourceExtraction(request, 'assignments', {
      assignments: [
        assignment({
          title: 'Essay',
          due: {
            kind: 'instant',
            instant,
            timezone: 'Asia/Tokyo',
            original,
          },
          url: null,
          evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
        }),
      ],
      coverage: 'complete',
    });
    const repeated = validateResourceExtraction(request, 'assignments', result);

    expect(result).toMatchObject({
      coverage: 'complete',
      assignments: [
        {
          due: {
            kind: 'instant',
            instant,
            timezone: expectedTimezone,
            original,
          },
        },
      ],
    });
    expect(repeated).toEqual(result);
  },
);

it.each([
  {
    label: 'an ISO timestamp with a different offset',
    original: '2026-11-02T23:59:00Z',
    instant: '2026-11-02T23:59:00-05:00',
  },
  {
    label: 'textual UTC interpreted as a local offset',
    original: 'November 2, 2026 at 11:59 PM UTC',
    instant: '2026-11-02T23:59:00-05:00',
  },
  {
    label: 'a textual numeric offset interpreted as UTC',
    original: 'November 2, 2026 at 11:59 PM -05:00',
    instant: '2026-11-02T23:59:00Z',
  },
])(
  'rejects $label when it changes the source instant',
  ({ original, instant }) => {
    const excerpt = `Work due ${original}.`;
    const result = validateResourceExtraction(
      {
        ...input,
        pages: [{ ...input.pages[0], text: excerpt }],
        targets: [],
      },
      'assignments',
      {
        assignments: [
          assignment({
            title: 'Work',
            due: { kind: 'instant', instant, timezone: null, original },
            url: null,
            evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
          }),
        ],
        coverage: 'complete',
      },
    );

    expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
  },
);

it('keeps conflicting timezone wording unresolved instead of choosing one zone', () => {
  const original = '2026-11-02T23:59:00Z -05:00';
  const excerpt = `Work due ${original}.`;
  const result = validateResourceExtraction(
    { ...input, pages: [{ ...input.pages[0], text: excerpt }], targets: [] },
    'assignments',
    {
      assignments: [
        assignment({
          title: 'Work',
          due: {
            kind: 'instant',
            instant: '2026-11-02T23:59:00Z',
            timezone: null,
            original,
          },
          url: null,
          evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
        }),
      ],
      coverage: 'complete',
    },
  );

  expect(result).toMatchObject({
    coverage: 'complete',
    assignments: [{ due: { kind: 'unresolved', original } }],
  });
});

it('retains an explicit timezone attached to the date evidence when original omits it', () => {
  const original = 'November 2, 2026 at 11:59 PM';
  const excerpt = `Work due ${original} UTC.`;
  const result = validateResourceExtraction(
    {
      ...input,
      pages: [{ ...input.pages[0], text: excerpt }],
      targets: [],
    },
    'assignments',
    {
      assignments: [
        assignment({
          title: 'Work',
          due: {
            kind: 'instant',
            instant: '2026-11-02T23:59:00Z',
            timezone: null,
            original,
          },
          url: null,
          evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
        }),
      ],
      coverage: 'complete',
    },
  );

  expect(result).toMatchObject({
    coverage: 'complete',
    assignments: [{ due: { kind: 'instant', timezone: 'UTC' } }],
  });
});

it('does not borrow a timezone that belongs to a neighboring item', () => {
  const original = 'November 2, 2026 at 11:59 PM';
  const excerpt = `Work due ${original}. Exam opens at 11:59 PM UTC.`;
  const result = validateResourceExtraction(
    {
      ...input,
      pages: [{ ...input.pages[0], text: excerpt }],
      targets: [],
    },
    'assignments',
    {
      assignments: [
        assignment({
          title: 'Work',
          due: {
            kind: 'instant',
            instant: '2026-11-03T05:59:00Z',
            timezone: null,
            original,
          },
          url: null,
          evidence: { sourceUrl: url, excerpts: [excerpt], targetIds: [] },
        }),
      ],
      coverage: 'complete',
    },
  );

  expect(result).toMatchObject({
    coverage: 'complete',
    assignments: [
      {
        due: {
          kind: 'unresolved',
          original,
          reason: 'The source wording does not establish a timezone.',
        },
      },
    ],
  });
});

it('rejects a time that is not supported by the item-specific date wording', () => {
  const dateInput = {
    ...input,
    pages: [
      {
        ...input.pages[0],
        text: 'Lab report due November 2, 2026 at 11:59 PM.',
      },
    ],
  };
  const result = validateResourceExtraction(dateInput, 'assignments', {
    assignments: [
      assignment({
        due: {
          kind: 'local',
          date: '2026-11-02',
          time: '10:59',
          original: 'November 2, 2026 at 11:59 PM',
        },
        evidence: {
          sourceUrl: url,
          excerpts: ['Lab report due November 2, 2026 at 11:59 PM.'],
          targetIds: ['1'],
        },
      }),
    ],
    coverage: 'complete',
  });

  expect(result).toMatchObject({ coverage: 'partial', assignments: [] });
});

it('keeps a grounded time unresolved when its timezone is not established', () => {
  const dateInput = {
    ...input,
    pages: [
      {
        ...input.pages[0],
        text: 'Lab report due November 2, 2026 at 11:59 PM.',
      },
    ],
  };
  const result = validateResourceExtraction(dateInput, 'assignments', {
    assignments: [
      assignment({
        due: {
          kind: 'instant',
          instant: '2026-11-02T23:59:00-05:00',
          timezone: 'America/Chicago',
          original: 'November 2, 2026 at 11:59 PM',
        },
        evidence: {
          sourceUrl: url,
          excerpts: ['Lab report due November 2, 2026 at 11:59 PM.'],
          targetIds: ['1'],
        },
      }),
    ],
    coverage: 'complete',
  });

  expect(result.assignments[0].due).toEqual({
    kind: 'unresolved',
    original: 'November 2, 2026 at 11:59 PM',
    reason: 'The source wording does not establish a timezone.',
  });
});

it.each(['Friday', 'November 2'])(
  'retains unresolved %s wording when the request cannot establish its year',
  (original) => {
    const dateInput = {
      ...input,
      pages: [
        {
          ...input.pages[0],
          text: `Essay due ${original}.`,
        },
      ],
      targets: [],
    };
    const extracted = {
      assignments: [
        assignment({
          title: 'Essay',
          due: { kind: 'date', date: '2026-11-06', original },
          url: null,
          evidence: {
            sourceUrl: url,
            excerpts: [`Essay due ${original}.`],
            targetIds: [],
          },
        }),
      ],
      coverage: 'complete' as const,
    };
    const first = validateResourceExtraction(
      dateInput,
      'assignments',
      extracted,
    );
    const second = validateResourceExtraction(dateInput, 'assignments', first);

    expect(first.assignments[0].due).toEqual({
      kind: 'unresolved',
      original,
      reason: 'The source wording does not establish a calendar year.',
    });
    expect(second).toEqual(first);
  },
);

it('does not extend an unlinked announcement into a neighboring publication date', () => {
  const text =
    'Welcome Read the syllabus before class. Exam reminder Posted 2026-11-09';
  const result = validateResourceExtraction(
    { ...input, pages: [{ ...input.pages[0], text }], targets: [] },
    'announcements',
    {
      coverage: 'complete',
      announcements: [
        {
          title: 'Welcome',
          body: 'Read the syllabus before class.',
          author: null,
          published: {
            kind: 'date',
            date: '2026-11-09',
            original: '2026-11-09',
          },
          updated: null,
          url: null,
          sourceId: null,
          resources: [],
          evidence: {
            sourceUrl: url,
            excerpts: ['Welcome', 'Posted 2026-11-09'],
            targetIds: [],
          },
        },
      ],
    },
  );
  expect(result).toMatchObject({ coverage: 'partial', announcements: [] });
});

it('keeps a verified card date after its introductory sentence', () => {
  const text = 'Essay Read chapter 1. Due 2026-11-09.';
  const targetUrl = 'https://school.example/assignments/essay';
  const request: AgentRequestSchema = {
    ...input,
    pages: [{ ...input.pages[0], text }],
    targets: [{ id: 'essay', label: 'Essay', context: text, url: targetUrl }],
  };
  const result = validateResourceExtraction(request, 'assignments', {
    coverage: 'complete',
    assignments: [
      assignment({
        title: 'Essay',
        url: targetUrl,
        due: { kind: 'date', date: '2026-11-09', original: '2026-11-09' },
        evidence: {
          sourceUrl: url,
          excerpts: ['Due 2026-11-09.'],
          targetIds: ['essay'],
        },
      }),
    ],
  });
  expect(result).toMatchObject({
    coverage: 'complete',
    assignments: [{ title: 'Essay', due: { date: '2026-11-09' } }],
  });
  expect(validateResourceExtraction(request, 'assignments', result)).toEqual(
    result,
  );
});
