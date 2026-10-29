import { describe, expect, it } from 'vitest';
import {
  previewKindForPrompt,
  validatePreviewCards,
} from '../lib/preview-validation';

const evidence = [
  {
    url: 'https://canvas.school.edu/courses',
    title: 'Courses',
    text: 'Biology 101 with Dr. Rivera. Lab report due Friday, May 3, 2026.',
  },
];

const card = {
  kind: 'course' as const,
  title: 'Biology 101',
  course: null,
  detail: 'With Dr. Rivera',
  date: null,
  sourceUrl: 'https://canvas.school.edu/courses',
};

const validate = (
  cards: unknown[],
  pages = evidence,
  kind: 'course' | 'assignment' | 'announcement' = 'course',
) => validatePreviewCards({ cards }, pages, kind);

describe('preview validation', () => {
  it.each([
    ['courses', 'course'],
    ['assignments', 'assignment'],
    ['announcements', 'announcement'],
  ] as const)('maps %s to %s cards', (prompt, kind) => {
    expect(previewKindForPrompt(prompt)).toBe(kind);
  });

  it('keeps cards proven by a retrieved source page', () => {
    expect(validate([card])).toMatchObject([card]);
  });

  it('keeps a usable supporting excerpt for each verified card', () => {
    const [result] = validate([card]);
    expect(result?.excerpt).toContain('Biology 101');
  });

  it('matches titles without case sensitivity', () => {
    expect(validate([{ ...card, title: 'BIOLOGY 101' }])).toHaveLength(1);
  });

  it('drops cards for a different prompt kind', () => {
    expect(validate([card], evidence, 'assignment')).toEqual([]);
  });

  it('drops cards whose source was not retrieved', () => {
    expect(
      validate([{ ...card, sourceUrl: 'https://canvas.school.edu/courses/1' }]),
    ).toEqual([]);
  });

  it('drops cards whose title is absent from the source text', () => {
    expect(validate([{ ...card, title: 'Chemistry 201' }])).toEqual([]);
  });

  it('drops a punctuation-only title', () => {
    expect(validate([{ ...card, title: '...' }])).toEqual([]);
  });

  it('omits a course name that the source never mentions', () => {
    const [result] = validate([{ ...card, course: 'Chemistry 201' }]);
    expect(result?.course).toBeNull();
    expect(result?.courseVerified).toBe(false);
  });

  it('omits an invented due date', () => {
    const pages = [
      {
        url: 'https://canvas.school.edu/courses',
        title: 'Courses',
        text: 'Lab report.',
      },
    ];
    const [result] = validate(
      [
        {
          ...card,
          kind: 'assignment',
          title: 'Lab report',
          date: 'Friday',
          course: null,
          detail: null,
        },
      ],
      pages,
      'assignment',
    );
    expect(result?.date).toBeNull();
    expect(result?.dateVerified).toBe(false);
  });

  it('omits a summary with an invented requirement', () => {
    const pages = [
      {
        url: 'https://canvas.school.edu/courses',
        title: 'Courses',
        text: 'Lab report.',
      },
    ];
    const [result] = validate(
      [
        {
          ...card,
          kind: 'assignment',
          title: 'Lab report',
          detail: 'Requires a 900-page report.',
          course: null,
          date: null,
        },
      ],
      pages,
      'assignment',
    );
    expect(result?.detail).toBeNull();
  });

  it('keeps a date explicitly present on the page', () => {
    const [result] = validate(
      [
        {
          ...card,
          kind: 'assignment',
          title: 'Lab report',
          course: 'Biology 101',
          date: 'May 3, 2026',
          detail: 'Lab report for Biology 101',
        },
      ],
      evidence,
      'assignment',
    );
    expect(result).toMatchObject({
      course: 'Biology 101',
      date: 'May 3, 2026',
      courseVerified: true,
      dateVerified: true,
    });
  });

  it('normalizes date formatting differences', () => {
    const [result] = validate(
      [
        {
          ...card,
          kind: 'assignment',
          title: 'Lab report',
          course: null,
          date: '2026-05-03',
          detail: null,
        },
      ],
      evidence,
      'assignment',
    );
    expect(result?.date).toBe('2026-05-03');
    expect(result?.dateVerified).toBe(true);
  });

  it('normalizes whitespace and case in titles and courses', () => {
    const [result] = validate([
      {
        ...card,
        title: '  LAB   report ',
        course: 'biology 101',
        detail: null,
      },
    ]);
    expect(result?.title).toBe('LAB report');
    expect(result?.course).toBe('biology 101');
  });

  it('drops a summary that mentions an ungrounded weekday', () => {
    const [result] = validate([
      {
        ...card,
        detail: 'Submit by Monday.',
      },
    ]);
    expect(result?.detail).toBeNull();
  });

  it('omits a summary whose number is only part of a larger page number', () => {
    const pages = [
      {
        url: 'https://canvas.school.edu/courses',
        title: 'Courses',
        text: 'Biology 101 Lab report. Reading 1,900 words this term.',
      },
    ];
    const [result] = validate(
      [
        {
          ...card,
          kind: 'assignment',
          title: 'Lab report',
          course: null,
          date: null,
          detail: 'Requires a 900-page report.',
        },
      ],
      pages,
      'assignment',
    );
    expect(result?.detail).toBeNull();
  });

  it('omits a paraphrase even when its numbers match the source', () => {
    const pages = [
      {
        url: 'https://canvas.school.edu/courses',
        title: 'Courses',
        text: 'Biology 101 Lab report. Reading 1,900 words this term.',
      },
    ];
    const [result] = validate(
      [
        {
          ...card,
          kind: 'assignment',
          title: 'Lab report',
          course: null,
          date: null,
          detail: 'Reading spans 1,900 words.',
        },
      ],
      pages,
      'assignment',
    );
    expect(result?.detail).toBeNull();
  });

  it('rejects malformed model output', () => {
    expect(() => validate([{ ...card, sourceUrl: 'not-a-url' }])).toThrow(
      'The results could not be verified.',
    );
  });
});

