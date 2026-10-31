import { describe, expect, it } from 'vitest';
import { composeAgentNotes } from '../lib/agent-notes';

describe('composeAgentNotes', () => {
  it('puts the site note before the general note and skips empty notes', () => {
    expect(composeAgentNotes('school.edu', 'Use biology', 'Fall term')).toEqual(
      {
        notes: 'school.edu: Use biology\nGeneral: Fall term',
        omitted: false,
      },
    );
    expect(composeAgentNotes('school.edu', null, 'Fall term').notes).toBe(
      'General: Fall term',
    );
  });

  it('fits the shared limit without cutting a general word', () => {
    const result = composeAgentNotes(
      'school.edu',
      'x'.repeat(500),
      `${'word '.repeat(400)}last`,
    );
    expect(result.notes.length).toBeLessThanOrEqual(2000);
    expect(result.notes.endsWith('word')).toBe(true);
    expect(result.omitted).toBe(true);
    expect(
      composeAgentNotes(
        'school.edu',
        'x'.repeat(500),
        `${'word '.repeat(400)}last`,
      ),
    ).toEqual(result);
  });
});
