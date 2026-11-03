import { describe, expect, it, vi } from 'vitest';
import {
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
          previewBytes: jpegBytes(2_000, 4_000),
          width: 2_000,
          height: 4_000,
          previewWidth: 2_000,
          previewHeight: 4_000,
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

  it('fails closed when there is no verified decoder', async () => {
    await expect(
      prepareContextImage(pngBytes(), 'image/png', { decode: null }),
    ).resolves.toMatchObject({ status: 'unreadable' });
  });

  it('aborts decoder work when its timeout expires', async () => {
    const onAbort = vi.fn();
    const decode: ContextImageDecoder = ({ signal }: { signal: AbortSignal }) =>
      new Promise<ContextImageDecodeResult>(() => {
        signal.addEventListener('abort', onAbort, { once: true });
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
