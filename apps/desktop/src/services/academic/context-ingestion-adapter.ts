import {
  documentPageStatuses,
  documentInterpretationStatuses,
} from '@scholaros/services/learning/context-contracts';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { net } from 'electron';
import { z } from 'zod';
import type {
  ActionCleanup,
  AuthorizedContext,
  AuthorizedRegistrar,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import type { IngestionStatus } from '@scholaros/services/learning/context-contracts';
import { authClient } from '../../lib/auth/client';
import { isAccountSessionCurrent } from '../../lib/auth/main';
import { clientEnv } from '../../data/env/client';
import {
  contextFileSelectionResultSchema,
  registerSelectedContextFilesInputSchema,
  type ContextFileSelectionResult,
  type RegisterSelectedContextFilesInput,
} from './contracts';
import type { ContextImageDecoder } from '../../features/context/services/image-content';
import {
  ContextIngestionError,
  cancelContextIngestion,
  configureContextIngestion,
  ingestSelectedFile,
  readContextPreview,
  retryContextIngestion,
  type ContextIngestionDependencies,
  type ContextIngestionErrorCode,
  type ContextIngestionVersionCommit,
  type SelectedFileTicketInfo,
  type StoredContextOriginal,
  waitForContextIngestionIdle,
} from '../../features/context/services/ingestion';
import {
  ContextStoreError,
  createUploadedContextItem,
  readContextIngestionItem,
  readContextIngestionVersion,
  removeUnreferencedContextOriginals,
  saveContextIngestionResult,
  setContextIngestionStatus,
} from '../../features/context/services/library-store';
import {
  ContextStorageError,
  readContextOriginal,
  writeContextOriginal,
} from '../../features/context/services/original-store';
import { contextFileLimits } from '../../features/context/services/file-validation';
import {
  createSelectedContextFileRegistry,
  type SelectedContextFileBinding,
} from './selected-context-files';

const maximumMaterialResponseBytes = 512 * 1024;
const materialMetadataSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  configurationRevision: z.string().min(1).max(300),
  status: z.enum(documentInterpretationStatuses),
  interpretedPages: z.array(z.number().int().positive().max(200)).max(20),
  pages: z
    .array(
      z.strictObject({
        page: z.number().int().positive().max(200),
        status: z.enum(documentPageStatuses),
        text: z.string().max(8_000),
        uncertainty: z.string().max(1_000).nullable(),
      }),
    )
    .max(20),
});
export type MaterialMetadataSchema = z.infer<typeof materialMetadataSchema>;
const materialErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().max(100).optional(),
    message: z.string().max(300).optional(),
  }),
});
export type MaterialErrorSchema = z.infer<typeof materialErrorSchema>;

type ContextIngestionHostOptions = {
  imageDecoder?: ContextImageDecoder | null;
};
type IngestionFence = {
  context: AuthorizedContext;
  itemId: string;
  operationId: string;
  attemptId: string;
  expectedRevision: number;
  sessionId?: string;
  courseId?: string;
  ticketId?: string;
};
type SelectedTicket = {
  context: AuthorizedContext;
  binding: SelectedContextFileBinding;
  info: SelectedFileTicketInfo;
  itemId: string;
  operationId: string;
};
type ActiveOperation = {
  context: AuthorizedContext;
  itemId: string;
  operationId: string;
  registrars: Set<AuthorizedRegistrar>;
};
type RegistrarOwner = { userId: string; epoch: number };
type MaterialRequest = {
  operationId: string;
  itemId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  signal: AbortSignal;
  pageNumbers?: number[];
};

const operationKey = (context: AuthorizedContext, operationId: string) =>
  `${context.userId}:${context.epoch}:${operationId}`;
const itemKey = (context: AuthorizedContext, itemId: string) =>
  `${context.userId}:${context.epoch}:${itemId}`;
