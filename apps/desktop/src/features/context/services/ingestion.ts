import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  idSchema,
  requestIdSchema,
  type AuthorizedContext,
  type ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import type {
  ContextImageMimeType,
  ContextPreview,
  IngestionStatus,
  Locator,
} from '@scholaros/services/learning/context-contracts';
import { extractDocxContent } from './docx-content';
import {
  contextFileLimits,
  isContextFileBatchWithinLimits,
  validateContextFile,
  type ContextFileValidationInput,
} from './file-validation';
import {
  createUtilityProcessImageDecoder,
  prepareContextImage,
  type ContextImageContentResult,
  type ContextImageDecoder,
} from './image-content';
import {
  createImagePreview,
  createTextPreview,
  createUnavailablePreview,
} from './preview-content';
import { extractPdfContent, type PdfContentResult } from './pdf-content';

const maxPendingIngestions = contextFileLimits.batchFiles;
const maxInterpretedPdfPages = 20;
const maxStoredPdfPages = 200;
const maxExtractedCharacters = 1_000_000;
const maxStoredTextCharacters = 2_000_000;
const maxRememberedOperations = 256;

export const ingestSelectedFileInputSchema = z.strictObject({
  ticketId: idSchema,
  itemId: idSchema,
  operationId: requestIdSchema.optional(),
  sessionId: idSchema.optional(),
  courseId: idSchema.optional(),
});
export type IngestSelectedFileInputSchema = z.infer<
  typeof ingestSelectedFileInputSchema
>;
export type IngestSelectedFileInput = z.infer<
  typeof ingestSelectedFileInputSchema
>;

export const retryContextIngestionInputSchema = z.strictObject({
  itemId: idSchema,
  requestId: requestIdSchema,
});
export type RetryContextIngestionInputSchema = z.infer<
  typeof retryContextIngestionInputSchema
>;
export type RetryContextIngestionInput = z.infer<
  typeof retryContextIngestionInputSchema
>;

export const cancelContextIngestionInputSchema = z.strictObject({
  operationId: idSchema,
});
export type CancelContextIngestionInputSchema = z.infer<
  typeof cancelContextIngestionInputSchema
>;
export type CancelContextIngestionInput = z.infer<
  typeof cancelContextIngestionInputSchema
>;

export const readContextPreviewInputSchema = z.strictObject({
  itemId: idSchema,
  versionId: idSchema.optional(),
  sessionId: idSchema.optional(),
});
export type ReadContextPreviewInputSchema = z.infer<
  typeof readContextPreviewInputSchema
>;
export type ReadContextPreviewInput = z.infer<
  typeof readContextPreviewInputSchema
>;

export type ContextIngestionErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'scope-denied'
  | 'session-changed'
  | 'permission-revoked'
  | 'busy'
  | 'cancelled'
  | 'limit-exceeded'
  | 'unsupported'
  | 'unreadable'
  | 'feature-unavailable'
  | 'needs-sign-in'
  | 'permission-revoked'
  | 'provider-failed'
  | 'rate-limited'
  | 'revision-conflict'
  | 'storage-failed';

export class ContextIngestionError extends Error {
  constructor(
    readonly code: ContextIngestionErrorCode,
    message = 'The requested context operation could not be completed.',
  ) {
    super(message);
    this.name = 'ContextIngestionError';
  }
}

export type SelectedFileTicketInfo = {
  fileName: string;
  contentType: string;
  byteLength: number;
};

export type StoredContextOriginal = {
  fileName: string;
  contentType: string;
  originalHash: string;
  storageKey: string;
  bytes: Uint8Array;
};

export type ContextIngestionItem = {
  id: string;
  revision: number;
  removed: boolean;
  currentVersionId: string | null;
  status: IngestionStatus;
  usable: boolean;
};

export type ContextIngestionVersion = {
  id: string;
  itemId: string;
  contentHash: string;
  mimeType: string;
  byteLength: number;
  extractionStatus: IngestionStatus;
  interpretedPages: number[];
  uncertainty: string | null;
  pageCount: number | null;
  locators: Locator[];
  extractedText: string | null;
  originalHash: string;
  originalStorageKey: string | null;
};

export type ContextIngestionAttemptInput = {
  itemId: string;
  attemptId: string;
  operationId: string;
  requestId: string | null;
  status: IngestionStatus;
};

export type ContextIngestionAttemptResult = {
  revision: number;
  existing?: boolean;
  operationId?: string;
  status?: IngestionStatus;
};

export type ContextIngestionAttemptStatusInput = {
  itemId: string;
  attemptId: string;
  operationId: string;
  status: IngestionStatus;
  errorCode?: ContextIngestionErrorCode;
  uncertainty?: string | null;
};

export type ContextIngestionVersionInput = {
  itemId: string;
  attemptId: string;
  operationId: string;
  expectedRevision: number;
  originalIsNew: boolean;
  originalHash: string;
  originalStorageKey: string;
  contentHash: string;
  mimeType: string;
  byteLength: number;
  extractedText: string | null;
  extractionStatus: 'complete' | 'partial';
  pageCount: number | null;
  interpretedPages: number[];
  uncertainty: string | null;
  locators: Locator[];
  signal: AbortSignal;
};

export type ContextIngestionVersionCommit = {
  versionId: string;
  revision: number;
  currentVersionId: string | null;
  usable: boolean;
};

export type ContextInterpretationPage = {
  pageNumber: number;
  text: string;
  uncertainty: string | null;
};

export type ContextPdfInterpretation = {
  status: 'complete' | 'partial' | 'unreadable' | 'unsupported';
  pages: ContextInterpretationPage[];
  interpretedPages: number[];
  uncertainty: string | null;
};

export type ContextImageInterpretation = {
  status: 'complete' | 'partial' | 'unreadable' | 'unsupported';
  text: string;
  uncertainty: string | null;
};

