import { inflateRawSync } from 'node:zlib';
import type { ContextImageMimeType } from '@scholaros/services/learning/context-contracts';

const MiB = 1024 * 1024;
const maxDocBytes = 10 * MiB;
const maxTextBytes = 2 * MiB;
const maxImageBytes = 8 * MiB;
const maxImagePixels = 20_000_000;
const maxBatchBytes = 24 * MiB;
const maxBatchFiles = 8;
const maxDocxEntries = 2_000;
const maxDocxInflatedBytes = 50 * MiB;
const maxDocxRatio = 100;
const maxInspectedXmlBytes = 2 * MiB;
const zipEndSignature = 0x06054b50;
const zipCentralSignature = 0x02014b50;
const zipLocalSignature = 0x04034b50;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const contextFileLimits = {
  documentBytes: maxDocBytes,
  textBytes: maxTextBytes,
  imageBytes: maxImageBytes,
  imagePixels: maxImagePixels,
  batchBytes: maxBatchBytes,
  batchFiles: maxBatchFiles,
  imageLongestEdge: 4096,
  docxEntries: maxDocxEntries,
  docxInflatedBytes: maxDocxInflatedBytes,
  docxExpansionRatio: maxDocxRatio,
} as const;

export const isContextFileBatchWithinLimits = (
  byteLengths: readonly number[],
) => {
  if (!Array.isArray(byteLengths) || byteLengths.length > maxBatchFiles)
    return false;
  let totalBytes = 0;
  for (const byteLength of byteLengths) {
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > maxDocBytes
    )
      return false;
    totalBytes += byteLength;
    if (totalBytes > maxBatchBytes) return false;
  }
  return true;
};

export type ContextFileKind = 'text' | 'pdf' | 'docx' | 'image';

export type ContextFileValidationInput = {
  fileName: string;
  contentType?: string;
  bytes: Uint8Array;
};

export type ContextFileValidationResult =
  | {
      status: 'valid';
      kind: ContextFileKind;
      mimeType: string;
      fileName: string;
      bytes: Uint8Array;
      text?: string;
      width?: number;
      height?: number;
      imageMimeType?: ContextImageMimeType;
    }
  | { status: 'unsupported'; reason: ContextFileIssueReason }
  | { status: 'unreadable'; reason: ContextFileIssueReason };

type ContextFileIssueReason =
  | 'mislabeled'
  | 'invalid-utf8'
  | 'limit-exceeded'
  | 'animated-image'
  | 'unsafe-archive'
  | 'invalid-container'
  | 'unsupported-format';

export type DocxArchiveEntry = {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  checksum: number;
  dataOffset: number;
};

export type DocxArchiveInspection =
  | {
      status: 'valid';
      entries: DocxArchiveEntry[];
      uncompressedBytes: number;
    }
  | { status: 'unsupported'; reason: DocxArchiveIssueReason }
  | { status: 'unreadable'; reason: DocxArchiveIssueReason };

type DocxArchiveIssueReason =
  | 'unsafe-archive'
  | 'invalid-container'
  | 'limit-exceeded'
  | 'unsupported-format';

export type ContextImageHeader = {
  mimeType: ContextImageMimeType;
  width: number;
  height: number;
  animated: boolean;
};

export type ContextImageHeaderResult =
  | { status: 'valid'; image: ContextImageHeader }
  | {
      status: 'unsupported';
      reason:
        | 'animated-image'
        | 'limit-exceeded'
        | 'invalid-container'
        | 'unsupported-format';
    }
  | {
      status: 'unreadable';
      reason:
        | 'animated-image'
        | 'limit-exceeded'
        | 'invalid-container'
        | 'unsupported-format';
    };

const unsupported = (
  reason: ContextFileIssueReason,
): ContextFileValidationResult => ({ status: 'unsupported', reason });

const unreadable = (
  reason: ContextFileIssueReason,
): ContextFileValidationResult => ({ status: 'unreadable', reason });

const isBuffer = (bytes: Uint8Array, start: number, value: string) =>
  bytes.byteLength >= start + value.length &&
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .subarray(start, start + value.length)
    .equals(Buffer.from(value, 'ascii'));

