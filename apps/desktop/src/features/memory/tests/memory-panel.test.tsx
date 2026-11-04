// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MemoryDTO } from '@scholaros/services/learning/memory-contracts';
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import type { CoursesSnapshot } from '../../courses/types';
import { MemoryPanel } from '../components/memory-panel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = '2026-11-03T12:00:00.000Z';
const explicitMemory: MemoryDTO = {
  id: 'memory-explicit',
  courseId: null,
  type: 'explicit-preference',
  content: { field: 'explanation-length', value: 'Keep explanations concise' },
  provenance: 'student-explicit',
  evidenceIds: ['evidence-1'],
  confidence: null,
  revision: 5,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const provisionalMemory: MemoryDTO = {
  id: 'memory-provisional',
  courseId: 'course-biology',
  type: 'provisional-preference',
  content: { field: 'vocabulary', value: 'Use plain language' },
  provenance: 'meta-inferred',
  evidenceIds: ['evidence-2'],
  confidence: 0.6,
  revision: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const memoryPage = (items: MemoryDTO[], revision = 1) => ({
  items,
  nextCursor: null,
  revision,
});
const coursesSnapshot: CoursesSnapshot = {
  courses: [
    {
      id: 'course-biology',
      name: 'Biology',
      code: null,
      term: null,
      connectionId: 'connection-1',
      instructor: null,
      description: null,
      url: 'https://school.example/course',
      active: true,
      sourceName: 'Schoology',
      sourceHost: 'school.example',
      sourceState: 'connected',
      lastSeenAt: timestamp,
      overviewSyncedAt: timestamp,
      announcementsStatus: 'complete',
      announcementsSyncedAt: timestamp,
      assignmentsStatus: 'complete',
      assignmentsSyncedAt: timestamp,
      announcementCount: 0,
      assignmentCount: 0,
    },
  ],
  sources: [],
  lastSuccessfulAt: timestamp,
};

let root: ReturnType<typeof createRoot>;
let bridge: Record<string, ReturnType<typeof vi.fn>>;
let storedMemories: MemoryDTO[];

const renderPanel = async (accountId = 'student-a') => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(MemoryPanel, { accountId })));
  return container;
};

const clickButton = async (name: string, occurrence = 0) => {
  const button = [...document.querySelectorAll('button')].filter(
    (candidate) =>
      candidate.getAttribute('aria-label') === name ||
      candidate.textContent?.trim() === name,
  )[occurrence];
  if (!button) throw new Error(`Could not find button: ${name}`);
  await act(async () => button.click());
};

const setInputValue = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    const prototype =
      input.ownerDocument.defaultView!.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const submitForm = async (label: string) =>
  act(async () => {
    document
      .querySelector<HTMLFormElement>(`form[aria-label="${label}"]`)!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

beforeEach(() => {
  storedMemories = [explicitMemory, provisionalMemory];
  bridge = {
    onCoursesChange: vi.fn(() => () => undefined),
    getCourses: vi.fn(async () => coursesSnapshot),
    onBackgroundSyncChange: vi.fn(() => () => undefined),
    listMemories: vi.fn(async () => memoryPage([...storedMemories])),
    correctMemory: vi.fn(
      async (input: { memoryId: string; preference: MemoryDTO['content'] }) => {
        const correctedMemory = {
          ...provisionalMemory,
          type: 'explicit-preference' as const,
          provenance: 'student-explicit' as const,
          content: input.preference,
          revision: provisionalMemory.revision + 1,
        };
        storedMemories = storedMemories.map((memory) =>
          memory.id === input.memoryId ? correctedMemory : memory,
        );
        return correctedMemory;
      },
    ),
    deleteMemory: vi.fn(async (input: { memoryId: string }) => {
      storedMemories = storedMemories.filter(
        (memory) => memory.id !== input.memoryId,
      );
    }),
    onProductEvent: vi.fn(() => () => undefined),
  };
  window.scholar = bridge as unknown as typeof window.scholar;
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: true,
  });
  vi.restoreAllMocks();
});

