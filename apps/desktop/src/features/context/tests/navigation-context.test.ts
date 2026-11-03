import { expect, it } from 'vitest';
import { createNavigationContext } from '../lib/navigation-context';
import type { NavigationLocationSelectData } from '../../../db/schema';

const location = (
  id: string,
  overrides: Partial<NavigationLocationSelectData> = {},
): NavigationLocationSelectData => ({
  id,
  userId: 'student-a',
  connectionId: 'connection-a',
  courseId: 'course-1',
  purpose: 'assignments',
  destinationUrl: `https://canvas.school.edu/courses/1/assignments/${id}`,
  parentUrl: 'https://canvas.school.edu/courses/1/assignments',
  recipe: null,
  label: `Assignment ${id}`,
  evidence: {
    sourceUrl: 'https://canvas.school.edu/courses/1/assignments',
    excerpts: ['Assignments'],
    targetIds: [],
  },
  status: 'verified',
  destinationKind: 'detail',
  observedAt: '2026-11-01T12:00:00.000Z',
  verifiedAt: '2026-11-01T12:00:00.000Z',
  failureCount: 0,
  lastFailureClass: null,
  ...overrides,
});

it('keeps context scoped and marks omitted destinations when record limits apply', () => {
  const context = createNavigationContext(
    [
      location('one'),
      location('two', { status: 'tentative' }),
      location('three', { courseId: 'course-2' }),
    ],
    {
      userId: 'student-a',
      connectionId: 'connection-a',
      purpose: 'assignments',
      courseId: 'course-1',
      maxLocations: 1,
    },
  );

  expect(context).toMatchObject({
    purpose: 'assignments',
    courseId: 'course-1',
    truncated: true,
    locations: [{ id: 'one', status: 'verified' }],
  });
  expect(context?.serialized.length).toBeLessThanOrEqual(8000);
});

it('bounds serialized evidence while reporting context truncation', () => {
  const context = createNavigationContext(
    [
      location('large', {
        evidence: {
          sourceUrl: 'https://canvas.school.edu/courses/1/assignments',
          excerpts: Array.from({ length: 4 }, () => 'x'.repeat(500)),
          targetIds: Array.from(
            { length: 30 },
            (_, index) => `target-${index}`,
          ),
        },
      }),
      location('next'),
    ],
    {
      userId: 'student-a',
      connectionId: 'connection-a',
      purpose: 'assignments',
      courseId: 'course-1',
      maxCharacters: 1800,
    },
  );

  expect(context?.truncated).toBe(true);
  expect(context?.serialized.length).toBeLessThanOrEqual(1800);
});