const extensionOf = (fileName: string) => {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
};

const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

const normalizedContentType = (contentType?: string) =>
  (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();

const hasMatchingType = (declared: string, accepted: readonly string[]) =>
  declared === '' ||
  declared === 'application/octet-stream' ||
  accepted.includes(declared);

const invalidZip = (
  reason: 'invalid-container' | 'unsafe-archive' = 'invalid-container',
): DocxArchiveInspection => ({
  status: 'unreadable',
  reason,
});

const unsupportedZip = (
  reason: DocxArchiveIssueReason,
): DocxArchiveInspection => ({
  status: 'unsupported',
  reason,
});

const readZipName = (bytes: Buffer, flags: number) => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const utf8 = (flags & 0x0800) !== 0;
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) return null;
  try {
    return utf8 ? decoder.decode(bytes) : bytes.toString('ascii');
  } catch {
    return null;
  }
};

const isUnsafeZipName = (name: string) => {
  if (
    name.length === 0 ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name)
  )
    return true;
  return name.split('/').some((part) => part === '..' || part === '.');
};

const zipExtraContainsZip64 = (bytes: Buffer) => {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return true;
    const id = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > bytes.length || id === 0x0001) return true;
    offset += length;
  }
  return false;
};

const findEndOfCentralDirectory = (bytes: Buffer) => {
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== zipEndSignature) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  return -1;
};

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const inflateEntry = (archive: Buffer, entry: DocxArchiveEntry) => {
  const compressed = archive.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );
  const content =
    entry.compressionMethod === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, entry.uncompressedSize),
        });
  if (
    content.byteLength !== entry.uncompressedSize ||
    crc32(content) !== entry.checksum
  )
    throw new Error('invalid-entry');
  return content;
};

