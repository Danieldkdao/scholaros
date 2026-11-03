import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  contextFileLimits,
  inspectImageHeader,
  isContextFileBatchWithinLimits,
  validateContextFile,
  type ContextFileValidationInput,
} from '../services/file-validation';

const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const docxBytes = () => {
  const files = [
    [
      '[Content_Types].xml',
      '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    ['word/document.xml', '<w:document/>'],
  ] as const;
  const localRecords: Buffer[] = [];
  const directoryRecords: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name);
    const content = Buffer.from(text);
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
  const centralDirectory = Buffer.concat(directoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
};

const pngBytes = (width = 1, height = 1) => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

const jpegBytes = (width = 1, height = 1) =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);

const webpBytes = (width = 1, height = 1, animated = false) => {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes[20] = animated ? 0x02 : 0;
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
};

const validPngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const validJpegBytes = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
  'base64',
);
const validWebpBytes = Buffer.from(
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
  'base64',
);

describe('validateContextFile', () => {
  it.each([
    ['notes.txt', 'text/plain', Buffer.from('A short note', 'utf8'), 'text'],
    ['notes.md', 'text/markdown', Buffer.from('# Notes', 'utf8'), 'text'],
    ['reading.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n'), 'pdf'],
    [
      'reading.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      docxBytes(),
      'docx',
    ],
    ['photo.png', 'image/png', validPngBytes, 'image'],
    ['photo.jpeg', 'image/jpeg', validJpegBytes, 'image'],
    ['photo.webp', 'image/webp', validWebpBytes, 'image'],
  ])(
    'accepts bounded %s by its actual content',
    (fileName, contentType, bytes, kind) => {
      const result = validateContextFile({ fileName, contentType, bytes });

      expect(result.status).toBe('valid');
      if (result.status !== 'valid') throw new Error('Expected a valid file.');
      expect(result.kind).toBe(kind);
    },
  );

  it('rejects bytes whose actual type disagrees with the filename', () => {
    const result = validateContextFile({
      fileName: 'notes.jpg',
      contentType: 'image/jpeg',
      bytes: pngBytes(),
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'mislabeled',
    });
  });

  it('does not accept a ZIP presentation as a generic supported document', () => {
    const result = validateContextFile({
      fileName: 'slides.pptx',
      contentType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: Buffer.from('PK\x03\x04'),
    });

    expect(result).toMatchObject({ status: 'unsupported' });
  });

  it('rejects invalid UTF-8 and oversized text before decoding', () => {
    expect(
      validateContextFile({
        fileName: 'notes.txt',
        contentType: 'text/plain',
        bytes: Buffer.from([0xc3, 0x28]),
      }),
    ).toMatchObject({ status: 'unreadable', reason: 'invalid-utf8' });

    expect(
      validateContextFile({
        fileName: 'notes.txt',
        contentType: 'text/plain',
        bytes: Buffer.alloc(2 * 1024 * 1024 + 1),
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'limit-exceeded' });
  });

  it('accepts a valid empty text document as empty content', () => {
    expect(
      validateContextFile({
        fileName: 'empty.txt',
        contentType: 'text/plain',
        bytes: Buffer.alloc(0),
      }),
    ).toMatchObject({
      status: 'valid',
      kind: 'text',
      text: '',
    });
  });

  it('rejects non-positive and over-budget image dimensions', () => {
    expect(
      validateContextFile({
        fileName: 'photo.png',
        contentType: 'image/png',
        bytes: pngBytes(0, 1),
      }),
    ).toMatchObject({ status: 'unreadable' });

    expect(
      validateContextFile({
        fileName: 'photo.png',
        contentType: 'image/png',
        bytes: pngBytes(5000, 5000),
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'limit-exceeded' });
  });

  it('accepts exactly 20 megapixels at image header preflight', () => {
    expect(inspectImageHeader(pngBytes(5000, 4000))).toMatchObject({
      status: 'valid',
      image: { width: 5000, height: 4000 },
    });
  });

  it('rejects animated WebP rather than decoding unbounded frames', () => {
    expect(
      validateContextFile({
        fileName: 'animated.webp',
        contentType: 'image/webp',
        bytes: webpBytes(1, 1, true),
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'animated-image' });
  });

  it('rejects PDF bytes selected as plain text even when the header is UTF-8', () => {
    expect(
      validateContextFile({
        fileName: 'notes.txt',
        contentType: 'text/plain',
        bytes: Buffer.from('%PDF-1.7\\n'),
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'mislabeled' });
  });

  it.each([
    ['PNG', 'photo.png', 'image/png', pngBytes()],
    ['JPEG', 'photo.jpg', 'image/jpeg', jpegBytes()],
    ['WebP', 'photo.webp', 'image/webp', webpBytes()],
  ])(
    'rejects a truncated %s container',
    (_format, fileName, contentType, bytes) => {
      expect(
        validateContextFile({ fileName, contentType, bytes }),
      ).toMatchObject({
        status: 'unreadable',
        reason: 'invalid-container',
      });
    },
  );

  it('rejects invalid runtime selection metadata without throwing', () => {
    expect(() =>
      validateContextFile(null as unknown as ContextFileValidationInput),
    ).not.toThrow();
    expect(
      validateContextFile(null as unknown as ContextFileValidationInput),
    ).not.toMatchObject({ status: 'valid' });
  });

  it('exposes bounded per-file and aggregate intake limits', () => {
    const MiB = 1024 * 1024;

    expect(contextFileLimits).toMatchObject({
      documentBytes: 10 * MiB,
      textBytes: 2 * MiB,
      imageBytes: 8 * MiB,
      imagePixels: 20_000_000,
      batchBytes: 24 * MiB,
      batchFiles: 8,
    });
    expect(isContextFileBatchWithinLimits([10 * MiB, 10 * MiB, 4 * MiB])).toBe(
      true,
    );
    expect(
      isContextFileBatchWithinLimits([10 * MiB, 10 * MiB, 4 * MiB + 1]),
    ).toBe(false);
    expect(isContextFileBatchWithinLimits(Array(9).fill(0))).toBe(false);
    expect(isContextFileBatchWithinLimits([Number.NaN])).toBe(false);
    expect(isContextFileBatchWithinLimits([-1])).toBe(false);
    expect(isContextFileBatchWithinLimits([10 * MiB + 1])).toBe(false);
  });

  it('rejects oversized images before accepting their advertised dimensions', () => {
    const bytes = Buffer.concat([
      validPngBytes,
      Buffer.alloc(contextFileLimits.imageBytes + 1 - validPngBytes.length),
    ]);

    expect(
      validateContextFile({
        fileName: 'large.png',
        contentType: 'image/png',
        bytes,
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'limit-exceeded' });
  });

  it('accepts strict UTF-8 text exactly at its byte limit', () => {
    const bytes = Buffer.alloc(contextFileLimits.textBytes, 0x61);

    expect(
      validateContextFile({
        fileName: 'notes.txt',
        contentType: 'text/plain',
        bytes,
      }),
    ).toMatchObject({ status: 'valid', kind: 'text' });
  });

  it('enforces the 10 MiB original boundary for PDFs and DOCX', () => {
    const pdfBytes = Buffer.alloc(contextFileLimits.documentBytes, 0x20);
    Buffer.from('%PDF-1.7\\n').copy(pdfBytes);
    expect(
      validateContextFile({
        fileName: 'large.pdf',
        contentType: 'application/pdf',
        bytes: pdfBytes,
      }),
    ).toMatchObject({ status: 'valid', kind: 'pdf' });

    const oversizedPdf = Buffer.alloc(
      contextFileLimits.documentBytes + 1,
      0x20,
    );
    Buffer.from('%PDF-1.7\\n').copy(oversizedPdf);
    const oversizedDocx = Buffer.alloc(contextFileLimits.documentBytes + 1);
    Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(oversizedDocx);
    expect(
      validateContextFile({
        fileName: 'large.pdf',
        contentType: 'application/pdf',
        bytes: oversizedPdf,
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'limit-exceeded' });
    expect(
      validateContextFile({
        fileName: 'large.docx',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: oversizedDocx,
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'limit-exceeded' });
  });

  it.each([
    '../notes.txt',
    'C:\\notes.txt',
    `notes.txt${String.fromCharCode(0)}`,
  ])('rejects unsafe selected filename %s', (fileName) => {
    expect(
      validateContextFile({
        fileName,
        contentType: 'text/plain',
        bytes: Buffer.from('text'),
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'mislabeled' });
  });

  it('rejects a generic ZIP selected as supported text', () => {
    const emptyZip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(18),
    ]);

    expect(
      validateContextFile({
        fileName: 'archive.txt',
        contentType: 'text/plain',
        bytes: emptyZip,
      }),
    ).toMatchObject({ status: 'unsupported', reason: 'mislabeled' });
  });
});