export type ContextIngestionDependencies = {
  inspectSelectedFile: (
    context: AuthorizedContext,
    ticketId: string,
  ) => Promise<SelectedFileTicketInfo>;
  readSelectedFile: (
    context: AuthorizedContext,
    ticketId: string,
    expected: SelectedFileTicketInfo,
    maxBytes: number,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  readOriginal: (
    context: AuthorizedContext,
    itemId: string,
    signal?: AbortSignal,
    storageKey?: string,
  ) => Promise<StoredContextOriginal | null>;
  storeOriginal: (
    context: AuthorizedContext,
    input: {
      itemId: string;
      fileName: string;
      contentType: string;
      originalHash: string;
      bytes: Uint8Array;
      signal: AbortSignal;
    },
  ) => Promise<{ originalHash: string; storageKey: string }>;
  readItem: (
    context: AuthorizedContext,
    itemId: string,
    scope?: { sessionId?: string; courseId?: string },
  ) => Promise<ContextIngestionItem | null>;
  readVersion: (
    context: AuthorizedContext,
    itemId: string,
    versionId?: string,
  ) => Promise<ContextIngestionVersion | null>;
  writeAttempt: (
    context: AuthorizedContext,
    input: ContextIngestionAttemptInput,
  ) => Promise<ContextIngestionAttemptResult>;
  updateAttemptStatus: (
    context: AuthorizedContext,
    input: ContextIngestionAttemptStatusInput,
  ) => Promise<{ revision: number }>;
  writeVersion: (
    context: AuthorizedContext,
    input: ContextIngestionVersionInput,
  ) => Promise<ContextIngestionVersionCommit>;
  cleanupOriginal?: (
    context: AuthorizedContext,
    storageKeys: string[],
  ) => Promise<void>;
  onOperationSettled?: (
    context: AuthorizedContext,
    operationId: string,
  ) => void | Promise<void>;
  publish: (event: ProductEventV1) => void | Promise<void>;
  extractPdf?: (
    bytes: Uint8Array,
    options: {
      signal: AbortSignal;
      maxPages: number;
      maxCharacters: number;
      timeoutMs: number;
    },
  ) => Promise<PdfContentResult>;
  prepareImage?: (
    bytes: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
  ) => Promise<ContextImageContentResult>;
  imageDecoder?: ContextImageDecoder | null;
  interpretMetaPdf?: (
    context: AuthorizedContext,
    input: {
      operationId: string;
      itemId: string;
      bytes: Uint8Array;
      pages: number[];
      signal: AbortSignal;
    },
  ) => Promise<ContextPdfInterpretation>;
  interpretMetaImage?: (
    context: AuthorizedContext,
    input: {
      operationId: string;
      itemId: string;
      bytes: Uint8Array;
      mimeType: ContextImageMimeType;
      signal: AbortSignal;
    },
  ) => Promise<ContextImageInterpretation>;
};

type IngestionScope = {
  sessionId?: string;
  courseId?: string;
};

type IngestionJob = {
  context: AuthorizedContext;
  operationId: string;
  attemptId: string;
  requestId: string | null;
  itemId: string;
  scope: IngestionScope;
  fileInfo: SelectedFileTicketInfo;
  source:
    | { kind: 'ticket'; ticketId: string }
    | { kind: 'original'; original: StoredContextOriginal };
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  state: 'queued' | 'running' | 'finished';
  onContextAbort: () => void;
};

type ContextIngestionService = {
  ingestSelectedFile: (
    context: AuthorizedContext,
    input: IngestSelectedFileInput,
  ) => Promise<{ operationId: string; itemId: string }>;
  retryContextIngestion: (
    context: AuthorizedContext,
    input: RetryContextIngestionInput,
  ) => Promise<{ operationId: string }>;
  cancelContextIngestion: (
    context: AuthorizedContext,
    input: CancelContextIngestionInput,
  ) => Promise<void>;
  readContextPreview: (
    context: AuthorizedContext,
    input: ReadContextPreviewInput,
  ) => Promise<ContextPreview>;
  whenIdle: () => Promise<void>;
};

const terminalStatuses = new Set<IngestionStatus>([
  'complete',
  'partial',
  'unreadable',
  'unsupported',
  'failed',
  'cancelled',
]);

const operationKey = (context: AuthorizedContext, operationId: string) =>
  `${context.userId}:${context.epoch}:${operationId}`;

const shortTextHash = (
  mimeType: string,
  originalHash: string,
  text: string | null,
) => {
  if (text !== null) return createHash('sha256').update(text).digest('hex');
  const digest = createHash('sha256');
  digest.update(mimeType);
  digest.update('\0');
  digest.update(originalHash);
  return digest.digest('hex');
};

const contentHashForImage = (
  originalHash: string,
  mimeType: string,
  text: string | null,
) => shortTextHash(mimeType, originalHash, text);

const textLocators = (text: string, markdown: boolean): Locator[] => {
  const locators: Locator[] = [];
  if (markdown) {
    for (const line of text.split(/\r?\n/)) {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)?.[1]?.trim();
      if (heading) {
        locators.push({ kind: 'heading', heading: heading.slice(0, 300) });
        if (locators.length >= 2_000) return locators;
      }
    }
  }
  const paragraphs = text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim());
  for (const [index] of paragraphs.entries()) {
    if (locators.length >= 2_000) break;
    locators.push({ kind: 'paragraph', ordinal: index + 1 });
  }
  return locators;
};

const pdfPageSegments = (result: PdfContentResult) => {
  const structured = result as PdfContentResult & {
    pages?: Array<{ pageNumber?: number; page?: number; text?: string }>;
  };
  if (Array.isArray(structured.pages))
    return structured.pages
      .flatMap((page) => {
        const pageNumber = page.pageNumber ?? page.page;
        return Number.isSafeInteger(pageNumber) && pageNumber! > 0
          ? [{ pageNumber: pageNumber!, text: page.text ?? '' }]
          : [];
      })
      .sort((left, right) => left.pageNumber - right.pageNumber);
  if (result.text.length === 0) return [];
  return result.text.split('\f').map((text, index) => ({
    pageNumber: index + 1,
    text,
  }));
};

const fullPdfText = (pages: Array<{ pageNumber: number; text: string }>) =>
  pages.map(({ text }) => text).join('\f');

