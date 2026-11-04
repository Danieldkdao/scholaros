import { describe, expect, it, vi } from 'vitest';
import { parseGradePage } from '../services/grade-collector';

vi.mock('../../onboarding/services/browser-workspace', () => ({
  getWorkspace: vi.fn(),
}));

const observedAt = '2026-11-03T12:00:00.000Z';
const sourceUrl = 'https://school.example/courses/biology/assignments/lab-1';

const page = (text: string) =>
  parseGradePage({
    url: sourceUrl,
    title: 'Lab report',
    text,
    observedAt,
  });

describe('parseGradePage', () => {
  it('keeps an earned numeric zero distinct from missing and maximum points', () => {
    const observation = page(
      'Grade: 0 / 10 points\nCompletion status: Completed\nOpportunity: No further submissions, resubmissions, or retakes are allowed\nFeedback: Recheck the units.',
    );

    expect(observation.grade).toEqual({
      scale: 'points',
      earned: 0,
      possible: 10,
    });
    expect(observation.completion).toBe('yes');
    expect(observation.remainingOpportunity).toBe('no');
    expect(observation.feedback).toBe('Recheck the units.');
    expect(observation.sourceUrl).toBe(sourceUrl);
    expect(observation.observedAt).toBe(observedAt);
    expect(observation.locators.grade).toEqual({
      kind: 'heading',
      heading: 'Grade',
    });
  });

  it.each([
    ['Grade: Pass', { scale: 'pass-fail', value: 'pass' }],
    ['Grade: fail', { scale: 'pass-fail', value: 'fail' }],
    ['Grade: B+', { scale: 'letter', value: 'B+' }],
    ['Score: 87%', { scale: 'percentage', earned: 87 }],
  ] as const)('supports the source grading scale in %s', (text, grade) => {
    expect(page(text).grade).toEqual(grade);
  });

  it('does not turn possible points or submission alone into a grade or completion', () => {
    const observation = page(
      'Points possible: 100\nSubmission status: Submitted',
    );

    expect(observation.grade).toBeNull();
    expect(observation.completion).toBe('unknown');
    expect(observation.remainingOpportunity).toBe('unknown');
  });

  it('keeps a graded assessment protected when an attempt remains or work reopened', () => {
    const retake = page(
      'Grade: A\nCompletion status: Completed\nAttempts remaining: 1',
    );
    const reopened = page(
      'Grade: 8 / 10\nCompletion status: Reopened\nOpportunity: No further submissions, resubmissions, or retakes are allowed',
    );

    expect(retake.grade).not.toBeNull();
    expect(retake.remainingOpportunity).toBe('yes');
    expect(reopened.completion).toBe('no');
  });

  it('marks contradictory grade and opportunity facts as conflicts', () => {
    const observation = page(
      'Grade: 8 / 10\nCurrent grade: 9 / 10\nCompletion status: Completed\nAttempts remaining: 0\nRetakes remaining: 1',
    );

    expect(observation.grade).toBeNull();
    expect(observation.remainingOpportunity).toBe('unknown');
    expect(observation.conflicts).toContain('multiple-grades');
    expect(observation.conflicts).toContain('opportunity-conflict');
  });

  it('does not infer that opportunities are closed from age or a completed label', () => {
    const observation = page('Completion status: Completed\nGrade: 100%');

    expect(observation.remainingOpportunity).toBe('unknown');
  });

  it('rejects a source URL outside the observed academic page contract', () => {
    expect(() =>
      parseGradePage({
        url: 'file:///outside/grade',
        title: 'Grade',
        text: 'Grade: A',
        observedAt,
      }),
    ).toThrow();
  });
});
