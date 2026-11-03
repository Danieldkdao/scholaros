import { describe, expect, it, vi } from 'vitest';
import { extractPdfContent } from '../services/pdf-content';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

const createPdf = (pages: string[]) => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages
      .map((_, index) => `${4 + index * 2} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of pages.entries()) {
    const contentId = 5 + index * 2;
    const escaped = text
      .replaceAll('\\', '\\\\')
      .replaceAll('(', '\\(')
      .replaceAll(')', '\\)');
    const stream = `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
};

describe('extractPdfContent', () => {
  it('extracts page text with stable page breaks', async () => {
    const result = await extractPdfContent(
      createPdf(['Course outline', 'Week two reading']),
    );

    expect(result).toEqual({
      status: 'complete',
      pageCount: 2,
      text: 'Course outline\fWeek two reading',
    });
  });

  it('limits page and text extraction and reports partial coverage', async () => {
    const result = await extractPdfContent(
      createPdf(['First page', 'Second page']),
      { maxPages: 1 },
    );

    expect(result).toEqual({
      status: 'partial',
      pageCount: 2,
      text: 'First page',
    });
  });

  it('marks malformed or scanned documents unreadable', async () => {
    const result = await extractPdfContent(
      new TextEncoder().encode('%PDF-invalid'),
    );

    expect(result.status).toBe('unreadable');
    expect(result.text).toBe('');
  });

  it('honors cancellation before parsing starts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractPdfContent(createPdf(['Cancelled']), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