const formatPdfText = (pages: Array<{ pageNumber: number; text: string }>) =>
  fullPdfText(pages).slice(0, maxExtractedCharacters);

const pdfLocators = (pages: Array<{ pageNumber: number; text: string }>) =>
  pages
    .slice(0, maxStoredPdfPages)
    .map(({ pageNumber }) => ({ kind: 'page' as const, page: pageNumber }));

const validInterpretedPages = (
  result: ContextPdfInterpretation,
  requestedPages: number[],
) => {
  const requested = new Set(requestedPages);
  const pages = result.interpretedPages;
  if (
    !Array.isArray(pages) ||
    pages.length > requestedPages.length ||
    pages.some((page) => !Number.isSafeInteger(page) || !requested.has(page)) ||
    new Set(pages).size !== pages.length
  )
    return false;
  const returnedPages = result.pages.map(({ pageNumber }) => pageNumber);
  return (
    returnedPages.length === pages.length &&
    returnedPages.every((page) => pages.includes(page)) &&
    result.pages.every(
      ({ text }) => typeof text === 'string' && text.length <= 50_000,
    )
  );
};

const resultingPdfStatus = (
  result: ContextPdfInterpretation,
  requestedPages: number[],
): 'complete' | 'partial' | null => {
  if (result.status === 'unsupported' || result.status === 'unreadable')
    return null;
  return result.status === 'complete' &&
    result.interpretedPages.length === requestedPages.length
    ? 'complete'
    : 'partial';
};

const resultingImageStatus = (
  result: ContextImageInterpretation,
): 'complete' | 'partial' | null => {
  if (result.status === 'unsupported' || result.status === 'unreadable')
    return null;
  return result.status === 'complete' &&
    result.text.trim().length > 0 &&
    result.text.length <= 50_000
    ? 'complete'
    : 'partial';
};

const safeUncertainty = (value: string | null | undefined) =>
  typeof value === 'string' ? value.slice(0, 1_000) : null;

const errorCodeForFileResult = (
  result: Extract<
    ReturnType<typeof validateContextFile>,
    { status: 'unsupported' | 'unreadable' }
  >,
): ContextIngestionErrorCode =>
  result.status === 'unsupported'
    ? result.reason === 'limit-exceeded'
      ? 'limit-exceeded'
      : 'unsupported'
    : 'unreadable';

const contextErrorCode = (error: unknown): ContextIngestionErrorCode => {
  if (error instanceof ContextIngestionError) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError')
    return 'cancelled';
  return 'storage-failed';
};

const interpretationErrorCode = (error: unknown): ContextIngestionErrorCode => {
  const code = contextErrorCode(error);
  return code === 'storage-failed' ? 'provider-failed' : code;
};

const assertRequest = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ContextIngestionError('invalid-input');
  return parsed.data;
};

const makeEvent = (
  context: AuthorizedContext,
  revision: number,
  itemId: string,
  operationId: string,
  status?: IngestionStatus,
): ProductEventV1 => ({
  version: 1,
  accountId: context.userId,
  revision,
  resource: 'context',
  targetId: itemId,
  operationId,
  ...(status
    ? {
        outcome:
          status === 'complete'
            ? ('completed' as const)
            : status === 'cancelled'
              ? ('cancelled' as const)
              : status === 'failed'
                ? ('failed' as const)
                : ('attention' as const),
      }
    : {}),
});

