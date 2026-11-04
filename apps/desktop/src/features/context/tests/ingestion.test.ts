import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type {
  AuthorizedContext,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import type { IngestionStatus } from '@scholaros/services/learning/context-contracts';
import {
  createContextIngestionService,
  type ContextIngestionAttemptInput,
  type ContextIngestionAttemptStatusInput,
  type ContextIngestionDependencies,
  type ContextImageInterpretation,
  type ContextIngestionItem,
  type ContextIngestionVersion,
  type ContextIngestionVersionInput,
  type ContextPdfInterpretation,
} from '../services/ingestion';
import * as imageContent from '../services/image-content';
import type { PdfContentResult } from '../services/pdf-content';
import { formatIngestionStatus } from '../lib/formatters';
import { extractPdfContent } from '../services/pdf-content';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

const textBytes = Buffer.from(
  'A literal <script> tag stays text.\nSecond paragraph.',
  'utf8',
);
const pdfBytes = Buffer.from('%PDF-1.7\nsynthetic pages');
const createImageBytes = async (
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
) => {
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = '#d71920';
  context.fillRect(0, 0, 2, 2);
  if (mimeType === 'image/png')
    return new Uint8Array(await canvas.encode('png'));
  if (mimeType === 'image/jpeg')
    return new Uint8Array(await canvas.encode('jpeg'));
  return new Uint8Array(await canvas.encode('webp'));
};

const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const createZip = (entries: Array<[string, string]>) => {
  const localRecords: Buffer[] = [];
  const directoryRecords: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const content = Buffer.from(value, 'utf8');
    const compressed = deflateRawSync(content);
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localRecords.push(local, compressed);

    const directory = Buffer.alloc(46 + nameBytes.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    nameBytes.copy(directory, 46);
    directoryRecords.push(directory);
    offset += local.length + compressed.length;
  }

  const directoryBytes = Buffer.concat(directoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, directoryBytes, end]);
};

