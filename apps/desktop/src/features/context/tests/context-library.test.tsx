// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ContextItemDTO,
  ContextPreview,
  ContextVersionDTO,
} from '@scholaros/services/learning/context-contracts';
import type { MemoryDTO } from '@scholaros/services/learning/memory-contracts';
import type {
  ProductEventV1,
  Page,
} from '@scholaros/services/learning/product-contracts';
import { ContextLibrary } from '../components/context-library';
import { toast } from '@scholaros/ui/components/toast';
import { useContextLibrary } from '../hooks/use-context-library';
import type {
  ContextCourse,
  ContextLibraryApi,
} from '../hooks/use-context-library';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let events: Set<(event: ProductEventV1) => void>;

const item = (overrides: Partial<ContextItemDTO> = {}): ContextItemDTO => ({
  id: 'item-1',
  title: 'Biology notes',
  kind: 'note',
  provenance: 'user-authored',
  courseIds: [],
  currentVersionId: 'version-1',
  status: 'complete',
  usable: true,
  createdAt: '2026-11-03T12:00:00Z',
  updatedAt: '2026-11-03T12:00:00Z',
  revision: 1,
  source: null,
  ...overrides,
});

const page = (items: ContextItemDTO[], revision = 1): Page<ContextItemDTO> => ({
  items,
  nextCursor: null,
  revision,
});

const api = (): ContextLibraryApi => ({
  listContextItems: vi.fn(async () => page([])),
  getContextItem: vi.fn(async () => null),
  createContextNote: vi.fn(async () => item()),
  updateContextItem: vi.fn(async () => item()),
  linkContextItem: vi.fn(async () => item()),
  removeContextItem: vi.fn(async () => undefined),
  retryContextIngestion: vi.fn(async () => ({ operationId: 'operation-1' })),
  readContextPreview: vi.fn(
    async () =>
      ({
        kind: 'unavailable',
        reason: 'processing',
      }) satisfies ContextPreview,
  ),
  upsertExplicitPreference: vi.fn(
    async () =>
      ({
        id: 'memory-1',
        courseId: null,
        type: 'explicit-preference',
        content: { field: 'vocabulary', value: 'plain language' },
        provenance: 'student-explicit',
        evidenceIds: [],
        confidence: null,
        revision: 1,
        createdAt: '2026-11-03T12:00:00Z',
        updatedAt: '2026-11-03T12:00:00Z',
      }) satisfies MemoryDTO,
  ),
  chooseContextFiles: vi.fn(async () => ({ items: [], cancelled: true })),
  openSource: vi.fn(async () => undefined),
});

const subscribe = (listener: (event: ProductEventV1) => void) => {
  events.add(listener);
  return () => events.delete(listener);
};

const mount = async (
  libraryApi = api(),
  accountId: string | null = 'account-a',
  courses: ContextCourse[] = [],
  readOnly = false,
  refreshEpoch = 0,
) => {
  await act(async () => {
    root.render(
      createElement(ContextLibrary, {
        accountId,
        api: libraryApi,
        courses,
        refreshEpoch,
        readOnly,
        subscribeToEvents: subscribe,
      }),
    );
  });
  return libraryApi;
};

const click = async (element: Element | null) => {
  if (!element) throw new Error('Expected an interactive element.');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const setFieldValue = async (
  element: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
) => {
  if (!element) throw new Error('Expected a form field.');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      'value',
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  events = new Set();
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it('distinguishes loading from a real empty library', async () => {
  let finish!: (result: Page<ContextItemDTO>) => void;
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems).mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );

  await mount(libraryApi);
  expect(document.body.textContent).toContain('Loading your Context');
  await act(async () => finish(page([])));
  expect(document.body.textContent).toContain('No notes or files yet');
  expect(document.body.textContent).not.toContain('Could not load');
  expect(
    [...document.querySelectorAll('a')]
      .find((link) => link.textContent?.includes('View learning preferences'))
      ?.getAttribute('href'),
  ).toBe('#/dashboard/settings?section=personal-context');
});

it('shows partial and unreadable outcomes without presenting them as complete', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems).mockResolvedValueOnce(
    page([
      item({
        id: 'partial',
        title: 'Lecture scan',
        kind: 'image',
        status: 'partial',
      }),
      item({
        id: 'unreadable',
        title: 'Encrypted handout',
        kind: 'document',
        status: 'unreadable',
        usable: true,
      }),
    ]),
  );

  await mount(libraryApi);
  expect(document.body.textContent).toContain('Partially available');
  expect(document.body.textContent).toContain('Unreadable');
  expect(document.body.textContent).toContain(
    'The last usable version is still available.',
  );
  expect(document.body.querySelector('[data-state="done"]')).toBeNull();
});

