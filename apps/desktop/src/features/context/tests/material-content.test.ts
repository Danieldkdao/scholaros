import { describe, expect, it } from 'vitest';
import { buildMaterialContent } from '../lib/material-content';

describe('material passage preparation', () => {
  it('preserves headings and page locators as passage boundaries', () => {
    const result = buildMaterialContent({
      sourceUrl: 'https://school.example/courses/1/reading',
      text: '# Week 1\nRead Chapter 2.\n\n## Learning goals\nCompare the two models.',
    });

    expect(result.passages).toEqual([
      expect.objectContaining({
        heading: 'Week 1',
        locator: null,
        text: 'Read Chapter 2.',
      }),
      expect.objectContaining({
        heading: 'Learning goals',
        locator: null,
        text: 'Compare the two models.',
      }),
    ]);
  });

  it('bounds long passages with stable overlap and preserves dates and numbers', () => {
    const paragraph = `${'Course material details '.repeat(14)}Deadline November 12, 2026. `;
    const result = buildMaterialContent({
      sourceUrl: 'https://school.example/courses/1/lecture',
      text: `# Lecture 4\n${paragraph}`,
      maxChars: 120,
      overlapChars: 24,
    });

    expect(result.passages.length).toBeGreaterThan(1);
    expect(result.passages.every((passage) => passage.text.length <= 120)).toBe(
      true,
    );
    expect(result.passages.at(-1)?.text).toContain('November 12, 2026');
    expect(
      result.passages.every((passage) => passage.heading === 'Lecture 4'),
    ).toBe(true);
    expect(result.passages[1]?.text).toContain(
      result.passages[0]?.text.slice(-24).trim(),
    );
  });

  it('produces the same version for equivalent line endings and changes it for meaningful edits', () => {
    const sourceUrl = 'https://school.example/courses/1/syllabus';
    const first = buildMaterialContent({
      sourceUrl,
      text: '# Dates\r\nFinal exam: December 8, 2026.\r\n',
    });
    const equivalent = buildMaterialContent({
      sourceUrl,
      text: '# Dates\nFinal exam: December 8, 2026.\n',
    });
    const changed = buildMaterialContent({
      sourceUrl,
      text: '# Dates\nFinal exam: December 9, 2026.\n',
    });

    expect(equivalent.hash).toBe(first.hash);
    expect(changed.hash).not.toBe(first.hash);
    expect(changed.passages[0]?.text).toContain('December 9, 2026');
  });

  it('keeps page locators when source text contains page boundaries', () => {
    const result = buildMaterialContent({
      sourceUrl: 'https://school.example/courses/1/reading.pdf',
      text: 'Page one text.\f# Section two\nPage two text.',
    });

    expect(result.passages).toEqual([
      expect.objectContaining({ locator: 'Page 1', text: 'Page one text.' }),
      expect.objectContaining({
        heading: 'Section two',
        locator: 'Page 2',
        text: 'Page two text.',
      }),
    ]);
  });

  it('keeps a page locator for a single-page PDF', () => {
    const result = buildMaterialContent({
      sourceUrl: 'https://school.example/courses/1/reading.pdf',
      text: 'One page of reading.',
      pageLocators: true,
    });

    expect(result.passages).toEqual([
      expect.objectContaining({
        locator: 'Page 1',
        text: 'One page of reading.',
      }),
    ]);
  });
});
