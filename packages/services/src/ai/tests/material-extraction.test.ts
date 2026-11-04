import { describe, expect, it } from 'vitest';
import type { AgentRequestSchema } from '../schemas';
import { validateMaterialExtraction } from '../resources/material';

const courseUrl = 'https://school.example/courses/1';
const sourceText = 'Read Chapters 1 and 2 to review the course learning goals.';
const input: AgentRequestSchema = {
  kind: 'materials',
  goal: 'Index the reading for Biology.',
  notes: '',
  context: {
    retrievedAt: '2026-11-01T12:00:00.000Z',
    observedTimezone: null,
    locale: 'en-US',
    courseUrl,
    courseName: 'Biology',
    truncated: false,
  },
  pages: [{ url: courseUrl, title: 'Week 1 Reading', text: sourceText }],
  targets: [{ id: '1', label: 'Week 1 Reading', url: courseUrl }],
};
const material = {
  title: 'Week 1 Reading',
  sourceType: 'reading',
  url: courseUrl,
  readability: 'readable',
  summary: 'Read chapters 1 and 2 for the course learning goals.',
  summaryEvidence: [sourceText],
  evidence: {
    sourceUrl: courseUrl,
    excerpts: [sourceText],
    targetIds: ['1'],
  },
};

describe('material extraction validation', () => {
  it('accepts a source-backed summary linked to an observed course source', () => {
    expect(
      validateMaterialExtraction(input, {
        materials: [material],
        coverage: 'complete',
      }),
    ).toEqual({ materials: [material], coverage: 'complete' });
  });

  it('rejects summary claims that introduce concepts missing from the evidence', () => {
    const result = validateMaterialExtraction(input, {
      materials: [
        {
          ...material,
          summary: 'Weekly quizzes count toward your final grade.',
        },
      ],
      coverage: 'complete',
    });

    expect(result).toEqual({ materials: [], coverage: 'partial' });
  });

  it('rejects invented links, mismatched source pages, and non-verbatim evidence', () => {
    const inventedLink = validateMaterialExtraction(input, {
      materials: [
        {
          ...material,
          url: 'https://school.example/courses/1/secret-reading',
        },
      ],
      coverage: 'complete',
    });
    const mismatchedPage = validateMaterialExtraction(input, {
      materials: [
        {
          ...material,
          evidence: {
            ...material.evidence,
            sourceUrl: 'https://school.example/courses/2',
          },
        },
      ],
      coverage: 'complete',
    });
    const inventedEvidence = validateMaterialExtraction(input, {
      materials: [
        {
          ...material,
          evidence: {
            ...material.evidence,
            excerpts: ['The reading contains extra credit requirements.'],
          },
          summaryEvidence: ['The reading contains extra credit requirements.'],
        },
      ],
      coverage: 'complete',
    });

    expect(inventedLink).toEqual({ materials: [], coverage: 'partial' });
    expect(mismatchedPage).toEqual({ materials: [], coverage: 'partial' });
    expect(inventedEvidence).toEqual({ materials: [], coverage: 'partial' });
  });

  it('collapses repeated source observations and preserves conflicting ones as partial', () => {
    const duplicate = validateMaterialExtraction(input, {
      materials: [material, material],
      coverage: 'complete',
    });
    const conflict = validateMaterialExtraction(input, {
      materials: [
        material,
        {
          ...material,
          summary: 'Read chapters 1 and 2 to review the course learning goals.',
        },
      ],
      coverage: 'complete',
    });

    expect(duplicate).toEqual({ materials: [material], coverage: 'complete' });
    expect(conflict.materials).toHaveLength(2);
    expect(conflict.coverage).toBe('partial');
  });

  it('keeps model-declared empty material output partial without host empty evidence', () => {
    expect(
      validateMaterialExtraction(input, {
        materials: [],
        coverage: 'complete',
      }),
    ).toEqual({ materials: [], coverage: 'partial' });
  });

  it('does not treat a synthetic parent target as course-membership proof', () => {
    const externalUrl = 'https://files.example.edu/biology/reading.pdf';
    const externalInput: AgentRequestSchema = {
      ...input,
      pages: [{ url: externalUrl, title: 'Week 1 Reading', text: sourceText }],
      targets: [{ id: 'parent', label: 'Reading', url: externalUrl }],
    };

    const result = validateMaterialExtraction(externalInput, {
      materials: [
        {
          ...material,
          url: externalUrl,
          sourceType: 'pdf',
          evidence: {
            ...material.evidence,
            sourceUrl: externalUrl,
            targetIds: ['parent'],
          },
        },
      ],
      coverage: 'complete',
    });

    expect(result).toEqual({ materials: [], coverage: 'partial' });
  });

  it('accepts an external resource linked from the observed course page', () => {
    const externalUrl = 'https://files.example.edu/biology/reading.pdf';
    const externalInput: AgentRequestSchema = {
      ...input,
      targets: [{ id: '1', label: 'Week 1 Reading', url: externalUrl }],
    };

    expect(
      validateMaterialExtraction(externalInput, {
        materials: [
          {
            ...material,
            url: externalUrl,
            sourceType: 'pdf',
            evidence: { ...material.evidence, targetIds: ['1'] },
          },
        ],
        coverage: 'complete',
      }),
    ).toMatchObject({
      coverage: 'complete',
      materials: [{ url: externalUrl }],
    });
  });

  it('keeps truncated sources partial and unreadable items free of summaries', () => {
    const truncated = validateMaterialExtraction(
      {
        ...input,
        context: { ...input.context!, truncated: true },
      },
      { materials: [material], coverage: 'complete' },
    );
    const unreadable = validateMaterialExtraction(input, {
      materials: [
        {
          ...material,
          readability: 'unreadable',
          summary: null,
          summaryEvidence: [],
        },
      ],
      coverage: 'complete',
    });

    expect(truncated.coverage).toBe('partial');
    expect(unreadable.materials[0]?.readability).toBe('unreadable');
    expect(unreadable.materials[0]?.summary).toBeNull();
  });
});