it('shows an offline read as a reconnect state, not an empty library', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems).mockRejectedValueOnce(
    Object.assign(new Error('offline'), { code: 'offline' }),
  );
  await mount(libraryApi);
  expect(document.body.textContent).toContain(
    'You’re offline. Reconnect to view saved Context.',
  );
  expect(document.body.textContent).not.toContain('No notes or files yet');
});

it('saves a typed personal preference and directs the student to its remembered settings', async () => {
  const savedToast = vi.spyOn(toast, 'success');
  const libraryApi = api();
  await mount(libraryApi);
  await click(document.querySelector('button[aria-label="Add to Context"]'));
  const preferenceItem = [
    ...document.querySelectorAll('[role="menuitem"]'),
  ].find((entry) =>
    entry.textContent?.includes('Personal preference or context'),
  );
  await click(preferenceItem ?? null);
  await setFieldValue(
    document.querySelector('input[name="value"]'),
    'Use plain language',
  );
  const form = document.querySelector('form');
  if (!form) throw new Error('Expected the preference form.');
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  expect(libraryApi.upsertExplicitPreference).toHaveBeenCalledWith(
    expect.objectContaining({
      preference: { field: 'explanation-length', value: 'Use plain language' },
    }),
  );
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(savedToast).toHaveBeenCalledWith(
    'Preference saved',
    expect.objectContaining({
      actionProps: expect.objectContaining({
        children: 'View preferences',
        onClick: expect.any(Function),
      }),
    }),
  );
  const action = savedToast.mock.calls.at(-1)?.[1]?.actionProps?.onClick;
  const originalHash = window.location.hash;
  await act(async () => {
    action?.({} as never);
  });
  expect(window.location.hash).toBe(
    '#/dashboard/settings?section=personal-context',
  );
  window.location.hash = originalHash;
  savedToast.mockRestore();
});

it('keeps the note draft open when creation fails', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.createContextNote).mockRejectedValueOnce(
    new Error('offline'),
  );
  await mount(libraryApi);

  await click(document.querySelector('button[aria-label="Add to Context"]'));
  const addNote = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Text or note'),
  );
  await click(addNote ?? null);
  await setFieldValue(
    document.querySelector('input[name="title"]'),
    'Exam review',
  );
  await setFieldValue(
    document.querySelector('textarea[name="text"]'),
    'Remember the cell cycle examples.',
  );
  const form = document.querySelector('form');
  if (!form) throw new Error('Expected the note form.');
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });

  expect(document.body.textContent?.toLowerCase()).toContain('offline');
  expect(
    (document.querySelector('input[name="title"]') as HTMLInputElement).value,
  ).toBe('Exam review');
  expect(
    (document.querySelector('textarea[name="text"]') as HTMLTextAreaElement)
      .value,
  ).toBe('Remember the cell cycle examples.');
});

it('keeps per-file outcomes independent when an import contains unsupported input', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.chooseContextFiles).mockResolvedValueOnce({
    cancelled: false,
    items: [
      { itemId: 'supported', operationId: 'op-1', status: 'processing' },
      { itemId: 'unsupported', operationId: 'op-2', status: 'unsupported' },
    ],
  });
  await mount(libraryApi);

  await click(document.querySelector('button[aria-label="Add to Context"]'));
  const addDocument = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Document or PDF'),
  );
  await click(addDocument ?? null);

  expect(libraryApi.chooseContextFiles).toHaveBeenCalledWith({
    courseId: undefined,
    saveToLibrary: true,
  });
  expect(document.body.textContent).toContain('File 1');
  expect(document.body.textContent).toContain('Reading');
  expect(document.body.textContent).toContain('File 2');
  expect(document.body.textContent).toContain('Unsupported');
});

