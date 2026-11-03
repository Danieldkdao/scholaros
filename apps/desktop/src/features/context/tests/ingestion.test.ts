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
import type { PdfContentResult } from '../services/pdf-content';
import { formatIngestionStatus } from '../lib/formatters';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

const textBytes = Buffer.from(
  'A literal <script> tag stays text.\nSecond paragraph.',
  'utf8',
);
const pdfBytes = Buffer.from('%PDF-1.7\nsynthetic pages');
const webpBytes = () => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(0, 24, 3);
  bytes.writeUIntLE(0, 27, 3);
  return bytes;
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
        return { revision: attempts.length };
      },
    ),
    writeVersion: vi.fn(
      async (_context, input: ContextIngestionVersionInput) => {
        const { signal: _signal, ...versionData } = input;
        const version: ContextIngestionVersion = {
          id: `version-${versions.length + 1}`,
          ...versionData,
        };
        versions.push(version);
        return {
          versionId: version.id,
          revision: versions.length,
          currentVersionId: version.id,
          usable:
            version.extractionStatus === 'complete' ||
            version.extractionStatus === 'partial',
        };
      },
    ),
    updateAttemptStatus: vi.fn(async (_context, input) => {
      attemptStatuses.push(input);
      return { revision: attempts.length + attemptStatuses.length };
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
    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: 'complete' }),
    );
    expect(
      state.publish.mock.calls
        .map(([event]) => event.outcome)
        .filter((outcome) => outcome !== undefined),
    ).toEqual(['completed']);
    await expect(
      service.readContextPreview(context(), { itemId: 'item-a' }),
    ).resolves.toMatchObject({
      kind: 'text',
      text: expect.stringContaining('<script>'),
    });
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

  it('reports encrypted/corrupt PDF as unreadable and never routes it to Meta interpretation', async () => {
    const bytes = Buffer.from('%PDF-1.7\nnot-a-valid-document');
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'corrupt.pdf',
        contentType: 'application/pdf',
        byteLength: bytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => bytes),
    });
    const service = createContextIngestionService(state.dependencies);

    await service.ingestSelectedFile(context(), {
      ticketId: 'pdf',
      itemId: 'pdf-a',
    });
    await waitForIdle(service);

    expect(state.attemptStatuses).toContainEqual(
      expect.objectContaining({ status: 'unreadable' }),
    );
    expect(state.dependencies.interpretMetaPdf).not.toHaveBeenCalled();
  });

  it('uses Meta interpretation for a scanned blank PDF and records exact page coverage', async () => {
    const state = makeDependencies({
      inspectSelectedFile: vi.fn(async () => ({
        fileName: 'scan.pdf',
        contentType: 'application/pdf',
        byteLength: pdfBytes.byteLength,
      })),
      readSelectedFile: vi.fn(async () => pdfBytes),
      extractPdf: vi.fn(
        async (): Promise<PdfContentResult> => ({
          status: 'complete',
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

  it('uses the Meta interpretation adapter for handwritten image content', async () => {
    const imageBytes = webpBytes();
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

  it('preserves a local image checkpoint when cancellation aborts later Meta work', async () => {
    let interpretationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      interpretationStarted = resolve;
    });
    const imageBytes = webpBytes();
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
    const imageBytes = webpBytes();
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