// Normalize XML references before scanning security-sensitive attributes.
const decodeXmlReferences = (xml: string): string | null => {
  if (/&(?!(?:#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);)/i.test(xml))
    return null;
  let invalidReference = false;
  const normalizedXml = xml.replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi,
    (_reference, entity: string) => {
      switch (entity.toLowerCase()) {
        case 'amp':
          return '&';
        case 'apos':
          return "'";
        case 'gt':
          return '>';
        case 'lt':
          return '<';
        case 'quot':
          return '"';
      }
      const codePoint = entity.toLowerCase().startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        !(
          codePoint === 0x09 ||
          codePoint === 0x0a ||
          codePoint === 0x0d ||
          (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
          (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
          (codePoint >= 0x10000 && codePoint <= 0x10ffff)
        )
      ) {
        invalidReference = true;
        return '';
      }
      return String.fromCodePoint(codePoint);
    },
  );
  return invalidReference ? null : normalizedXml;
};

export const inspectDocxArchive = (
  input: Uint8Array,
): DocxArchiveInspection => {
  if (input.byteLength === 0 || input.byteLength > maxDocBytes)
    return unsupportedZip('limit-exceeded');
  const archive = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0) return invalidZip();
  if (
    archive.readUInt16LE(eocdOffset + 4) !== 0 ||
    archive.readUInt16LE(eocdOffset + 6) !== 0
  )
    return unsupportedZip('unsupported-format');

  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
  if (
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  )
    return unsupportedZip('unsupported-format');
  if (totalEntries === 0 || totalEntries > maxDocxEntries)
    return unsupportedZip('limit-exceeded');
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryEnd !== eocdOffset ||
    centralDirectoryOffset >= eocdOffset ||
    centralDirectoryEnd > archive.byteLength
  )
    return invalidZip();

  const entries: DocxArchiveEntry[] = [];
  const names = new Set<string>();
  let uncompressedBytes = 0;
  let offset = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > centralDirectoryEnd ||
      archive.readUInt32LE(offset) !== zipCentralSignature
    )
      return invalidZip();
    const flags = archive.readUInt16LE(offset + 8);
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const diskStart = archive.readUInt16LE(offset + 34);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (
      recordEnd > centralDirectoryEnd ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    )
      return unsupportedZip('unsupported-format');
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    const name = readZipName(nameBytes, flags);
    if (!name) return unsupportedZip('unsafe-archive');
    if (isUnsafeZipName(name)) return unsupportedZip('unsafe-archive');
    const normalizedName = name.normalize('NFC').toLowerCase();
    if (names.has(normalizedName)) return unsupportedZip('unsafe-archive');
    names.add(normalizedName);

    const extra = archive.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    if (zipExtraContainsZip64(extra))
      return unsupportedZip('unsupported-format');
    if ((flags & (0x0001 | 0x0040 | 0x2000)) !== 0)
      return unsupportedZip('unsupported-format');
    if (compressionMethod !== 0 && compressionMethod !== 8)
      return unsupportedZip('unsupported-format');
    if (compressedSize === 0 && uncompressedSize > 0)
      return unsupportedZip('limit-exceeded');
    if (uncompressedSize > compressedSize * maxDocxRatio)
      return unsupportedZip('limit-exceeded');
    uncompressedBytes += uncompressedSize;
    if (uncompressedBytes > maxDocxInflatedBytes)
      return unsupportedZip('limit-exceeded');
    if (localHeaderOffset + 30 > centralDirectoryOffset) return invalidZip();
    if (archive.readUInt32LE(localHeaderOffset) !== zipLocalSignature)
      return invalidZip();
    const localFlags = archive.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = archive.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const localNameStart = localHeaderOffset + 30;
    const localDataOffset = localNameStart + localNameLength + localExtraLength;
    const localName = archive.subarray(
      localNameStart,
      localNameStart + localNameLength,
    );
    const localExtra = archive.subarray(
      localNameStart + localNameLength,
      localDataOffset,
    );
    if (
      localFlags !== flags ||
      localCompressionMethod !== compressionMethod ||
      !localName.equals(nameBytes) ||
      zipExtraContainsZip64(localExtra) ||
      localDataOffset + compressedSize > centralDirectoryOffset
    )
      return invalidZip();
    entries.push({
      name,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      checksum,
      dataOffset: localDataOffset,
    });
    offset = recordEnd;
  }
  if (offset !== centralDirectoryEnd) return invalidZip();

  const exactNames = new Set(entries.map(({ name }) => name));
  if (
    !exactNames.has('[Content_Types].xml') ||
    !exactNames.has('_rels/.rels') ||
    !exactNames.has('word/document.xml')
  )
    return unsupportedZip('unsupported-format');
  if (
    entries.some(({ name }) =>
      /(?:^|\/)(?:embeddings|activex)\/|vbaProject\.bin|oleObject/i.test(name),
    )
  )
    return unsupportedZip('unsafe-archive');

  try {
    let inspectedXmlBytes = 0;
    let contentTypesXml = '';
    let rootRelationshipsXml = '';
    for (const entry of entries) {
      if (
        entry.name !== '[Content_Types].xml' &&
        !entry.name.endsWith('.rels') &&
        entry.name !== 'word/document.xml'
      )
        continue;
      inspectedXmlBytes += entry.uncompressedSize;
      if (inspectedXmlBytes > maxInspectedXmlBytes)
        return unsupportedZip('limit-exceeded');
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(
        inflateEntry(archive, entry),
      );
      const normalizedXml = decodeXmlReferences(xml);
      if (normalizedXml === null) return unsupportedZip('unsafe-archive');
      if (entry.name === '[Content_Types].xml') contentTypesXml = normalizedXml;
      if (entry.name === '_rels/.rels') rootRelationshipsXml = normalizedXml;
      if (
        /macroEnabled|vbaProject|oleObject|TargetMode\s*=\s*["']\s*External\s*["']|<!DOCTYPE|<!ENTITY|<\s*(?:[\w.-]+:)?(?:altChunk|object|OLEObject)\b/i.test(
          normalizedXml,
        )
      )
        return unsupportedZip('unsafe-archive');
    }
    const hasDocumentContentType =
      /<Override\b(?=[^>]*\bPartName\s*=\s*["']\/?word\/document\.xml["'])(?=[^>]*\bContentType\s*=\s*["']application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document\.main\+xml["'])[^>]*>/i.test(
        contentTypesXml,
      );
    const rootDocumentRelationship = rootRelationshipsXml
      .match(/<Relationship\b[^>]*>/gi)
      ?.find((relationship) => /\/officeDocument["']/i.test(relationship));
    if (
      !hasDocumentContentType ||
      !rootDocumentRelationship ||
      !/\bTarget\s*=\s*["']\/?word\/document\.xml["']/i.test(
        rootDocumentRelationship,
      )
    )
      return unsupportedZip('unsupported-format');
  } catch {
    return invalidZip();
  }

  return { status: 'valid', entries, uncompressedBytes };
};

const parsePngHeader = (bytes: Buffer): ContextImageHeaderResult => {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(pngSignature) ||
    !isBuffer(bytes, 12, 'IHDR')
  )
    return { status: 'unreadable', reason: 'invalid-container' };
  return imageHeader(
    'image/png',
    bytes.readUInt32BE(16),
    bytes.readUInt32BE(20),
  );
};

const parseJpegHeader = (bytes: Buffer): ContextImageHeaderResult => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return { status: 'unreadable', reason: 'invalid-container' };
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff)
      return { status: 'unreadable', reason: 'invalid-container' };
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      continue;
    if (offset + 2 > bytes.length)
      return { status: 'unreadable', reason: 'invalid-container' };
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length)
      return { status: 'unreadable', reason: 'invalid-container' };
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7)
        return { status: 'unreadable', reason: 'invalid-container' };
      return imageHeader(
        'image/jpeg',
        bytes.readUInt16BE(offset + 5),
        bytes.readUInt16BE(offset + 3),
      );
    }
    offset += segmentLength;
  }
  return { status: 'unreadable', reason: 'invalid-container' };
};

