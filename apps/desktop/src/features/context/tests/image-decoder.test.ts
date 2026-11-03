import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { canvasNativePackageNamesForTarget } from '../../../../forge.config.mts';
import { decodeImageBytes } from '../workers/image-decoder';

const createImageBytes = async (
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
) => {
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = '#d71920';
  context.fillRect(0, 0, 2, 2);

  if (mimeType === 'image/png')
    return new Uint8Array(
      await canvas.encode('png', { comment: 'private-image-metadata' }),
    );
  if (mimeType === 'image/jpeg')
    return new Uint8Array(
      await canvas.encode('jpeg', { comment: 'private-image-metadata' }),
    );
  return new Uint8Array(await canvas.encode('webp'));
};

const pngHeader = (width: number, height: number) => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
};

describe('bounded context image decoder', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)(
    'decodes %s into metadata-free safe outputs without transcribing it',
    async (mimeType) => {
      const bytes = await createImageBytes(mimeType);
      const format = mimeType.slice('image/'.length) as 'png' | 'jpeg' | 'webp';
      const result = await decodeImageBytes({
        bytes,
        mimeType,
        width: 2,
        height: 2,
        maxLongestEdge: 4096,
      });
      const normalized = await loadImage(result.bytes);
      const preview = await loadImage(result.previewBytes);

      expect(result).toMatchObject({
        mimeType,
        width: 2,
        height: 2,
        previewWidth: 2,
        previewHeight: 2,
        metadataStripped: true,
      });
      expect(result.bytes.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(result.previewBytes.byteLength).toBeLessThanOrEqual(1024 * 1024);
      expect([normalized.width, normalized.height]).toEqual([2, 2]);
      expect([preview.width, preview.height]).toEqual([2, 2]);
      expect(Buffer.from(result.bytes).toString('latin1')).not.toContain(
        'private-image-metadata',
      );
      expect(Buffer.from(result.previewBytes).toString('latin1')).not.toContain(
        'private-image-metadata',
      );
      expect(result.mimeType).toBe(mimeType);
      expect(format).toBe(mimeType.slice('image/'.length));
      expect(result).not.toHaveProperty('text');
      expect(result).not.toHaveProperty('transcription');
    },
  );

  it('downscales a wide image to the requested longest edge', async () => {
    const canvas = createCanvas(5000, 1);
    const bytes = new Uint8Array(await canvas.encode('png'));

    const result = await decodeImageBytes({
      bytes,
      mimeType: 'image/png',
      width: 5000,
      height: 1,
      maxLongestEdge: 4096,
    });

    expect(result).toMatchObject({ width: 4096, height: 1 });
    expect(result.previewWidth).toBeLessThanOrEqual(512);
    expect(result.previewHeight).toBeGreaterThan(0);
  });

  it('rejects malformed and MIME-misleading image content', async () => {
    await expect(
      decodeImageBytes({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
        width: 1,
        height: 1,
        maxLongestEdge: 4096,
      }),
    ).rejects.toMatchObject({ code: 'invalid-container' });

    const png = await createImageBytes('image/png');
    await expect(
      decodeImageBytes({
        bytes: png,
        mimeType: 'image/jpeg',
        width: 2,
        height: 2,
        maxLongestEdge: 4096,
      }),
    ).rejects.toMatchObject({ code: 'invalid-container' });
  });

  it('rejects invalid, misleading and over-budget dimensions before raster allocation', async () => {
    const validPng = await createImageBytes('image/png');

    await expect(
      decodeImageBytes({
        bytes: validPng,
        mimeType: 'image/png',
        width: 0,
        height: 2,
        maxLongestEdge: 4096,
      }),
    ).rejects.toMatchObject({ code: 'invalid-container' });
    await expect(
      decodeImageBytes({
        bytes: validPng,
        mimeType: 'image/png',
        width: Number.NaN,
        height: 2,
        maxLongestEdge: 4096,
      }),
    ).rejects.toMatchObject({ code: 'invalid-container' });
    await expect(
      decodeImageBytes({
        bytes: validPng,
        mimeType: 'image/png',
        width: 1,
        height: 2,
        maxLongestEdge: 4096,
      }),
    ).rejects.toMatchObject({ code: 'invalid-container' });
    await expect(
      decodeImageBytes({
        bytes: pngHeader(5000, 5000),
        mimeType: 'image/png',
        width: 5000,
        height: 5000,
        maxLongestEdge: 4096,
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it('rejects encoded inputs above the 8 MiB source-byte limit', async () => {
    await expect(
      decodeImageBytes({
        bytes: new Uint8Array(8 * 1024 * 1024 + 1),
        mimeType: 'image/png',
        width: 1,
        height: 1,
        maxLongestEdge: 4096,
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });
});

describe('canvas native package target selection', () => {
  it.each([
    ['darwin', 'arm64', undefined, ['@napi-rs/canvas-darwin-arm64']],
    ['darwin', 'x64', undefined, ['@napi-rs/canvas-darwin-x64']],
    ['mas', 'arm64', undefined, ['@napi-rs/canvas-darwin-arm64']],
    ['win32', 'arm64', undefined, ['@napi-rs/canvas-win32-arm64-msvc']],
    ['win32', 'x64', undefined, ['@napi-rs/canvas-win32-x64-msvc']],
    ['linux', 'armv7l', undefined, ['@napi-rs/canvas-linux-arm-gnueabihf']],
    ['linux', 'arm64', true, ['@napi-rs/canvas-linux-arm64-gnu']],
    ['linux', 'arm64', false, ['@napi-rs/canvas-linux-arm64-musl']],
    ['linux', 'x64', true, ['@napi-rs/canvas-linux-x64-gnu']],
    ['linux', 'x64', false, ['@napi-rs/canvas-linux-x64-musl']],
  ] as const)(
    'selects packages for %s %s',
    (platform, arch, usesGlibc, expected) => {
      expect(
        canvasNativePackageNamesForTarget(platform, arch, usesGlibc),
      ).toEqual(expected);
    },
  );

  it('fails package creation for unsupported native targets', () => {
    expect(() => canvasNativePackageNamesForTarget('win32', 'ia32')).toThrow(
      /unsupported/i,
    );
    expect(() =>
      canvasNativePackageNamesForTarget('darwin', 'universal'),
    ).toThrow(/unsupported/i);
  });
});