it('edits a readable note with its expected revision and complete text', async () => {
  const note = item();
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems).mockResolvedValueOnce(page([note]));
  vi.mocked(libraryApi.getContextItem).mockResolvedValueOnce({
    item: note,
    versions: [],
    preview: {
      kind: 'text',
      text: 'Original note text',
      locators: [],
      partial: false,
      uncertainty: null,
    },
  });
  await mount(libraryApi);
  await click(
    document.querySelector('button[aria-label="Actions for Biology notes"]'),
  );
  const editNote = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Edit note'),
  );
  await click(editNote ?? null);
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
  );
  await setFieldValue(
    document.querySelector('input[name="title"]'),
    'Updated biology notes',
  );
  await setFieldValue(
    document.querySelector('textarea[name="text"]'),
    'Updated complete note text',
  );
  const form = document.querySelector('form');
  if (!form) throw new Error('Expected the note editor.');
  await act(async () =>
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  await vi.waitFor(() => {
    expect(libraryApi.updateContextItem).toHaveBeenCalledWith({
      itemId: note.id,
      expectedRevision: note.revision,
      title: 'Updated biology notes',
      text: 'Updated complete note text',
      courseId: null,
    });
  });
});

it('does not replace note text when only partial content is available', async () => {
  const note = item();
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems).mockResolvedValueOnce(page([note]));
  vi.mocked(libraryApi.getContextItem).mockResolvedValueOnce({
    item: note,
    versions: [],
    preview: {
      kind: 'text',
      text: 'Only an incomplete excerpt',
      locators: [],
      partial: true,
      uncertainty: 'Some paragraphs are missing.',
    },
  });
  await mount(libraryApi);
  await click(
    document.querySelector('button[aria-label="Actions for Biology notes"]'),
  );
  const editNote = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Edit note'),
  );
  await click(editNote ?? null);
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
  );
  expect(document.querySelector('textarea[name="text"]')).toBeNull();
  await setFieldValue(
    document.querySelector('input[name="title"]'),
    'Retitled biology notes',
  );
  const form = document.querySelector('form');
  if (!form) throw new Error('Expected the note editor.');
  await act(async () =>
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
  await vi.waitFor(() => {
    expect(libraryApi.updateContextItem).toHaveBeenCalledOnce();
  });
  const update = vi.mocked(libraryApi.updateContextItem).mock.calls[0]?.[0];
  expect(update).toMatchObject({
    itemId: note.id,
    expectedRevision: note.revision,
    title: 'Retitled biology notes',
    courseId: null,
  });
  expect(update).not.toHaveProperty('text');
});

it('keeps pagination available when a local type filter has no current-page matches', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems)
    .mockResolvedValueOnce({
      items: [item({ id: 'note-1', title: 'Lecture note' })],
      nextCursor: 'cursor-2',
      revision: 5,
    })
    .mockResolvedValueOnce({
      items: [item({ id: 'image-1', title: 'Lecture photo', kind: 'image' })],
      nextCursor: null,
      revision: 5,
    });
  await mount(libraryApi);

  expect(
    document.querySelector('[aria-labelledby="context-kind-filter-label"]'),
  ).toBeNull();
  await click(document.querySelector('button[aria-label="Context filters"]'));
  const typeFilter = document.querySelector<HTMLButtonElement>(
    '[aria-labelledby="context-kind-filter-label"]',
  );
  if (!typeFilter) throw new Error('Expected the type filter.');
  await act(async () => {
    typeFilter.focus();
    typeFilter.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  const imageOption = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent?.trim() === 'Image');
  if (!imageOption) throw new Error('Expected the image filter option.');
  await act(async () => {
    imageOption.focus();
    imageOption.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });

  expect(document.body.textContent).toContain('No matching items');
  const loadMore = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Load more'),
  );
  await click(loadMore ?? null);
  expect(document.body.textContent).toContain('Lecture photo');
});

it('keeps successful empty data distinct from a failed read and recovers on retry', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(page([item({ title: 'Recovered note' })], 2));
  await mount(libraryApi);

  expect(document.body.textContent).toContain('Could not load your Context.');
  const retry = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Try again'),
  );
  await click(retry ?? null);
  expect(document.body.textContent).toContain('Recovered note');
  expect(document.body.textContent).not.toContain(
    'Could not load your Context.',
  );
});

it('loads the next bounded page without losing earlier items', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems)
    .mockResolvedValueOnce({
      items: [item({ id: 'first', title: 'First note' })],
      nextCursor: 'cursor-1',
      revision: 4,
    })
    .mockResolvedValueOnce({
      items: [item({ id: 'second', title: 'Second note' })],
      nextCursor: null,
      revision: 4,
    });
  await mount(libraryApi);

  const loadMore = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Load more'),
  );
  await click(loadMore ?? null);
  expect(libraryApi.listContextItems).toHaveBeenNthCalledWith(2, {
    cursor: 'cursor-1',
    limit: 25,
  });
  expect(document.body.textContent).toContain('First note');
  expect(document.body.textContent).toContain('Second note');
});

