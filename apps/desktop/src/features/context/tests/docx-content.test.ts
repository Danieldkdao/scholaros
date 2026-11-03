import { Worker } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  extractDocxContent,
  inspectDocxArchive,
} from '../services/docx-content';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const zip = (entries: Array<[string, string]>) => {
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

const mutateCentralEntry = (
  input: Buffer,
  name: string,
  mutate: (
    archive: Buffer,
    entryOffset: number,
    localHeaderOffset: number,
  ) => void,
) => {
  const archive = Buffer.from(input);
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endOffset < 0) throw new Error('Missing ZIP end record.');
  let offset = archive.readUInt32LE(endOffset + 16);
  while (
    offset + 46 <= endOffset &&
    archive.readUInt32LE(offset) === 0x02014b50
  ) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const entryName = archive.toString(
      'utf8',
      offset + 46,
      offset + 46 + nameLength,
    );
    if (entryName === name) {
      mutate(archive, offset, archive.readUInt32LE(offset + 42));
      return archive;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing ZIP entry: ${name}`);
};

const createOutputText = (length: number) => {
  const bytes = Buffer.alloc(length);
  let state = 0x2f6e2b1;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = 97 + ((state >>> 0) % 26);
  }
  return bytes.toString('ascii');
};

const contentTypes =
  '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rootRelationships =
  '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const escapeXml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const documentXml = (paragraphs: string[]) =>
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((paragraph) => `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
const createDocxWithParagraphs = (
  paragraphs: string[],
  extra: Array<[string, string]> = [],
) =>
  zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRelationships],
    ['word/document.xml', documentXml(paragraphs)],
    ['word/_rels/document.xml.rels', '<Relationships/>'],
    ...extra,
  ]);
const createDocx = (text: string, extra: Array<[string, string]> = []) =>
  createDocxWithParagraphs([text], extra);

