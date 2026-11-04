import { describe, expect, it, vi } from 'vitest';
import {
  inspectDocumentInput,
  validateDocumentInterpretation,
} from '../document-interpretation';

const { serverEnv } = vi.hoisted(() => ({
  serverEnv: {
    BETTER_AUTH_SECRET: 'x',
    META_MODEL: 'muse-spark-1.3',
    META_API_KEY: 'x',
  },
}));
vi.mock('@scholaros/env/server', () => ({ serverEnv }));

const makePdf = (pageCount: number) => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(' ')}] >>\nendobj\n`,
    ...Array.from(
      { length: pageCount },
      (_, index) =>
        `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`,
    ),
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(new TextEncoder().encode(document).byteLength);
    document += object;
  }
  const xrefOffset = new TextEncoder().encode(document).byteLength;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(document);
};
const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
};

describe('document input inspection', () => {
  it('checks image signature, dimensions, and the pixel ceiling', async () => {
    await expect(
      inspectDocumentInput({
        bytes: png(4000, 4000),
        declaredMimeType: 'image/png',
      }),
    ).resolves.toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      width: 4000,
      height: 4000,
    });
    await expect(
      inspectDocumentInput({
        bytes: png(5000, 5000),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it('cancels PDF inspection when the operation signal is already aborted', async () => {
    await expect(
      inspectDocumentInput(
        { bytes: makePdf(1), declaredMimeType: 'application/pdf' },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects images whose transmitted longest edge exceeds 4096 pixels', async () => {
    await expect(
      inspectDocumentInput({
        bytes: png(5000, 100),
        declaredMimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it('rejects a misleading MIME declaration before any model call', async () => {
    await expect(
      inspectDocumentInput({
        bytes: png(10, 10),
        declaredMimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('parses actual PDF page count from bytes and rejects more than twenty pages', async () => {
    await expect(
      inspectDocumentInput({
        bytes: makePdf(20),
        declaredMimeType: 'application/pdf',
      }),
    ).resolves.toMatchObject({ kind: 'pdf', pageCount: 20 });
    await expect(
      inspectDocumentInput({
        bytes: makePdf(21),
        declaredMimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it('rejects malformed or encrypted PDFs without requesting a password', async () => {
    await expect(
      inspectDocumentInput({
        bytes: new TextEncoder().encode('%PDF-not-a-document'),
        declaredMimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });
});

describe('document interpretation validation', () => {
  it('returns only offered page IDs and marks omitted pages partial', () => {
    const result = validateDocumentInterpretation(
      { pageNumbers: [2, 3] },
      {
        pages: [
          {
            page: 2,
            status: 'readable',
            text: 'Observed diagram labels.',
            uncertainty: null,
          },
        ],
      },
    );

    expect(result).toEqual({
      status: 'partial',
      interpretedPages: [2],
      pages: [
        {
          page: 2,
          status: 'readable',
          text: 'Observed diagram labels.',
          uncertainty: null,
        },
      ],
    });
  });

  it('rejects an empty or repeated offered page scope', () => {
    expect(() =>
      validateDocumentInterpretation({ pageNumbers: [] }, { pages: [] }),
    ).toThrow();
    expect(() =>
      validateDocumentInterpretation(
        { pageNumbers: [1, 1] },
        {
          pages: [
            {
              page: 1,
              status: 'readable',
              text: 'Observed text.',
              uncertainty: null,
            },
          ],
        },
      ),
    ).toThrow();
  });

  it('keeps unreadable handwriting uncertain and rejects invented page numbers', () => {
    expect(
      validateDocumentInterpretation(
        { pageNumbers: [1] },
        {
          pages: [
            {
              page: 1,
              status: 'unreadable',
              text: '',
              uncertainty: 'Text is not legible.',
            },
          ],
        },
      ),
    ).toMatchObject({ status: 'unreadable', interpretedPages: [1] });
    expect(() =>
      validateDocumentInterpretation(
        { pageNumbers: [1] },
        {
          pages: [
            {
              page: 2,
              status: 'readable',
              text: 'Invented page.',
              uncertainty: null,
            },
          ],
        },
      ),
    ).toThrow();
  });
});