it('reloads on a newer same-account event and ignores the older snapshot', async () => {
  let resolveOld!: (result: Page<ContextItemDTO>) => void;
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems)
    .mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    )
    .mockResolvedValueOnce(page([item({ id: 'new', title: 'New note' })], 2));
  await mount(libraryApi);

  const [listener] = [...events];
  if (!listener) throw new Error('Expected a Context event subscription.');
  await act(async () =>
    listener({
      version: 1,
      accountId: 'account-a',
      revision: 2,
      resource: 'context',
      targetId: 'new',
    }),
  );
  await act(async () =>
    resolveOld(page([item({ id: 'old', title: 'Old note' })], 1)),
  );
  expect(document.body.textContent).toContain('New note');
  expect(document.body.textContent).not.toContain('Old note');
});

it('opens the add menu and note dialog with keyboard focus support', async () => {
  await mount();
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Add to Context"]',
  );
  if (!trigger) throw new Error('Expected the Context add menu.');
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  const noteItem = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Text or note'),
  );
  await click(noteItem ?? null);
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  await vi.waitFor(() => {
    expect(dialog?.contains(document.activeElement)).toBe(true);
  });
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('links and detaches a course through the existing item relationship', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems)
    .mockResolvedValueOnce(page([item()]))
    .mockResolvedValueOnce(page([item({ courseIds: ['course-1'] })], 2))
    .mockResolvedValueOnce(page([item()], 3));
  await mount(libraryApi, 'account-a', [
    { id: 'course-1', name: 'Biology 101', url: 'https://example.edu/course' },
  ]);

  const chooseCourse = async (label: string) => {
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-context-item-id="item-1"] button[data-slot="select-trigger"]',
    );
    if (!trigger) throw new Error('Expected the course association control.');
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((candidate) => candidate.textContent?.includes(label));
    if (!option) throw new Error(`Expected the ${label} course option.`);
    await act(async () => {
      option.focus();
      option.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
  };

  await chooseCourse('Biology 101');
  expect(libraryApi.linkContextItem).toHaveBeenNthCalledWith(1, {
    itemId: 'item-1',
    courseId: 'course-1',
    retainInLibrary: true,
  });
  await chooseCourse('No course');
  expect(libraryApi.linkContextItem).toHaveBeenNthCalledWith(2, {
    itemId: 'item-1',
    courseId: null,
    retainInLibrary: true,
  });
});

it('keeps a source visible when confirmed removal fails', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems).mockResolvedValue(page([item()]));
  vi.mocked(libraryApi.removeContextItem).mockRejectedValueOnce(
    new Error('storage failed'),
  );
  await mount(libraryApi);

  await click(
    document.querySelector('button[aria-label="Actions for Biology notes"]'),
  );
  const removeItem = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Remove from Context'),
  );
  await click(removeItem ?? null);
  const removeButton = [
    ...document.querySelectorAll('[role="alertdialog"] button'),
  ].find((button) => button.textContent?.includes('Remove'));
  await click(removeButton ?? null);

  expect(document.body.textContent).toContain('storage failed');
  expect(
    document.querySelector('[data-context-item-id="item-1"]'),
  ).not.toBeNull();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
});