const parseWebpHeader = (bytes: Buffer): ContextImageHeaderResult => {
  if (
    bytes.length < 25 ||
    !isBuffer(bytes, 0, 'RIFF') ||
    !isBuffer(bytes, 8, 'WEBP') ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return { status: 'unreadable', reason: 'invalid-container' };
  let offset = 12;
  let dimensions: { width: number; height: number } | null = null;
  let animated = false;
  while (offset + 8 <= bytes.length) {
    const chunk = bytes.toString('ascii', offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const paddedLength = chunkLength + (chunkLength % 2);
    if (paddedLength > bytes.length - dataOffset)
      return { status: 'unreadable', reason: 'invalid-container' };
    if (chunk === 'ANIM' || chunk === 'ANMF') animated = true;
    if (chunk === 'VP8X') {
      if (chunkLength < 10)
        return { status: 'unreadable', reason: 'invalid-container' };
      animated ||= (bytes[dataOffset]! & 0x02) !== 0;
      dimensions = {
        width: 1 + bytes.readUIntLE(dataOffset + 4, 3),
        height: 1 + bytes.readUIntLE(dataOffset + 7, 3),
      };
    } else if (chunk === 'VP8L' && chunkLength >= 5) {
      if (bytes[dataOffset] !== 0x2f)
        return { status: 'unreadable', reason: 'invalid-container' };
      const b1 = bytes[dataOffset + 1]!;
      const b2 = bytes[dataOffset + 2]!;
      const b3 = bytes[dataOffset + 3]!;
      const b4 = bytes[dataOffset + 4]!;
      dimensions = {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
    } else if (chunk === 'VP8 ' && chunkLength >= 10) {
      if (
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      )
        return { status: 'unreadable', reason: 'invalid-container' };
      dimensions = {
        width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    }
    offset = dataOffset + paddedLength;
  }
  if (offset !== bytes.length || !dimensions)
    return { status: 'unreadable', reason: 'invalid-container' };
  if (animated) return { status: 'unsupported', reason: 'animated-image' };
  return imageHeader('image/webp', dimensions.width, dimensions.height);
};

const parsePng = (bytes: Buffer): ContextImageHeaderResult => {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.readUInt32BE(8) !== 13 ||
    !isBuffer(bytes, 12, 'IHDR')
  )
    return { status: 'unreadable', reason: 'invalid-container' };
  const headerDimensions = imageHeader(
    'image/png',
    bytes.readUInt32BE(16),
    bytes.readUInt32BE(20),
  );
  if (headerDimensions.status !== 'valid') return headerDimensions;

  let offset = 8;
  let width: number | null = null;
  let height: number | null = null;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length)
      return { status: 'unreadable', reason: 'invalid-container' };
    const chunkLength = bytes.readUInt32BE(offset);
    if (chunkLength > bytes.length - offset - 12)
      return { status: 'unreadable', reason: 'invalid-container' };
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + chunkLength;
    const type = bytes.toString('ascii', typeOffset, typeOffset + 4);
    if (!/^[A-Za-z]{4}$/.test(type))
      return { status: 'unreadable', reason: 'invalid-container' };

    if (width === null) {
      if (type !== 'IHDR' || chunkLength !== 13)
        return { status: 'unreadable', reason: 'invalid-container' };
      width = bytes.readUInt32BE(dataOffset);
      height = bytes.readUInt32BE(dataOffset + 4);
      const dimensions = imageHeader('image/png', width, height);
      if (dimensions.status !== 'valid') return dimensions;
      const bitDepth = bytes[dataOffset + 8]!;
      const colorType = bytes[dataOffset + 9]!;
      const validBitDepth =
        colorType === 0
          ? [1, 2, 4, 8, 16].includes(bitDepth)
          : colorType === 2 || colorType === 4 || colorType === 6
            ? bitDepth === 8 || bitDepth === 16
            : colorType === 3
              ? [1, 2, 4, 8].includes(bitDepth)
              : false;
      if (
        !validBitDepth ||
        bytes[dataOffset + 10] !== 0 ||
        bytes[dataOffset + 11] !== 0 ||
        bytes[dataOffset + 12]! > 1 ||
        crc32(bytes.subarray(typeOffset, crcOffset)) !==
          bytes.readUInt32BE(crcOffset)
      )
        return { status: 'unreadable', reason: 'invalid-container' };
    } else {
      if (type === 'IHDR')
        return { status: 'unreadable', reason: 'invalid-container' };
      if (type === 'IDAT') {
        if (idatEnded)
          return { status: 'unreadable', reason: 'invalid-container' };
        sawIdat = true;
      } else if (sawIdat && type !== 'IEND') {
        idatEnded = true;
      }
      if (type === 'IEND') {
        if (
          chunkLength !== 0 ||
          !sawIdat ||
          crc32(bytes.subarray(typeOffset, crcOffset)) !==
            bytes.readUInt32BE(crcOffset) ||
          crcOffset + 4 !== bytes.length
        )
          return { status: 'unreadable', reason: 'invalid-container' };
        sawIend = true;
        break;
      }
    }
    offset = crcOffset + 4;
  }

  if (width === null || height === null || !sawIdat || !sawIend)
    return { status: 'unreadable', reason: 'invalid-container' };
  return imageHeader('image/png', width, height);
};

const isJpegStartOfFrame = (marker: number) =>
  [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ].includes(marker);

const parseJpeg = (bytes: Buffer): ContextImageHeaderResult => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return { status: 'unreadable', reason: 'invalid-container' };

  let offset = 2;
  let width: number | null = null;
  let height: number | null = null;
  let sawScan = false;
  let inScan = false;
  while (offset < bytes.length) {
    if (inScan) {
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const markerOffset = offset;
        while (bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length)
          return { status: 'unreadable', reason: 'invalid-container' };
        const marker = bytes[offset]!;
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 1;
          continue;
        }
        inScan = false;
        offset = markerOffset;
        break;
      }
      if (inScan) return { status: 'unreadable', reason: 'invalid-container' };
      continue;
    }

    if (bytes[offset] !== 0xff)
      return { status: 'unreadable', reason: 'invalid-container' };
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length)
      return { status: 'unreadable', reason: 'invalid-container' };
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9) {
      if (
        width === null ||
        height === null ||
        !sawScan ||
        offset !== bytes.length
      )
        return { status: 'unreadable', reason: 'invalid-container' };
      return imageHeader('image/jpeg', width, height);
    }
    if (
      marker === 0xd8 ||
      marker === 0x00 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      return { status: 'unreadable', reason: 'invalid-container' };
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length)
      return { status: 'unreadable', reason: 'invalid-container' };
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length)
      return { status: 'unreadable', reason: 'invalid-container' };

    if (isJpegStartOfFrame(marker)) {
      if (width !== null || segmentLength < 8)
        return { status: 'unreadable', reason: 'invalid-container' };
      const componentCount = bytes[offset + 7]!;
      if (componentCount === 0 || segmentLength !== 8 + componentCount * 3)
        return { status: 'unreadable', reason: 'invalid-container' };
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      const dimensions = imageHeader('image/jpeg', width, height);
      if (dimensions.status !== 'valid') return dimensions;
    } else if (marker === 0xda) {
      if (width === null || height === null || segmentLength < 6)
        return { status: 'unreadable', reason: 'invalid-container' };
      const componentCount = bytes[offset + 2]!;
      if (componentCount === 0 || segmentLength !== 6 + componentCount * 2)
        return { status: 'unreadable', reason: 'invalid-container' };
      sawScan = true;
      inScan = true;
    }
    offset += segmentLength;
  }
  return { status: 'unreadable', reason: 'invalid-container' };
};

