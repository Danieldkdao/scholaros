import { describe, expect, it, vi } from 'vitest';
import {
  createUtilityProcessImageDecoder,
  inspectContextImage,
  prepareContextImage,
  type ContextImageDecodeResult,
  type ContextImageDecoder,
} from '../services/image-content';

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

const createUtilityProcess = (response?: unknown) => {
  const listeners = new Map<string, ((value: unknown) => void)[]>();
  let request: unknown;
  let killCount = 0;
  let exited = false;
  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const child = {
    on: (event: string, listener: (value: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return child;
    },
    postMessage: (message: unknown) => {
      request = message;
      if (response !== undefined)
        queueMicrotask(() => emit('message', response));
    },
    kill: () => {
      killCount += 1;
      queueMicrotask(() => {
        exited = true;
        emit('exit', 0);
      });
      return true;
    },
  };
  const fork = vi.fn(() => child);
  return {
    utilityProcess: { fork },
    fork,
    get request() {
      return request;
    },
    get killCount() {
      return killCount;
    },
    get exited() {
      return exited;
    },
  };
};

const decodedPng = (): ContextImageDecodeResult => ({
  mimeType: 'image/png',
  bytes: pngBytes(),
  previewBytes: pngBytes(),
  width: 1,
  height: 1,
  previewWidth: 1,
  previewHeight: 1,
  metadataStripped: true,
});

describe('context image preparation', () => {
  it.each([
    [pngBytes(), 'image/png'],
    [jpegBytes(), 'image/jpeg'],
    [webpBytes(), 'image/webp'],
  ])('reads real dimensions for %s', (bytes, mimeType) => {
    expect(inspectContextImage(bytes, mimeType)).toMatchObject({
      status: 'valid',
      width: 1,
      height: 1,
    });
  });

  it('rejects animated, invalid, and over-budget images before decode', () => {
    expect(
      inspectContextImage(webpBytes(1, 1, true), 'image/webp'),
    ).toMatchObject({
      status: 'unsupported',
      reason: 'animated-image',
    });
    expect(
      inspectContextImage(Buffer.from('not an image'), 'image/png').status,
    ).toBe('unreadable');
    expect(
      inspectContextImage(pngBytes(5000, 5000), 'image/png'),
    ).toMatchObject({
      status: 'unsupported',
      reason: 'limit-exceeded',
    });
  });

  it('strips metadata, returns a bounded preview, and reports visible downscale uncertainty', async () => {
    const decoder = vi.fn(async () => ({
      mimeType: 'image/png' as const,
      bytes: pngBytes(4096, 3277),
      previewBytes: pngBytes(512, 410),
      width: 4096,
      height: 3277,
      previewWidth: 512,
      previewHeight: 410,
      metadataStripped: true,
    }));
    const result = await prepareContextImage(
      pngBytes(5000, 4000),
      'image/png',
      {
        decode: decoder,
      },
    );

    expect(decoder).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'complete',
      width: 4096,
      height: 3277,
      previewWidth: 512,
      previewHeight: 410,
      detailReduced: true,
    });
    if (result.status !== 'complete')
      throw new Error('Expected decoded image.');
    expect(result.uncertainty).toMatch(/detail/i);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.previewBytes.byteLength).toBeLessThanOrEqual(1024 * 1024);
  });

  it('accepts decoder-applied orientation when metadata is stripped', async () => {
    expect(
      inspectContextImage(jpegBytes(4_000, 2_000), 'image/jpeg'),
    ).toMatchObject({
      width: 4_000,
      height: 2_000,
    });
    const result = await prepareContextImage(
      jpegBytes(4_000, 2_000),
      'image/jpeg',
      {
        decode: async () => ({
          mimeType: 'image/jpeg',
          bytes: jpegBytes(2_000, 4_000),
          previewBytes: jpegBytes(256, 512),
          width: 2_000,
          height: 4_000,
          previewWidth: 256,
          previewHeight: 512,
          metadataStripped: true,
        }),
      },
    );

    expect(result).toMatchObject({
      status: 'complete',
      width: 2_000,
      height: 4_000,
    });
  });

  it('rejects previews whose longest edge exceeds 512 pixels', async () => {
    const result = await prepareContextImage(pngBytes(), 'image/png', {
      decode: async () => ({
        ...decodedPng(),
        previewBytes: pngBytes(513, 1),
        previewWidth: 513,
      }),
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'invalid-decoder-result',
    });
  });

  it('fails closed when there is no verified decoder', async () => {
    await expect(
      prepareContextImage(pngBytes(), 'image/png', { decode: null }),
    ).resolves.toMatchObject({ status: 'unreadable' });
  });

  it('decodes through a one-shot utility process and waits for process cleanup', async () => {
    const process = createUtilityProcess({
      type: 'result',
      result: decodedPng(),
    });
    const decode = createUtilityProcessImageDecoder({
      utilityProcess: process.utilityProcess as never,
      workerPath: 'image-decoder.cjs',
    });

    const result = await prepareContextImage(pngBytes(), 'image/png', {
      decode,
    });

    expect(result).toMatchObject({ status: 'complete' });
    expect(process.fork).toHaveBeenCalledOnce();
    expect(process.request).toMatchObject({
      type: 'decode',
      bytes: expect.any(Uint8Array),
      mimeType: 'image/png',
      maxLongestEdge: 4096,
    });
    expect(process.killCount).toBe(1);
    expect(process.exited).toBe(true);
    if (result.status === 'complete') {
      expect(result).not.toHaveProperty('text');
      expect(result).not.toHaveProperty('transcription');
    }
  });

  it('kills the utility process and waits for exit after timeout', async () => {
    const process = createUtilityProcess();
    const decode = createUtilityProcessImageDecoder({
      utilityProcess: process.utilityProcess as never,
      workerPath: 'image-decoder.cjs',
    });

    const result = await prepareContextImage(pngBytes(), 'image/png', {
      decode,
      timeoutMs: 1,
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'decode-failed',
    });
    expect(process.killCount).toBe(1);
    expect(process.exited).toBe(true);
  });

  it('kills the utility process and waits for exit when cancelled', async () => {
    const process = createUtilityProcess();
    const decode = createUtilityProcessImageDecoder({
      utilityProcess: process.utilityProcess as never,
      workerPath: 'image-decoder.cjs',
    });
    const controller = new AbortController();
    const pending = prepareContextImage(pngBytes(), 'image/png', {
      decode,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(process.killCount).toBe(1);
    expect(process.exited).toBe(true);
  });

  it('rejects oversized, misleading and over-pixel inputs before starting a utility process', async () => {
    const process = createUtilityProcess({
      type: 'result',
      result: decodedPng(),
    });
    const decode = createUtilityProcessImageDecoder({
      utilityProcess: process.utilityProcess as never,
      workerPath: 'image-decoder.cjs',
    });

    await expect(
      prepareContextImage(new Uint8Array(8 * 1024 * 1024 + 1), 'image/png', {
        decode,
      }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      reason: 'limit-exceeded',
    });
    await expect(
      prepareContextImage(pngBytes(), 'image/jpeg', { decode }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      reason: 'invalid-container',
    });
    await expect(
      prepareContextImage(pngBytes(5000, 5000), 'image/png', { decode }),
    ).resolves.toMatchObject({
      status: 'unsupported',
      reason: 'limit-exceeded',
    });

    expect(process.fork).not.toHaveBeenCalled();
  });

  it('aborts decoder work when its timeout expires', async () => {
    const onAbort = vi.fn();
    const decode: ContextImageDecoder = ({ signal }: { signal: AbortSignal }) =>
      new Promise<ContextImageDecodeResult>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            onAbort();
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    const result = await prepareContextImage(pngBytes(), 'image/png', {
      decode,
      timeoutMs: 1,
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'decode-failed',
    });
    expect(onAbort).toHaveBeenCalledOnce();
  });
});
