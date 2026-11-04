import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  contextFileLimits,
  isContextFileBatchWithinLimits,
} from '../../features/context/services/file-validation';

export type SelectedContextFileBinding = {
  itemId: string;
  revision: number;
  sessionId?: string;
  courseId?: string;
};

export type SelectedContextFileInfo = {
  fileName: string;
  contentType: string;
  byteLength: number;
};

type SelectedContextFileContext = {
  userId: string;
  epoch: number;
  isCurrent?: () => boolean;
  signal?: AbortSignal;
};

type SelectedContextFileTicket = {
  fileHandle: FileHandle;
  filePath: string;
  expiresAt: number;
  identity: Pick<BigIntStats, 'dev' | 'ino' | 'mtimeNs' | 'ctimeNs'>;
  context: Pick<SelectedContextFileContext, 'userId' | 'epoch'>;
  binding: SelectedContextFileBinding;
  info: SelectedContextFileInfo;
  closePromise: Promise<void> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

type SelectedContextFileActiveRead = {
  ticket: SelectedContextFileTicket;
  controller: AbortController;
  promise: Promise<Buffer | null>;
};

const hasSameSnapshot = (
  expected: Pick<BigIntStats, 'dev' | 'ino' | 'mtimeNs' | 'ctimeNs'>,
  actual: BigIntStats,
) =>
  expected.dev === actual.dev &&
  expected.ino === actual.ino &&
  expected.mtimeNs === actual.mtimeNs &&
  expected.ctimeNs === actual.ctimeNs;

const contentTypeFor = (filePath: string) => {
  switch (extname(filePath).toLowerCase()) {
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.pdf':
      return 'application/pdf';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
};

const ticketLifetimeMs = 5 * 60 * 1000;

const safeFileNameFor = (filePath: string) => {
  const fileName = basename(filePath);
  const hasControlCharacters = Array.from(fileName).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
  return fileName.length > 0 &&
    fileName.length <= 255 &&
    fileName !== '.' &&
    fileName !== '..' &&
    !fileName.includes('/') &&
    !fileName.includes('\\') &&
    !hasControlCharacters
    ? fileName
    : null;
};

const contextIsUsable = (context: SelectedContextFileContext) => {
  try {
    return (
      typeof context.userId === 'string' &&
      context.userId.trim().length > 0 &&
      Number.isSafeInteger(context.epoch) &&
      context.epoch >= 0 &&
      context.signal?.aborted !== true &&
      context.isCurrent?.() !== false
    );
  } catch {
    return false;
  }
};

const bindingIsValid = (binding: SelectedContextFileBinding) => {
  try {
    if (!binding || typeof binding !== 'object') return false;
    const keys = Object.keys(binding);
    return (
      keys.every((key) =>
        ['itemId', 'revision', 'sessionId', 'courseId'].includes(key),
      ) &&
      typeof binding.itemId === 'string' &&
      binding.itemId.trim().length > 0 &&
      Number.isSafeInteger(binding.revision) &&
      binding.revision >= 0 &&
      (binding.sessionId === undefined ||
        (typeof binding.sessionId === 'string' &&
          binding.sessionId.length > 0)) &&
      (binding.courseId === undefined ||
        (typeof binding.courseId === 'string' && binding.courseId.length > 0))
    );
  } catch {
    return false;
  }
};

const bindingMatches = (
  registered: SelectedContextFileBinding,
  candidate: SelectedContextFileBinding,
) =>
  bindingIsValid(candidate) &&
  registered.itemId === candidate.itemId &&
  registered.revision === candidate.revision &&
  registered.sessionId === candidate.sessionId &&
  registered.courseId === candidate.courseId;

const contextMatches = (
  registered: Pick<SelectedContextFileContext, 'userId' | 'epoch'>,
  candidate: SelectedContextFileContext,
) =>
  contextIsUsable(candidate) &&
  registered.userId === candidate.userId &&
  registered.epoch === candidate.epoch;

const selectedFileMatchesTicket = async (ticket: SelectedContextFileTicket) => {
  const [pathStats, fileStats] = await Promise.all([
    lstat(ticket.filePath, { bigint: true }).catch(() => null),
    ticket.fileHandle.stat({ bigint: true }).catch(() => null),
  ]);
  return (
    pathStats?.isFile() === true &&
    !pathStats.isSymbolicLink() &&
    fileStats?.isFile() === true &&
    hasSameSnapshot(ticket.identity, pathStats) &&
    hasSameSnapshot(ticket.identity, fileStats) &&
    pathStats.size === BigInt(ticket.info.byteLength) &&
    fileStats.size === BigInt(ticket.info.byteLength)
  );
};

const expectedInfoMatches = (
  registered: SelectedContextFileInfo,
  expected: SelectedContextFileInfo,
) => {
  try {
    const keys = Object.keys(expected);
    return (
      keys.length === 3 &&
      keys.every((key) =>
        ['fileName', 'contentType', 'byteLength'].includes(key),
      ) &&
      registered.fileName === expected.fileName &&
      registered.contentType === expected.contentType &&
      registered.byteLength === expected.byteLength
    );
  } catch {
    return false;
  }
};

const readChunkBytes = 64 * 1024;

export const createSelectedContextFileRegistry = () => {
  const tickets = new Map<string, SelectedContextFileTicket>();
  const activeReads = new Map<string, SelectedContextFileActiveRead>();
  const registrations = new Set<Promise<unknown>>();
  let clearing = false;
  let clearPromise: Promise<void> | null = null;

  const heldTickets = () => [
    ...tickets.values(),
    ...[...activeReads.values()].map(({ ticket }) => ticket),
  ];

  const closeTicket = (ticket: SelectedContextFileTicket) => {
    if (ticket.expiryTimer) clearTimeout(ticket.expiryTimer);
    ticket.expiryTimer = null;
    ticket.closePromise ??= ticket.fileHandle
      .close()
      .then(() => undefined)
      .catch(() => undefined);
    return ticket.closePromise;
  };

  const invalidateTicket = async (
    ticketId: string,
    ticket: SelectedContextFileTicket,
  ) => {
    if (tickets.get(ticketId) === ticket) tickets.delete(ticketId);
    await closeTicket(ticket);
  };

  const reapExpiredTickets = async () => {
    const expired = [...tickets.entries()].filter(
      ([, ticket]) => Date.now() >= ticket.expiresAt,
    );
    for (const [ticketId, ticket] of expired)
      await invalidateTicket(ticketId, ticket);
  };

  const registerFile = async (
    context: SelectedContextFileContext,
    filePath: string,
    binding: SelectedContextFileBinding,
  ) => {
    let fileHandle: FileHandle | null = null;
    try {
      if (clearing || !contextIsUsable(context) || !bindingIsValid(binding))
        return null;
      await reapExpiredTickets();
      if (clearing || !contextIsUsable(context)) return null;
      const pathStats = await lstat(filePath, { bigint: true });
      if (clearing || !contextIsUsable(context)) return null;
      if (!pathStats.isFile() || pathStats.isSymbolicLink()) return null;
      fileHandle = await open(
        filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      if (clearing || !contextIsUsable(context)) return null;
      const fileStats = await fileHandle.stat({ bigint: true });
      if (clearing || !contextIsUsable(context)) return null;
      if (!fileStats.isFile() || !hasSameSnapshot(pathStats, fileStats))
        return null;
      const byteLength = Number(fileStats.size);
      const held = heldTickets();
      const pendingLengths = held.map((ticket) => ticket.info.byteLength);
      if (
        clearing ||
        held.length >= contextFileLimits.batchFiles ||
        !isContextFileBatchWithinLimits([...pendingLengths, byteLength])
      )
        return null;
      const fileName = safeFileNameFor(filePath);
      if (!fileName) return null;
      const info = {
        fileName,
        contentType: contentTypeFor(filePath),
        byteLength,
      };
      const ticketId = randomUUID();
      const ticket: SelectedContextFileTicket = {
        fileHandle,
        filePath,
        expiresAt: Date.now() + ticketLifetimeMs,
        identity: {
          dev: fileStats.dev,
          ino: fileStats.ino,
          mtimeNs: fileStats.mtimeNs,
          ctimeNs: fileStats.ctimeNs,
        },
        context: { userId: context.userId, epoch: context.epoch },
        binding: { ...binding },
        info,
        closePromise: null,
        expiryTimer: null,
      };
      tickets.set(ticketId, ticket);
      ticket.expiryTimer = setTimeout(() => {
        const activeRead = activeReads.get(ticketId);
        if (activeRead) activeRead.controller.abort();
        else void invalidateTicket(ticketId, ticket);
      }, ticketLifetimeMs);
      ticket.expiryTimer.unref?.();
      fileHandle = null;
      return { ticketId, info: { ...info } };
    } catch {
      return null;
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  const register = (
    context: SelectedContextFileContext,
    filePath: string,
    binding: SelectedContextFileBinding,
  ) => {
    if (clearing) return Promise.resolve(null);
    const registration = registerFile(context, filePath, binding);
    registrations.add(registration);
    void registration.then(
      () => registrations.delete(registration),
      () => registrations.delete(registration),
    );
    return registration;
  };

  const inspect = async (
    context: SelectedContextFileContext,
    ticketId: string,
    binding: SelectedContextFileBinding,
  ) => {
    const ticket = tickets.get(ticketId);
    if (ticket && Date.now() >= ticket.expiresAt) {
      await invalidateTicket(ticketId, ticket);
      return null;
    }
    if (
      !ticket ||
      !contextMatches(ticket.context, context) ||
      !bindingMatches(ticket.binding, binding)
    )
      return null;
    if (!(await selectedFileMatchesTicket(ticket))) {
      await invalidateTicket(ticketId, ticket);
      return null;
    }
    if (tickets.get(ticketId) !== ticket) return null;
    if (Date.now() >= ticket.expiresAt) {
      await invalidateTicket(ticketId, ticket);
      return null;
    }
    if (
      !contextMatches(ticket.context, context) ||
      !bindingMatches(ticket.binding, binding)
    )
      return null;
    return { ...ticket.info };
  };

  const read = (
    context: SelectedContextFileContext,
    ticketId: string,
    binding: SelectedContextFileBinding,
    expectedInfo: SelectedContextFileInfo,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer | null> => {
    const ticket = tickets.get(ticketId);
    if (!ticket) return Promise.resolve(null);
    if (Date.now() >= ticket.expiresAt)
      return invalidateTicket(ticketId, ticket).then(() => null);
    const boundedMaxBytes = Math.min(maxBytes, contextFileLimits.documentBytes);
    if (
      clearing ||
      !contextMatches(ticket.context, context) ||
      !bindingMatches(ticket.binding, binding) ||
      !expectedInfoMatches(ticket.info, expectedInfo) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      ticket.info.byteLength > boundedMaxBytes
    )
      return Promise.resolve(null);

    tickets.delete(ticketId);
    const activeRead: SelectedContextFileActiveRead = {
      ticket,
      controller: new AbortController(),
      promise: Promise.resolve(null),
    };
    activeReads.set(ticketId, activeRead);
    const isCancelled = () =>
      signal.aborted ||
      activeRead.controller.signal.aborted ||
      context.signal?.aborted === true ||
      Date.now() >= ticket.expiresAt ||
      !contextMatches(ticket.context, context) ||
      !bindingMatches(ticket.binding, binding);
    const operation = (async (): Promise<Buffer | null> => {
      try {
        if (isCancelled() || !(await selectedFileMatchesTicket(ticket)))
          return null;
        const bytes = Buffer.allocUnsafe(ticket.info.byteLength);
        let position = 0;
        while (position < bytes.byteLength) {
          if (isCancelled()) return null;
          const length = Math.min(readChunkBytes, bytes.byteLength - position);
          const { bytesRead } = await ticket.fileHandle.read(
            bytes,
            position,
            length,
            position,
          );
          if (bytesRead === 0) return null;
          position += bytesRead;
          if (isCancelled() || !(await selectedFileMatchesTicket(ticket)))
            return null;
        }
        if (isCancelled() || !(await selectedFileMatchesTicket(ticket)))
          return null;
        return bytes;
      } catch {
        return null;
      } finally {
        await closeTicket(ticket);
        if (activeReads.get(ticketId) === activeRead)
          activeReads.delete(ticketId);
      }
    })();
    activeRead.promise = operation;
    return operation;
  };

  const discard = async (
    context: SelectedContextFileContext,
    ticketId: string,
  ) => {
    const ticket = tickets.get(ticketId);
    if (ticket) {
      if (!contextMatches(ticket.context, context)) return;
      await invalidateTicket(ticketId, ticket);
      return;
    }
    const activeRead = activeReads.get(ticketId);
    if (!activeRead || !contextMatches(activeRead.ticket.context, context))
      return;
    activeRead.controller.abort();
    await activeRead.promise.then(
      () => undefined,
      () => undefined,
    );
  };

  const clear = (): Promise<void> => {
    if (clearPromise) return clearPromise;
    clearing = true;
    const pending = [...tickets.values()];
    const pendingRegistrations = [...registrations];
    const inFlightReads = [...activeReads.values()];
    tickets.clear();
    for (const activeRead of inFlightReads) activeRead.controller.abort();
    let completion!: Promise<void>;
    completion = Promise.all([
      ...pending.map(closeTicket),
      ...pendingRegistrations.map((registration) =>
        registration.then(
          () => undefined,
          () => undefined,
        ),
      ),
      ...inFlightReads.map((activeRead) =>
        activeRead.promise.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ])
      .then(() => undefined)
      .finally(() => {
        if (clearPromise === completion) {
          clearing = false;
          clearPromise = null;
        }
      });
    clearPromise = completion;
    return completion;
  };

  return { register, inspect, read, discard, clear };
};
