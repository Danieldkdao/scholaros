import {
  contextPreviewSchema,
  type ContextPreview,
  type Locator,
} from '@scholaros/services/learning/context-contracts';

const maxPreviewTextCharacters = 50_000;
const maxPreviewLocators = 200;
const maxPreviewImageBytes = 1_048_576;
const maxPreviewImageEdge = 512;

export type TextPreviewInput = {
  text: string;
  locators: Locator[];
  partial: boolean;
  uncertainty: string | null;
};

export type ImagePreviewInput = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: Uint8Array;
  width: number;
  height: number;
};

export const createTextPreview = (input: TextPreviewInput): ContextPreview => {
  const text = input.text.slice(0, maxPreviewTextCharacters);
  const locators = input.locators.slice(0, maxPreviewLocators);
  const candidate = {
    kind: 'text' as const,
    text,
    locators,
    partial:
      input.partial ||
      text.length < input.text.length ||
      locators.length < input.locators.length,
    uncertainty: input.uncertainty,
  };
  const parsed = contextPreviewSchema.safeParse(candidate);
  return parsed.success
    ? parsed.data
    : { kind: 'unavailable', reason: 'unreadable' };
};

export const createImagePreview = (
  input: ImagePreviewInput,
): ContextPreview => {
  if (
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > maxPreviewImageBytes ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0 ||
    Math.max(input.width, input.height) > maxPreviewImageEdge
  )
    return { kind: 'unavailable', reason: 'unreadable' };
  const parsed = contextPreviewSchema.safeParse({
    kind: 'image',
    ...input,
    bytes: new Uint8Array(input.bytes),
  });
  return parsed.success
    ? parsed.data
    : { kind: 'unavailable', reason: 'unreadable' };
};

export const createUnavailablePreview = (
  reason: 'removed' | 'unreadable' | 'unsupported' | 'offline' | 'processing',
): ContextPreview => ({ kind: 'unavailable', reason });