it('omits an invented prose requirement even when it has no numbers', () => {
  const [result] = validate([
    { ...card, detail: 'Your instructor cancelled the exam.' },
  ]);
  expect(result?.detail).toBeNull();
});
it('does not borrow another assignment’s date from the same page', () => {
  const pages = [
    { ...evidence[0]!, text: 'Lab report. Midterm exam due May 10, 2026.' },
  ];
  const [result] = validate(
    [
      {
        ...card,
        kind: 'assignment',
        title: 'Lab report',
        date: '2026-05-10',
        detail: null,
      },
    ],
    pages,
    'assignment',
  );
  expect(result?.date).toBeNull();
  expect(result?.dateVerified).toBe(false);
});

it('does not borrow a date when the title only differs by whitespace', () => {
  const pages = [
    { ...evidence[0]!, text: 'Lab  report. Midterm exam due May 10, 2026.' },
  ];
  const [result] = validate(
    [
      {
        ...card,
        kind: 'assignment',
        title: 'Lab  report',
        date: '2026-05-10',
        detail: null,
      },
    ],
    pages,
    'assignment',
  );
  expect(result?.date).toBeNull();
  expect(result?.dateVerified).toBe(false);
});

it.each(['Lab report', 'Lab  report', 'Lab report.'])(
  'does not borrow a date from a larger word matching %s',
  (title) => {
    const pages = [
      {
        ...evidence[0]!,
        text: 'Prelab report due May 10, 2026. Lab report.',
      },
    ];
    const [result] = validate(
      [
        {
          ...card,
          kind: 'assignment',
          title,
          date: 'May 10, 2026',
          detail: null,
        },
      ],
      pages,
      'assignment',
    );
    expect(result?.date).toBeNull();
    expect(result?.dateVerified).toBe(false);
  },
);

it('keeps the sentence boundary when a generated title ends in punctuation', () => {
  const pages = [
    { ...evidence[0]!, text: 'Lab report. Midterm exam due May 10, 2026.' },
  ];
  const [result] = validate(
    [
      {
        ...card,
        kind: 'assignment',
        title: 'Lab report.',
        date: 'May 10, 2026',
        detail: null,
      },
    ],
    pages,
    'assignment',
  );
  expect(result?.date).toBeNull();
  expect(result?.dateVerified).toBe(false);
});

it('does not treat May 3 as evidence for May 30 or vice versa', () => {
  const pages = [{ ...evidence[0]!, text: 'Lab report due May 30, 2026.' }];
  const [result] = validate(
    [
      {
        ...card,
        kind: 'assignment',
        title: 'Lab report',
        date: 'May 3',
        detail: null,
      },
    ],
    pages,
    'assignment',
  );
  expect(result?.date).toBeNull();
});
it('does not validate a course title that is only a fragment of a different course', () => {
  expect(validate([{ ...card, title: 'Biology 10' }])).toHaveLength(0);
});