it('refreshes the open preview after starting a new reading attempt', async () => {
  const libraryApi = api();
  const failedItem = item({
    id: 'file-1',
    title: 'Study guide',
    kind: 'document',
    status: 'failed',
    currentVersionId: 'version-1',
  });
  const processingItem = {
    ...failedItem,
    status: 'processing' as const,
    updatedAt: '2026-11-03T12:05:00Z',
  };
  const versionFor = (
    extractionStatus: ContextVersionDTO['extractionStatus'],
  ): ContextVersionDTO => ({
    id: 'version-1',
    itemId: 'file-1',
    contentHash: 'a'.repeat(64),
    mimeType: 'application/pdf',
    byteLength: 1024,
    pageCount: 1,
    extractionStatus,
    interpretedPages: [],
    uncertainty: null,
    createdAt: '2026-11-03T12:00:00Z',
    originalAvailable: true,
    locators: [],
  });
  vi.mocked(libraryApi.listContextItems)
    .mockResolvedValueOnce(page([failedItem]))
    .mockResolvedValueOnce(page([processingItem], 2));
  vi.mocked(libraryApi.getContextItem)
    .mockResolvedValueOnce({
      item: failedItem,
      versions: [versionFor('failed')],
      preview: { kind: 'unavailable', reason: 'unreadable' },
    })
    .mockResolvedValueOnce({
      item: processingItem,
      versions: [versionFor('processing')],
      preview: { kind: 'unavailable', reason: 'processing' },
    });
  await mount(libraryApi);

  await click(
    document.querySelector('button[aria-label="Preview Study guide"]'),
  );
  expect(document.body.textContent).toContain('Could not read');
  const retryButton = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Try again'),
  );
  await click(retryButton ?? null);
  await act(async () => {
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'Reading',
      );
    });
  });
  expect(libraryApi.getContextItem).toHaveBeenCalledTimes(2);
});

it('clears pending retry UI when the active account changes', async () => {
  const libraryApi = api();
  let resolveRetry!: (result: { operationId: string }) => void;
  vi.mocked(libraryApi.listContextItems)
    .mockResolvedValueOnce(
      page([
        item({
          id: 'shared-item',
          title: 'Old account file',
          kind: 'document',
          status: 'failed',
        }),
      ]),
    )
    .mockResolvedValueOnce(
      page([
        item({
          id: 'shared-item',
          title: 'New account file',
          kind: 'document',
          status: 'failed',
        }),
      ]),
    );
  vi.mocked(libraryApi.retryContextIngestion).mockReturnValue(
    new Promise((resolve) => (resolveRetry = resolve)),
  );
  await mount(libraryApi, 'account-old');
  const oldActions = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Actions for Old account file"]',
  );
  await click(oldActions ?? null);
  const oldRetry = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Try reading again'),
  );
  await click(oldRetry ?? null);

  await mount(libraryApi, 'account-new');
  const newActions = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Actions for New account file"]',
  );
  await click(newActions ?? null);
  const newRetry = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Try reading again'),
  );
  expect(newRetry?.getAttribute('aria-disabled')).not.toBe('true');

  await act(async () => resolveRetry({ operationId: 'retry-old' }));
});

it('never renders the prior account snapshot during an account switch', async () => {
  const observations: { accountId: string; titles: string[] }[] = [];
  const libraryApi = api();
  let resolveOld!: (result: Page<ContextItemDTO>) => void;
  let resolveCurrent!: (result: Page<ContextItemDTO>) => void;
  vi.mocked(libraryApi.listContextItems)
    .mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    )
    .mockImplementationOnce(
      () => new Promise((resolve) => (resolveCurrent = resolve)),
    );
  const Probe = ({ accountId }: { accountId: string }) => {
    const library = useContextLibrary(accountId, libraryApi, subscribe);
    useLayoutEffect(() => {
      observations.push({
        accountId,
        titles: library.items.map((contextItem) => contextItem.title),
      });
    }, [accountId, library.items]);
    return createElement(
      'div',
      null,
      library.items.map((contextItem) => contextItem.title),
    );
  };

  await act(async () =>
    root.render(createElement(Probe, { accountId: 'account-old' })),
  );
  await act(async () =>
    resolveOld(page([item({ id: 'old', title: 'Old account note' })], 1)),
  );
  observations.length = 0;
  await act(async () =>
    root.render(createElement(Probe, { accountId: 'account-current' })),
  );
  expect(
    observations.some((observation) =>
      observation.titles.includes('Old account note'),
    ),
  ).toBe(false);
  await act(async () =>
    resolveCurrent(
      page([item({ id: 'current', title: 'Current account note' })], 2),
    ),
  );
  expect(document.body.textContent).toContain('Current account note');
});

it('ignores stale account responses and unrelated account events', async () => {
  let resolveOld!: (result: Page<ContextItemDTO>) => void;
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems)
    .mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve)),
    )
    .mockResolvedValueOnce(
      page([item({ id: 'current', title: 'Current account note' })], 2),
    );

  await mount(libraryApi, 'account-old');
  await act(async () => {
    root.render(
      createElement(ContextLibrary, {
        accountId: 'account-current',
        api: libraryApi,
        courses: [],
        subscribeToEvents: subscribe,
      }),
    );
  });
  await act(async () =>
    resolveOld(page([item({ id: 'old', title: 'Old account note' })], 1)),
  );
  expect(document.body.textContent).toContain('Current account note');
  expect(document.body.textContent).not.toContain('Old account note');

  const before = vi.mocked(libraryApi.listContextItems).mock.calls.length;
  await act(async () => {
    for (const listener of events)
      listener({
        version: 1,
        accountId: 'other-account',
        revision: 3,
        resource: 'context',
        targetId: null,
      });
  });
  expect(vi.mocked(libraryApi.listContextItems).mock.calls.length).toBe(before);
});