const createDocx = (text: string) =>
  createZip([
    [
      '[Content_Types].xml',
      '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ]);

const createPdf = (pages: string[], encrypted = false) => {
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
  const encryptionObjectId = objects.length + 1;
  if (encrypted)
    objects.push(
      '<< /Filter /Standard /V 1 /R 2 /O (0123456789abcdef) /U (0123456789abcdef) /P -4 >>',
    );
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
  const encryptionEntries = encrypted
    ? `/Encrypt ${encryptionObjectId} 0 R /ID [<0123456789ABCDEF><0123456789ABCDEF>]`
    : '';
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryptionEntries} >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
};

const context = (userId = 'account-a'): AuthorizedContext => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const makeDependencies = (
  overrides: Partial<ContextIngestionDependencies> = {},
) => {
  const versions: ContextIngestionVersion[] = [];
  const attempts: ContextIngestionAttemptInput[] = [];
  const attemptStatuses: ContextIngestionAttemptStatusInput[] = [];
  const itemRevisions = new Map<string, number>();
  const nextRevision = (itemId: string) => {
    const revision = (itemRevisions.get(itemId) ?? 0) + 1;
    itemRevisions.set(itemId, revision);
    return revision;
  };
  const originals = new Map<
    string,
    {
      fileName: string;
      contentType: string;
      originalHash: string;
      storageKey: string;
      bytes: Uint8Array;
    }
  >();
  const publish = vi.fn(async (_event: ProductEventV1) => undefined);
  const defaultExtractPdf = async (): Promise<PdfContentResult> => ({
    status: 'unreadable',
    pageCount: 0,
    text: '',
  });
  const defaultInterpretPdf: NonNullable<
    ContextIngestionDependencies['interpretMetaPdf']
  > = async () => ({
    status: 'complete',
    pages: [],
    interpretedPages: [],
    uncertainty: 'No page content was interpreted.',
  });
  const defaultInterpretImage: NonNullable<
    ContextIngestionDependencies['interpretMetaImage']
  > = async () => ({
    status: 'complete',
    text: 'Handwriting may be uncertain.',
    uncertainty: 'Handwriting is provisional.',
  });
  const dependencies: ContextIngestionDependencies = {
    inspectSelectedFile: vi.fn(async (_context, ticketId) => ({
      fileName: ticketId === 'bad' ? 'fake.pdf' : 'notes.txt',
      contentType: ticketId === 'bad' ? 'application/pdf' : 'text/plain',
      byteLength: ticketId === 'bad' ? 8 : textBytes.byteLength,
    })),
    readSelectedFile: vi.fn(async (_context, ticketId) =>
      ticketId === 'bad' ? Buffer.from('not-pdf') : textBytes,
    ),
    readOriginal: vi.fn(
      async (_context, itemId) => originals.get(itemId) ?? null,
    ),
    storeOriginal: vi.fn(async (_context, input) => {
      const original = {
        fileName: input.fileName,
        contentType: input.contentType,
        originalHash: input.originalHash,
        storageKey: `opaque-${input.itemId}`,
        bytes: input.bytes,
      };
      originals.set(input.itemId, original);
      return {
        originalHash: original.originalHash,
        storageKey: original.storageKey,
      };
    }),
    readItem: vi.fn(
      async (_context, itemId): Promise<ContextIngestionItem> => ({
        id: itemId,
        revision: itemRevisions.get(itemId) ?? 0,
        removed: false,
        currentVersionId:
          versions.filter((version) => version.itemId === itemId).at(-1)?.id ??
          null,
        status: 'queued',
        usable: versions.some((version) => version.itemId === itemId),
      }),
    ),
    readVersion: vi.fn(
      async (_context, itemId, versionId) =>
        versions.find(
          (version) => version.itemId === itemId && version.id === versionId,
        ) ??
        versions.filter((version) => version.itemId === itemId).at(-1) ??
        null,
    ),
    writeAttempt: vi.fn(
      async (_context, attempt): Promise<{ revision: number }> => {
        attempts.push(attempt);
        return { revision: nextRevision(attempt.itemId) };
      },
    ),
    writeVersion: vi.fn(
      async (_context, input: ContextIngestionVersionInput) => {
        const {
          signal: _signal,
          expectedRevision: _expectedRevision,
          originalIsNew: _originalIsNew,
          ...versionData
        } = input;
        const version: ContextIngestionVersion = {
          id: `version-${versions.length + 1}`,
          ...versionData,
        };
        versions.push(version);
        const revision = nextRevision(input.itemId);
        return {
          versionId: version.id,
          revision,
          currentVersionId: version.id,
          usable:
            version.extractionStatus === 'complete' ||
            version.extractionStatus === 'partial',
        };
      },
    ),
    updateAttemptStatus: vi.fn(async (_context, input) => {
      attemptStatuses.push(input);
      return { revision: nextRevision(input.itemId) };
    }),
    publish,
    extractPdf: vi.fn(defaultExtractPdf),
    interpretMetaPdf: vi.fn(defaultInterpretPdf),
    interpretMetaImage: vi.fn(defaultInterpretImage),
    prepareImage: vi.fn(async () => ({
      status: 'complete' as const,
      mimeType: 'image/png' as const,
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      previewBytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      width: 1,
      height: 1,
      previewWidth: 1,
      previewHeight: 1,
      detailReduced: false,
      uncertainty: null,
    })),
    ...overrides,
  };
  return {
    dependencies,
    versions,
    attempts,
    attemptStatuses,
    originals,
    publish,
  };
};

const waitForIdle = async (service: { whenIdle: () => Promise<void> }) =>
  service.whenIdle();

describe('Context ingestion', () => {
  it('bounds concurrent admissions before inspecting selected files', async () => {
    let releaseInspection!: () => void;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const inspectSelectedFile = vi.fn(async (_context, ticketId: string) => {
      await inspectionGate;
      return {
        fileName: `${ticketId}.txt`,
        contentType: 'text/plain',
        byteLength: textBytes.byteLength,
      };
    });
    const state = makeDependencies({ inspectSelectedFile });
    const service = createContextIngestionService(state.dependencies);
    const submissions = Array.from({ length: 9 }, (_, index) =>
      service.ingestSelectedFile(context(), {
        ticketId: `ticket-${index}`,
        itemId: `item-${index}`,
      }),
    );

    const resultsPromise = Promise.allSettled(submissions);
    let becameIdle = false;
    const idlePromise = service.whenIdle().then(() => {
      becameIdle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inspectSelectedFile).toHaveBeenCalledTimes(8);
    expect(becameIdle).toBe(false);
    releaseInspection();
    const results = await resultsPromise;
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await idlePromise;
    expect(becameIdle).toBe(true);
    await waitForIdle(service);
  });

  it('settles jobs even when operation cleanup throws synchronously', async () => {
    const state = makeDependencies({
      onOperationSettled: () => {
        throw new Error('cleanup failed');
      },
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'good',
      itemId: 'item-settlement',
    });
    await waitForIdle(service);

    expect(state.versions).toHaveLength(1);
  });

  it('returns a queued operation promptly, checkpoints a valid version, and keeps markup literal', async () => {
    const state = makeDependencies();
    const service = createContextIngestionService(state.dependencies);
    const started = await service.ingestSelectedFile(context(), {
      ticketId: 'good',
      itemId: 'item-a',
    });

    expect(started).toMatchObject({ itemId: 'item-a' });
    await waitForIdle(service);

    expect(state.versions[0]).toMatchObject({
      itemId: 'item-a',
      extractionStatus: 'complete',
      extractedText: textBytes.toString('utf8'),
    });
    expect(state.versions[0]?.contentHash).toBe(
      createHash('sha256').update(textBytes.toString('utf8')).digest('hex'),
    );
    expect(state.dependencies.writeVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedRevision: expect.any(Number),
        originalIsNew: true,
      }),
    );
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: 'complete' }),
    );
    expect(
      state.publish.mock.calls
        .map(([event]) => event.outcome)
        .filter((outcome) => outcome !== undefined),
    ).toEqual(['completed']);
    const preview = await service.readContextPreview(context(), {
      itemId: 'item-a',
    });
    expect(preview).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('<script>'),
    });
    expect(preview).not.toHaveProperty('html');
    expect(preview).not.toHaveProperty('url');
  });

  it.each([
    {
      format: 'Markdown',
      fileName: 'study-guide.md',
      contentType: 'text/markdown',
      bytes: Buffer.from('# Cell structure\n\nMitochondria make ATP.', 'utf8'),
      extractedText: '# Cell structure\n\nMitochondria make ATP.',
    },
    {
      format: 'PDF',
      fileName: 'reading.pdf',
      contentType: 'application/pdf',
      bytes: createPdf(['First page', 'Second page']),
      extractedText: 'First page\fSecond page',
    },
    {
      format: 'DOCX',
      fileName: 'reading.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: createDocx('A document paragraph.'),
      extractedText: 'A document paragraph.',
    },
  ])(
    'extracts valid $format content through its bounded parser',
    async (file) => {
      const state = makeDependencies({
        inspectSelectedFile: vi.fn(async () => ({
          fileName: file.fileName,
          contentType: file.contentType,
          byteLength: file.bytes.byteLength,
        })),
        readSelectedFile: vi.fn(async () => file.bytes),
        ...(file.format === 'PDF' ? { extractPdf: extractPdfContent } : {}),
      });
      const service = createContextIngestionService(state.dependencies);

      await service.ingestSelectedFile(context(), {
        ticketId: `valid-${file.format.toLowerCase()}`,
        itemId: `valid-${file.format.toLowerCase()}`,
      });
      await waitForIdle(service);

      expect(state.versions).toHaveLength(1);
      expect(state.versions[0]).toMatchObject({
        extractionStatus: 'complete',
      });
      if (file.format === 'DOCX')
        expect(state.versions[0]?.extractedText).toContain(file.extractedText);
      else expect(state.versions[0]?.extractedText).toBe(file.extractedText);
    },
  );

  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)(
    'accepts complete %s content before Meta interpretation',
    async (mimeType) => {
      const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice(6);
      const bytes = await createImageBytes(mimeType);
      const state = makeDependencies({
        inspectSelectedFile: vi.fn(async () => ({
          fileName: `handwriting.${extension}`,
          contentType: mimeType,
          byteLength: bytes.byteLength,
        })),
        readSelectedFile: vi.fn(async () => bytes),
        prepareImage: vi.fn(async () => ({
          status: 'complete' as const,
          mimeType,
          bytes,
          previewBytes: bytes,
          width: 2,
          height: 2,
          previewWidth: 2,
          previewHeight: 2,
          detailReduced: false,
          uncertainty: null,
        })),
        interpretMetaImage: vi.fn(async () => ({
          status: 'complete' as const,
          text: 'The image contains a handwritten cell label.',
          uncertainty: null,
        })),
      });
      const service = createContextIngestionService(state.dependencies);

      await service.ingestSelectedFile(context(), {
        ticketId: `image-${extension}`,
        itemId: `image-${extension}`,
      });
      await waitForIdle(service);

      expect(state.dependencies.interpretMetaImage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mimeType, bytes }),
      );
      expect(state.versions.at(-1)).toMatchObject({
        extractionStatus: 'complete',
        extractedText: 'The image contains a handwritten cell label.',
      });
    },
  );

  it.each([
    {
      label: 'invalid UTF-8 text',
      fileName: 'broken.md',
      contentType: 'text/markdown',
      bytes: Buffer.from([0xc3, 0x28]),
      status: 'unreadable',
    },
    {
      label: 'a text payload mislabeled as PDF',
      fileName: 'notes.pdf',
      contentType: 'application/pdf',
      bytes: textBytes,
      status: 'unreadable',
    },
    {
      label: 'a presentation renamed as DOCX',
      fileName: 'slides.pptx',
      contentType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: createDocx('not a presentation'),
      status: 'unsupported',
    },
  ])('rejects $label before storing the original', async (file) => {
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: file.fileName,
        contentType: file.contentType,
        byteLength: file.bytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => file.bytes),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'invalid-file',
      itemId: 'invalid-file',
    });
    await waitForIdle(service);

    expect(state.dependencies.storeOriginal).not.toHaveBeenCalled();
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: file.status }),
    );
    expect(state.versions).toHaveLength(0);
  });

  it('rejects TXT above the strict UTF-8 byte limit before extraction', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'oversized.txt',
        contentType: 'text/plain',
        byteLength: bytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => bytes),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'oversized-text',
      itemId: 'oversized-text',
    });
    await waitForIdle(service);

    expect(state.dependencies.storeOriginal).not.toHaveBeenCalled();
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({
        status: 'unsupported',
        errorCode: 'limit-exceeded',
      }),
    );
  });

  it('marks TXT partial at the P08 extracted-text storage cap', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'boundary.txt',
        contentType: 'text/plain',
        byteLength: bytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => bytes),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'text-storage-limit',
      itemId: 'text-storage-limit',
    });
    await waitForIdle(service);

    expect(state.versions[0].extractedText).toHaveLength(2_000_000);
    expect(state.versions[0].extractedText?.slice(0, 4)).toBe('aaaa');
    expect(state.versions[0].extractedText?.slice(-4)).toBe('aaaa');
    expect(state.versions[0]).toMatchObject({
      extractionStatus: 'partial',
      uncertainty: expect.stringContaining('truncated'),
    });
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: 'partial' }),
    );
  });

  it('does not split a UTF-8 character at the extracted-text storage cap', async () => {
    const sourceText = `${'a'.repeat(1_999_999)}😀`;
    const bytes = Buffer.from(sourceText, 'utf8');
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'unicode-boundary.txt',
        contentType: 'text/plain',
        byteLength: bytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => bytes),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'unicode-boundary',
      itemId: 'unicode-boundary',
    });
    await waitForIdle(service);

    const extractedText = state.versions[0].extractedText ?? '';
    expect(extractedText).toHaveLength(1_999_999);
    expect(extractedText.at(-1)).toBe('a');
    expect(extractedText).not.toContain('\uD83D');
  });

  it('stores empty UTF-8 text as a successful empty version', async () => {
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'empty.txt',
        contentType: 'text/plain',
        byteLength: 0,
      })),
      readSelectedFile: vi.fn(async () => Buffer.alloc(0)),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'empty',
      itemId: 'empty-a',
    });
    await waitForIdle(service);

    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({
      extractionStatus: 'complete',
      extractedText: '',
    });
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: 'complete' }),
    );
    await expect(
      service.readContextPreview(context(), { itemId: 'empty-a' }),
    ).resolves.toMatchObject({
      kind: 'text',
      text: '',
      partial: false,
    });
  });

  it('withholds a preview when the account epoch changes during lookup', async () => {
    let current = true;
    const authorizedContext = {
      ...context(),
      isCurrent: () => current,
    };
    const state = makeDependencies();
    const service = createContextIngestionService(state.dependencies);
    await service.ingestSelectedFile(authorizedContext, {
      ticketId: 'good',
      itemId: 'item-a',
    });
    await waitForIdle(service);
    const readVersion = state.dependencies.readVersion;
    state.dependencies.readVersion = async (
      currentContext: AuthorizedContext,
      itemId: string,
      versionId?: string,
    ) => {
      const version = await readVersion(currentContext, itemId, versionId);
      current = false;
      return version;
    };

    await expect(
      service.readContextPreview(authorizedContext, { itemId: 'item-a' }),
    ).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'unreadable',
    });
  });

  it.each([
    {
      label: 'corrupt',
      bytes: Buffer.from('%PDF-1.7\nnot-a-valid-document'),
    },
    {
      label: 'encrypted',
      bytes: createPdf(['Password-protected content'], true),
    },
  ])(
    'reports an unreadable %s PDF without Meta interpretation',
    async ({ label, bytes }) => {
      const state = makeDependencies({
        inspectSelectedFile: vi.fn(async () => ({
          fileName: `${label}.pdf`,
          contentType: 'application/pdf',
          byteLength: bytes.byteLength,
        })),
        readSelectedFile: vi.fn(async () => bytes),
        extractPdf: extractPdfContent,
      });
      const service = createContextIngestionService(state.dependencies);

      await service.ingestSelectedFile(context(), {
        ticketId: `pdf-${label}`,
        itemId: `pdf-${label}`,
      });
      await waitForIdle(service);

      expect(state.attemptStatuses).toContainEqual(
        expect.objectContaining({ status: 'unreadable' }),
      );
      expect(state.dependencies.interpretMetaPdf).not.toHaveBeenCalled();
    },
  );

  it('uses Meta for a scanned blank PDF when P05 reports its page count', async () => {
    const scanBytes = createPdf(['', '']);
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'scan.pdf',
        contentType: 'application/pdf',
        byteLength: scanBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => scanBytes),
      extractPdf: vi.fn(
        async (): Promise<PdfContentResult> => ({
          status: 'unreadable',
          pageCount: 2,
          text: '',
        }),
      ),
      interpretMetaPdf: vi.fn(
        async (_context, input): Promise<ContextPdfInterpretation> => {
          expect(input.pages).toEqual([1, 2]);
          return {
            status: 'partial',
            pages: [
              {
                pageNumber: 1,
                text: 'Diagram labels are unclear.',
                uncertainty: null,
              },
            ],
            interpretedPages: [1],
            uncertainty: 'Page 2 was not interpreted.',
          };
        },
      ),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'scan',
      itemId: 'scan-a',
    });
    await waitForIdle(service);

    expect(state.dependencies.interpretMetaPdf).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pages: [1, 2] }),
    );
    expect(state.versions.at(-1)).toMatchObject({
      extractionStatus: 'partial',
      interpretedPages: [1],
      uncertainty: 'Page 2 was not interpreted.',
    });
    expect(
      state.publish.mock.calls
        .map(([event]) => event.outcome)
        .filter((outcome) => outcome !== undefined),
    ).toEqual(['attention']);
  });

  it('keeps PDFs above P08 page metadata bounds partial without persisting an invalid count', async () => {
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'oversized-pages.pdf',
        contentType: 'application/pdf',
        byteLength: pdfBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => pdfBytes),
      extractPdf: vi.fn(
        async (): Promise<PdfContentResult> => ({
          status: 'partial',
          pageCount: 201,
          text: 'First page is readable.',
        }),
      ),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'pdf-page-limit',
      itemId: 'pdf-page-limit',
    });
    await waitForIdle(service);

    expect(state.versions.at(-1)).toMatchObject({
      extractionStatus: 'partial',
      pageCount: null,
      uncertainty: expect.stringContaining('200-page'),
    });
  });

  it('completes over-limit scanned PDFs as partial without sending pages', async () => {
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'long-scan.pdf',
        contentType: 'application/pdf',
        byteLength: pdfBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => pdfBytes),
      extractPdf: vi.fn(
        async (): Promise<PdfContentResult> => ({
          status: 'complete',
          pageCount: 21,
          text: '',
        }),
      ),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'long-scan',
      itemId: 'long-scan-a',
    });
    await waitForIdle(service);

    expect(state.dependencies.interpretMetaPdf).not.toHaveBeenCalled();
    expect(state.versions.at(-1)).toMatchObject({
      extractionStatus: 'partial',
      pageCount: 21,
    });
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({
        status: 'partial',
        errorCode: 'limit-exceeded',
      }),
    );
    expect(
      state.publish.mock.calls
        .map(([event]) => event.outcome)
        .filter((outcome) => outcome !== undefined),
    ).toEqual(['attention']);
  });

  it('keeps a complete empty Meta interpretation distinguishable from unreadable output', async () => {
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'blank-scan.pdf',
        contentType: 'application/pdf',
        byteLength: pdfBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => pdfBytes),
      extractPdf: vi.fn(
        async (): Promise<PdfContentResult> => ({
          status: 'complete',
          pageCount: 1,
          text: '',
        }),
      ),
      interpretMetaPdf: vi.fn(
        async (): Promise<ContextPdfInterpretation> => ({
          status: 'complete',
          pages: [{ pageNumber: 1, text: '', uncertainty: null }],
          interpretedPages: [1],
          uncertainty: null,
        }),
      ),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'blank-scan',
      itemId: 'blank-scan-a',
    });
    await waitForIdle(service);

    await expect(
      service.readContextPreview(context(), { itemId: 'blank-scan-a' }),
    ).resolves.toMatchObject({
      kind: 'text',
      text: '',
      partial: false,
    });
  });

  it('lets a failed upload settle and continues the next queued upload', async () => {
    const state = makeDependencies();
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'bad',
      itemId: 'bad-a',
    });
    await service.ingestSelectedFile(context(), {
      ticketId: 'good',
      itemId: 'good-a',
    });
    await waitForIdle(service);

    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: 'unreadable' }),
    );
    expect(state.versions.some((version) => version.itemId === 'good-a')).toBe(
      true,
    );
  });

  it('rejects a batch whose aggregate reserved originals exceed 24 MiB', async () => {
    let releaseRead!: () => void;
    let signalReadStarted!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const byteLength = 9 * 1024 * 1024;
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async (_context, ticketId: string) => ({
        fileName: `${ticketId}.txt`,
        contentType: 'text/plain',
        byteLength,
      })),
      readSelectedFile: vi.fn(async (_context, ticketId: string) => {
        if (ticketId === 'batch-a') {
          signalReadStarted();
          await readGate;
        }
        return textBytes;
      }),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'batch-a',
      itemId: 'batch-a',
    });
    await readStarted;
    await service.ingestSelectedFile(context(), {
      ticketId: 'batch-b',
      itemId: 'batch-b',
    });
    await expect(
      service.ingestSelectedFile(context(), {
        ticketId: 'batch-c',
        itemId: 'batch-c',
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });

    releaseRead();
    await waitForIdle(service);
    expect(state.dependencies.readSelectedFile).toHaveBeenCalledTimes(2);
  });

  it('serializes decoding while cached previews stay readable', async () => {
    let releaseSlowRead!: () => void;
    let signalSlowReadStarted!: () => void;
    const slowReadGate = new Promise<void>((resolve) => {
      releaseSlowRead = resolve;
    });
    const slowReadStarted = new Promise<void>((resolve) => {
      signalSlowReadStarted = resolve;
    });
    const readSelectedFile = vi.fn(async (_context, ticketId: string) => {
      if (ticketId === 'slow') {
        signalSlowReadStarted();
        await slowReadGate;
      }
      return textBytes;
    });
    const state = makeDependencies({ readSelectedFile });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'cached',
      itemId: 'cached-item',
    });
    await waitForIdle(service);
    await service.ingestSelectedFile(context(), {
      ticketId: 'slow',
      itemId: 'slow-item',
    });
    await slowReadStarted;
    await service.ingestSelectedFile(context(), {
      ticketId: 'later',
      itemId: 'later-item',
    });

    await expect(
      service.readContextPreview(context(), { itemId: 'cached-item' }),
    ).resolves.toMatchObject({ kind: 'text', partial: false });
    expect(
      readSelectedFile.mock.calls.filter(
        ([, ticketId]) => ticketId === 'later',
      ),
    ).toHaveLength(0);

    releaseSlowRead();
    await waitForIdle(service);
    expect(
      readSelectedFile.mock.calls.filter(
        ([, ticketId]) => ticketId === 'later',
      ),
    ).toHaveLength(1);
  });

  it('uses the Meta interpretation adapter for handwritten image content', async () => {
    const imageBytes = await createImageBytes('image/webp');
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'handwriting.webp',
        contentType: 'image/webp',
        byteLength: imageBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => imageBytes),
      prepareImage: vi.fn(async () => ({
        status: 'complete' as const,
        mimeType: 'image/webp' as const,
        bytes: imageBytes,
        previewBytes: imageBytes,
        width: 1,
        height: 1,
        previewWidth: 1,
        previewHeight: 1,
        detailReduced: false,
        uncertainty: null,
      })),
      interpretMetaImage: vi.fn(
        async (): Promise<ContextImageInterpretation> => ({
          status: 'complete',
          text: 'The handwritten note says mitochondria.',
          uncertainty: 'Handwriting interpretation is provisional.',
        }),
      ),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'image',
      itemId: 'image-a',
    });
    await waitForIdle(service);

    expect(state.dependencies.interpretMetaImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mimeType: 'image/webp' }),
    );
    expect(state.versions.at(-1)).toMatchObject({
      extractionStatus: 'complete',
      extractedText: 'The handwritten note says mitochondria.',
      uncertainty: 'Handwriting interpretation is provisional.',
    });
    expect(
      state.publish.mock.calls
        .map(([event]) => event.outcome)
        .filter((outcome) => outcome !== undefined),
    ).toEqual(['completed']);
  });

  it('uses the bounded utility-process decoder when no decoder is injected', async () => {
    const imageBytes = await createImageBytes('image/png');
    const decoder = vi.fn(async (input) => ({
      mimeType: input.mimeType,
      bytes: input.bytes,
      previewBytes: input.bytes,
      width: input.width,
      height: input.height,
      previewWidth: input.width,
      previewHeight: input.height,
      metadataStripped: true,
    }));
    const decoderFactory = vi
      .spyOn(imageContent, 'createUtilityProcessImageDecoder')
      .mockReturnValue(decoder);
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'diagram.png',
        contentType: 'image/png',
        byteLength: imageBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => imageBytes),
      prepareImage: undefined,
      interpretMetaImage: vi.fn(async () => ({
        status: 'complete' as const,
        text: 'The diagram labels a cell wall.',
        uncertainty: null,
      })),
    });
    const service = createContextIngestionService(state.dependencies);

    try {
      await service.ingestSelectedFile(context(), {
        ticketId: 'decoder-default',
        itemId: 'decoder-default',
      });
      await waitForIdle(service);

      expect(decoderFactory).toHaveBeenCalledOnce();
      expect(decoder).toHaveBeenCalledOnce();
      expect(state.dependencies.interpretMetaImage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mimeType: 'image/png' }),
      );
    } finally {
      decoderFactory.mockRestore();
    }
  });

  it('keeps unavailable, rejected, and uncertain Meta image results explicit', async () => {
    const imageBytes = await createImageBytes('image/webp');
    const cases: Array<{
      label: string;
      interpretation: ContextIngestionDependencies['interpretMetaImage'];
      status: IngestionStatus;
      errorCode?: string;
      extractedText?: string | null;
    }> = [
      {
        label: 'unavailable',
        interpretation: undefined,
        status: 'partial',
        errorCode: 'feature-unavailable',
        extractedText: null,
      },
      {
        label: 'rejected',
        interpretation: vi.fn(async () => ({
          status: 'unreadable' as const,
          text: '',
          uncertainty: 'The handwriting could not be read.',
        })),
        status: 'unreadable',
        errorCode: 'unreadable',
        extractedText: null,
      },
      {
        label: 'uncertain',
        interpretation: vi.fn(async () => ({
          status: 'partial' as const,
          text: 'Possibly “mitosis”.',
          uncertainty: 'The handwritten word is uncertain.',
        })),
        status: 'partial',
        extractedText: 'Possibly “mitosis”.',
      },
      {
        label: 'provider failure',
        interpretation: vi.fn(async () => {
          throw new Error('provider failure');
        }),
        status: 'failed',
        errorCode: 'provider-failed',
        extractedText: null,
      },
    ];

    for (const scenario of cases) {
      const state = makeDependencies({
        inspectSelectedFile: vi.fn(async () => ({
          fileName: 'handwriting.webp',
          contentType: 'image/webp',
          byteLength: imageBytes.byteLength,
        })),
        readSelectedFile: vi.fn(async () => imageBytes),
        prepareImage: vi.fn(async () => ({
          status: 'complete' as const,
          mimeType: 'image/webp' as const,
          bytes: imageBytes,
          previewBytes: imageBytes,
          width: 2,
          height: 2,
          previewWidth: 2,
          previewHeight: 2,
          detailReduced: false,
          uncertainty: null,
        })),
        interpretMetaImage: scenario.interpretation,
      });
      const service = createContextIngestionService(state.dependencies);

      await service.ingestSelectedFile(context(), {
        ticketId: `meta-${scenario.label}`,
        itemId: `meta-${scenario.label}`,
      });
      await waitForIdle(service);

      expect(state.attemptStatuses.at(-1)).toMatchObject({
        status: scenario.status,
        ...(scenario.errorCode ? { errorCode: scenario.errorCode } : {}),
      });
      expect(state.versions.at(-1)).toMatchObject({
        extractionStatus: 'partial',
        extractedText: scenario.extractedText,
      });
    }
  });

  it('rejects raster previews above the 512 px edge and never returns file URLs', async () => {
    const imageBytes = await createImageBytes('image/png');
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'source.png',
        contentType: 'image/png',
        byteLength: imageBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => imageBytes),
      prepareImage: vi.fn(async () => ({
        status: 'complete' as const,
        mimeType: 'image/png' as const,
        bytes: imageBytes,
        previewBytes: imageBytes,
        width: 513,
        height: 1,
        previewWidth: 513,
        previewHeight: 1,
        detailReduced: false,
        uncertainty: null,
      })),
      interpretMetaImage: undefined,
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'preview-limit',
      itemId: 'preview-limit',
    });
    await waitForIdle(service);
    const preview = await service.readContextPreview(context(), {
      itemId: 'preview-limit',
    });

    expect(preview).toMatchObject({
      kind: 'unavailable',
      reason: 'unreadable',
    });
    expect(preview).not.toHaveProperty('url');
    expect(preview).not.toHaveProperty('html');
  });

  it('preserves a local image checkpoint when cancellation aborts later Meta work', async () => {
    let interpretationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      interpretationStarted = resolve;
    });
    const imageBytes = await createImageBytes('image/webp');
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'handwriting.webp',
        contentType: 'image/webp',
        byteLength: imageBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => imageBytes),
      prepareImage: vi.fn(async () => ({
        status: 'complete' as const,
        mimeType: 'image/webp' as const,
        bytes: imageBytes,
        previewBytes: imageBytes,
        width: 1,
        height: 1,
        previewWidth: 1,
        previewHeight: 1,
        detailReduced: false,
        uncertainty: null,
      })),
      interpretMetaImage: vi.fn(
        async (_context, input): Promise<ContextImageInterpretation> => {
          interpretationStarted?.();
          return new Promise<ContextImageInterpretation>((_resolve, reject) => {
            input.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          });
        },
      ),
    });
    const service = createContextIngestionService(state.dependencies);
    const operation = await service.ingestSelectedFile(context(), {
      ticketId: 'image',
      itemId: 'image-a',
    });
    await started;

    await service.cancelContextIngestion(context(), {
      operationId: operation.operationId,
    });
    await waitForIdle(service);

    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({
      itemId: 'image-a',
      extractionStatus: 'partial',
      originalStorageKey: 'opaque-image-a',
    });
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: 'cancelled' }),
    );
    expect(
      state.publish.mock.calls
        .map(([event]) => event.outcome)
        .filter((outcome) => outcome !== undefined),
    ).toEqual(['cancelled']);
  });

  it('does not commit a late interpretation after its source item is removed', async () => {
    let startInterpretation!: () => void;
    let finishInterpretation!: () => void;
    let removed = false;
    const interpretationStarted = new Promise<void>((resolve) => {
      startInterpretation = resolve;
    });
    const interpretationGate = new Promise<void>((resolve) => {
      finishInterpretation = resolve;
    });
    const imageBytes = await createImageBytes('image/webp');
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'handwriting.webp',
        contentType: 'image/webp',
        byteLength: imageBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => imageBytes),
      readItem: vi.fn(
        async (_context, itemId): Promise<ContextIngestionItem> => ({
          id: itemId,
          revision: state.attempts.length + state.attemptStatuses.length,
          removed,
          currentVersionId:
            state.versions.filter((version) => version.itemId === itemId).at(-1)
              ?.id ?? null,
          status: 'processing',
          usable: state.versions.some((version) => version.itemId === itemId),
        }),
      ),
      prepareImage: vi.fn(async () => ({
        status: 'complete' as const,
        mimeType: 'image/webp' as const,
        bytes: imageBytes,
        previewBytes: imageBytes,
        width: 1,
        height: 1,
        previewWidth: 1,
        previewHeight: 1,
        detailReduced: false,
        uncertainty: null,
      })),
      interpretMetaImage: vi.fn(async () => {
        startInterpretation();
        await interpretationGate;
        return {
          status: 'complete' as const,
          text: 'Late interpretation must not be stored.',
          uncertainty: null,
        };
      }),
    });
    const service = createContextIngestionService(state.dependencies);
    await service.ingestSelectedFile(context(), {
      ticketId: 'image',
      itemId: 'removed-image',
    });
    await interpretationStarted;
    removed = true;
    finishInterpretation();
    await waitForIdle(service);

    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({
      itemId: 'removed-image',
      extractionStatus: 'partial',
    });
    expect(state.versions.some((version) => version.extractedText)).toBe(false);
    expect(
      state.publish.mock.calls
        .map(([event]) => event.outcome)
        .filter((outcome) => outcome !== undefined),
    ).toEqual([]);
  });

  it('retries the original bytes as a new attempt and preserves the usable version on unreadable extraction', async () => {
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'reading.pdf',
        contentType: 'application/pdf',
        byteLength: pdfBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => pdfBytes),
      extractPdf: vi.fn(
        async (): Promise<PdfContentResult> => ({
          status: 'complete',
          pageCount: 1,
          text: 'Known readable page.',
        }),
      ),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'pdf',
      itemId: 'item-a',
    });
    await waitForIdle(service);
    const firstVersion = state.versions[0]?.id;
    state.dependencies.extractPdf = vi.fn(
      async (): Promise<PdfContentResult> => ({
        status: 'unreadable',
        pageCount: 0,
        text: '',
      }),
    );
    await service.retryContextIngestion(context(), {
      itemId: 'item-a',
      requestId: 'a7c2b3ea-6d8f-46fd-9f1b-7de62ab05801',
    });
    await waitForIdle(service);

    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]?.id).toBe(firstVersion);
    expect(state.attempts.length).toBeGreaterThanOrEqual(2);
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: 'unreadable' }),
    );
  });

  it('formats every ingestion state with a label and icon', () => {
    const statuses: IngestionStatus[] = [
      'queued',
      'processing',
      'complete',
      'partial',
      'unreadable',
      'unsupported',
      'failed',
      'cancelled',
    ];

    for (const status of statuses) {
      const presentation = formatIngestionStatus(status);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.icon).toBeTruthy();
    }
  });
});
