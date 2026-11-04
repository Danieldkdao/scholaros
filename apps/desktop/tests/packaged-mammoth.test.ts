import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { stageRuntimePackage } from '../stage-runtime-package.mts';

const packaged = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getAppPath: () => packaged.root } }));

it('stages mammoth and its runtime dependencies for an isolated package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scholaros-mammoth-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{}');
    await stageRuntimePackage('mammoth', root);
    const packagedRequire = createRequire(path.join(root, 'package.json'));
    const mammoth = packagedRequire('mammoth');
    const Zip = packagedRequire('jszip');
    const zip = new Zip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      '_rels/.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Packaged document</w:t></w:r></w:p></w:body></w:document>',
    );
    zip.file('word/_rels/document.xml.rels', '<Relationships/>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const raw = await mammoth.extractRawText({ buffer });
    expect(raw.value).toContain('Packaged document');
    packaged.root = root;
    const { extractDocxContent } = await import(
      '../src/features/context/services/docx-content'
    );
    const result = await extractDocxContent(buffer);
    expect(result.status).toBe('complete');
    expect(result.text).toContain('Packaged document');
    expect(result.locators).toEqual([{ kind: 'paragraph', ordinal: 1 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
