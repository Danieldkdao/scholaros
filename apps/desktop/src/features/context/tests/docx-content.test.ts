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

const contentTypes =
  '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rootRelationships =
  '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const documentXml = (text: string) =>
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</w:t></w:r></w:p></w:body></w:document>`;
const createDocx = (text: string, extra: Array<[string, string]> = []) =>
  zip([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRelationships],
    ['word/document.xml', documentXml(text)],
    ['word/_rels/document.xml.rels', '<Relationships/>'],
    ...extra,
  ]);

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
  });

  it('rejects traversal, duplicate paths, external relationships and OLE parts', () => {
    const cases = [
      createDocx('text', [['../escape.xml', '<unsafe/>']]),
      createDocx('text', [['word/document.xml', documentXml('second')]]),
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