export const createContextIngestionService = (
  dependencies: ContextIngestionDependencies,
): ContextIngestionService => {
  const queue: IngestionJob[] = [];
  const imageDecoder =
    dependencies.imageDecoder === undefined
      ? createUtilityProcessImageDecoder()
      : dependencies.imageDecoder;
  const jobs = new Map<string, IngestionJob>();
  const ticketOperations = new Map<string, string>();
  const ticketAdmissions = new Map<
    string,
    Promise<{ operationId: string; itemId: string }>
  >();
  const retryOperations = new Map<string, string>();
  const retryAdmissions = new Map<string, Promise<{ operationId: string }>>();
  const reservedFileBytes = new Map<string, number>();
  let pendingAdmissions = 0;
  let activeJob: IngestionJob | null = null;
  let drainPromise: Promise<void> | null = null;

  const emit = (event: ProductEventV1) => {
    try {
      void Promise.resolve(dependencies.publish(event)).catch(() => undefined);
    } catch {
      return;
    }
  };

  const assertCurrent = (job: IngestionJob) => {
    if (job.controller.signal.aborted || job.context.signal.aborted)
      throw new DOMException('Aborted', 'AbortError');
    if (!job.context.isCurrent())
      throw new ContextIngestionError('session-changed');
  };

  const assertItemAvailable = async (job: IngestionJob) => {
    assertCurrent(job);
    const item = await dependencies.readItem(
      job.context,
      job.itemId,
      job.scope,
    );
    if (!item || item.removed)
      throw new ContextIngestionError('permission-revoked');
    return item;
  };

  const saveSpecificAttemptStatus = async (
    job: IngestionJob,
    attemptId: string,
    status: IngestionStatus,
    errorCode?: ContextIngestionErrorCode,
    uncertainty?: string | null,
    terminalOutcome = false,
  ) => {
    if (!job.context.isCurrent()) return;
    const item = await dependencies.readItem(
      job.context,
      job.itemId,
      job.scope,
    );
    if (!item || item.removed) return;
    const result = await dependencies.updateAttemptStatus(job.context, {
      itemId: job.itemId,
      attemptId,
      operationId: job.operationId,
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(uncertainty !== undefined
        ? { uncertainty: safeUncertainty(uncertainty) }
        : {}),
    });
    emit(
      makeEvent(
        job.context,
        result.revision,
        job.itemId,
        job.operationId,
        terminalOutcome ? status : undefined,
      ),
    );
  };

  const saveAttemptStatus = async (
    job: IngestionJob,
    status: IngestionStatus,
    errorCode?: ContextIngestionErrorCode,
    uncertainty?: string | null,
  ) =>
    saveSpecificAttemptStatus(
      job,
      job.attemptId,
      status,
      errorCode,
      uncertainty,
      true,
    );

  const persistVersion = async (
    job: IngestionJob,
    version: Omit<
      ContextIngestionVersionInput,
      | 'itemId'
      | 'attemptId'
      | 'operationId'
      | 'expectedRevision'
      | 'originalIsNew'
      | 'signal'
    > & {
      attemptId?: string;
    },
  ) => {
    const item = await assertItemAvailable(job);
    const result = await dependencies.writeVersion(job.context, {
      ...version,
      itemId: job.itemId,
      attemptId: version.attemptId ?? job.attemptId,
      operationId: job.operationId,
      expectedRevision: item.revision,
      originalIsNew: job.source.kind === 'ticket',
      signal: job.controller.signal,
    });
    emit(makeEvent(job.context, result.revision, job.itemId, job.operationId));
    return result;
  };

  const keepBounded = (
    map: Map<string, string>,
    key: string,
    value: string,
  ) => {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > maxRememberedOperations)
      map.delete(map.keys().next().value!);
  };

  const beginAdmission = () => {
    if (
      queue.length + (activeJob ? 1 : 0) + pendingAdmissions >=
      maxPendingIngestions
    )
      throw new ContextIngestionError('busy');
    pendingAdmissions++;
  };

  const endAdmission = () => {
    pendingAdmissions = Math.max(0, pendingAdmissions - 1);
  };

  const finishJob = async (job: IngestionJob) => {
    job.state = 'finished';
    const key = operationKey(job.context, job.operationId);
    jobs.delete(key);
    reservedFileBytes.delete(key);
    job.context.signal.removeEventListener('abort', job.onContextAbort);
    await Promise.resolve()
      .then(() =>
        dependencies.onOperationSettled?.(job.context, job.operationId),
      )
      .catch(() => undefined);
    job.resolveDone();
  };

  const completeAttempt = async (
    job: IngestionJob,
    status: IngestionStatus,
    errorCode?: ContextIngestionErrorCode,
    uncertainty?: string | null,
  ) => {
    if (terminalStatuses.has(status)) {
      try {
        await saveAttemptStatus(job, status, errorCode, uncertainty);
      } catch {
        return;
      }
    }
  };

  const processPdf = async (
    job: IngestionJob,
    file: ContextFileValidationInput & { bytes: Uint8Array },
    original: { originalHash: string; storageKey: string },
  ) => {
    const parsePdf = dependencies.extractPdf ?? extractPdfContent;
    const parsed = await parsePdf(file.bytes, {
      signal: job.controller.signal,
      maxPages: maxStoredPdfPages,
      maxCharacters: maxExtractedCharacters,
      timeoutMs: 15_000,
    });
    assertCurrent(job);
    const pages = pdfPageSegments(parsed);
    const localText = formatPdfText(pages);
    const localTextTruncated =
      fullPdfText(pages).length > maxExtractedCharacters;
    const pageCount = Math.max(parsed.pageCount, pages.at(-1)?.pageNumber ?? 0);
    const pageCountOutOfBounds = pageCount > maxStoredPdfPages;
    const storedPageCount = pageCountOutOfBounds ? null : pageCount;
    if (parsed.status !== 'unreadable' && localText.trim()) {
      const status =
        parsed.status === 'partial' ||
        localTextTruncated ||
        pageCountOutOfBounds
          ? 'partial'
          : 'complete';
      const uncertainty = localTextTruncated
        ? 'PDF text was truncated at the extraction limit.'
        : pageCountOutOfBounds
          ? 'PDF exceeds the 200-page processing limit; some pages were not extracted.'
          : status === 'partial'
            ? 'PDF text extraction reached a processing limit.'
            : null;
      await persistVersion(job, {
        originalHash: original.originalHash,
        originalStorageKey: original.storageKey,
        contentHash: shortTextHash(
          file.contentType ?? 'application/pdf',
          original.originalHash,
          localText,
        ),
        mimeType: 'application/pdf',
        byteLength: file.bytes.byteLength,
        extractedText: localText,
        extractionStatus: status,
        pageCount: storedPageCount,
        interpretedPages: [],
        uncertainty,
        locators: pdfLocators(pages),
      });
      await completeAttempt(job, status, undefined, uncertainty);
      return;
    }

    if (pageCount <= 0) {
      await completeAttempt(job, 'unreadable', 'unreadable');
      return;
    }

    const scanUncertainty = pageCountOutOfBounds
      ? 'Scanned PDF exceeds the 200-page processing limit; some pages were not extracted.'
      : pageCount > maxInterpretedPdfPages
        ? 'This scanned PDF exceeds the 20-page interpretation limit; no pages were sent.'
        : 'No selectable PDF text was found; visual interpretation is required.';
    await persistVersion(job, {
      originalHash: original.originalHash,
      originalStorageKey: original.storageKey,
      contentHash: shortTextHash(
        'application/pdf',
        original.originalHash,
        null,
      ),
      mimeType: 'application/pdf',
      byteLength: file.bytes.byteLength,
      extractedText: null,
      extractionStatus: 'partial',
      pageCount: storedPageCount,
      interpretedPages: [],
      uncertainty: scanUncertainty,
      locators: pdfLocators(pages),
    });
    if (pageCount > maxInterpretedPdfPages) {
      await completeAttempt(job, 'partial', 'limit-exceeded', scanUncertainty);
      return;
    }
    if (!dependencies.interpretMetaPdf) {
      await completeAttempt(
        job,
        'partial',
        'feature-unavailable',
        'PDF was saved, but Meta document interpretation is unavailable.',
      );
      return;
    }

    const requestedPages = Array.from(
      { length: pageCount },
      (_, index) => index + 1,
    );
    await assertItemAvailable(job);
    const interpretationAttemptId = randomUUID();
    const interpretationAttempt = await dependencies.writeAttempt(job.context, {
      itemId: job.itemId,
      attemptId: interpretationAttemptId,
      operationId: job.operationId,
      requestId: null,
      status: 'processing',
    });
    emit(
      makeEvent(
        job.context,
        interpretationAttempt.revision,
        job.itemId,
        job.operationId,
      ),
    );
    try {
      const interpreted = await dependencies.interpretMetaPdf(job.context, {
        operationId: job.operationId,
        itemId: job.itemId,
        bytes: file.bytes,
        pages: requestedPages,
        signal: job.controller.signal,
      });
      assertCurrent(job);
      if (!validInterpretedPages(interpreted, requestedPages))
        throw new ContextIngestionError('provider-failed');
      const status = resultingPdfStatus(interpreted, requestedPages);
      if (!status) {
        const errorCode =
          interpreted.status === 'unsupported' ? 'unsupported' : 'unreadable';
        await saveSpecificAttemptStatus(
          job,
          interpretationAttemptId,
          interpreted.status,
          errorCode,
          interpreted.uncertainty,
        );
        await completeAttempt(
          job,
          interpreted.status,
          errorCode,
          interpreted.uncertainty,
        );
        return;
      }
      const interpretedPageText = [...interpreted.pages]
        .sort((left, right) => left.pageNumber - right.pageNumber)
        .map(({ pageNumber, text }) => ({ pageNumber, text }));
      const interpretedFullText = fullPdfText(interpretedPageText);
      const interpretedText = interpretedFullText.slice(
        0,
        maxExtractedCharacters,
      );
      const finalStatus =
        status === 'partial' ||
        interpretedFullText.length > maxExtractedCharacters
          ? 'partial'
          : 'complete';
      const uncertainty = safeUncertainty(
        [
          interpreted.uncertainty,
          interpretedFullText.length > maxExtractedCharacters
            ? 'Interpreted PDF text was truncated at the extraction limit.'
            : null,
        ]
          .filter((part): part is string => !!part)
          .join(' '),
      );
      await persistVersion(job, {
        attemptId: interpretationAttemptId,
        originalHash: original.originalHash,
        originalStorageKey: original.storageKey,
        contentHash: shortTextHash(
          'application/pdf',
          original.originalHash,
          interpretedText,
        ),
        mimeType: 'application/pdf',
        byteLength: file.bytes.byteLength,
        extractedText: interpretedText,
        extractionStatus: finalStatus,
        pageCount,
        interpretedPages: [...interpreted.interpretedPages].sort(
          (a, b) => a - b,
        ),
        uncertainty,
        locators: pdfLocators(interpretedPageText),
      });
      await completeAttempt(job, finalStatus, undefined, uncertainty);
    } catch (error) {
      const errorCode = interpretationErrorCode(error);
      const status = errorCode === 'cancelled' ? 'cancelled' : 'failed';
      try {
        await saveSpecificAttemptStatus(
          job,
          interpretationAttemptId,
          status,
          errorCode,
        );
      } catch {
        return;
      }
      await completeAttempt(job, status, errorCode);
    }
  };

  const processImage = async (
    job: IngestionJob,
    file: ContextFileValidationInput & {
      bytes: Uint8Array;
      imageMimeType: ContextImageMimeType;
    },
    original: { originalHash: string; storageKey: string },
  ) => {
    const prepare =
      dependencies.prepareImage ??
      ((bytes, mimeType, signal) =>
        prepareContextImage(bytes, mimeType, {
          decode: imageDecoder,
          signal,
        }));
    const prepared = await prepare(
      file.bytes,
      file.imageMimeType,
      job.controller.signal,
    );
    assertCurrent(job);
    if (prepared.status !== 'complete') {
      await completeAttempt(
        job,
        prepared.status,
        prepared.reason === 'limit-exceeded' ? 'limit-exceeded' : 'unreadable',
      );
      return;
    }

    await persistVersion(job, {
      originalHash: original.originalHash,
      originalStorageKey: original.storageKey,
      contentHash: contentHashForImage(
        original.originalHash,
        file.imageMimeType,
        null,
      ),
      mimeType: file.imageMimeType,
      byteLength: file.bytes.byteLength,
      extractedText: null,
      extractionStatus: 'partial',
      pageCount: null,
      interpretedPages: [],
      uncertainty: prepared.uncertainty,
      locators: [],
    });
    if (!dependencies.interpretMetaImage) {
      await completeAttempt(
        job,
        'partial',
        'feature-unavailable',
        'Image was saved, but Meta image interpretation is unavailable.',
      );
      return;
    }

    await assertItemAvailable(job);
    const interpretationAttemptId = randomUUID();
    const interpretationAttempt = await dependencies.writeAttempt(job.context, {
      itemId: job.itemId,
      attemptId: interpretationAttemptId,
      operationId: job.operationId,
      requestId: null,
      status: 'processing',
    });
    emit(
      makeEvent(
        job.context,
        interpretationAttempt.revision,
        job.itemId,
        job.operationId,
      ),
    );
    try {
      const interpreted = await dependencies.interpretMetaImage(job.context, {
        operationId: job.operationId,
        itemId: job.itemId,
        bytes: prepared.bytes,
        mimeType: prepared.mimeType,
        signal: job.controller.signal,
      });
      assertCurrent(job);
      const status = resultingImageStatus(interpreted);
      if (!status) {
        const errorCode =
          interpreted.status === 'unsupported' ? 'unsupported' : 'unreadable';
        await saveSpecificAttemptStatus(
          job,
          interpretationAttemptId,
          interpreted.status,
          errorCode,
          interpreted.uncertainty,
        );
        await completeAttempt(
          job,
          interpreted.status,
          errorCode,
          interpreted.uncertainty,
        );
        return;
      }
      const text = interpreted.text.slice(0, 50_000);
      const textTruncated = text.length < interpreted.text.length;
      const finalStatus = textTruncated ? 'partial' : status;
      const uncertainty = safeUncertainty(
        [
          prepared.uncertainty,
          interpreted.uncertainty,
          textTruncated
            ? 'Image interpretation text was truncated at the preview limit.'
            : null,
        ]
          .filter((part): part is string => !!part)
          .join(' '),
      );
      await persistVersion(job, {
        attemptId: interpretationAttemptId,
        originalHash: original.originalHash,
        originalStorageKey: original.storageKey,
        contentHash: contentHashForImage(
          original.originalHash,
          file.imageMimeType,
          text,
        ),
        mimeType: file.imageMimeType,
        byteLength: file.bytes.byteLength,
        extractedText: text,
        extractionStatus: finalStatus,
        pageCount: null,
        interpretedPages: [],
        uncertainty,
        locators: [],
      });
      await completeAttempt(job, finalStatus, undefined, uncertainty);
    } catch (error) {
      const errorCode = interpretationErrorCode(error);
      const status = errorCode === 'cancelled' ? 'cancelled' : 'failed';
      try {
        await saveSpecificAttemptStatus(
          job,
          interpretationAttemptId,
          status,
          errorCode,
        );
      } catch {
        return;
      }
      await completeAttempt(job, status, errorCode);
    }
  };

  const processJob = async (job: IngestionJob) => {
    job.state = 'running';
    activeJob = job;
    let newlyStoredOriginalKey: string | null = null;
    try {
      await assertItemAvailable(job);
      const processing = await dependencies.updateAttemptStatus(job.context, {
        itemId: job.itemId,
        attemptId: job.attemptId,
        operationId: job.operationId,
        status: 'processing',
      });
      emit(
        makeEvent(
          job.context,
          processing.revision,
          job.itemId,
          job.operationId,
        ),
      );
      if (job.fileInfo.byteLength > contextFileLimits.documentBytes) {
        await completeAttempt(job, 'unsupported', 'limit-exceeded');
        return;
      }
      const bytes =
        job.source.kind === 'ticket'
          ? await dependencies.readSelectedFile(
              job.context,
              job.source.ticketId,
              job.fileInfo,
              contextFileLimits.documentBytes,
              job.controller.signal,
            )
          : job.source.original.bytes;
      assertCurrent(job);
      await assertItemAvailable(job);
      if (bytes.byteLength !== job.fileInfo.byteLength)
        throw new ContextIngestionError('unreadable');
      const fileInput = {
        fileName: job.fileInfo.fileName,
        contentType: job.fileInfo.contentType,
        bytes,
      };
      const validated = validateContextFile(fileInput);
      if (validated.status !== 'valid') {
        await completeAttempt(
          job,
          validated.status,
          errorCodeForFileResult(validated),
        );
        return;
      }
      let original =
        job.source.kind === 'original' ? job.source.original : null;
      if (job.source.kind === 'ticket') {
        await assertItemAvailable(job);
        const originalHash = createHash('sha256').update(bytes).digest('hex');
        const stored = await dependencies.storeOriginal(job.context, {
          itemId: job.itemId,
          fileName: validated.fileName,
          contentType: validated.mimeType,
          originalHash,
          bytes,
          signal: job.controller.signal,
        });
        newlyStoredOriginalKey = stored.storageKey;
        assertCurrent(job);
        if (stored.originalHash !== originalHash || !stored.storageKey)
          throw new ContextIngestionError('storage-failed');
        original = {
          fileName: validated.fileName,
          contentType: validated.mimeType,
          originalHash,
          storageKey: stored.storageKey,
          bytes,
        };
      }
      if (!original) throw new ContextIngestionError('storage-failed');
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== original.originalHash)
        throw new ContextIngestionError('unreadable');

      switch (validated.kind) {
        case 'text': {
          const sourceText = validated.text ?? '';
          const textLimit = Math.min(
            sourceText.length,
            maxStoredTextCharacters,
          );
          const lastCodeUnit = sourceText.charCodeAt(textLimit - 1);
          const endsWithSplitSurrogate =
            textLimit < sourceText.length &&
            lastCodeUnit >= 0xd800 &&
            lastCodeUnit <= 0xdbff;
          const text = sourceText.slice(
            0,
            textLimit - (endsWithSplitSurrogate ? 1 : 0),
          );
          const textTruncated = sourceText.length > text.length;
          const uncertainty = textTruncated
            ? 'Text extraction was truncated at the 2,000,000-character storage limit.'
            : null;
          const status = textTruncated ? 'partial' : 'complete';
          await persistVersion(job, {
            originalHash: original.originalHash,
            originalStorageKey: original.storageKey,
            contentHash: shortTextHash(
              validated.mimeType,
              original.originalHash,
              text,
            ),
            mimeType: validated.mimeType,
            byteLength: bytes.byteLength,
            extractedText: text,
            extractionStatus: status,
            pageCount: null,
            interpretedPages: [],
            uncertainty,
            locators: textLocators(
              text,
              validated.mimeType === 'text/markdown',
            ),
          });
          await completeAttempt(job, status, undefined, uncertainty);
          return;
        }
        case 'docx': {
          const extracted = await extractDocxContent(bytes, {
            signal: job.controller.signal,
          });
          assertCurrent(job);
          if (
            extracted.status === 'unreadable' ||
            extracted.status === 'unsupported'
          ) {
            await completeAttempt(
              job,
              extracted.status,
              extracted.status === 'unsupported' ? 'unsupported' : 'unreadable',
              extracted.uncertainty,
            );
            return;
          }
          await persistVersion(job, {
            originalHash: original.originalHash,
            originalStorageKey: original.storageKey,
            contentHash: shortTextHash(
              validated.mimeType,
              original.originalHash,
              extracted.text,
            ),
            mimeType: validated.mimeType,
            byteLength: bytes.byteLength,
            extractedText: extracted.text,
            extractionStatus: extracted.status,
            pageCount: null,
            interpretedPages: [],
            uncertainty: extracted.uncertainty,
            locators: extracted.locators,
          });
          await completeAttempt(
            job,
            extracted.status,
            undefined,
            extracted.uncertainty,
          );
          return;
        }
        case 'pdf':
          await processPdf(job, fileInput, original);
          return;
        case 'image':
          if (!validated.imageMimeType)
            throw new ContextIngestionError('unreadable');
          await processImage(
            job,
            { ...fileInput, imageMimeType: validated.imageMimeType },
            original,
          );
          return;
      }
    } catch (error) {
      const errorCode = contextErrorCode(error);
      const status: IngestionStatus =
        errorCode === 'cancelled'
          ? 'cancelled'
          : errorCode === 'unreadable'
            ? 'unreadable'
            : errorCode === 'unsupported' || errorCode === 'limit-exceeded'
              ? 'unsupported'
              : 'failed';
      await completeAttempt(job, status, errorCode);
    } finally {
      activeJob = null;
      if (newlyStoredOriginalKey && dependencies.cleanupOriginal)
        await dependencies
          .cleanupOriginal(job.context, [newlyStoredOriginalKey])
          .catch(() => undefined);
      await finishJob(job);
    }
  };

  const drain = async () => {
    while (queue.length > 0) {
      const job = queue.shift()!;
      if (job.state === 'finished') continue;
      await processJob(job);
    }
  };

  const scheduleDrain = () => {
    if (drainPromise) return;
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainPromise = null;
        if (queue.length > 0) scheduleDrain();
      });
  };

  const addJob = async (input: {
    context: AuthorizedContext;
    operationId: string;
    attemptId: string;
    requestId: string | null;
    itemId: string;
    scope: IngestionScope;
    fileInfo: SelectedFileTicketInfo;
    source: IngestionJob['source'];
  }) => {
    const key = operationKey(input.context, input.operationId);
    const existingJob = jobs.get(key);
    if (existingJob)
      return { operationId: existingJob.operationId, existing: true };
    if (
      queue.length + (activeJob ? 1 : 0) + pendingAdmissions >
      maxPendingIngestions
    )
      throw new ContextIngestionError('busy');
    if (
      !isContextFileBatchWithinLimits([
        ...reservedFileBytes.values(),
        input.fileInfo.byteLength,
      ])
    )
      throw new ContextIngestionError('limit-exceeded');
    reservedFileBytes.set(key, input.fileInfo.byteLength);

    let attempt: Awaited<
      ReturnType<ContextIngestionDependencies['writeAttempt']>
    >;
    try {
      attempt = await dependencies.writeAttempt(input.context, {
        itemId: input.itemId,
        attemptId: input.attemptId,
        operationId: input.operationId,
        requestId: input.requestId,
        status: 'queued',
      });
    } catch (error) {
      reservedFileBytes.delete(key);
      throw error;
    }
    if (attempt.existing) {
      reservedFileBytes.delete(key);
      return {
        operationId: attempt.operationId ?? input.operationId,
        existing: true,
      };
    }

    const controller = new AbortController();
    const onContextAbort = () => controller.abort();
    input.context.signal.addEventListener('abort', onContextAbort, {
      once: true,
    });
    if (input.context.signal.aborted) controller.abort();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const job = {
      ...input,
      controller,
      done,
      resolveDone,
      state: 'queued' as const,
      onContextAbort,
    } as IngestionJob & { onContextAbort: () => void };
    jobs.set(key, job);
    queue.push(job);
    emit(
      makeEvent(
        input.context,
        attempt.revision,
        input.itemId,
        input.operationId,
      ),
    );
    scheduleDrain();
    return { operationId: input.operationId, existing: false };
  };

  const ingestSelectedFile = async (
    context: AuthorizedContext,
    rawInput: IngestSelectedFileInput,
  ) => {
    const input = assertRequest(ingestSelectedFileInputSchema, rawInput);
    if (!context.isCurrent())
      throw new ContextIngestionError('session-changed');
    const ticketKey = `${context.userId}:${context.epoch}:${input.itemId}:${input.ticketId}`;
    const priorOperation = ticketOperations.get(ticketKey);
    if (priorOperation)
      return { operationId: priorOperation, itemId: input.itemId };
    const pendingAdmission = ticketAdmissions.get(ticketKey);
    if (pendingAdmission) return pendingAdmission;

    const admission = (async () => {
      beginAdmission();
      try {
        const item = await dependencies.readItem(context, input.itemId, {
          sessionId: input.sessionId,
          courseId: input.courseId,
        });
        if (!item || item.removed) throw new ContextIngestionError('not-found');
        const fileInfo = await dependencies.inspectSelectedFile(
          context,
          input.ticketId,
        );
        if (
          !Number.isSafeInteger(fileInfo.byteLength) ||
          fileInfo.byteLength < 0
        )
          throw new ContextIngestionError('invalid-input');
        if (!context.isCurrent())
          throw new ContextIngestionError('session-changed');
        const currentItem = await dependencies.readItem(context, input.itemId, {
          sessionId: input.sessionId,
          courseId: input.courseId,
        });
        if (!currentItem || currentItem.removed)
          throw new ContextIngestionError('not-found');
        const operationId = input.operationId ?? randomUUID();
        const attemptId = operationId;
        const result = await addJob({
          context,
          operationId,
          attemptId,
          requestId: null,
          itemId: input.itemId,
          scope: { sessionId: input.sessionId, courseId: input.courseId },
          fileInfo,
          source: { kind: 'ticket', ticketId: input.ticketId },
        });
        keepBounded(ticketOperations, ticketKey, result.operationId);
        return { operationId: result.operationId, itemId: input.itemId };
      } finally {
        endAdmission();
      }
    })();
    ticketAdmissions.set(ticketKey, admission);
    try {
      return await admission;
    } finally {
      if (ticketAdmissions.get(ticketKey) === admission)
        ticketAdmissions.delete(ticketKey);
    }
  };

  const retryContextIngestion = async (
    context: AuthorizedContext,
    rawInput: RetryContextIngestionInput,
  ) => {
    const input = assertRequest(retryContextIngestionInputSchema, rawInput);
    if (!context.isCurrent())
      throw new ContextIngestionError('session-changed');
    const retryKey = `${context.userId}:${context.epoch}:${input.itemId}:${input.requestId}`;
    const priorOperation = retryOperations.get(retryKey);
    if (priorOperation) return { operationId: priorOperation };
    const pendingAdmission = retryAdmissions.get(retryKey);
    if (pendingAdmission) return pendingAdmission;

    const admission = (async () => {
      beginAdmission();
      try {
        const item = await dependencies.readItem(context, input.itemId);
        if (!item || item.removed) throw new ContextIngestionError('not-found');
        const original = await dependencies.readOriginal(context, input.itemId);
        if (!original) throw new ContextIngestionError('not-found');
        if (!context.isCurrent())
          throw new ContextIngestionError('session-changed');
        const currentItem = await dependencies.readItem(context, input.itemId);
        if (!currentItem || currentItem.removed)
          throw new ContextIngestionError('not-found');
        if (original.bytes.byteLength > contextFileLimits.documentBytes)
          throw new ContextIngestionError('limit-exceeded');
        const operationId = input.requestId;
        const result = await addJob({
          context,
          operationId,
          attemptId: input.requestId,
          requestId: input.requestId,
          itemId: input.itemId,
          scope: {},
          fileInfo: {
            fileName: original.fileName,
            contentType: original.contentType,
            byteLength: original.bytes.byteLength,
          },
          source: { kind: 'original', original },
        });
        keepBounded(retryOperations, retryKey, result.operationId);
        return { operationId: result.operationId };
      } finally {
        endAdmission();
      }
    })();
    retryAdmissions.set(retryKey, admission);
    try {
      return await admission;
    } finally {
      if (retryAdmissions.get(retryKey) === admission)
        retryAdmissions.delete(retryKey);
    }
  };

  const cancelContextIngestion = async (
    context: AuthorizedContext,
    rawInput: CancelContextIngestionInput,
  ) => {
    const input = assertRequest(cancelContextIngestionInputSchema, rawInput);
    const key = operationKey(context, input.operationId);
    const job = jobs.get(key);
    if (!job) return;
    job.controller.abort();
    if (job.state === 'queued') {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      await completeAttempt(job, 'cancelled', 'cancelled');
      await finishJob(job);
      return;
    }
    await job.done;
  };

  const readContextPreview = async (
    context: AuthorizedContext,
    rawInput: ReadContextPreviewInput,
  ): Promise<ContextPreview> => {
    const parsed = readContextPreviewInputSchema.safeParse(rawInput);
    if (!parsed.success || !context.isCurrent())
      return createUnavailablePreview('unreadable');
    try {
      const item = await dependencies.readItem(context, parsed.data.itemId, {
        sessionId: parsed.data.sessionId,
      });
      if (!context.isCurrent()) return createUnavailablePreview('unreadable');
      if (!item || item.removed) return createUnavailablePreview('removed');
      const version = await dependencies.readVersion(
        context,
        item.id,
        parsed.data.versionId ?? item.currentVersionId ?? undefined,
      );
      if (!context.isCurrent()) return createUnavailablePreview('unreadable');
      if (!version)
        return createUnavailablePreview(
          item.status === 'queued' || item.status === 'processing'
            ? 'processing'
            : item.status === 'unsupported'
              ? 'unsupported'
              : 'unreadable',
        );
      if (version.extractedText !== null)
        return createTextPreview({
          text: version.extractedText,
          locators: version.locators,
          partial: version.extractionStatus !== 'complete',
          uncertainty: version.uncertainty,
        });
      if (
        version.mimeType === 'image/png' ||
        version.mimeType === 'image/jpeg' ||
        version.mimeType === 'image/webp'
      ) {
        if (!version.originalStorageKey)
          return createUnavailablePreview('removed');
        const original = await dependencies.readOriginal(
          context,
          item.id,
          context.signal,
          version.originalStorageKey,
        );
        if (!context.isCurrent()) return createUnavailablePreview('unreadable');
        if (!original) return createUnavailablePreview('offline');
        const prepare =
          dependencies.prepareImage ??
          ((bytes, mimeType, signal) =>
            prepareContextImage(bytes, mimeType, {
              decode: imageDecoder,
              signal,
            }));
        const prepared = await prepare(
          original.bytes,
          original.contentType,
          context.signal,
        );
        if (!context.isCurrent()) return createUnavailablePreview('unreadable');
        if (prepared.status !== 'complete')
          return createUnavailablePreview('unreadable');
        return createImagePreview({
          mimeType: prepared.mimeType,
          bytes: prepared.previewBytes,
          width: prepared.previewWidth,
          height: prepared.previewHeight,
        });
      }
      return createUnavailablePreview('unreadable');
    } catch {
      return createUnavailablePreview('unreadable');
    }
  };

  const whenIdle = async () => {
    while (
      queue.length > 0 ||
      activeJob ||
      drainPromise ||
      pendingAdmissions > 0
    ) {
      const current = drainPromise;
      if (current) await current;
      else {
        const admissions = [
          ...ticketAdmissions.values(),
          ...retryAdmissions.values(),
        ];
        if (admissions.length > 0) await Promise.allSettled(admissions);
        else await Promise.resolve();
      }
    }
  };

  return {
    ingestSelectedFile,
    retryContextIngestion,
    cancelContextIngestion,
    readContextPreview,
    whenIdle,
  };
};

