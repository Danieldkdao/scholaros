import {
  contextImageMimeTypes,
  type ContextImageMimeType,
} from '@scholaros/services/learning/context-contracts';
import { contextFileLimits, inspectImageHeader } from './file-validation';

const maxDecodeTimeMs = 15_000;
const maxPreviewBytes = 1_048_576;

export type ContextImageInspection = {
  status: 'valid' | 'unsupported' | 'unreadable';
  reason?: string;
  mimeType?: ContextImageMimeType;
  width?: number;
  height?: number;
};

export type ContextImageDecodeResult = {
  mimeType: ContextImageMimeType;
  bytes: Uint8Array;
  previewBytes: Uint8Array;
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  metadataStripped: boolean;
};

// Implementations must decode in a bounded worker and terminate on abort.
export type ContextImageDecoder = (input: {
  bytes: Uint8Array;
  mimeType: ContextImageMimeType;
  width: number;
  height: number;
  maxLongestEdge: number;
  signal: AbortSignal;
}) => Promise<ContextImageDecodeResult>;

export type ContextImageContentResult =
  | {
      status: 'complete';
      mimeType: ContextImageMimeType;
      bytes: Uint8Array;
      previewBytes: Uint8Array;
      width: number;
      height: number;
      previewWidth: number;
      previewHeight: number;
      detailReduced: boolean;
      uncertainty: string | null;
    }
  | { status: 'unsupported'; reason: ContextImageFailureReason }
  | { status: 'unreadable'; reason: ContextImageFailureReason };

type ContextImageFailureReason =
  | 'decoder-unavailable'
  | 'invalid-container'
  | 'animated-image'
  | 'limit-exceeded'
  | 'invalid-decoder-result'
  | 'decode-failed';

export type PrepareContextImageOptions = {
  decode: ContextImageDecoder | null;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const imageFailure = (
  status: 'unsupported' | 'unreadable',
  reason: ContextImageFailureReason,
): ContextImageContentResult => ({ status, reason });

export const inspectContextImage = (
  bytes: Uint8Array,
  mimeType?: string,
): ContextImageInspection => {
  const inspected = inspectImageHeader(bytes, mimeType);
  if (inspected.status !== 'valid')
    return {
      status: inspected.status,
      reason: inspected.reason,
    };
  return {
    status: 'valid',
    mimeType: inspected.image.mimeType,
    width: inspected.image.width,
    height: inspected.image.height,
  };
};

const boundedTimeout = (value: number | undefined) =>
  Number.isFinite(value)
    ? Math.max(1, Math.min(maxDecodeTimeMs, Math.floor(value!)))
    : maxDecodeTimeMs;

const isSupportedMimeType = (value: string): value is ContextImageMimeType =>
  contextImageMimeTypes.includes(value as ContextImageMimeType);

const awaitDecoder = async (
  operation: Promise<ContextImageDecodeResult>,
  signal: AbortSignal,
  decoderController: AbortController,
  timeoutMs: number,
): Promise<ContextImageDecodeResult> => {
  if (signal.aborted) {
    decoderController.abort();
    throw new DOMException('Aborted', 'AbortError');
  }
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        onAbort = () => {
          decoderController.abort();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          decoderController.abort();
          reject(new Error('decode-timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const outputMatchesBudget = (
  output: ContextImageDecodeResult,
  input: { width: number; height: number },
) => {
  if (
    !isSupportedMimeType(output.mimeType) ||
    !(output.bytes instanceof Uint8Array) ||
    !(output.previewBytes instanceof Uint8Array) ||
    output.bytes.byteLength === 0 ||
    output.bytes.byteLength > contextFileLimits.imageBytes ||
    output.previewBytes.byteLength === 0 ||
    output.previewBytes.byteLength > maxPreviewBytes ||
    !output.metadataStripped ||
    !Number.isSafeInteger(output.width) ||
    !Number.isSafeInteger(output.height) ||
    output.width <= 0 ||
    output.height <= 0 ||
    output.width * output.height > contextFileLimits.imagePixels ||
    Math.max(output.width, output.height) >
      contextFileLimits.imageLongestEdge ||
    !Number.isSafeInteger(output.previewWidth) ||
    !Number.isSafeInteger(output.previewHeight) ||
    output.previewWidth <= 0 ||
    output.previewHeight <= 0 ||
    output.previewWidth * output.previewHeight >
      contextFileLimits.imagePixels ||
    Math.max(output.previewWidth, output.previewHeight) >
      contextFileLimits.imageLongestEdge
  )
    return false;

  const expectedScale = Math.min(
    1,
    contextFileLimits.imageLongestEdge / Math.max(input.width, input.height),
  );
  const expectedWidth = Math.max(1, Math.round(input.width * expectedScale));
  const expectedHeight = Math.max(1, Math.round(input.height * expectedScale));
  const matchesDimensions = (width: number, height: number) =>
    Math.abs(output.width - width) <= 1 &&
    Math.abs(output.height - height) <= 1;
  return (
    matchesDimensions(expectedWidth, expectedHeight) ||
    matchesDimensions(expectedHeight, expectedWidth)
  );
};

export const prepareContextImage = async (
  bytes: Uint8Array,
  mimeType: string,
  options: PrepareContextImageOptions,
): Promise<ContextImageContentResult> => {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (bytes.byteLength === 0 || bytes.byteLength > contextFileLimits.imageBytes)
    return imageFailure('unsupported', 'limit-exceeded');
  const inspection = inspectContextImage(bytes, mimeType);
  if (inspection.status !== 'valid')
    return imageFailure(
      inspection.status,
      inspection.reason === 'animated-image'
        ? 'animated-image'
        : inspection.reason === 'limit-exceeded'
          ? 'limit-exceeded'
          : 'invalid-container',
    );
  if (!options.decode) return imageFailure('unreadable', 'decoder-unavailable');

  const signal = options.signal ?? new AbortController().signal;
  const decoderController = new AbortController();
  try {
    const decoded = await awaitDecoder(
      options.decode({
        bytes,
        mimeType: inspection.mimeType!,
        width: inspection.width!,
        height: inspection.height!,
        maxLongestEdge: contextFileLimits.imageLongestEdge,
        signal: decoderController.signal,
      }),
      signal,
      decoderController,
      boundedTimeout(options.timeoutMs),
    );
    const normalizedHeader = inspectContextImage(
      decoded.bytes,
      decoded.mimeType,
    );
    const previewHeader = inspectContextImage(
      decoded.previewBytes,
      decoded.mimeType,
    );
    if (
      !outputMatchesBudget(decoded, {
        width: inspection.width!,
        height: inspection.height!,
      }) ||
      normalizedHeader.status !== 'valid' ||
      normalizedHeader.width !== decoded.width ||
      normalizedHeader.height !== decoded.height ||
      previewHeader.status !== 'valid' ||
      previewHeader.width !== decoded.previewWidth ||
      previewHeader.height !== decoded.previewHeight
    )
      return imageFailure('unreadable', 'invalid-decoder-result');

    const detailReduced =
      Math.max(inspection.width!, inspection.height!) >
      contextFileLimits.imageLongestEdge;
    return {
      status: 'complete',
      mimeType: decoded.mimeType,
      bytes: decoded.bytes,
      previewBytes: decoded.previewBytes,
      width: decoded.width,
      height: decoded.height,
      previewWidth: decoded.previewWidth,
      previewHeight: decoded.previewHeight,
      detailReduced,
      uncertainty: detailReduced
        ? 'Image downscaled to 4096 px; fine detail may be lost.'
        : null,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    return imageFailure('unreadable', 'decode-failed');
  }
};