describe('DOCX content extraction', () => {
  it('extracts plain text and paragraph locators without producing HTML', async () => {
    const result = await extractDocxContent(
      createDocx('A <script>literal text</script>'),
    );

    expect(result.status).toBe('complete');
    expect(result.text).toContain('A <script>literal text</script>');
    expect(result.text).not.toContain('<p>');
    expect(result.locators).toEqual([{ kind: 'paragraph', ordinal: 1 }]);
    expect(result.uncertainty).toMatch(/formatting/i);
    expect(result.uncertainty).toMatch(/heading hierarchy/i);
  });

  it('preserves a separate locator for each source paragraph', async () => {
    const result = await extractDocxContent(
      createDocxWithParagraphs(['First paragraph', 'Second paragraph']),
    );

    expect(result.text).toContain('First paragraph');
    expect(result.text).toContain('Second paragraph');
    expect(result.locators).toEqual([
      { kind: 'paragraph', ordinal: 1 },
      { kind: 'paragraph', ordinal: 2 },
    ]);
  });

  it('rejects traversal, duplicate paths, external relationships and OLE parts', () => {
    const cases = [
      createDocx('text', [['../escape.xml', '<unsafe/>']]),
      createDocx('text', [['/absolute.xml', '<unsafe/>']]),
      createDocx('text', [['C:/absolute.xml', '<unsafe/>']]),
      createDocx('text', [['word/document.xml', documentXml(['second'])]]),
      createDocx('text', [['word/vbaProject.bin', 'macro']]),
      createDocx('text', [
        [
          'word/_rels/other.xml.rels',
          '<Relationships><Relationship Target="https://example.com/x" TargetMode="External"/></Relationships>',
        ],
      ]),
      createDocx('text', [['word/embeddings/oleObject1.bin', 'object']]),
    ];

    for (const bytes of cases)
      expect(inspectDocxArchive(bytes).status).not.toBe('valid');
  });

  it('rejects archives whose declared inflation exceeds the product ratio limit', () => {
    const bytes = createDocx('x'.repeat(20_000));

    expect(inspectDocxArchive(bytes)).toMatchObject({ status: 'unsupported' });
  });

  it('accepts 2,000 ZIP entries and rejects a 2,001st entry', () => {
    const entries = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => [`custom/part-${index}.xml`, 'x'] as [string, string],
      );

    expect(inspectDocxArchive(createDocx('text', entries(1_996))).status).toBe(
      'valid',
    );
    expect(
      inspectDocxArchive(createDocx('text', entries(1_997))),
    ).toMatchObject({ status: 'unsupported', reason: 'limit-exceeded' });
  });

  it('rejects declared inflated bytes above 50 MiB before reading entries', () => {
    const bytes = mutateCentralEntry(
      createDocx('text', [['custom/large.xml', 'x']]),
      'custom/large.xml',
      (archive, entryOffset) => {
        archive.writeUInt32LE(600_000, entryOffset + 20);
        archive.writeUInt32LE(50 * 1024 * 1024 + 1, entryOffset + 24);
      },
    );

    expect(inspectDocxArchive(bytes)).toMatchObject({
      status: 'unsupported',
      reason: 'limit-exceeded',
    });
  });

  it('rejects encrypted entries and ZIP64 size sentinels', () => {
    const encrypted = mutateCentralEntry(
      createDocx('text'),
      'word/document.xml',
      (archive, entryOffset, localHeaderOffset) => {
        archive.writeUInt16LE(
          archive.readUInt16LE(entryOffset + 8) | 1,
          entryOffset + 8,
        );
        archive.writeUInt16LE(
          archive.readUInt16LE(localHeaderOffset + 6) | 1,
          localHeaderOffset + 6,
        );
      },
    );
    const zip64 = mutateCentralEntry(
      createDocx('text'),
      'word/document.xml',
      (archive, entryOffset) =>
        archive.writeUInt32LE(0xffffffff, entryOffset + 24),
    );

    expect(inspectDocxArchive(encrypted)).toMatchObject({
      status: 'unsupported',
    });
    expect(inspectDocxArchive(zip64)).toMatchObject({
      status: 'unsupported',
    });
  });

  it('rejects external relationships with XML character-reference escapes', async () => {
    const bytes = createDocx('text', [
      [
        'word/_rels/other.xml.rels',
        '<Relationships><Relationship Target="https://example.invalid/" TargetMode="Exter&#x6e;al"/></Relationships>',
      ],
    ]);

    await expect(extractDocxContent(bytes)).resolves.toMatchObject({
      status: 'unsupported',
    });
  });

  it('rejects malformed ZIP and unsupported OOXML packages', () => {
    expect(inspectDocxArchive(Buffer.from('PK\x03\x04broken'))).toMatchObject({
      status: 'unreadable',
    });
    expect(
      inspectDocxArchive(
        zip([
          ['[Content_Types].xml', '<Types/>'],
          ['ppt/presentation.xml', '<p:presentation/>'],
        ]),
      ),
    ).toMatchObject({ status: 'unsupported' });
  });

  it('rejects an input above the 10 MiB document limit before spawning a worker', async () => {
    await expect(
      extractDocxContent(Buffer.alloc(10 * 1024 * 1024 + 1)),
    ).resolves.toMatchObject({ status: 'unsupported', text: '' });
  });

  it('bounds extracted output and marks truncation partial', async () => {
    const result = await extractDocxContent(
      createDocx(createOutputText(1_000_001)),
    );

    expect(result.status).toBe('partial');
    expect(result.text).toHaveLength(1_000_000);
  });

  it('terminates the worker when the extraction deadline expires', async () => {
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    try {
      const result = await extractDocxContent(
        createDocx(createOutputText(500_000)),
        { timeoutMs: 1 },
      );

      expect(result).toMatchObject({ status: 'unreadable', text: '' });
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      terminate.mockRestore();
    }
  });

  it('waits for worker termination before rejecting cancellation', async () => {
    const originalTerminate = Worker.prototype.terminate;
    let releaseTermination: () => void = () => {};
    const terminationBarrier = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let terminationStarted = false;
    const terminate = vi
      .spyOn(Worker.prototype, 'terminate')
      .mockImplementation(function (this: Worker) {
        terminationStarted = true;
        return originalTerminate.call(this).then(async (code) => {
          await terminationBarrier;
          return code;
        });
      });
    const controller = new AbortController();
    try {
      const pending = extractDocxContent(
        createDocx(createOutputText(500_000)),
        { signal: controller.signal },
      );
      let settled = false;
      const outcome = pending.then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(terminationStarted).toBe(true);
      expect(settled).toBe(false);
      releaseTermination();
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      expect(terminate).toHaveBeenCalledOnce();
      expect(settled).toBe(true);
    } finally {
      releaseTermination();
      terminate.mockRestore();
    }
  });

  it('honors cancellation and returns unreadable when the worker cannot parse the document', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractDocxContent(createDocx('cancelled'), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    await expect(
      extractDocxContent(Buffer.from('%PDF-not-docx')),
    ).resolves.toMatchObject({
      status: 'unreadable',
      text: '',
    });
  });
});
