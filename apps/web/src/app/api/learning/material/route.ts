import { createHash } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth/helpers';
import { serverEnv } from '@/data/env/server';
import { z } from 'zod';
import {
  LearningDispatchError,
  learningCapabilitiesSchema,
  type LearningCapabilities,
} from '../../../../../../../packages/services/src/ai/learning-dispatch';
import { requestIdSchema } from '../../../../../../../packages/services/src/learning/product-contracts';
import {
  documentInterpretationResultSchema,
  generateDocumentInterpretation,
  inspectDocumentInput,
  maximumImageBytes,
  maximumImagesPerOperation,
  maximumInterpretedTextCharacters,
  maximumMaterialWireBytes,
  maximumPdfPagesPerOperation,
  validateDocumentInterpretation,
  type DocumentInputDescriptor,
  type DocumentInterpretationResult,
} from '../../../../../../../packages/services/src/ai/document-interpretation';
import { getLearningCapabilities } from '../../../../../../../packages/services/src/ai/tutor';

export const runtime = 'nodejs';
const requestWindowMs = 60_000;
const requestsPerWindow = 10;
const maxConcurrentRequests = 1;
const maximumTextCharacters = 100_000;
const maximumImageBatchBytes = 16 * 1024 * 1024;
const metadataSchema = z.strictObject({
  version: z.literal(1),
  requestId: requestIdSchema,
  kind: z.literal('document-interpret'),
  pageNumbers: z
    .array(z.number().int().positive().max(200))
    .max(maximumPdfPagesPerOperation)
    .optional(),
});
export type MetadataSchema = z.infer<typeof metadataSchema>;
export type MaterialMetadataSchema = z.infer<typeof metadataSchema>;
type MaterialInterpretationInput = {
  userId: string;
  requestId: string;
  pageNumbers: number[];
  files: Array<{ bytes: Uint8Array; mimeType: string; filename: string }>;
  text?: string;
};
type CurrentUser = { userId: string | null } | null;
type MaterialRouteDependencies = {
  getCurrentUser: (headers: Headers) => Promise<CurrentUser>;
  trustedOrigin: string;
  getCapabilities: () => Promise<LearningCapabilities>;
  interpretDocument: (
    input: MaterialInterpretationInput,
    signal: AbortSignal,
  ) => Promise<DocumentInterpretationResult>;
  now?: () => number;
};
type RequestBudget = { since: number; count: number; inFlight: number };
type IdempotencyEntry = {
  digest: string;
  expiresAt: number;
  createdAt: number;
  response: Promise<unknown>;
};
type ValidatedFile = {
  file: MaterialInterpretationInput['files'][number];
  descriptor: DocumentInputDescriptor;
};
const noStore = { 'Cache-Control': 'no-store' };
const jsonError = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers: noStore });
const statusForError = (code: LearningDispatchError['code']) => {
  switch (code) {
    case 'invalid-input':
      return 400;
    case 'scope-denied':
      return 403;
    case 'revision-conflict':
    case 'capability-changed':
      return 409;
    case 'limit-exceeded':
      return 413;
    case 'unsupported':
      return 415;
    case 'unreadable':
      return 422;
    case 'cancelled':
      return 408;
    case 'feature-unavailable':
      return 503;
    case 'provider-failed':
      return 502;
  }
};
const messageForError = (code: LearningDispatchError['code']) => {
  switch (code) {
    case 'invalid-input':
      return 'The document request is invalid.';
    case 'scope-denied':
      return 'This document request is not allowed.';
    case 'revision-conflict':
      return 'The request ID was already used with different content.';
    case 'capability-changed':
      return 'The interpretation capability changed; retry the request.';
    case 'limit-exceeded':
      return 'The document exceeds its size or page limit.';
    case 'unsupported':
      return 'This document type is not supported.';
    case 'unreadable':
      return 'The document could not be read.';
    case 'cancelled':
      return 'The interpretation request was cancelled.';
    case 'feature-unavailable':
      return 'The selected interpretation capability is unavailable.';
    case 'provider-failed':
      return 'The document could not be interpreted. Try again.';
  }
};
const readBoundedBytes = async (
  request: Request,
  limit: number,
  signal: AbortSignal,
) => {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
      return { kind: 'invalid' as const };
    if (declaredLength > limit) return { kind: 'too-large' as const };
  }
  if (signal.aborted) return { kind: 'cancelled' as const };
  if (!request.body) return { kind: 'invalid' as const };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancelRead = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelRead, { once: true });
  try {
    if (signal.aborted) return { kind: 'cancelled' as const };
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { kind: 'cancelled' as const };
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large' as const };
      }
      chunks.push(value);
    }
  } catch {
    return signal.aborted
      ? { kind: 'cancelled' as const }
      : { kind: 'invalid' as const };
  } finally {
    signal.removeEventListener('abort', cancelRead);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok' as const, bytes };
};
const parseFormData = async (request: Request, bytes: Uint8Array) => {
  try {
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    const copy = new Request(request.url, {
      method: 'POST',
      headers,
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    });
    return await copy.formData();
  } catch {
    return null;
  }
};
const sourceFingerprint = (
  metadata: MaterialMetadataSchema,
  files: MaterialInterpretationInput['files'],
  text?: string,
) => {
  const hash = createHash('sha256').update(JSON.stringify(metadata));
  if (text) hash.update(text);
  for (const file of files) hash.update(file.mimeType).update(file.bytes);
  return hash.digest('hex');
};
const pageNumbersForImages = (
  raw: number[] | undefined,
  imageCount: number,
) => {
  if (raw === undefined)
    return Array.from({ length: imageCount }, (_, index) => index + 1);
  if (raw.length !== imageCount || new Set(raw).size !== raw.length)
    throw new LearningDispatchError('invalid-input');
  return raw;
};
const pageNumbersForDescriptor = (descriptor: DocumentInputDescriptor) =>
  descriptor.kind === 'pdf'
    ? Array.from({ length: descriptor.pageCount }, (_, index) => index + 1)
    : [1];