const parseWebp = (bytes: Buffer): ContextImageHeaderResult => {
  if (
    bytes.length < 20 ||
    !isBuffer(bytes, 0, 'RIFF') ||
    !isBuffer(bytes, 8, 'WEBP') ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return { status: 'unreadable', reason: 'invalid-container' };

  let offset = 12;
  let dimensions: { width: number; height: number } | null = null;
  let hasExtendedHeader = false;
  let hasBitstream = false;
  let animated = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length)
      return { status: 'unreadable', reason: 'invalid-container' };
    const chunk = bytes.toString('ascii', offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const paddedLength = chunkLength + (chunkLength % 2);
    if (paddedLength > bytes.length - dataOffset)
      return { status: 'unreadable', reason: 'invalid-container' };
    if (chunkLength % 2 !== 0 && bytes[dataOffset + chunkLength] !== 0)
      return { status: 'unreadable', reason: 'invalid-container' };

    if (chunk === 'VP8X') {
      if (offset !== 12 || hasExtendedHeader || chunkLength !== 10)
        return { status: 'unreadable', reason: 'invalid-container' };
      const flags = bytes[dataOffset]!;
      if (
        (flags & 0xc1) !== 0 ||
        bytes[dataOffset + 1] !== 0 ||
        bytes[dataOffset + 2] !== 0 ||
        bytes[dataOffset + 3] !== 0
      )
        return { status: 'unreadable', reason: 'invalid-container' };
      animated ||= (flags & 0x02) !== 0;
      dimensions = {
        width: 1 + bytes.readUIntLE(dataOffset + 4, 3),
        height: 1 + bytes.readUIntLE(dataOffset + 7, 3),
      };
      const checked = imageHeader(
        'image/webp',
        dimensions.width,
        dimensions.height,
      );
      if (checked.status !== 'valid') return checked;
      hasExtendedHeader = true;
    } else if (chunk === 'VP8L') {
      if (hasBitstream || chunkLength < 5 || bytes[dataOffset] !== 0x2f)
        return { status: 'unreadable', reason: 'invalid-container' };
      const b1 = bytes[dataOffset + 1]!;
      const b2 = bytes[dataOffset + 2]!;
      const b3 = bytes[dataOffset + 3]!;
      const b4 = bytes[dataOffset + 4]!;
      if ((b4 & 0xe0) !== 0)
        return { status: 'unreadable', reason: 'invalid-container' };
      const bitstreamDimensions = {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      };
      const checked = imageHeader(
        'image/webp',
        bitstreamDimensions.width,
        bitstreamDimensions.height,
      );
      if (checked.status !== 'valid') return checked;
      dimensions ??= bitstreamDimensions;
      hasBitstream = true;
    } else if (chunk === 'VP8 ') {
      if (
        hasBitstream ||
        chunkLength < 10 ||
        bytes[dataOffset + 3] !== 0x9d ||
        bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a
      )
        return { status: 'unreadable', reason: 'invalid-container' };
      const bitstreamDimensions = {
        width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
      const checked = imageHeader(
        'image/webp',
        bitstreamDimensions.width,
        bitstreamDimensions.height,
      );
      if (checked.status !== 'valid') return checked;
      dimensions ??= bitstreamDimensions;
      hasBitstream = true;
    } else if (chunk === 'ANIM' || chunk === 'ANMF') {
      animated = true;
      if ((chunk === 'ANIM' && chunkLength !== 6) || chunkLength < 16)
        return { status: 'unreadable', reason: 'invalid-container' };
    }
    offset = dataOffset + paddedLength;
  }

  if (offset !== bytes.length)
    return { status: 'unreadable', reason: 'invalid-container' };
  if (animated) return { status: 'unsupported', reason: 'animated-image' };
  if (!dimensions || !hasBitstream)
    return { status: 'unreadable', reason: 'invalid-container' };
  return imageHeader('image/webp', dimensions.width, dimensions.height);
};

const imageHeader = (
  mimeType: ContextImageMimeType,
  width: number,
  height: number,
): ContextImageHeaderResult => {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    return { status: 'unreadable', reason: 'invalid-container' };
  if (width * height > maxImagePixels)
    return { status: 'unsupported', reason: 'limit-exceeded' };
  return {
    status: 'valid',
    image: { mimeType, width, height, animated: false },
  };
};

// This reads dimensions for bounded decoding; validateContextFile checks full containers.
export const inspectImageHeader = (
  bytes: Uint8Array,
  mimeType?: string,
): ContextImageHeaderResult => {
  if (!(bytes instanceof Uint8Array))
    return { status: 'unreadable', reason: 'invalid-container' };
  if (bytes.byteLength > maxImageBytes)
    return { status: 'unsupported', reason: 'limit-exceeded' };
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let result: ContextImageHeaderResult;
  if (buffer.subarray(0, 8).equals(pngSignature))
    result = parsePngHeader(buffer);
  else if (buffer[0] === 0xff && buffer[1] === 0xd8)
    result = parseJpegHeader(buffer);
  else if (isBuffer(buffer, 0, 'RIFF')) result = parseWebpHeader(buffer);
  else return { status: 'unreadable', reason: 'invalid-container' };
  if (
    result.status === 'valid' &&
    mimeType &&
    mimeType !== result.image.mimeType &&
    mimeType !== 'application/octet-stream'
  )
    return { status: 'unsupported', reason: 'invalid-container' };
  return result;
};

const isZipSignature = (bytes: Buffer) =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08));

