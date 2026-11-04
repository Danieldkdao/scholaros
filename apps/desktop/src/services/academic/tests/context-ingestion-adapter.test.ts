import { createCanvas } from '@napi-rs/canvas';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type {
  AuthorizedContext,
  AuthorizedRegistrar,
  LearningPublicMethod,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import type { ContextImageDecoder } from '../../../features/context/services/image-content';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const electronState = vi.hoisted(() => ({ userData: '', netFetch: vi.fn() }));

vi.mock('electron', () => {
  electronState.userData = mkdtempSync(
    path.join(tmpdir(), 'scholaros-ingestion-adapter-'),
  );
  return {
    app: {
      getPath: () => electronState.userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
      on: vi.fn(),
    },
    net: { fetch: electronState.netFetch },
  };
});

vi.mock('../../../lib/auth/client', () => ({
  authClient: { getCookie: () => 'test-account-cookie' },
}));
vi.mock('../../../lib/auth/main', () => ({
  isAccountSessionCurrent: () => true,
}));
vi.mock('../../../data/env/client', () => ({
  clientEnv: { VITE_API_URL: 'https://scholaros.test' },
}));

const { db } = await import('../../../db');
const {
  ContextChunkTable,
  ContextItemTable,
  ContextLinkTable,
  ContextVersionTable,
  CourseMaterialChunkTable,
  CourseMaterialTable,
  CourseTable,
  StudyMessageTable,
  StudySessionTable,
  StudySourceReferenceTable,
} = await import('../../../db/schema');
const {
  readContextIngestionItem,
  readContextIngestionVersion,
  updateContextItem,
} = await import('../../../features/context/services/library-store');
const { createOriginalStore, readContextOriginal } =
  await import('../../../features/context/services/original-store');
const { createContextIngestionHost } =
  await import('../context-ingestion-adapter');

const userId = 'context-adapter-student';
const courseId = 'context-adapter-course';
const sessionId = 'context-adapter-session';
const currentTime = '2026-11-03T12:00:00.000Z';
const createPdf = (pages: string[]) => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages
      .map((_, index) => `${4 + index * 2} 0 R`)
      .join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of pages.entries()) {
    const contentId = 5 + index * 2;
    const backslash = String.fromCharCode(92);
    const escaped = text
      .split(backslash)
      .join(`${backslash}${backslash}`)
      .replaceAll('(', `${backslash}(`)
      .replaceAll(')', `${backslash})`);
    const stream = `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  }
  const newline = String.fromCharCode(10);
  let pdf = `%PDF-1.4${newline}`;
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj${newline}${object}${newline}endobj${newline}`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref${newline}0 ${objects.length + 1}${newline}0000000000 65535 f ${newline}`;
  for (const offset of offsets.slice(1))
    pdf += `${String(offset).padStart(10, '0')} 00000 n ${newline}`;
  pdf += `trailer${newline}<< /Size ${objects.length + 1} /Root 1 0 R >>${newline}startxref${newline}${xrefOffset}${newline}%%EOF`;
  return new TextEncoder().encode(pdf);
};
const createImageBytes = async () => {
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = '#d71920';
  context.fillRect(0, 0, 2, 2);
  return new Uint8Array(await canvas.encode('png'));
};
const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const createZip = (entries: Array<[string, string]>) => {
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
const createDocx = (text: string) =>
  createZip([
    [
      '[Content_Types].xml',
      '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ],
  ]);
const createMaterialResponse = (formData: FormData, text: string) => {
  const metadata = JSON.parse(String(formData.get('metadata'))) as {
    requestId: string;
    pageNumbers?: number[];
  };
  const page = metadata.pageNumbers?.[0] ?? 1;
  return Response.json({
    version: 1,
    requestId: metadata.requestId,
    configurationRevision: 'test-meta-revision',
    status: 'complete',
    interpretedPages: [page],
    pages: [{ page, status: 'readable', text, uncertainty: null }],
  });
};
const testDirectories: string[] = [];
let activeHost: ReturnType<typeof createContextIngestionHost> | null = null;
let activeCleanup: (() => Promise<void>) | null = null;

type ActionHandler = (
  context: AuthorizedContext,
  input: unknown,
) => Promise<unknown>;

type TestRegistrar = {
  registrar: AuthorizedRegistrar;
  handlers: Map<string, ActionHandler>;
  events: ProductEventV1[];
  waitForEvent: (
    predicate: (event: ProductEventV1) => boolean,
  ) => Promise<ProductEventV1>;
};

const createTestRegistrar = (): TestRegistrar => {
  const handlers = new Map<string, ActionHandler>();
  const events: ProductEventV1[] = [];
  const listeners = new Set<(event: ProductEventV1) => void>();
  const lifecycleController = new AbortController();
  const registrar = {
    handle: (name: LearningPublicMethod, handler: ActionHandler) => {
      handlers.set(name, handler);
    },
    publish: (event: ProductEventV1) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
    lifecycle: {
      signal: lifecycleController.signal,
      epoch: 1,
      isCurrent: (epoch: number) => epoch === 1,
      now: () => Date.now(),
      registerOperation: () => () => {},
      onTeardown: () => {},
    },
  } as unknown as AuthorizedRegistrar;
  return {
    registrar,
    handlers,
    events,
    waitForEvent: (predicate) => {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error('Timed out waiting for an ingestion event.'));
        }, 5_000);
        const listener = (event: ProductEventV1) => {
          if (!predicate(event)) return;
          clearTimeout(timeout);
          listeners.delete(listener);
          resolve(event);
        };
        listeners.add(listener);
      });
    },
  };
};

const createAuthorizedContext = (): AuthorizedContext => ({
  userId,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const createSelectionDirectory = async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'scholaros-selected-context-files-'),
  );
  testDirectories.push(directory);
  return directory;
};

const insertCourse = () =>
  db
    .insert(CourseTable)
    .values({
      id: courseId,
      userId,
      connectionId: null,
      sourceKey: `manual-${courseId}`,
      sourceName: 'Manual',
      sourceHost: 'local',
      externalId: null,
      name: 'Adapter course',
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: 'https://example.edu/course',
      firstSeenAt: currentTime,
      lastSeenAt: currentTime,
      contentChangedAt: null,
      overviewSyncedAt: null,
      announcementsSyncedAt: null,
      assignmentsSyncedAt: null,
    })
    .run();

const insertSession = () =>
  db
    .insert(StudySessionTable)
    .values({
      id: sessionId,
      userId,
      courseId,
      title: 'Adapter session',
      activity: 'understand-topic',
      targetAssignmentId: null,
      topic: null,
      status: 'saved',
      revision: 0,
      generationEpoch: 0,
      draftText: '',
      draftRevision: 0,
      deadlineAt: null,
      timerRevision: 0,
      expiredRevision: null,
      resolvedExpiredRevision: null,
      finishedAt: null,
      deletedAt: null,
      createdAt: currentTime,
      updatedAt: currentTime,
      lastOpenedAt: currentTime,
    })
    .run();

const startHost = (
  options: Parameters<typeof createContextIngestionHost>[0] = {},
) => {
  const host = createContextIngestionHost(options);
  activeHost = host;
  const testRegistrar = createTestRegistrar();
  activeCleanup = host.registerContextIngestionActions(testRegistrar.registrar);
  return { host, ...testRegistrar };
};

const callAction = (
  handlers: Map<string, ActionHandler>,
  context: AuthorizedContext,
  method: string,
  input: unknown,
) => {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`Missing test action registration: ${method}`);
  return handler(context, input);
};

beforeEach(async () => {
  electronState.netFetch.mockReset();
  db.delete(StudySourceReferenceTable).run();
  db.delete(StudyMessageTable).run();
  db.delete(ContextChunkTable).run();
  db.delete(ContextLinkTable).run();
  db.delete(ContextVersionTable).run();
  db.delete(ContextItemTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseMaterialChunkTable).run();
  db.delete(CourseMaterialTable).run();
  db.delete(CourseTable).run();
  await rm(path.join(electronState.userData, 'context-originals'), {
    recursive: true,
    force: true,
  });
  insertCourse();
  insertSession();
});

afterEach(async () => {
  await activeCleanup?.();
  await activeHost?.dispose();
  activeCleanup = null;
  activeHost = null;
  await Promise.all(
    testDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  db.$client.close();
  await rm(electronState.userData, { recursive: true, force: true });
});

describe('production Context ingestion host', () => {
  it('registers a selected text file through the real P08 store and P09 service without returning paths or tickets', async () => {
    const { host, waitForEvent } = startHost({ imageDecoder: null });
    const context = createAuthorizedContext();
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'lecture-notes.txt');
    await writeFile(filePath, 'Cell membranes regulate transport.');

    const registered = await host.registerSelectedContextFiles(context, {
      filePaths: [filePath],
      sessionId,
      courseId,
      saveToLibrary: false,
    });

    expect(registered.items).toHaveLength(1);
    const upload = registered.items[0]!;
    expect(upload).toMatchObject({
      itemId: expect.any(String),
      operationId: expect.any(String),
      status: 'queued',
    });
    expect(Object.keys(upload).sort()).toEqual([
      'itemId',
      'operationId',
      'status',
    ]);
    expect(JSON.stringify(registered)).not.toContain(filePath);
    expect(JSON.stringify(registered)).not.toContain('ticketId');

    await waitForEvent(
      (event) =>
        event.targetId === upload.itemId && event.outcome === 'completed',
    );
    const item = readContextIngestionItem(context, {
      itemId: upload.itemId,
      sessionId,
      courseId,
    });
    const version = item?.currentVersionId
      ? readContextIngestionVersion(context, {
          itemId: upload.itemId,
          versionId: item.currentVersionId,
        })
      : null;

    expect(item).toMatchObject({ status: 'complete', usable: true });
    expect(version).toMatchObject({
      itemId: upload.itemId,
      mimeType: 'text/plain',
      extractedText: 'Cell membranes regulate transport.',
    });
    expect(version?.attemptId).toBe(upload.operationId);
    expect(
      await readContextOriginal(userId, version!.originalStorageKey!),
    ).toEqual(Buffer.from('Cell membranes regulate transport.'));
  });

  it('persists an empty UTF-8 document as a successful non-searchable version', async () => {
    const { host, waitForEvent, handlers } = startHost({ imageDecoder: null });
    const context = createAuthorizedContext();
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'empty.txt');
    await writeFile(filePath, Buffer.alloc(0));

    const registered = await host.registerSelectedContextFiles(context, {
      filePaths: [filePath],
      saveToLibrary: true,
    });
    const upload = registered.items[0]!;
    await waitForEvent(
      (event) =>
        event.targetId === upload.itemId && event.outcome === 'completed',
    );

    const item = readContextIngestionItem(context, { itemId: upload.itemId });
    const version = item?.currentVersionId
      ? readContextIngestionVersion(context, {
          itemId: upload.itemId,
          versionId: item.currentVersionId,
        })
      : null;
    const preview = await callAction(handlers, context, 'readContextPreview', {
      itemId: upload.itemId,
    });

    expect(item).toMatchObject({ status: 'complete', usable: false });
    expect(version).toMatchObject({
      extractionStatus: 'complete',
      extractedText: '',
    });
    expect(
      db
        .select()
        .from(ContextChunkTable)
        .all()
        .filter((chunk) => chunk.itemId === upload.itemId),
    ).toHaveLength(0);
    expect(preview).toMatchObject({ kind: 'text', text: '', partial: false });
  });

  it('extracts a DOCX through the production worker and stores the version', async () => {
    const { host, waitForEvent } = startHost({ imageDecoder: null });
    const context = createAuthorizedContext();
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'course-notes.docx');
    await writeFile(
      filePath,
      createDocx('Mitochondria produce cellular energy.'),
    );

    const registered = await host.registerSelectedContextFiles(context, {
      filePaths: [filePath],
      sessionId,
      courseId,
      saveToLibrary: false,
    });
    const upload = registered.items[0]!;
    await waitForEvent(
      (event) =>
        event.targetId === upload.itemId && event.outcome === 'completed',
    );
    const item = readContextIngestionItem(context, {
      itemId: upload.itemId,
      sessionId,
      courseId,
    });

    expect(item?.currentVersionId).toBeTruthy();
    expect(
      readContextIngestionVersion(context, {
        itemId: upload.itemId,
        versionId: item!.currentVersionId!,
      }),
    ).toMatchObject({
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(
      readContextIngestionVersion(context, {
        itemId: upload.itemId,
        versionId: item!.currentVersionId!,
      })?.extractedText?.trim(),
    ).toBe('Mitochondria produce cellular energy.');
  }, 15_000);

  it('removes originals for unreadable PDFs that never create a version checkpoint', async () => {
    const { host } = startHost({ imageDecoder: null });
    const context = createAuthorizedContext();
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'corrupt.pdf');
    await writeFile(filePath, '%PDF-1.4\\nnot a valid document');
    const registered = await host.registerSelectedContextFiles(context, {
      filePaths: [filePath],
      saveToLibrary: true,
    });
    const upload = registered.items[0]!;
    await host.whenIdle();

    const item = readContextIngestionItem(context, { itemId: upload.itemId });
    const versions = db
      .select()
      .from(ContextVersionTable)
      .all()
      .filter((version) => version.itemId === upload.itemId);
    const originals = await createOriginalStore({
      rootDirectory: path.join(electronState.userData, 'context-originals'),
    }).list(userId);

    expect(item?.status).toBe('unreadable');
    expect(versions).toHaveLength(0);
    expect(originals).toHaveLength(0);
  }, 15_000);

  it('decodes an image and posts only the bounded Meta payload to the authenticated material route', async () => {
    const imageDecoder: ContextImageDecoder = async ({
      bytes,
      mimeType,
      width,
      height,
    }) => ({
      mimeType,
      bytes,
      previewBytes: bytes,
      width,
      height,
      previewWidth: width,
      previewHeight: height,
      metadataStripped: true,
    });
    const { host, waitForEvent } = startHost({ imageDecoder });
    const context = createAuthorizedContext();
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'lecture-slide.png');
    const bytes = await createImageBytes();
    await writeFile(filePath, bytes);
    electronState.netFetch.mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://scholaros.test/api/learning/material');
      const request = init as RequestInit;
      expect(request.method).toBe('POST');
      expect(request.credentials).toBe('omit');
      expect(request.redirect).toBe('error');
      expect(new Headers(request.headers).get('cookie')).toBe(
        'test-account-cookie',
      );
      const formData = request.body as FormData;
      expect(JSON.parse(String(formData.get('metadata')))).toMatchObject({
        version: 1,
        kind: 'document-interpret',
        pageNumbers: [1],
      });
      expect((formData.get('files') as File).type).toBe('image/png');
      return createMaterialResponse(
        formData,
        'The slide describes photosynthesis.',
      );
    });

    const registered = await host.registerSelectedContextFiles(context, {
      filePaths: [filePath],
      saveToLibrary: true,
    });
    const upload = registered.items[0]!;
    await waitForEvent(
      (event) =>
        event.targetId === upload.itemId && event.outcome === 'completed',
    );
    const item = readContextIngestionItem(context, { itemId: upload.itemId });
    const version = item?.currentVersionId
      ? readContextIngestionVersion(context, {
          itemId: upload.itemId,
          versionId: item.currentVersionId,
        })
      : null;

    expect(electronState.netFetch).toHaveBeenCalledTimes(1);
    expect(version).toMatchObject({
      mimeType: 'image/png',
      extractedText: 'The slide describes photosynthesis.',
      extractionStatus: 'complete',
    });
  }, 15_000);

  it('retries a scanned PDF after host recreation from its persisted original and deduplicates the durable attempt id', async () => {
    let shouldFail = true;
    electronState.netFetch.mockImplementation(async (_url, init) => {
      if (shouldFail)
        return Response.json(
          { error: { code: 'provider-failed', message: 'Temporary failure.' } },
          { status: 502 },
        );
      return createMaterialResponse(
        (init as RequestInit).body as FormData,
        'The scanned page explains osmosis.',
      );
    });
    const firstHost = startHost({ imageDecoder: null });
    const context = createAuthorizedContext();
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'scanned-lab.pdf');
    const pdfBytes = createPdf(['']);
    await writeFile(filePath, pdfBytes);

    const registered = await firstHost.host.registerSelectedContextFiles(
      context,
      {
        filePaths: [filePath],
        sessionId,
        courseId,
        saveToLibrary: false,
      },
    );
    const upload = registered.items[0]!;
    await firstHost.waitForEvent(
      (event) => event.targetId === upload.itemId && event.outcome === 'failed',
    );
    const itemAfterFirstAttempt = readContextIngestionItem(context, {
      itemId: upload.itemId,
      sessionId,
      courseId,
    });
    const rawCheckpoint = readContextIngestionVersion(context, {
      itemId: upload.itemId,
    });
    expect(itemAfterFirstAttempt?.currentVersionId).toBeNull();
    expect(rawCheckpoint).toMatchObject({
      extractionStatus: 'partial',
      extractedText: null,
      mimeType: 'application/pdf',
    });
    expect(
      await readContextOriginal(
        userId,
        rawCheckpoint!.originalStorageKey!,
        rawCheckpoint!.originalHash,
      ),
    ).toEqual(Buffer.from(pdfBytes));

    await (activeCleanup as (() => Promise<void>) | null)?.();
    await firstHost.host.dispose();
    activeCleanup = null;
    activeHost = null;
    shouldFail = false;
    const secondHost = startHost({ imageDecoder: null });
    const requestId = randomUUID();
    const retryInput = { itemId: upload.itemId, requestId };
    const [firstRetry, duplicateRetry] = await Promise.all([
      callAction(
        secondHost.handlers,
        context,
        'retryContextIngestion',
        retryInput,
      ),
      callAction(
        secondHost.handlers,
        context,
        'retryContextIngestion',
        retryInput,
      ),
    ]);
    expect(firstRetry).toEqual(duplicateRetry);
    expect(firstRetry).toMatchObject({ operationId: requestId });
    await secondHost.waitForEvent(
      (event) =>
        event.targetId === upload.itemId && event.outcome === 'completed',
    );

    const completedItem = readContextIngestionItem(context, {
      itemId: upload.itemId,
      sessionId,
      courseId,
    });
    const finalVersion = completedItem?.currentVersionId
      ? readContextIngestionVersion(context, {
          itemId: upload.itemId,
          versionId: completedItem.currentVersionId,
        })
      : null;
    const persistedRetry = readContextIngestionVersion(context, {
      itemId: upload.itemId,
      attemptId: requestId,
    });
    const persistedVersions = db
      .select()
      .from(ContextVersionTable)
      .all()
      .filter((version) => version.itemId === upload.itemId);

    expect(finalVersion).toMatchObject({
      extractionStatus: 'complete',
      extractedText: 'The scanned page explains osmosis.',
    });
    expect(persistedRetry).toMatchObject({
      attemptId: requestId,
      extractionStatus: 'partial',
      extractedText: null,
    });
    expect(persistedVersions).toHaveLength(3);

    await (activeCleanup as (() => Promise<void>) | null)?.();
    await secondHost.host.dispose();
    activeCleanup = null;
    activeHost = null;
    const thirdHost = startHost({ imageDecoder: null });
    await expect(
      callAction(
        thirdHost.handlers,
        context,
        'retryContextIngestion',
        retryInput,
      ),
    ).resolves.toMatchObject({ operationId: requestId });
    expect(
      db
        .select()
        .from(ContextVersionTable)
        .all()
        .filter((version) => version.itemId === upload.itemId),
    ).toHaveLength(3);
  }, 20_000);

  it('cancels an in-flight production interpretation and settles persisted status', async () => {
    electronState.netFetch.mockImplementation(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled.', 'AbortError')),
            { once: true },
          );
        }),
    );
    const { host, handlers } = startHost({ imageDecoder: null });
    const context = createAuthorizedContext();
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'cancelled-scan.pdf');
    await writeFile(filePath, createPdf(['']));
    const registered = await host.registerSelectedContextFiles(context, {
      filePaths: [filePath],
      sessionId,
      courseId,
      saveToLibrary: false,
    });
    const upload = registered.items[0]!;

    await vi.waitFor(() => expect(electronState.netFetch).toHaveBeenCalled());
    await callAction(handlers, context, 'cancelContextIngestion', {
      operationId: upload.operationId,
    });

    const item = readContextIngestionItem(context, {
      itemId: upload.itemId,
      sessionId,
      courseId,
    });
    const versions = db
      .select()
      .from(ContextVersionTable)
      .all()
      .filter((version) => version.itemId === upload.itemId);
    expect(item?.status).toBe('cancelled');
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      extractionStatus: 'partial',
      extractedText: null,
    });
  }, 15_000);

  it('does not commit a late Meta result after the selected session is invalidated', async () => {
    const requestControl: { resolve: (response: Response) => void } = {
      resolve: () => {
        throw new Error('The material request has not started.');
      },
    };
    electronState.netFetch.mockImplementation(
      (_url: unknown, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          requestControl.resolve = resolve;
        }),
    );
    const lifecycle = new AbortController();
    let current = true;
    const context = {
      ...createAuthorizedContext(),
      isCurrent: () => current,
      signal: lifecycle.signal,
    };
    const { host } = startHost({ imageDecoder: null });
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'session-switch-scan.pdf');
    await writeFile(filePath, createPdf(['']));
    const registered = await host.registerSelectedContextFiles(context, {
      filePaths: [filePath],
      sessionId,
      courseId,
      saveToLibrary: false,
    });
    const upload = registered.items[0]!;

    await vi.waitFor(() => expect(electronState.netFetch).toHaveBeenCalled());
    current = false;
    lifecycle.abort();
    requestControl.resolve(
      createMaterialResponse(
        electronState.netFetch.mock.calls[0]![1].body as FormData,
        'This late interpretation must not be committed.',
      ),
    );
    await host.whenIdle();

    const persistedItem = db
      .select()
      .from(ContextItemTable)
      .all()
      .find((item) => item.id === upload.itemId);
    const versions = db
      .select()
      .from(ContextVersionTable)
      .all()
      .filter((version) => version.itemId === upload.itemId);
    expect(persistedItem?.currentVersionId).toBeNull();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.extractedText).toBeNull();
  }, 15_000);

  it('rejects a late interpretation after an external item revision changes', async () => {
    const requestControl: { resolve: (response: Response) => void } = {
      resolve: () => {
        throw new Error('The material request has not started.');
      },
    };
    electronState.netFetch.mockImplementation(
      (_url: unknown, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          requestControl.resolve = resolve;
        }),
    );
    const { host } = startHost({ imageDecoder: null });
    const context = createAuthorizedContext();
    const directory = await createSelectionDirectory();
    const filePath = path.join(directory, 'edited-scan.pdf');
    await writeFile(filePath, createPdf(['']));
    const registered = await host.registerSelectedContextFiles(context, {
      filePaths: [filePath],
      sessionId,
      courseId,
      saveToLibrary: false,
    });
    const upload = registered.items[0]!;

    await vi.waitFor(() => expect(electronState.netFetch).toHaveBeenCalled());
    const currentItem = readContextIngestionItem(context, {
      itemId: upload.itemId,
      sessionId,
      courseId,
    });
    expect(currentItem).not.toBeNull();
    await updateContextItem(context, {
      itemId: upload.itemId,
      expectedRevision: currentItem!.revision,
      title: 'Edited while interpretation was running',
    });
    const request = electronState.netFetch.mock.calls[0]![1] as RequestInit;
    requestControl.resolve(
      createMaterialResponse(
        request.body as FormData,
        'A stale result must not replace the current item revision.',
      ),
    );
    await host.whenIdle();

    const persistedItem = readContextIngestionItem(context, {
      itemId: upload.itemId,
      sessionId,
      courseId,
    });
    const versions = db
      .select()
      .from(ContextVersionTable)
      .all()
      .filter((version) => version.itemId === upload.itemId);
    expect(persistedItem).toMatchObject({
      title: 'Edited while interpretation was running',
      currentVersionId: null,
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.extractedText).toBeNull();
  }, 15_000);
});
