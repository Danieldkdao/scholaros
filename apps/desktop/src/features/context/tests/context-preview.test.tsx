// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ContextItemDTO,
  ContextPreview as ContextPreviewData,
  ContextVersionDTO,
} from '@scholaros/services/learning/context-contracts';
import { ContextPreview } from '../components/context-preview';
import type { ContextItemDetails } from '../hooks/use-context-library';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;

const item: ContextItemDTO = {
  id: 'item-1',
  title: 'Lab notes',
  kind: 'document',
  provenance: 'user-uploaded',
  courseIds: ['course-1'],
  currentVersionId: 'version-current',
  status: 'partial',
  usable: true,
  createdAt: '2026-11-02T12:00:00Z',
  updatedAt: '2026-11-03T12:00:00Z',
  revision: 3,
  source: null,
};

const version = (
  overrides: Partial<ContextVersionDTO> = {},
): ContextVersionDTO => ({
  id: 'version-current',
  itemId: 'item-1',
  contentHash: 'a'.repeat(64),
  mimeType: 'application/pdf',
  byteLength: 2048,
  pageCount: 4,
  extractionStatus: 'partial',
  interpretedPages: [1, 2, 4],
  uncertainty: 'Handwriting on page 4 is unclear.',
  createdAt: '2026-11-03T12:00:00Z',
  originalAvailable: true,
  locators: [{ kind: 'page', page: 1 }],
  ...overrides,
});

const details: ContextItemDetails = {
  item,
  versions: [
    version(),
    version({
      id: 'version-old',
      createdAt: '2026-11-02T12:00:00Z',
      extractionStatus: 'complete',
      interpretedPages: [1, 2, 3, 4],
      uncertainty: null,
    }),
  ],
};

const preview = (
  value: ContextPreviewData,
  selectedVersionId = 'version-current',
) =>
  createElement(ContextPreview, {
    open: true,
    onOpenChange: vi.fn(),
    details,
    selectedVersionId,
    preview: value,
    loading: false,
    retrying: false,
    onVersionChange: vi.fn(),
    onRetry: vi.fn(),
  });

beforeEach(() => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it('renders bounded interpreted text and uncertainty as text, never as HTML', async () => {
  const unsafeLookingText = '<img src=x onerror=alert(1)> interpreted text';
  await act(async () =>
    root.render(
      preview({
        kind: 'text',
        text: unsafeLookingText,
        locators: [{ kind: 'page', page: 3 }],
        partial: true,
        uncertainty: 'Handwriting is not fully legible.',
      }),
    ),
  );

  expect(document.body.textContent).toContain(unsafeLookingText);
  expect(document.body.textContent).toContain('Page 3');
  expect(document.body.textContent).toContain(
    'Handwriting is not fully legible.',
  );
  expect(document.body.querySelector('img[src="x"]')).toBeNull();
  expect(document.body.querySelector('script')).toBeNull();
});

it('marks an older version historical and changes preview without retrying it', async () => {
  const onVersionChange = vi.fn();
  const onRetry = vi.fn();
  await act(async () =>
    root.render(
      createElement(ContextPreview, {
        open: true,
        onOpenChange: vi.fn(),
        details,
        selectedVersionId: 'version-old',
        preview: {
          kind: 'text',
          text: 'Archived source text',
          locators: [],
          partial: false,
          uncertainty: null,
        },
        loading: false,
        retrying: false,
        onVersionChange,
        onRetry,
      }),
    ),
  );

  expect(document.body.textContent).toContain('Earlier version');
  expect(document.body.textContent).toContain('Archived source text');
  expect(document.body.textContent).not.toContain('Try again');
  expect(onRetry).not.toHaveBeenCalled();
});

it('selects an archived version without retrying or regenerating it', async () => {
  const onVersionChange = vi.fn();
  const onRetry = vi.fn();
  await act(async () =>
    root.render(
      createElement(ContextPreview, {
        open: true,
        onOpenChange: vi.fn(),
        details,
        selectedVersionId: 'version-current',
        preview: {
          kind: 'text',
          text: 'Current source',
          locators: [],
          partial: false,
          uncertainty: null,
        },
        loading: false,
        retrying: false,
        onVersionChange,
        onRetry,
      }),
    ),
  );

  const versionTrigger = document.querySelector<HTMLButtonElement>(
    '[aria-labelledby="context-preview-version-label"]',
  );
  await act(async () => {
    versionTrigger?.focus();
    versionTrigger?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  const oldVersion = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent?.includes('Earlier version'));
  if (!oldVersion) throw new Error('Expected the archived version option.');
  await act(async () => {
    oldVersion.focus();
    oldVersion.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });

  expect(onVersionChange).toHaveBeenCalledWith('version-old');
  expect(onRetry).not.toHaveBeenCalled();
});

it('renders only a bounded app-owned image preview URL', async () => {
  const original = URL.createObjectURL;
  const createObjectUrl = vi.fn(() => 'blob:context-preview');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectUrl,
  });

  await act(async () =>
    root.render(
      preview({
        kind: 'image',
        mimeType: 'image/png',
        bytes: new Uint8Array([137, 80, 78, 71]),
        width: 40,
        height: 20,
      }),
    ),
  );

  const image = document.body.querySelector('img');
  expect(image?.src).toContain('blob:context-preview');
  expect(image?.src).not.toContain('file:');
  expect(image?.alt).toBe('Preview of Lab notes');
  expect(createObjectUrl).toHaveBeenCalledOnce();

  await act(async () => root.unmount());
  if (original)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: original,
    });
  else Reflect.deleteProperty(URL, 'createObjectURL');
});

it('explains removed originals and preserves the historical preview state', async () => {
  await act(async () =>
    root.render(
      preview({ kind: 'unavailable', reason: 'removed' }, 'version-old'),
    ),
  );

  expect(document.body.textContent).toContain(
    'The original source is no longer available.',
  );
  expect(document.body.textContent).toContain('Earlier version');
});