it('keeps cached Context readable while host read-only mode blocks mutations', async () => {
  const libraryApi = api();
  const cachedItem = item({
    id: 'cached-file',
    title: 'Cached study guide',
    kind: 'document',
    status: 'failed',
    courseIds: ['course-1'],
  });
  vi.mocked(libraryApi.listContextItems).mockResolvedValueOnce(
    page([cachedItem]),
  );
  await mount(
    libraryApi,
    'account-a',
    [
      {
        id: 'course-1',
        name: 'Biology 101',
        url: 'https://example.edu/course',
      },
    ],
    true,
  );

  expect(document.body.textContent).toContain('Cached study guide');
  expect(
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Add to Context"]',
    )?.disabled,
  ).toBe(true);
  expect(
    document.querySelector(
      'button[aria-label="Actions for Cached study guide"]',
    ),
  ).toBeNull();
  expect(
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview Cached study guide"]',
    )?.disabled,
  ).not.toBe(true);
  expect(
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open Biology 101"]',
    )?.disabled,
  ).not.toBe(true);
  expect(libraryApi.createContextNote).not.toHaveBeenCalled();
  expect(libraryApi.updateContextItem).not.toHaveBeenCalled();
  expect(libraryApi.linkContextItem).not.toHaveBeenCalled();
  expect(libraryApi.removeContextItem).not.toHaveBeenCalled();
  expect(libraryApi.retryContextIngestion).not.toHaveBeenCalled();
  expect(libraryApi.chooseContextFiles).not.toHaveBeenCalled();
});

it('refreshes its scoped snapshot across offline-local and online transitions', async () => {
  const libraryApi = api();
  let resolveOnline!: (result: Page<ContextItemDTO>) => void;
  vi.mocked(libraryApi.listContextItems)
    .mockImplementationOnce(
      () => new Promise((resolve) => (resolveOnline = resolve)),
    )
    .mockResolvedValueOnce(
      page([item({ id: 'offline-cache', title: 'Offline cached note' })], 2),
    )
    .mockResolvedValueOnce(
      page([item({ id: 'reconnected', title: 'Fresh online note' })], 3),
    );
  await mount(libraryApi, 'account-a', [], false);

  await act(async () => {
    root.render(
      createElement(ContextLibrary, {
        accountId: 'account-a',
        api: libraryApi,
        courses: [],
        readOnly: true,
        subscribeToEvents: subscribe,
      }),
    );
  });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Offline cached note'),
  );
  await act(async () =>
    resolveOnline(
      page([item({ id: 'stale-online', title: 'Stale online note' })], 1),
    ),
  );
  expect(document.body.textContent).not.toContain('Stale online note');

  await act(async () => {
    root.render(
      createElement(ContextLibrary, {
        accountId: 'account-a',
        api: libraryApi,
        courses: [],
        readOnly: false,
        subscribeToEvents: subscribe,
      }),
    );
  });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Fresh online note'),
  );
  expect(libraryApi.listContextItems).toHaveBeenCalledTimes(3);
});

it('refreshes Context snapshots without discarding an open note draft', async () => {
  const libraryApi = api();
  await mount(libraryApi);
  await click(document.querySelector('button[aria-label="Add to Context"]'));
  const addNote = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Text or note'),
  );
  await click(addNote ?? null);
  await setFieldValue(
    document.querySelector('input[name="title"]'),
    'Pending note title',
  );
  await setFieldValue(
    document.querySelector('textarea[name="text"]'),
    'Pending note body',
  );

  await mount(libraryApi, 'account-a', [], false, 1);
  await vi.waitFor(() =>
    expect(libraryApi.listContextItems).toHaveBeenCalledTimes(2),
  );
  expect(
    document.querySelector<HTMLInputElement>('input[name="title"]')?.value,
  ).toBe('Pending note title');
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[name="text"]')?.value,
  ).toBe('Pending note body');
});