it('shows explicit and provisional provenance, course scope, and bounded filters', async () => {
  const container = await renderPanel();
  await vi.waitFor(() => expect(bridge.listMemories).toHaveBeenCalled());

  expect(container.textContent).toContain('Explicit preference');
  expect(container.textContent).toContain('Provisional preference');
  expect(container.textContent).toContain('You told ScholarOS');
  expect(container.textContent).toContain('Inferred from study patterns');
  expect(container.textContent).toContain('Account-wide');
  expect(container.textContent).toContain('Biology');
  expect(container.textContent).toContain('1 evidence record');
  expect(container.querySelector('input[maxlength="200"]')).not.toBeNull();
  await clickButton('Remembered information filters');
  expect(
    document.querySelector('[aria-label="Filter memories by type"]'),
  ).not.toBeNull();
  expect(
    document.querySelector('[aria-label="Filter memories by course"]'),
  ).not.toBeNull();
});

it('preserves an edited draft after a correction fails and retries with its revision', async () => {
  bridge.correctMemory
    .mockRejectedValueOnce(new Error('Service unavailable'))
    .mockImplementationOnce(
      async (input: { memoryId: string; preference: MemoryDTO['content'] }) => {
        const correctedMemory = {
          ...provisionalMemory,
          type: 'explicit-preference' as const,
          provenance: 'student-explicit' as const,
          content: input.preference,
          revision: provisionalMemory.revision + 1,
        };
        storedMemories = storedMemories.map((memory) =>
          memory.id === input.memoryId ? correctedMemory : memory,
        );
        return correctedMemory;
      },
    );
  const container = await renderPanel();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Use plain language'),
  );
  await clickButton('Edit Vocabulary');

  const value = document.querySelector<HTMLInputElement>(
    'input[aria-label="Preference value"]',
  )!;
  await setInputValue(value, 'Use simple words');
  await submitForm('Edit remembered preference');
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Service unavailable'),
  );
  expect(
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Preference value"]',
    )?.value,
  ).toBe('Use simple words');

  await submitForm('Edit remembered preference');
  await vi.waitFor(() => expect(bridge.correctMemory).toHaveBeenCalledTimes(2));
  expect(bridge.correctMemory).toHaveBeenLastCalledWith({
    memoryId: provisionalMemory.id,
    expectedRevision: provisionalMemory.revision,
    preference: { field: 'vocabulary', value: 'Use simple words' },
  });
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')).toBeNull(),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Use simple words'),
  );
  expect(container.textContent).not.toContain('Use plain language');
});

it('keeps deletion confirmation open after failure and retries without deleting the source', async () => {
  bridge.deleteMemory.mockImplementationOnce(async () => {
    throw new Error('Temporary storage error');
  });
  const container = await renderPanel();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Keep explanations concise'),
  );
  await clickButton('Delete Explanation length');

  expect(document.body.textContent).toContain(
    'This removes the memory from future study context without deleting its source or transcript.',
  );
  await clickButton('Delete memory');
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Temporary storage error'),
  );
  expect(document.body.textContent).toContain('Keep explanations concise');

  await clickButton('Delete memory');
  await vi.waitFor(() => expect(bridge.deleteMemory).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(container.textContent).not.toContain('Keep explanations concise'),
  );
  expect(bridge.deleteMemory).toHaveBeenLastCalledWith({
    memoryId: explicitMemory.id,
    expectedRevision: explicitMemory.revision,
  });
});

it('bounds search text and applies type and course filters to paged reads', async () => {
  const container = await renderPanel();
  await vi.waitFor(() => expect(bridge.listMemories).toHaveBeenCalled());
  const searchInput = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search remembered information"]',
  )!;
  const query = 'biology '.repeat(35);
  await setInputValue(searchInput, query);
  await vi.waitFor(() =>
    expect(bridge.listMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: query.trim().slice(0, 200), limit: 50 }),
    ),
  );

  await clickButton('Remembered information filters');
  const typeTrigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="Filter memories by type"]',
  )!;
  await act(async () => typeTrigger.click());
  const observationOption = await vi.waitFor(() => {
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find(
      (candidate) => candidate.textContent?.trim() === 'Learning observation',
    );
    if (!option) throw new Error('Memory type options did not open.');
    return option;
  });
  await act(async () => observationOption.click());
  await vi.waitFor(() =>
    expect(bridge.listMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: query.trim().slice(0, 200),
        type: 'learning-observation',
        limit: 50,
      }),
    ),
  );

  const courseTrigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="Filter memories by course"]',
  )!;
  await act(async () => courseTrigger.click());
  const courseOption = await vi.waitFor(() => {
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((candidate) => candidate.textContent?.trim() === 'Biology');
    if (!option) throw new Error('Course filter options did not open.');
    return option;
  });
  await act(async () => courseOption.click());
  await vi.waitFor(() =>
    expect(bridge.listMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: query.trim().slice(0, 200),
        type: 'learning-observation',
        courseId: 'course-biology',
        limit: 50,
      }),
    ),
  );
});