const assertContextCurrent = (
  context: AuthorizedContext,
  signal?: AbortSignal,
) => {
  if (signal?.aborted || context.signal.aborted)
    throw new ContextIngestionError('cancelled');
  if (!context.isCurrent()) throw new ContextIngestionError('session-changed');
};
const toIngestionError = (error: unknown) => {
  if (error instanceof ContextIngestionError) return error;
  if (
    error instanceof ContextStoreError ||
    error instanceof ContextStorageError
  )
    return new ContextIngestionError(error.code);
  return new ContextIngestionError('storage-failed');
};
const statusForSelectionError = (
  error: ContextIngestionErrorCode,
): IngestionStatus => {
  switch (error) {
    case 'cancelled':
      return 'cancelled';
    case 'unsupported':
    case 'limit-exceeded':
      return 'unsupported';
    case 'unreadable':
    case 'not-found':
    case 'invalid-input':
    case 'scope-denied':
      return 'unreadable';
    case 'busy':
    case 'feature-unavailable':
    case 'needs-sign-in':
    case 'permission-revoked':
    case 'provider-failed':
    case 'rate-limited':
    case 'revision-conflict':
    case 'session-changed':
    case 'storage-failed':
      return 'failed';
  }
};
const terminalOutcome = (
  status: IngestionStatus,
): ProductEventV1['outcome'] => {
  switch (status) {
    case 'complete':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'queued':
    case 'processing':
    case 'partial':
    case 'unreadable':
    case 'unsupported':
      return 'attention';
  }
};
const eventForItem = (
  context: AuthorizedContext,
  itemId: string,
  operationId: string,
  revision: number,
  status?: IngestionStatus,
): ProductEventV1 => ({
  version: 1,
  accountId: context.userId,
  revision,
  resource: 'context',
  targetId: itemId,
  operationId,
  ...(status ? { outcome: terminalOutcome(status) } : {}),
});
const pageUncertainty = (pages: Array<{ uncertainty: string | null }>) => {
  const uncertainty = [
    ...new Set(
      pages.flatMap(({ uncertainty: value }) => (value ? [value] : [])),
    ),
  ].join(' ');
  return uncertainty.length > 0 ? uncertainty.slice(0, 1_000) : null;
};
const errorCodeForStatus = (status: number, code?: string) => {
  const recognized = new Set<ContextIngestionErrorCode>([
    'cancelled',
    'feature-unavailable',
    'invalid-input',
    'limit-exceeded',
    'needs-sign-in',
    'not-found',
    'permission-revoked',
    'provider-failed',
    'rate-limited',
    'revision-conflict',
    'scope-denied',
    'session-changed',
    'storage-failed',
    'unsupported',
    'unreadable',
  ]);
  if (code && recognized.has(code as ContextIngestionErrorCode))
    return code as ContextIngestionErrorCode;
  switch (status) {
    case 401:
      return 'needs-sign-in';
    case 403:
      return 'scope-denied';
    case 408:
      return 'cancelled';
    case 409:
      return 'revision-conflict';
    case 413:
      return 'limit-exceeded';
    case 415:
      return 'unsupported';
    case 422:
      return 'unreadable';
    case 429:
      return 'rate-limited';
    case 503:
      return 'feature-unavailable';
    default:
      return 'provider-failed';
  }
};

const readBoundedResponseText = async (
  response: Response,
  signal: AbortSignal,
) => {
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > maximumMaterialResponseBytes
  )
    throw new ContextIngestionError('provider-failed');
  if (!response.body) throw new ContextIngestionError('provider-failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumMaterialResponseBytes)
        throw new ContextIngestionError('provider-failed');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) throw new ContextIngestionError('cancelled');
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new ContextIngestionError('provider-failed');
  }
};