const imageMimeTypeForSignature = (
  bytes: Buffer,
): ContextImageMimeType | null => {
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (isBuffer(bytes, 0, 'RIFF') && isBuffer(bytes, 8, 'WEBP'))
    return 'image/webp';
  return null;
};

const inspectImageContainer = (
  bytes: Uint8Array,
  mimeType: ContextImageMimeType,
): ContextImageHeaderResult => {
  if (!(bytes instanceof Uint8Array))
    return { status: 'unreadable', reason: 'invalid-container' };
  if (bytes.byteLength > maxImageBytes)
    return { status: 'unsupported', reason: 'limit-exceeded' };
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (mimeType) {
    case 'image/png':
      return parsePng(buffer);
    case 'image/jpeg':
      return parseJpeg(buffer);
    case 'image/webp':
      return parseWebp(buffer);
  }
};

const hasForbiddenTextControls = (bytes: Uint8Array) => {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]!;
    if (
      (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
      byte === 0x7f
    )
      return true;
    if (
      byte === 0xc2 &&
      bytes[index + 1] !== undefined &&
      bytes[index + 1]! >= 0x80 &&
      bytes[index + 1]! <= 0x9f
    )
      return true;
  }
  return false;
};

export const validateContextFile = (
  input: ContextFileValidationInput,
): ContextFileValidationResult => {
  if (!input || typeof input !== 'object') return unsupported('mislabeled');
  const { fileName, contentType, bytes } = input;
  if (
    typeof fileName !== 'string' ||
    fileName.trim().length === 0 ||
    fileName.length > 255 ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    hasControlCharacters(fileName) ||
    (contentType !== undefined && typeof contentType !== 'string')
  )
    return unsupported('mislabeled');
  if (!(bytes instanceof Uint8Array)) return unreadable('invalid-container');
  if (bytes.byteLength > maxDocBytes) return unsupported('limit-exceeded');

  const extension = extensionOf(fileName);
  const declared = normalizedContentType(contentType);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (isBuffer(buffer, 0, '%PDF')) {
    if (!isBuffer(buffer, 0, '%PDF-')) return unreadable('invalid-container');
    if (extension !== 'pdf' || !hasMatchingType(declared, ['application/pdf']))
      return unsupported('mislabeled');
    // P05 performs full PDF parsing after this bounded signature check.
    return {
      status: 'valid',
      kind: 'pdf',
      mimeType: 'application/pdf',
      fileName,
      bytes,
    };
  }

  if (isZipSignature(buffer)) {
    if (
      extension !== 'docx' ||
      !hasMatchingType(declared, [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ])
    )
      return unsupported('mislabeled');
    const archive = inspectDocxArchive(bytes);
    if (archive.status !== 'valid')
      return archive.status === 'unsupported'
        ? unsupported(archive.reason)
        : unreadable('invalid-container');
    return {
      status: 'valid',
      kind: 'docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName,
      bytes,
    };
  }

  const imageMimeType = imageMimeTypeForSignature(buffer);
  if (imageMimeType) {
    const acceptedExtensions =
      imageMimeType === 'image/png'
        ? ['png']
        : imageMimeType === 'image/jpeg'
          ? ['jpg', 'jpeg']
          : ['webp'];
    if (
      !acceptedExtensions.includes(extension) ||
      !hasMatchingType(declared, [imageMimeType])
    )
      return unsupported('mislabeled');
    if (bytes.byteLength > maxImageBytes) return unsupported('limit-exceeded');

    const image = inspectImageContainer(bytes, imageMimeType);
    if (image.status === 'unsupported') {
      if (image.reason === 'animated-image')
        return unsupported('animated-image');
      if (image.reason === 'limit-exceeded')
        return unsupported('limit-exceeded');
      return unsupported('unsupported-format');
    }
    if (image.status === 'unreadable') return unreadable('invalid-container');
    return {
      status: 'valid',
      kind: 'image',
      mimeType: image.image.mimeType,
      imageMimeType: image.image.mimeType,
      fileName,
      bytes,
      width: image.image.width,
      height: image.image.height,
    };
  }

  if (isBuffer(buffer, 0, 'RIFF')) {
    if (extension === 'webp' || declared.startsWith('image/'))
      return unreadable('invalid-container');
    return unsupported('mislabeled');
  }

  if (
    ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ||
    declared.startsWith('image/')
  )
    return unreadable('invalid-container');
  if (
    extension === 'pdf' ||
    extension === 'docx' ||
    declared === 'application/pdf' ||
    declared ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return unreadable('invalid-container');

  if (['txt', 'md', 'markdown'].includes(extension)) {
    if (!hasMatchingType(declared, ['text/plain', 'text/markdown']))
      return unsupported('mislabeled');
    if (bytes.byteLength > maxTextBytes) return unsupported('limit-exceeded');
    try {
      if (hasForbiddenTextControls(bytes)) return unreadable('invalid-utf8');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return {
        status: 'valid',
        kind: 'text',
        mimeType: extension === 'txt' ? 'text/plain' : 'text/markdown',
        fileName,
        bytes,
        text,
      };
    } catch {
      return unreadable('invalid-utf8');
    }
  }
  if (bytes.byteLength === 0) return unreadable('invalid-container');
  return unsupported('unsupported-format');
};
