import { describe, expect, it } from 'vitest';
import type { WatchPageSnapshot } from '../types';
import { createPageFingerprint } from '../lib/page-fingerprint';

const snapshot = (
  overrides: Partial<WatchPageSnapshot> = {},
): WatchPageSnapshot => ({
  url: 'https://canvas.school.edu/courses/1/assignments#upcoming',
  title: 'Biology 101 Assignments',
  text: 'Quiz 2 is due November 2, 2026.',
  links: [
    {
      label: 'Quiz 2',
      url: 'https://canvas.school.edu/courses/1/assignments/42?view=student',
      context: 'Due November 2, 2026',
    },
  ],
  statuses: ['Open'],
  complete: true,
  recipeVersion: 1,
  ...overrides,
});

describe('watch page fingerprints', () => {
  it('normalizes whitespace without changing source wording', () => {
    expect(
      createPageFingerprint(
        snapshot({ text: ' Quiz 2\n is due November 2, 2026. ' }),
      ),
    ).toBe(createPageFingerprint(snapshot()));
  });

  it('keeps meaningful date, number, and status changes', () => {
    expect(
      createPageFingerprint(
        snapshot({ text: 'Quiz 2 is due November 3, 2026.' }),
      ),
    ).not.toBe(createPageFingerprint(snapshot()));
    expect(
      createPageFingerprint(snapshot({ statuses: ['Submitted'] })),
    ).not.toBe(createPageFingerprint(snapshot()));
  });

  it('keeps query ordering and hash routes in the fingerprint', () => {
    expect(
      createPageFingerprint(
        snapshot({
          url: 'https://canvas.school.edu/courses/1/assignments#past',
        }),
      ),
    ).not.toBe(createPageFingerprint(snapshot()));
    expect(
      createPageFingerprint(
        snapshot({
          links: [
            {
              label: 'Quiz 2',
              url: 'https://canvas.school.edu/courses/1/assignments/42?view=student&sort=date',
              context: 'Due November 2, 2026',
            },
          ],
        }),
      ),
    ).not.toBe(createPageFingerprint(snapshot()));
  });

  it('includes completeness and recipe version', () => {
    expect(createPageFingerprint(snapshot({ complete: false }))).not.toBe(
      createPageFingerprint(snapshot()),
    );
    expect(createPageFingerprint(snapshot({ recipeVersion: 2 }))).not.toBe(
      createPageFingerprint(snapshot()),
    );
  });
});