const requestMaterialInterpretation = async (
  context: AuthorizedContext,
  input: MaterialRequest,
) => {
  assertContextCurrent(context, input.signal);
  const cookie = authClient.getCookie();
  if (!cookie.trim()) throw new ContextIngestionError('needs-sign-in');
  if (!isAccountSessionCurrent(cookie))
    throw new ContextIngestionError('session-changed');
  const formData = new FormData();
  formData.set(
    'metadata',
    JSON.stringify({
      version: 1,
      requestId: input.operationId,
      kind: 'document-interpret',
      ...(input.pageNumbers ? { pageNumbers: input.pageNumbers } : {}),
    }),
  );
  formData.append(
    'files',
    new File([Buffer.from(input.bytes)], input.fileName, {
      type: input.mimeType,
    }),
    input.fileName,
  );
  const signal = AbortSignal.any([
    context.signal,
    input.signal,
    AbortSignal.timeout(65_000),
  ]);
  let response: Response;
  try {
    response = await net.fetch(
      new URL('/api/learning/material', clientEnv.VITE_API_URL).href,
      {
        method: 'POST',
        headers: { Cookie: cookie },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        body: formData,
        signal,
      },
    );
  } catch {
    assertContextCurrent(context, input.signal);
    throw new ContextIngestionError('provider-failed');
  }
  assertContextCurrent(context, input.signal);
  if (!isAccountSessionCurrent(cookie))
    throw new ContextIngestionError('session-changed');
  const responseText = await readBoundedResponseText(response, signal);
  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    throw new ContextIngestionError('provider-failed');
  }
  if (!response.ok) {
    const error = materialErrorSchema.safeParse(responseJson);
    throw new ContextIngestionError(
      errorCodeForStatus(
        response.status,
        error.success ? error.data.error.code : undefined,
      ),
    );
  }
  const result = materialMetadataSchema.safeParse(responseJson);
  if (!result.success || result.data.requestId !== input.operationId)
    throw new ContextIngestionError('provider-failed');
  assertContextCurrent(context, input.signal);
  if (!isAccountSessionCurrent(cookie))
    throw new ContextIngestionError('session-changed');
  return result.data;
};

const fileNameForItem = (context: AuthorizedContext, itemId: string) => {
  const item = readContextIngestionItem(context, { itemId });
  if (!item) throw new ContextIngestionError('not-found');
  return item.title;
};