it('preserves an open note draft and blocks its save during a read-only transition', async () => {
  const libraryApi = api();
  await mount(libraryApi);
  await click(document.querySelector('button[aria-label="Add to Context"]'));
  const addNote = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Text or note'),
  );
  await click(addNote ?? null);
  await setFieldValue(
    document.querySelector('input[name="title"]'),
    'Offline draft',
  );
  await setFieldValue(
    document.querySelector('textarea[name="text"]'),
    'Keep this note for reconnect.',
  );

  await act(async () => {
    root.render(
      createElement(ContextLibrary, {
        accountId: 'account-a',
        api: libraryApi,
        courses: [],
        readOnly: true,
        subscribeToEvents: subscribe,
      }),
    );
  });
  expect(
    document.querySelector<HTMLInputElement>('input[name="title"]')?.value,
  ).toBe('Offline draft');
  expect(
    document.querySelector<HTMLButtonElement>('button[type="submit"]')
      ?.disabled,
  ).toBe(true);
  await act(async () => {
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(libraryApi.createContextNote).not.toHaveBeenCalled();

  await act(async () => {
    root.render(
      createElement(ContextLibrary, {
        accountId: 'account-a',
        api: libraryApi,
        courses: [],
        readOnly: false,
        subscribeToEvents: subscribe,
      }),
    );
  });
  expect(
    document.querySelector<HTMLInputElement>('input[name="title"]')?.value,
  ).toBe('Offline draft');
  await act(async () => {
    document
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(libraryApi.createContextNote).toHaveBeenCalledOnce();
});

it('cancels a pending removal confirmation when entering read-only mode', async () => {
  const libraryApi = api();
  vi.mocked(libraryApi.listContextItems).mockResolvedValue(page([item()]));
  await mount(libraryApi);
  await click(
    document.querySelector('button[aria-label="Actions for Biology notes"]'),
  );
  const removeItem = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent?.includes('Remove from Context'),
  );
  await click(removeItem ?? null);
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

  await mount(libraryApi, 'account-a', [], true);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await mount(libraryApi, 'account-a', [], false);

  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(libraryApi.removeContextItem).not.toHaveBeenCalled();
});

it('renders learning preferences as a native link without button semantics warnings', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await mount(api());
    const link = [...document.querySelectorAll('a')].find((element) =>
      element.textContent?.includes('View learning preferences'),
    );
    expect(link?.getAttribute('href')).toBe(
      '#/dashboard/settings?section=personal-context',
    );
    expect(link?.getAttribute('role')).toBeNull();
    expect(
      errors.mock.calls.some(([message]) =>
        String(message).includes('nativeButton'),
      ),
    ).toBe(false);
  } finally {
    errors.mockRestore();
  }
});

it('shows a ready saved file once while retaining preview access and course assignment', async () => {
  const libraryApi = api();
  const ready = item({
    id: 'ready-file',
    title: 'Osmosis notes.pdf',
    kind: 'document',
    provenance: 'user-uploaded',
  });
  vi.mocked(libraryApi.listContextItems).mockResolvedValueOnce(page([ready]));
  vi.mocked(libraryApi.getContextItem).mockResolvedValueOnce({
    item: ready,
    versions: [],
    preview: {
      kind: 'text',
      text: 'Water crosses membranes.',
      locators: [],
      partial: false,
      uncertainty: null,
    },
  });
  await mount(libraryApi);
  const card = document.querySelector('[data-context-item-id="ready-file"]')!;
  expect(card.querySelector('[data-slot="attachment"]')).toBeNull();
  expect((card.textContent?.match(/ready to use/gi) ?? []).length).toBe(1);
  expect(card.querySelector('[role="combobox"]')).not.toBeNull();
  await click(
    card.querySelector('button[aria-label="Preview Osmosis notes.pdf"]'),
  );
  expect(libraryApi.getContextItem).toHaveBeenCalledWith({ itemId: ready.id });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Water crosses membranes.',
  );
});

it.each(['processing', 'failed'] as const)(
  'retains the existing attachment feedback for a %s file',
  async (status) => {
    const libraryApi = api();
    vi.mocked(libraryApi.listContextItems).mockResolvedValueOnce(
      page([item({ kind: 'document', status })]),
    );
    await mount(libraryApi);
    expect(
      document.querySelector(
        '[data-context-item-id="item-1"] [data-slot="attachment"]',
      ),
    ).not.toBeNull();
  },
);
