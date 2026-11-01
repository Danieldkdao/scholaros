import { expect, it } from 'vitest';
import {
  previewKindForPrompt,
  validatePreviewCards,
} from '../lib/preview-validation';
import type { AgentRequestSchema } from '@scholaros/services/ai/schemas';

const url = 'https://canvas.school.edu/courses';
const target = 'https://canvas.school.edu/courses/1';
const request: AgentRequestSchema = {
  kind: 'courses',
  goal: 'Courses',
  notes: '',
  pages: [{ url, title: 'Courses', text: 'Biology 101 with Dr. Rivera.' }],
  targets: [{ id: '1', label: 'Biology 101', url: target }],
};
const course = {
  name: 'Biology 101',
  code: null,
  section: null,
  term: null,
  description: 'With Dr. Rivera',
  instructors: ['Dr. Rivera'],
  sourceId: null,
  url: target,
  evidence: {
    sourceUrl: url,
    excerpts: ['Biology 101 with Dr. Rivera.'],
    targetIds: ['1'],
  },
};
const validate = (value: unknown) => validatePreviewCards(value, request);
it.each([
  ['courses', 'course'],
  ['assignments', 'assignment'],
  ['announcements', 'announcement'],
] as const)('maps %s to %s for presentation', (prompt, kind) =>
  expect(previewKindForPrompt(prompt)).toBe(kind),
);
it('displays normalized course evidence without parsing resource fields from titles', () => {
  expect(validate({ courses: [course], coverage: 'complete' })).toMatchObject([
    {
      title: 'Biology 101',
      detail: 'With Dr. Rivera',
      excerpt: 'Biology 101 with Dr. Rivera.',
      sourceUrl: url,
    },
  ]);
});
it.each([
  { name: 'Invented course' },
  { url: 'https://other.example/courses/1' },
  { evidence: { ...course.evidence, sourceUrl: target } },
  { evidence: { ...course.evidence, excerpts: ['Invented instruction'] } },
])('does not display unsupported resource evidence: %j', (override) => {
  expect(
    validate({ courses: [{ ...course, ...override }], coverage: 'complete' }),
  ).toEqual([]);
});
it('rejects a response for the wrong resource rather than treating it as an empty verified collection', () => {
  expect(validate({ assignments: [], coverage: 'complete' })).toEqual([]);
});