const asFile = async (
  value: FormDataEntryValue,
  signal: AbortSignal,
): Promise<ValidatedFile> => {
  if (!(value instanceof File))
    throw new LearningDispatchError('invalid-input');
  const bytes = new Uint8Array(await value.arrayBuffer());
  const descriptor = await inspectDocumentInput(
    {
      bytes,
      declaredMimeType: value.type,
    },
    signal,
  );
  return {
    file: {
      bytes,
      mimeType: descriptor.mimeType,
      filename:
        descriptor.kind === 'pdf'
          ? 'source.pdf'
          : `source.${descriptor.mimeType.slice(6)}`,
    },
    descriptor,
  };
};
const responseSchema = z.strictObject({
  version: z.literal(1),
  requestId: requestIdSchema,
  configurationRevision: z.string().min(1).max(200),
  status: z.enum(['complete', 'partial', 'unreadable']),
  interpretedPages: z
    .array(z.number().int().positive())
    .max(maximumPdfPagesPerOperation),
  pages: documentInterpretationResultSchema.shape.pages,
});
export type ResponseSchema = z.infer<typeof responseSchema>;

export const createLearningMaterialPostHandler = (
  dependencies: MaterialRouteDependencies,
) => {
  const now = dependencies.now ?? Date.now;
  const budgets = new Map<string, RequestBudget>();
  const idempotency = new Map<string, IdempotencyEntry>();
  return async (request: Request) => {
    const origin = request.headers.get('origin');
    if (origin && origin !== dependencies.trustedOrigin)
      return jsonError(
        403,
        'scope-denied',
        'The request origin is not allowed.',
      );
    const currentUser = await dependencies.getCurrentUser(request.headers);
    if (!currentUser?.userId)
      return jsonError(401, 'needs-sign-in', 'Sign in to interpret documents.');
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(60_000),
    ]);
    const contentType =
      request.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('multipart/form-data;'))
      return jsonError(
        415,
        'unsupported',
        'Send a multipart document request.',
      );
    const body = await readBoundedBytes(
      request,
      maximumMaterialWireBytes,
      signal,
    );
    if (body.kind === 'cancelled')
      return jsonError(
        408,
        'cancelled',
        'The document request was cancelled or timed out.',
      );
    if (body.kind === 'too-large')
      return jsonError(
        413,
        'limit-exceeded',
        'The document request is too large.',
      );
    if (body.kind === 'invalid')
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    const formData = await parseFormData(request, body.bytes);
    if (!formData)
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    const allowedFields = new Set(['metadata', 'files', 'text']);
    if ([...formData.keys()].some((key) => !allowedFields.has(key)))
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    const metadataText = formData.get('metadata');
    if (
      typeof metadataText !== 'string' ||
      formData.getAll('metadata').length !== 1
    )
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    let rawMetadata: unknown;
    try {
      rawMetadata = JSON.parse(metadataText);
    } catch {
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    }
    const parsedMetadata = metadataSchema.safeParse(rawMetadata);
    if (!parsedMetadata.success)
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    let text: string | undefined;
    const textValue = formData.get('text');
    if (textValue !== null) {
      if (
        typeof textValue !== 'string' ||
        textValue.length > maximumTextCharacters
      )
        return jsonError(
          413,
          'limit-exceeded',
          'The document text exceeds its limit.',
        );
      text = textValue;
    }
    const fileEntries = formData.getAll('files');
    if (formData.getAll('text').length > 1)
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    let validatedFiles: ValidatedFile[];
    let pageNumbers: number[];
    try {
      if (
        (fileEntries.length > 0 && text !== undefined) ||
        (fileEntries.length === 0 && text === undefined)
      )
        throw new LearningDispatchError('invalid-input');
      if (fileEntries.length > maximumImagesPerOperation)
        throw new LearningDispatchError('limit-exceeded');
      validatedFiles = await Promise.all(
        fileEntries.map((entry) => asFile(entry, signal)),
      );
      if (
        validatedFiles.length === 1 &&
        validatedFiles[0]?.descriptor.kind === 'pdf'
      ) {
        if (parsedMetadata.data.pageNumbers)
          throw new LearningDispatchError('invalid-input');
        pageNumbers = pageNumbersForDescriptor(validatedFiles[0].descriptor);
      } else if (validatedFiles.length > 0) {
        if (validatedFiles.some((item) => item.descriptor.kind !== 'image'))
          throw new LearningDispatchError('invalid-input');
        const totalImageBytes = validatedFiles.reduce(
          (total, item) => total + item.file.bytes.byteLength,
          0,
        );
        if (
          totalImageBytes > maximumImageBatchBytes ||
          validatedFiles.some(
            (item) => item.file.bytes.byteLength > maximumImageBytes,
          )
        )
          throw new LearningDispatchError('limit-exceeded');
        pageNumbers = pageNumbersForImages(
          parsedMetadata.data.pageNumbers,
          validatedFiles.length,
        );
      } else {
        if (parsedMetadata.data.pageNumbers)
          throw new LearningDispatchError('invalid-input');
        pageNumbers = [1];
      }
    } catch (error) {
      if (error instanceof LearningDispatchError)
        return jsonError(
          statusForError(error.code),
          error.code,
          messageForError(error.code),
        );
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    }
    if (signal.aborted)
      return jsonError(
        408,
        'cancelled',
        'The document request was cancelled or timed out.',
      );
    let capabilities: LearningCapabilities;
    try {
      capabilities = learningCapabilitiesSchema.parse(
        await dependencies.getCapabilities(),
      );
    } catch {
      return jsonError(
        503,
        'feature-unavailable',
        'The interpretation capability is unavailable.',
      );
    }
    const needsPdf = validatedFiles.some(
      (item) => item.descriptor.kind === 'pdf',
    );
    const needsImage = validatedFiles.some(
      (item) => item.descriptor.kind === 'image',
    );
    if (
      (needsPdf && capabilities.pdfInterpretation !== 'available') ||
      (needsImage && capabilities.imageInterpretation !== 'available') ||
      (!needsPdf && !needsImage && capabilities.tutor !== 'available')
    )
      return jsonError(
        503,
        'feature-unavailable',
        'The interpretation capability is unavailable.',
      );
    const files = validatedFiles.map((item) => item.file);
    if (text !== undefined && text.trim().length === 0)
      return jsonError(
        400,
        'invalid-input',
        'The document request is invalid.',
      );
    const textTruncated =
      text !== undefined && text.length > maximumInterpretedTextCharacters;
    const boundedText =
      text === undefined
        ? undefined
        : textTruncated
          ? text.slice(0, maximumInterpretedTextCharacters)
          : text;
    const payloadDigest = sourceFingerprint(parsedMetadata.data, files, text);
    const idempotencyKey = `${currentUser.userId}:${parsedMetadata.data.requestId}`;
    const nowValue = now();
    for (const [key, entry] of idempotency)
      if (entry.expiresAt <= nowValue) idempotency.delete(key);
    const existing = idempotency.get(idempotencyKey);
    if (existing) {
      if (existing.digest !== payloadDigest)
        return jsonError(
          409,
          'revision-conflict',
          'The request ID was already used with different content.',
        );
      try {
        return Response.json(await existing.response, { headers: noStore });
      } catch {
        return jsonError(
          502,
          'provider-failed',
          'The document could not be interpreted. Try again.',
        );
      }
    }
    if (idempotency.size >= 128) {
      const oldest = [...idempotency.entries()].sort(
        ([, left], [, right]) => left.expiresAt - right.expiresAt,
      )[0];
      if (oldest) idempotency.delete(oldest[0]);
    }
    for (const [userId, budget] of budgets)
      if (nowValue - budget.since >= requestWindowMs) budgets.delete(userId);
    const budget = budgets.get(currentUser.userId) ?? {
      since: nowValue,
      count: 0,
      inFlight: 0,
    };
    if (
      budget.count >= requestsPerWindow ||
      budget.inFlight >= maxConcurrentRequests
    )
      return jsonError(
        429,
        'rate-limited',
        'The document interpretation limit was reached.',
      );
    budgets.set(currentUser.userId, {
      ...budget,
      count: budget.count + 1,
      inFlight: budget.inFlight + 1,
    });
    const responsePromise = (async () => {
      const interpreted = await dependencies.interpretDocument(
        {
          userId: currentUser.userId!,
          requestId: parsedMetadata.data.requestId,
          pageNumbers,
          files,
          ...(boundedText === undefined ? {} : { text: boundedText }),
        },
        signal,
      );
      const result = validateDocumentInterpretation(
        { pageNumbers },
        { pages: interpreted.pages },
      );
      return responseSchema.parse({
        version: 1,
        requestId: parsedMetadata.data.requestId,
        configurationRevision: capabilities.configurationRevision,
        status:
          textTruncated && result.status === 'complete'
            ? 'partial'
            : result.status,
        interpretedPages: result.interpretedPages,
        pages: result.pages,
      });
    })();
    idempotency.set(idempotencyKey, {
      digest: payloadDigest,
      expiresAt: nowValue + 5 * 60_000,
      createdAt: nowValue,
      response: responsePromise,
    });
    try {
      const result = await responsePromise;
      signal.throwIfAborted();
      return Response.json(result, { headers: noStore });
    } catch (error) {
      idempotency.delete(idempotencyKey);
      if (signal.aborted)
        return jsonError(
          408,
          'cancelled',
          'The document request was cancelled or timed out.',
        );
      if (error instanceof LearningDispatchError)
        return jsonError(
          statusForError(error.code),
          error.code,
          messageForError(error.code),
        );
      console.error('[api/learning/material] interpretation failed', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return jsonError(
        502,
        'provider-failed',
        'The document could not be interpreted. Try again.',
      );
    } finally {
      const currentBudget = budgets.get(currentUser.userId!);
      if (currentBudget)
        budgets.set(currentUser.userId!, {
          ...currentBudget,
          inFlight: Math.max(0, currentBudget.inFlight - 1),
        });
    }
  };
};

export const POST = createLearningMaterialPostHandler({
  getCurrentUser,
  trustedOrigin: new URL(serverEnv.BETTER_AUTH_URL).origin,
  getCapabilities: getLearningCapabilities,
  interpretDocument: generateDocumentInterpretation,
});
