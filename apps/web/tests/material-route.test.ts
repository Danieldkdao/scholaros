import { describe, expect, it, vi } from 'vitest';
import { createLearningMaterialPostHandler } from '../src/app/api/learning/material/route';

const { authUser, webEnv, serviceEnv } = vi.hoisted(() => ({
  authUser: vi.fn(),
  webEnv: { BETTER_AUTH_URL: 'https://scholaros.example' },
  serviceEnv: {
    BETTER_AUTH_URL: 'https://scholaros.example',
    BETTER_AUTH_SECRET: 'x',
    INFERENCE_PROVIDER: 'meta',
    META_MODEL: 'muse-spark-1.3',
    META_API_KEY: 'x',
    BASETEN_MODEL: 'meta-models/muse-spark-open-1026',
    BASETEN_API_KEY: undefined,
  },
}));
vi.mock('@/lib/auth/helpers', () => ({ getCurrentUser: authUser }));
vi.mock('@/data/env/server', () => ({ serverEnv: webEnv }));
vi.mock('@scholaros/env/server', () => ({ serverEnv: serviceEnv }));

const trustedOrigin = 'https://scholaros.example';
const capabilities = {
  version: 1,
  configurationRevision: 'configuration-1',
  tutor: 'available',
  imageInterpretation: 'available',
  pdfInterpretation: 'available',
  liveDictation: 'unavailable',
  fileDictation: 'unavailable',
  limits: {
    inputTextCharacters: 8000,
    materialWireBytes: 24 * 1024 * 1024,
    pdfPagesPerOperation: 20,
    imagesPerOperation: 4,
    dictationDurationMs: 120_000,
  },
} as const;
const metadata = {
  version: 1,
  requestId: '2d6f6b84-ef17-4b64-9f5b-22af32083d84',
  kind: 'document-interpret',
} as const;
const interpretation = {
  status: 'partial',
  interpretedPages: [1],
  pages: [
    {
      page: 1,
      status: 'uncertain',
      text: '',
      uncertainty: 'Handwriting is not sufficiently legible.',
    },
  ],
};
const expectedResponse = {
  version: 1,
  requestId: metadata.requestId,
  configurationRevision: capabilities.configurationRevision,
  ...interpretation,
};
const imageBytes = (width = 32, height = 24) => {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([8, 2, 0, 0, 0], 24);
  return bytes;
};
const pdfBytes = (pageCount: number) => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(' ')}] >>\nendobj\n`,
    ...Array.from(
      { length: pageCount },
      (_, index) =>
        `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`,
    ),
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(new TextEncoder().encode(document).byteLength);
    document += object;
  }
  const xrefOffset = new TextEncoder().encode(document).byteLength;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(document);
};
const materialRequest = (
  files: Array<{ name: string; type: string; bytes: Uint8Array }> = [
    { name: 'handwriting.png', type: 'image/png', bytes: imageBytes() },
  ],
  options: {
    origin?: string;
    metadata?: unknown;
    headers?: HeadersInit;
    signal?: AbortSignal;
    text?: string;
  } = {},
) => {
  const form = new FormData();
  form.set('metadata', JSON.stringify(options.metadata ?? metadata));
  if (options.text !== undefined) form.set('text', options.text);
  for (const file of files) {
    const bytes = new Uint8Array(file.bytes.byteLength);
    bytes.set(file.bytes);
    form.append(
      'files',
      new Blob([bytes.buffer], { type: file.type }),
      file.name,
    );
  }
  return new Request(`${trustedOrigin}/api/learning/material`, {
    method: 'POST',
    headers: {
      ...(options.origin === undefined
        ? { origin: trustedOrigin }
        : { origin: options.origin }),
      ...options.headers,
    },
    body: form,
    ...(options.signal ? { signal: options.signal } : {}),
  });
};
const createPostHandler = (overrides: Record<string, unknown> = {}) => {
  const dependencies = {
    getCurrentUser: vi.fn().mockResolvedValue({ userId: 'account-1' }),
    trustedOrigin,
    getCapabilities: vi.fn().mockResolvedValue(capabilities),
    interpretDocument: vi.fn().mockResolvedValue(interpretation),
    now: vi.fn(() => 1_000_000),
    ...overrides,
  };
  return {
    handler: createLearningMaterialPostHandler(dependencies as never),
    dependencies,
  };
};

describe('POST /api/learning/material', () => {
  it('authenticates and validates source bytes before bounded Meta interpretation', async () => {
    const { handler, dependencies } = createPostHandler();
    const response = await handler(materialRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(expectedResponse);
    expect(dependencies.interpretDocument).toHaveBeenCalledOnce();
    expect(dependencies.interpretDocument.mock.calls[0][0]).toMatchObject({
      userId: 'account-1',
      requestId: metadata.requestId,
      pageNumbers: [1],
    });
  });

  it('rejects wrong-origin and unauthenticated requests before inference', async () => {
    const { handler, dependencies } = createPostHandler();

    expect(
      (await handler(materialRequest([], { origin: 'https://evil.example' })))
        .status,
    ).toBe(403);
    dependencies.getCurrentUser.mockResolvedValueOnce(null);
    expect((await handler(materialRequest())).status).toBe(401);
    expect(dependencies.interpretDocument).not.toHaveBeenCalled();
  });

  it('returns a safe cancellation response before parsing an aborted upload', async () => {
    const controller = new AbortController();
    controller.abort();
    const { handler, dependencies } = createPostHandler();
    const response = await handler(
      materialRequest([], {
        text: 'Parsed document text.',
        signal: controller.signal,
      }),
    );

    expect(response.status).toBe(408);
    expect(dependencies.interpretDocument).not.toHaveBeenCalled();
  });

  it('rejects a MIME/signature mismatch and unsupported formats', async () => {
    const { handler, dependencies } = createPostHandler();

    expect(
      (
        await handler(
          materialRequest([
            {
              name: 'scan.png',
              type: 'image/png',
              bytes: new Uint8Array([1, 2, 3]),
            },
          ]),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await handler(
          materialRequest([
            {
              name: 'slides.pptx',
              type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              bytes: new Uint8Array([80, 75, 3, 4]),
            },
          ]),
        )
      ).status,
    ).toBe(415);
    expect(dependencies.interpretDocument).not.toHaveBeenCalled();
  });

  it('rejects image pixel dimensions above the decoded image budget', async () => {
    const { handler, dependencies } = createPostHandler();
    const response = await handler(
      materialRequest([
        { name: 'large.png', type: 'image/png', bytes: imageBytes(5000, 5000) },
      ]),
    );

    expect(response.status).toBe(413);
    expect(dependencies.interpretDocument).not.toHaveBeenCalled();
  });

  it('enforces the streamed wire cap and rejects arbitrary URL fetch fields', async () => {
    const { handler, dependencies } = createPostHandler();
    const tooLarge = new Request(`${trustedOrigin}/api/learning/material`, {
      method: 'POST',
      headers: {
        origin: trustedOrigin,
        'content-type': 'multipart/form-data; boundary=test',
        'content-length': String(24 * 1024 * 1024 + 1),
      },
      body: new Uint8Array(),
    });
    expect((await handler(tooLarge)).status).toBe(413);
    expect(
      (
        await handler(
          materialRequest([], {
            metadata: {
              ...metadata,
              url: 'https://attacker.example/private.pdf',
            },
          }),
        )
      ).status,
    ).toBe(400);
    expect(dependencies.interpretDocument).not.toHaveBeenCalled();
  });

  it('returns partial per-page uncertainty without manufacturing extracted text', async () => {
    const { handler } = createPostHandler();
    const response = await handler(materialRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'partial',
      interpretedPages: [1],
      pages: [
        {
          page: 1,
          status: 'uncertain',
          text: '',
          uncertainty: expect.any(String),
        },
      ],
    });
  });

  it('fails closed when the selected model lacks image/PDF capability', async () => {
    const { handler, dependencies } = createPostHandler({
      getCapabilities: vi.fn().mockResolvedValue({
        ...capabilities,
        imageInterpretation: 'unavailable',
      }),
    });

    const response = await handler(materialRequest());

    expect(response.status).toBe(503);
    expect(dependencies.interpretDocument).not.toHaveBeenCalled();
  });

  it('rejects a PDF whose actual page count exceeds the operation limit', async () => {
    const { handler, dependencies } = createPostHandler();
    const response = await handler(
      materialRequest([
        { name: 'scan.pdf', type: 'application/pdf', bytes: pdfBytes(21) },
      ]),
    );

    expect(response.status).toBe(413);
    expect(dependencies.interpretDocument).not.toHaveBeenCalled();
  });

  it('accepts DOCX-derived local text without sending a native DOCX file', async () => {
    const interpretDocument = vi.fn().mockResolvedValue({
      status: 'complete',
      interpretedPages: [1],
      pages: [
        {
          page: 1,
          status: 'readable',
          text: 'Parsed document text.',
          uncertainty: null,
        },
      ],
    });
    const { handler, dependencies } = createPostHandler({ interpretDocument });
    const response = await handler(
      materialRequest([], { text: 'Parsed document text.' }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.interpretDocument.mock.calls[0][0]).toMatchObject({
      files: [],
      text: 'Parsed document text.',
      pageNumbers: [1],
    });
  });

  it('reports partial when locally parsed text is capped before interpretation', async () => {
    const interpretDocument = vi.fn().mockResolvedValue({
      status: 'complete',
      interpretedPages: [1],
      pages: [
        {
          page: 1,
          status: 'readable',
          text: 'Bounded summary.',
          uncertainty: null,
        },
      ],
    });
    const { handler, dependencies } = createPostHandler({ interpretDocument });
    const response = await handler(
      materialRequest([], { text: 'x'.repeat(30_000) }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('partial');
    expect(dependencies.interpretDocument.mock.calls[0][0].text).toHaveLength(
      24_000,
    );
  });

  it('sanitizes provider failures and does not expose raw document or model errors', async () => {
    const { handler } = createPostHandler({
      interpretDocument: vi
        .fn()
        .mockRejectedValue(new Error('PRIVATE_DOCUMENT_AND_PROVIDER_DATA')),
    });
    const response = await handler(materialRequest());

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(
      'PRIVATE_DOCUMENT_AND_PROVIDER_DATA',
    );
  });
});