it('keeps editor focus contained and associates inline validation errors', async () => {
  const container = await renderPanel();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Use plain language'),
  );
  const editButtons = [...document.querySelectorAll('button')].filter(
    (candidate) => candidate.getAttribute('aria-label')?.startsWith('Edit '),
  );
  const trigger = editButtons[1];
  await act(async () => {
    trigger.focus();
    trigger.click();
  });

  const dialog = document.querySelector('[role="dialog"]')!;
  await vi.waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true),
  );
  const value = dialog.querySelector<HTMLInputElement>(
    'input[aria-label="Preference value"]',
  )!;
  await setInputValue(value, '');
  await submitForm('Edit remembered preference');

  expect(value.getAttribute('aria-invalid')).toBe('true');
  const errorId = value.getAttribute('aria-describedby')?.split(' ').at(-1);
  expect(document.getElementById(errorId!)?.textContent).toContain(
    'Add a preference before saving.',
  );
  await act(async () =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  await vi.waitFor(() =>
    expect(document.querySelector('[role="dialog"]')).toBeNull(),
  );
  expect(document.activeElement).toBe(trigger);
});

it('shows loading and a genuine empty result without treating it as an error', async () => {
  let resolvePage!: (page: ReturnType<typeof memoryPage>) => void;
  bridge.listMemories.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
  );
  const container = await renderPanel();
  expect(
    container.querySelector('[aria-label="Loading remembered information"]'),
  ).not.toBeNull();

  await act(async () => resolvePage(memoryPage([])));
  await vi.waitFor(() =>
    expect(container.textContent).toContain('No matching memories'),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('shows retryable read errors and a distinct offline state', async () => {
  bridge.listMemories.mockRejectedValueOnce(new Error('Service unavailable'));
  const container = await renderPanel();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Service unavailable'),
  );
  await clickButton('Try again');
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Keep explanations concise'),
  );

  act(() => root.unmount());
  document.body.replaceChildren();
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: false,
  });
  bridge.listMemories.mockRejectedValueOnce(new Error('Service unavailable'));
  const offlineContainer = await renderPanel();
  await vi.waitFor(() =>
    expect(offlineContainer.textContent).toContain(
      'Remembered information is unavailable offline.',
    ),
  );
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: true,
  });
});

it('reloads only for newer memory events in the active account', async () => {
  let publish!: (event: ProductEventV1) => void;
  bridge.onProductEvent.mockImplementation(
    (listener: (event: ProductEventV1) => void) => {
      publish = listener;
      return () => undefined;
    },
  );
  const container = await renderPanel();
  await vi.waitFor(() => expect(bridge.listMemories).toHaveBeenCalledOnce());

  await act(async () =>
    publish({
      version: 1,
      accountId: 'another-student',
      revision: 2,
      resource: 'memory',
      targetId: null,
    }),
  );
  await act(async () =>
    publish({
      version: 1,
      accountId: 'student-a',
      revision: 1,
      resource: 'memory',
      targetId: null,
    }),
  );
  expect(bridge.listMemories).toHaveBeenCalledOnce();

  await act(async () =>
    publish({
      version: 1,
      accountId: 'student-a',
      revision: 2,
      resource: 'memory',
      targetId: null,
    }),
  );
  await vi.waitFor(() => expect(bridge.listMemories).toHaveBeenCalledTimes(2));
  expect(container.textContent).toContain('Keep explanations concise');

  await act(async () => window.dispatchEvent(new Event('online')));
  await vi.waitFor(() => expect(bridge.listMemories).toHaveBeenCalledTimes(3));
});

it('ignores a memory response from the previous account', async () => {
  let resolveOld!: (value: ReturnType<typeof memoryPage>) => void;
  bridge.listMemories.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const container = await renderPanel('student-old');
  await act(async () =>
    root.render(createElement(MemoryPanel, { accountId: 'student-new' })),
  );
  await vi.waitFor(() => expect(bridge.listMemories).toHaveBeenCalledTimes(2));
  await act(async () => resolveOld(memoryPage([explicitMemory])));

  expect(container.textContent).toContain('Keep explanations concise');
  expect(container.textContent).toContain('Use plain language');
  expect(bridge.listMemories).toHaveBeenCalledTimes(2);
});