let configuredService: ContextIngestionService | null = null;

export const configureContextIngestion = (
  dependencies: ContextIngestionDependencies,
) => {
  if (configuredService)
    throw new ContextIngestionError(
      'busy',
      'Context ingestion is already configured.',
    );
  const service = createContextIngestionService(dependencies);
  configuredService = service;
  return async () => {
    await service.whenIdle();
    if (configuredService === service) configuredService = null;
  };
};

const getConfiguredService = () => {
  if (!configuredService)
    throw new ContextIngestionError('feature-unavailable');
  return configuredService;
};

export const waitForContextIngestionIdle = () =>
  getConfiguredService().whenIdle();

export const ingestSelectedFile = (
  context: AuthorizedContext,
  input: IngestSelectedFileInput,
) => getConfiguredService().ingestSelectedFile(context, input);

export const retryContextIngestion = (
  context: AuthorizedContext,
  input: RetryContextIngestionInput,
) => getConfiguredService().retryContextIngestion(context, input);

export const cancelContextIngestion = (
  context: AuthorizedContext,
  input: CancelContextIngestionInput,
) => getConfiguredService().cancelContextIngestion(context, input);

export const readContextPreview = (
  context: AuthorizedContext,
  input: ReadContextPreviewInput,
) => getConfiguredService().readContextPreview(context, input);
