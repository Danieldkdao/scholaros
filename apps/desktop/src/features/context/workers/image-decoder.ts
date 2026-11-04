import { createCanvas, Image, type Canvas } from '@napi-rs/canvas';
import {
  contextImageMimeTypes,
  type ContextImageMimeType,
} from '@scholaros/services/learning/context-contracts';
import {
  contextFileLimits,
  inspectImageHeader,
} from '../services/file-validation';
import type { ContextImageDecodeResult } from '../services/image-content';

const maxPreviewBytes = 1_048_576;
const maxPreviewEdge = 512;

export type ImageDecoderRequest = {
  bytes: Uint8Array;
  mimeType: ContextImageMimeType;
  width: number;
  height: number;
  maxLongestEdge: number;
};

export type ImageDecoderMessage = { type: 'decode' } & ImageDecoderRequest;

export type ImageDecoderFailureCode =
  | 'animated-image'
  | 'decode-failed'
  | 'invalid-container'
  | 'limit-exceeded';

export type ImageDecoderResponse =
  | { type: 'result'; result: ContextImageDecodeResult }
  | { type: 'error'; code: ImageDecoderFailureCode };

export class ImageDecoderError extends Error {
  constructor(readonly code: ImageDecoderFailureCode) {
    super(code);
    this.name = 'ImageDecoderError';
  }
}

const imageError = (code: ImageDecoderFailureCode): ImageDecoderError =>
  new ImageDecoderError(code);

const pngHasAnimationControl = (bytes: Uint8Array) => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length < 8 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return false;

  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (length > buffer.length - offset - 12) return false;
    offset += length + 12;
    if (type === 'IEND') return false;
  }
  return false;
};

const assertImageRequest = (input: ImageDecoderRequest) => {
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > contextFileLimits.imageBytes
  )
    throw imageError('limit-exceeded');
  if (
    !contextImageMimeTypes.includes(input.mimeType) ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0 ||
    !Number.isSafeInteger(input.maxLongestEdge) ||
    input.maxLongestEdge <= 0 ||
    input.maxLongestEdge > contextFileLimits.imageLongestEdge
  )
    throw imageError('invalid-container');
  if (input.width * input.height > contextFileLimits.imagePixels)
    throw imageError('limit-exceeded');
  if (pngHasAnimationControl(input.bytes)) throw imageError('animated-image');

  const inspection = inspectImageHeader(input.bytes, input.mimeType);
  if (inspection.status !== 'valid') {
    if (inspection.reason === 'animated-image')
      throw imageError('animated-image');
    if (inspection.reason === 'limit-exceeded')
      throw imageError('limit-exceeded');
    throw imageError('invalid-container');
  }
  if (
    inspection.image.width !== input.width ||
    inspection.image.height !== input.height
  )
    throw imageError('invalid-container');
};

const scaledDimensions = (
  width: number,
  height: number,
  longestEdge: number,
) => {
  const scale = Math.min(1, longestEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

const encodeImage = async (canvas: Canvas, mimeType: ContextImageMimeType) => {
  switch (mimeType) {
    case 'image/png':
      return new Uint8Array(await canvas.encode('png'));
    case 'image/jpeg':
      return new Uint8Array(await canvas.encode('jpeg'));
    case 'image/webp':
      return new Uint8Array(await canvas.encode('webp'));
  }
};

const drawImage = (image: Image, width: number, height: number) => {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  return canvas;
};

const createPreview = async (
  image: Image,
  mimeType: ContextImageMimeType,
  width: number,
  height: number,
) => {
  let edge = Math.min(maxPreviewEdge, Math.max(width, height));
  while (edge > 0) {
    const dimensions = scaledDimensions(width, height, edge);
    const bytes = await encodeImage(
      drawImage(image, dimensions.width, dimensions.height),
      mimeType,
    );
    if (bytes.byteLength <= maxPreviewBytes) return { ...dimensions, bytes };
    if (edge === 1) break;
    edge = Math.max(1, Math.floor(edge / 2));
  }
  throw imageError('limit-exceeded');
};

export const decodeImageBytes = async (
  input: ImageDecoderRequest,
): Promise<ContextImageDecodeResult> => {
  assertImageRequest(input);
  try {
    const image = new Image();
    image.src = input.bytes;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const validDimensions =
      Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width * height <= contextFileLimits.imagePixels &&
      ((width === input.width && height === input.height) ||
        (width === input.height && height === input.width));
    if (!validDimensions) throw imageError('invalid-container');

    const dimensions = scaledDimensions(width, height, input.maxLongestEdge);
    const normalizedCanvas = drawImage(
      image,
      dimensions.width,
      dimensions.height,
    );
    const normalizedBytes = await encodeImage(normalizedCanvas, input.mimeType);
    if (
      normalizedBytes.byteLength === 0 ||
      normalizedBytes.byteLength > contextFileLimits.imageBytes
    )
      throw imageError('limit-exceeded');
    const preview = await createPreview(
      image,
      input.mimeType,
      dimensions.width,
      dimensions.height,
    );

    return {
      mimeType: input.mimeType,
      bytes: normalizedBytes,
      previewBytes: preview.bytes,
      width: dimensions.width,
      height: dimensions.height,
      previewWidth: preview.width,
      previewHeight: preview.height,
      metadataStripped: true,
    };
  } catch (error) {
    if (error instanceof ImageDecoderError) throw error;
    throw imageError('decode-failed');
  }
};

const parentPort = process.parentPort as Electron.ParentPort | null;
if (parentPort) {
  let handled = false;
  parentPort.on('message', (event) => {
    if (handled) return;
    handled = true;
    const message = event.data as Partial<ImageDecoderMessage> | null;
    if (!message || message.type !== 'decode') {
      parentPort.postMessage({ type: 'error', code: 'invalid-container' });
      return;
    }
    void decodeImageBytes(message as ImageDecoderRequest).then(
      (result) => parentPort.postMessage({ type: 'result', result }),
      (error: unknown) =>
        parentPort.postMessage({
          type: 'error',
          code:
            error instanceof ImageDecoderError ? error.code : 'decode-failed',
        }),
    );
  });
}
