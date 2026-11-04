// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LearningProgress } from '@scholaros/services/learning/memory-contracts';
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import { ProgressSummary } from '../components/progress-summary';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = '2026-11-03T12:00:00.000Z';
const sourceReference = {
  sourceKind: 'course-material' as const,
  sourceId: 'material-1',
  versionId: 'version-1',
  courseId: 'course-biology',
  locator: { kind: 'page' as const, page: 4 },
  title: 'Cell structure notes',
  provenance: 'connected-source' as const,
  observedAt: timestamp,
  state: 'current' as const,
};
const assistedStrength = {
  conceptId: 'concept-cell',
  label: 'Cell structure',
  summary: 'Explained the role of the cell membrane.',
  evidenceIds: ['attempt-1'],
  assisted: true,
  sourceReferences: [sourceReference],
};
const progress: LearningProgress = {
  courseId: 'course-biology',
  strengths: [assistedStrength],
  practiceTopics: [
    {
      conceptId: 'concept-osmosis',
      label: 'Osmosis',
      summary: 'Review how water moves across a membrane.',
      evidenceIds: ['attempt-2'],
      assisted: false,
      sourceReferences: [{ ...sourceReference, state: 'historical' }],
    },
  ],
  recentChanges: [
    {
      conceptId: 'concept-membrane',
      label: 'Cell membrane',
      summary: 'Used a source that was later removed.',
      evidenceIds: ['attempt-3'],
      assisted: false,
      sourceReferences: [
        {
          ...sourceReference,
          sourceId: 'removed-material',
          title: 'Removed course handout',
          state: 'removed',
        },
      ],
    },
  ],
  unknownCount: 2,
  revision: 4,
};
const emptyProgress: LearningProgress = {
  courseId: null,
  strengths: [],
  practiceTopics: [],
  recentChanges: [],
  unknownCount: 3,
  revision: 1,
};

let root: ReturnType<typeof createRoot>;
let bridge: Record<string, ReturnType<typeof vi.fn>>;

const renderSummary = async (accountId = 'student-a') => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ProgressSummary, { accountId, courseId: 'course-biology' }),
    ),
  );
  return container;
};

beforeEach(() => {
  bridge = {
    getLearningProgress: vi.fn(async () => progress),
    onProductEvent: vi.fn(() => () => undefined),
  };
  window.scholar = bridge as unknown as typeof window.scholar;
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('shows evidence-backed sections, source locators, and assisted evidence tags', async () => {
  const container = await renderSummary();
  await vi.waitFor(() => expect(bridge.getLearningProgress).toHaveBeenCalled());

  expect(container.textContent).toContain('Strengths');
  expect(container.textContent).toContain('Topics to practice');
  expect(container.textContent).toContain('Recent changes');
  expect(container.textContent).toContain('Cell structure notes');
  expect(container.textContent).toContain('Page 4');
  expect(container.textContent).toContain('Current source');
  expect(container.textContent).toContain('Historical source');
  expect(container.textContent).toContain('Removed source');
  expect(container.textContent).toContain('Assisted evidence');
  expect(container.textContent).toContain('Independent evidence');
  expect(container.textContent).toContain(
    '2 topics without enough evidence yet',
  );
  expect(container.textContent).not.toContain('%');
});

it('keeps unknown topics neutral instead of labeling them as difficulty', async () => {
  bridge.getLearningProgress.mockResolvedValueOnce(emptyProgress);
  const container = await renderSummary();
  await vi.waitFor(() =>
    expect(container.textContent).toContain('Not enough evidence yet'),
  );

  expect(container.textContent).toContain(
    '3 topics without enough evidence yet',
  );
  expect(container.textContent).not.toContain('Weak');
  expect(container.textContent).not.toContain('Low ability');
  expect(container.textContent).not.toContain('Difficulty');
});

it('rehydrates progress only for newer same-account learning events', async () => {
  let publish!: (event: ProductEventV1) => void;
  bridge.onProductEvent.mockImplementation(
    (listener: (event: ProductEventV1) => void) => {
      publish = listener;
      return () => undefined;
    },
  );
  const container = await renderSummary();
  await vi.waitFor(() =>
    expect(bridge.getLearningProgress).toHaveBeenCalledOnce(),
  );

  await act(async () =>
    publish({
      version: 1,
      accountId: 'another-student',
      revision: 5,
      resource: 'study',
      targetId: null,
    }),
  );
  await act(async () =>
    publish({
      version: 1,
      accountId: 'student-a',
      revision: 4,
      resource: 'memory',
      targetId: null,
    }),
  );
  expect(bridge.getLearningProgress).toHaveBeenCalledOnce();

  await act(async () =>
    publish({
      version: 1,
      accountId: 'student-a',
      revision: 5,
      resource: 'memory',
      targetId: null,
    }),
  );
  await vi.waitFor(() =>
    expect(bridge.getLearningProgress).toHaveBeenCalledTimes(2),
  );
  expect(container.textContent).toContain('Cell structure');
});

it('ignores progress from the previous account', async () => {
  let resolveOld!: (value: LearningProgress) => void;
  bridge.getLearningProgress.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const container = await renderSummary('student-old');
  await act(async () =>
    root.render(
      createElement(ProgressSummary, {
        accountId: 'student-new',
        courseId: 'course-biology',
      }),
    ),
  );
  await vi.waitFor(() =>
    expect(bridge.getLearningProgress).toHaveBeenCalledTimes(2),
  );
  await act(async () =>
    resolveOld({
      ...progress,
      strengths: [{ ...assistedStrength, label: 'Old account topic' }],
    }),
  );

  expect(container.textContent).toContain('Cell structure');
  expect(container.textContent).not.toContain('Old account topic');
});