export const createContextIngestionHost = (
  options: ContextIngestionHostOptions = {},
) => {
  const fileRegistry = createSelectedContextFileRegistry();
  const tickets = new Map<string, SelectedTicket>();
  const fencesByOperation = new Map<string, IngestionFence>();
  const fencesByItem = new Map<string, IngestionFence>();
  const operations = new Map<string, ActiveOperation>();
  const registrars = new Set<AuthorizedRegistrar>();
  const registrarOwners = new Map<AuthorizedRegistrar, RegistrarOwner>();
  const registrarOperations = new Map<AuthorizedRegistrar, Set<string>>();
  const pendingAdmissions = new Set<Promise<unknown>>();
  let closing = false;
  let disposal: Promise<void> | null = null;

  const trackPending = <TResult>(promise: Promise<TResult>) => {
    pendingAdmissions.add(promise);
    void promise.then(
      () => pendingAdmissions.delete(promise),
      () => pendingAdmissions.delete(promise),
    );
    return promise;
  };
  const waitForAdmissions = async () => {
    while (pendingAdmissions.size > 0)
      await Promise.allSettled(pendingAdmissions);
  };
  const assertHostOpen = (context: AuthorizedContext) => {
    if (closing) throw new ContextIngestionError('cancelled');
    assertContextCurrent(context);
  };
  const publish = (event: ProductEventV1) => {
    for (const registrar of registrars) {
      const owner = registrarOwners.get(registrar);
      if (
        !owner ||
        owner.userId !== event.accountId ||
        !registrar.lifecycle.isCurrent(owner.epoch)
      )
        continue;
      try {
        registrar.publish(event);
      } catch {
        continue;
      }
    }
  };
  const associateContext = (
    registrar: AuthorizedRegistrar,
    context: AuthorizedContext,
  ) => {
    if (registrar.lifecycle.isCurrent(context.epoch))
      registrarOwners.set(registrar, {
        userId: context.userId,
        epoch: context.epoch,
      });
  };
  const associateCurrentRegistrars = (context: AuthorizedContext) => {
    for (const registrar of registrars) associateContext(registrar, context);
    return [...registrars].filter((registrar) => {
      const owner = registrarOwners.get(registrar);
      return owner?.userId === context.userId && owner.epoch === context.epoch;
    });
  };
  const addOperation = (
    context: AuthorizedContext,
    input: {
      itemId: string;
      operationId: string;
      attemptId: string;
      expectedRevision: number;
      sessionId?: string;
      courseId?: string;
      ticketId?: string;
    },
    operationRegistrars: AuthorizedRegistrar[] = [],
  ) => {
    const key = operationKey(context, input.operationId);
    const itemIdKey = itemKey(context, input.itemId);
    const existingFence = fencesByItem.get(itemIdKey);
    if (existingFence && existingFence.operationId !== input.operationId)
      throw new ContextIngestionError('busy');
    const fence = existingFence ?? {
      context,
      itemId: input.itemId,
      operationId: input.operationId,
      attemptId: input.attemptId,
      expectedRevision: input.expectedRevision,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.courseId ? { courseId: input.courseId } : {}),
      ...(input.ticketId ? { ticketId: input.ticketId } : {}),
    };
    fencesByItem.set(itemIdKey, fence);
    fencesByOperation.set(key, fence);
    operations.set(key, {
      context,
      itemId: input.itemId,
      operationId: input.operationId,
      registrars: new Set(operationRegistrars),
    });
    for (const registrar of operationRegistrars) {
      const registrarOps = registrarOperations.get(registrar) ?? new Set();
      registrarOps.add(key);
      registrarOperations.set(registrar, registrarOps);
    }
    return fence;
  };
  const removeOperation = async (
    context: AuthorizedContext,
    operationId: string,
  ) => {
    const key = operationKey(context, operationId);
    const fence = fencesByOperation.get(key);
    if (fence && fencesByItem.get(itemKey(context, fence.itemId)) === fence)
      fencesByItem.delete(itemKey(context, fence.itemId));
    fencesByOperation.delete(key);
    const operation = operations.get(key);
    operations.delete(key);
    for (const registrar of operation?.registrars ?? []) {
      const registrarOps = registrarOperations.get(registrar);
      registrarOps?.delete(key);
      if (registrarOps?.size === 0) registrarOperations.delete(registrar);
    }
    for (const [ticketId, ticket] of tickets) {
      if (
        ticket.operationId === operationId &&
        ticket.context.userId === context.userId &&
        ticket.context.epoch === context.epoch
      ) {
        tickets.delete(ticketId);
        await fileRegistry.discard(ticket.context, ticketId);
      }
    }
  };
  const operationSettled = async (
    context: AuthorizedContext,
    operationId: string,
  ) => removeOperation(context, operationId);
  const itemForFence = (
    context: AuthorizedContext,
    itemId: string,
    scope?: { sessionId?: string; courseId?: string },
  ) => {
    assertContextCurrent(context);
    const item = readContextIngestionItem(context, {
      itemId,
      ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
      ...(scope?.courseId ? { courseId: scope.courseId } : {}),
    });
    if (!item) return null;
    const fence = fencesByItem.get(itemKey(context, itemId));
    if (fence && item.revision !== fence.expectedRevision)
      throw new ContextIngestionError('revision-conflict');
    return item;
  };
  const fenceForOperation = (
    context: AuthorizedContext,
    itemId: string,
    operationId: string,
    attemptId: string,
  ) => {
    const operation = operationKey(context, operationId);
    let fence = fencesByOperation.get(operation);
    if (fence) {
      if (fence.itemId !== itemId)
        throw new ContextIngestionError('scope-denied');
      return fence;
    }
    const item = itemForFence(context, itemId);
    if (!item || item.removed) throw new ContextIngestionError('not-found');
    fence = addOperation(context, {
      itemId,
      operationId,
      attemptId,
      expectedRevision: item.revision,
    });
    return fence;
  };
  const ensureFenceRevision = (
    context: AuthorizedContext,
    fence: IngestionFence,
  ) => {
    assertContextCurrent(context);
    const item = readContextIngestionItem(context, {
      itemId: fence.itemId,
      ...(fence.sessionId ? { sessionId: fence.sessionId } : {}),
      ...(fence.courseId ? { courseId: fence.courseId } : {}),
    });
    if (!item || item.removed) throw new ContextIngestionError('not-found');
    if (item.revision !== fence.expectedRevision)
      throw new ContextIngestionError('revision-conflict');
    return item;
  };
  const updateItemStatus = async (
    context: AuthorizedContext,
    fence: IngestionFence,
    status: IngestionStatus,
  ) => {
    const item = ensureFenceRevision(context, fence);
    const updated = await setContextIngestionStatus(context, {
      itemId: fence.itemId,
      expectedRevision: item.revision,
      status,
    });
    fence.expectedRevision = updated.revision;
    return updated;
  };
  const publishTerminal = (
    context: AuthorizedContext,
    itemId: string,
    operationId: string,
    revision: number,
    status: IngestionStatus,
  ) => publish(eventForItem(context, itemId, operationId, revision, status));

  const dependencies: ContextIngestionDependencies = {
    inspectSelectedFile: async (context, ticketId) => {
      assertHostOpen(context);
      const ticket = tickets.get(ticketId);
      if (
        !ticket ||
        ticket.context.userId !== context.userId ||
        ticket.context.epoch !== context.epoch
      )
        throw new ContextIngestionError('session-changed');
      const info = await fileRegistry.inspect(
        context,
        ticketId,
        ticket.binding,
      );
      assertContextCurrent(context);
      if (!info) throw new ContextIngestionError('unreadable');
      return info;
    },
    readSelectedFile: async (context, ticketId, expected, maxBytes, signal) => {
      const ticket = tickets.get(ticketId);
      if (
        !ticket ||
        ticket.context.userId !== context.userId ||
        ticket.context.epoch !== context.epoch
      )
        throw new ContextIngestionError('session-changed');
      try {
        const bytes = await fileRegistry.read(
          context,
          ticketId,
          ticket.binding,
          expected,
          maxBytes,
          signal,
        );
        assertContextCurrent(context, signal);
        if (!bytes) throw new ContextIngestionError('unreadable');
        return bytes;
      } finally {
        tickets.delete(ticketId);
        await fileRegistry.discard(context, ticketId);
      }
    },
    readOriginal: async (context, itemId, signal, storageKey) => {
      assertContextCurrent(context, signal);
      const version = readContextIngestionVersion(context, {
        itemId,
        ...(storageKey ? { storageKey } : {}),
      });
      if (!version?.originalStorageKey) return null;
      const item = readContextIngestionItem(context, { itemId });
      if (!item) return null;
      try {
        const bytes = await readContextOriginal(
          context.userId,
          version.originalStorageKey,
          version.originalHash,
        );
        assertContextCurrent(context, signal);
        if (bytes.byteLength !== version.byteLength) return null;
        return {
          fileName: item.title,
          contentType: version.mimeType,
          originalHash: version.originalHash,
          storageKey: version.originalStorageKey,
          bytes,
        } satisfies StoredContextOriginal;
      } catch (error) {
        if (signal?.aborted || context.signal.aborted)
          throw new ContextIngestionError('cancelled');
        if (!context.isCurrent())
          throw new ContextIngestionError('session-changed');
        if (error instanceof ContextStorageError && error.code === 'not-found')
          return null;
        throw toIngestionError(error);
      }
    },
    storeOriginal: async (context, input) => {
      assertContextCurrent(context, input.signal);
      let original: Awaited<ReturnType<typeof writeContextOriginal>> | null =
        null;
      try {
        original = await writeContextOriginal(
          context.userId,
          input.bytes,
          contextFileLimits.documentBytes,
        );
        assertContextCurrent(context, input.signal);
        if (original.hash !== input.originalHash)
          throw new ContextIngestionError('unreadable');
        return {
          originalHash: original.hash,
          storageKey: original.storageKey,
        };
      } catch (error) {
        if (original)
          await removeUnreferencedContextOriginals(context, [
            original.storageKey,
          ]).catch(() => undefined);
        throw toIngestionError(error);
      }
    },
    readItem: async (context, itemId, scope) =>
      itemForFence(context, itemId, scope),
    readVersion: async (context, itemId, versionId) => {
      assertContextCurrent(context);
      return readContextIngestionVersion(context, {
        itemId,
        ...(versionId ? { versionId } : {}),
      });
    },
    writeAttempt: async (context, input) => {
      assertHostOpen(context);
      const fence = fenceForOperation(
        context,
        input.itemId,
        input.operationId,
        input.attemptId,
      );
      const updated = await updateItemStatus(context, fence, input.status);
      return { revision: updated.revision };
    },
    updateAttemptStatus: async (context, input) => {
      const fence = fencesByOperation.get(
        operationKey(context, input.operationId),
      );
      if (!fence || fence.itemId !== input.itemId)
        throw new ContextIngestionError('session-changed');
      const updated = await updateItemStatus(context, fence, input.status);
      return { revision: updated.revision };
    },
    writeVersion: async (
      context,
      input,
    ): Promise<ContextIngestionVersionCommit> => {
      assertContextCurrent(context, input.signal);
      const fence = fenceForOperation(
        context,
        input.itemId,
        input.operationId,
        input.attemptId,
      );
      ensureFenceRevision(context, fence);
      if (input.expectedRevision !== fence.expectedRevision)
        throw new ContextIngestionError('revision-conflict');
      try {
        const updated = await saveContextIngestionResult(context, {
          itemId: input.itemId,
          expectedRevision: input.expectedRevision,
          attemptId: input.attemptId,
          originalHash: input.originalHash,
          originalStorageKey: input.originalStorageKey,
          originalIsNew: input.originalIsNew,
          contentHash: input.contentHash,
          mimeType: input.mimeType,
          byteLength: input.byteLength,
          extractedText: input.extractedText,
          extractionStatus: input.extractionStatus,
          pageCount: input.pageCount,
          interpretedPages: input.interpretedPages,
          uncertainty: input.uncertainty,
          locators: input.locators,
        });
        assertContextCurrent(context, input.signal);
        fence.expectedRevision = updated.revision;
        const version = readContextIngestionVersion(context, {
          itemId: input.itemId,
          attemptId: input.attemptId,
        });
        if (!version) throw new ContextIngestionError('storage-failed');
        return {
          versionId: version.id,
          revision: updated.revision,
          currentVersionId: updated.currentVersionId,
          usable: updated.usable,
        };
      } catch (error) {
        if (input.originalIsNew)
          await removeUnreferencedContextOriginals(context, [
            input.originalStorageKey,
          ]).catch(() => undefined);
        throw toIngestionError(error);
      }
    },
    cleanupOriginal: async (context, storageKeys) =>
      removeUnreferencedContextOriginals(context, storageKeys),
    onOperationSettled: operationSettled,
    publish,
    ...(options.imageDecoder === undefined
      ? {}
      : { imageDecoder: options.imageDecoder }),
    interpretMetaPdf: async (context, input) => {
      const response = await requestMaterialInterpretation(context, {
        operationId: input.operationId,
        itemId: input.itemId,
        fileName: fileNameForItem(context, input.itemId),
        mimeType: 'application/pdf',
        bytes: input.bytes,
        signal: input.signal,
      });
      return {
        status: response.status,
        interpretedPages: response.interpretedPages,
        pages: response.pages.map((page) => ({
          pageNumber: page.page,
          text: page.text,
          uncertainty: page.uncertainty,
        })),
        uncertainty: pageUncertainty(response.pages),
      };
    },
    interpretMetaImage: async (context, input) => {
      const response = await requestMaterialInterpretation(context, {
        operationId: input.operationId,
        itemId: input.itemId,
        fileName: fileNameForItem(context, input.itemId),
        mimeType: input.mimeType,
        bytes: input.bytes,
        pageNumbers: [1],
        signal: input.signal,
      });
      const page = response.pages[0];
      return {
        status: response.status,
        text: page?.text ?? '',
        uncertainty:
          pageUncertainty(response.pages) ??
          (page ? null : 'Meta returned no image interpretation.'),
      };
    },
  };

  const cleanupService = configureContextIngestion(dependencies);

  const doRegisterSelectedContextFiles = async (
    context: AuthorizedContext,
    rawInput: unknown,
  ): Promise<ContextFileSelectionResult> => {
    assertHostOpen(context);
    const parsed = registerSelectedContextFilesInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new ContextIngestionError('invalid-input');
    const input: RegisterSelectedContextFilesInput = parsed.data;
    const ownerRegistrars = associateCurrentRegistrars(context);
    const items: ContextFileSelectionResult['items'] = [];
    const admissions: Array<{
      itemId: string;
      operationId: string;
      ticketId: string;
      binding: SelectedContextFileBinding;
      fileInfo: SelectedFileTicketInfo;
      statusIndex: number;
    }> = [];

    for (const filePath of input.filePaths) {
      assertHostOpen(context);
      const itemId = randomUUID();
      const operationId = randomUUID();
      const fileName = path.basename(filePath);
      const extension = path.extname(fileName).toLowerCase();
      const kind = ['.png', '.jpg', '.jpeg', '.webp'].includes(extension)
        ? 'image'
        : 'document';
      const created = await createUploadedContextItem(context, {
        itemId,
        title: fileName.slice(0, 160) || 'Uploaded file',
        kind,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.courseId ? { courseId: input.courseId } : {}),
        saveToLibrary: input.saveToLibrary,
      });
      assertHostOpen(context);
      const binding: SelectedContextFileBinding = {
        itemId,
        revision: created.revision,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.courseId ? { courseId: input.courseId } : {}),
      };
      const selected = await fileRegistry.register(context, filePath, binding);
      assertContextCurrent(context);
      if (!selected) {
        const updated = await setContextIngestionStatus(context, {
          itemId,
          expectedRevision: created.revision,
          status: 'unreadable',
        });
        publish(
          eventForItem(
            context,
            itemId,
            operationId,
            updated.revision,
            'unreadable',
          ),
        );
        items.push({ itemId, operationId, status: 'unreadable' });
        continue;
      }
      tickets.set(selected.ticketId, {
        context,
        binding,
        info: selected.info,
        itemId,
        operationId,
      });
      const fence = addOperation(
        context,
        {
          itemId,
          operationId,
          attemptId: operationId,
          expectedRevision: created.revision,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.courseId ? { courseId: input.courseId } : {}),
          ticketId: selected.ticketId,
        },
        ownerRegistrars,
      );
      fence.expectedRevision = created.revision;
      items.push({ itemId, operationId, status: 'queued' });
      admissions.push({
        itemId,
        operationId,
        ticketId: selected.ticketId,
        binding,
        fileInfo: selected.info,
        statusIndex: items.length - 1,
      });
    }

    for (const admission of admissions) {
      assertHostOpen(context);
      try {
        await trackPending(
          ingestSelectedFile(context, {
            ticketId: admission.ticketId,
            itemId: admission.itemId,
            operationId: admission.operationId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.courseId ? { courseId: input.courseId } : {}),
          }),
        );
      } catch (error) {
        const failure = toIngestionError(error);
        await removeOperation(context, admission.operationId);
        const item = readContextIngestionItem(context, {
          itemId: admission.itemId,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.courseId ? { courseId: input.courseId } : {}),
        });
        if (
          item &&
          context.isCurrent() &&
          failure.code !== 'revision-conflict'
        ) {
          const status = statusForSelectionError(failure.code);
          const updated = await setContextIngestionStatus(context, {
            itemId: item.id,
            expectedRevision: item.revision,
            status,
          }).catch(() => null);
          if (updated)
            publishTerminal(
              context,
              item.id,
              admission.operationId,
              updated.revision,
              status,
            );
          items[admission.statusIndex] = {
            itemId: admission.itemId,
            operationId: admission.operationId,
            status,
          };
        }
      }
    }

    return contextFileSelectionResultSchema.parse({ items, cancelled: false });
  };

  const registerSelectedContextFiles = (
    context: AuthorizedContext,
    input: unknown,
  ) => trackPending(doRegisterSelectedContextFiles(context, input));

  const registerContextIngestionActions = (
    registrar: AuthorizedRegistrar,
  ): ActionCleanup => {
    if (closing) throw new ContextIngestionError('feature-unavailable');
    registrars.add(registrar);
    registrar.handle('retryContextIngestion', async (context, rawInput) => {
      assertHostOpen(context);
      associateContext(registrar, context);
      const input = z
        .strictObject({
          itemId: z.string().min(1).max(300),
          requestId: z.uuid(),
        })
        .safeParse(rawInput);
      if (!input.success) throw new ContextIngestionError('invalid-input');
      const item = readContextIngestionItem(context, {
        itemId: input.data.itemId,
      });
      if (!item) throw new ContextIngestionError('not-found');
      const existingOperation = operations.get(
        operationKey(context, input.data.requestId),
      );
      if (existingOperation) return { operationId: input.data.requestId };
      const persisted = readContextIngestionVersion(context, {
        itemId: input.data.itemId,
        attemptId: input.data.requestId,
      });
      if (persisted) return { operationId: input.data.requestId };
      const existingFence = fencesByItem.get(itemKey(context, item.id));
      if (existingFence?.operationId === input.data.requestId)
        return { operationId: input.data.requestId };
      if (existingFence) throw new ContextIngestionError('busy');
      addOperation(
        context,
        {
          itemId: item.id,
          operationId: input.data.requestId,
          attemptId: input.data.requestId,
          expectedRevision: item.revision,
        },
        [registrar],
      );
      return trackPending(
        retryContextIngestion(context, input.data).catch(async (error) => {
          await removeOperation(context, input.data.requestId);
          throw toIngestionError(error);
        }),
      );
    });
    registrar.handle('cancelContextIngestion', async (context, input) => {
      assertHostOpen(context);
      associateContext(registrar, context);
      const parsed = z
        .strictObject({ operationId: z.string().min(1).max(300) })
        .safeParse(input);
      if (!parsed.success) throw new ContextIngestionError('invalid-input');
      const result = await cancelContextIngestion(context, parsed.data);
      await removeOperation(context, parsed.data.operationId);
      return result;
    });
    registrar.handle('readContextPreview', async (context, input) => {
      assertHostOpen(context);
      associateContext(registrar, context);
      return readContextPreview(context, input);
    });

    let cleanupPromise: Promise<void> | null = null;
    return () =>
      (cleanupPromise ??= (async () => {
        const keys = [...(registrarOperations.get(registrar) ?? [])];
        await Promise.allSettled(
          keys.map(async (key) => {
            const operation = operations.get(key);
            if (operation)
              await cancelContextIngestion(operation.context, {
                operationId: operation.operationId,
              }).catch(() => undefined);
          }),
        );
        for (const [ticketId, ticket] of tickets) {
          const owner = registrarOwners.get(registrar);
          if (
            owner &&
            ticket.context.userId === owner.userId &&
            ticket.context.epoch === owner.epoch
          ) {
            tickets.delete(ticketId);
            await fileRegistry.discard(ticket.context, ticketId);
          }
        }
        registrarOperations.delete(registrar);
        registrarOwners.delete(registrar);
        registrars.delete(registrar);
      })());
  };

  const dispose = () => {
    if (disposal) return disposal;
    closing = true;
    disposal = (async () => {
      await waitForAdmissions();
      const active = [...operations.values()];
      await Promise.allSettled(
        active.map((operation) =>
          cancelContextIngestion(operation.context, {
            operationId: operation.operationId,
          }).catch(() => undefined),
        ),
      );
      await cleanupService();
      await fileRegistry.clear();
      tickets.clear();
      fencesByOperation.clear();
      fencesByItem.clear();
      operations.clear();
      registrarOperations.clear();
      registrarOwners.clear();
      registrars.clear();
    })();
    return disposal;
  };

  return {
    registerSelectedContextFiles,
    registerContextIngestionActions,
    dispose,
    whenIdle: async () => {
      await waitForAdmissions();
      await waitForContextIngestionIdle();
    },
  };
};
