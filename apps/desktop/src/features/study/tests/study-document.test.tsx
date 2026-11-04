// @vitest-environment jsdom
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StudyDocument,
  StudyDocumentRenderersProvider,
  type StudyDocumentRenderers,
} from '../components/study-document';
import { useStudySession, type StudyBridge } from '../hooks/use-study-session';
import type {
  SourceReference,
  ContextItemDTO,
  ContextVersionDTO,
} from '@scholaros/services/learning/context-contracts';
import type {
  MessagePart,
  SessionSnapshot,
  StudyMessageDTO,
  StudySessionDTO,
  StudyTimerDTO,
} from '@scholaros/services/learning/study-contracts';
import type { PracticeSnapshot } from '@scholaros/services/learning/practice-contracts';
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import type { CurrentUser } from '../../onboarding/types';
import type { CourseDetail } from '../../courses/types';
import { PracticeView as ActualPracticeView } from '../../practice/components/practice-view';
import { ActivityHost as ActualActivityHost } from '../components/activity-host';
import type {
  ActivityHostBridge,
  ActivityRuntimeChange,
} from '../hooks/use-activity-host';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('a', { ...props, href: to }, children),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, 'scrollTo', {
  configurable: true,
  value: vi.fn(),
});

let root: ReturnType<typeof createRoot> | undefined;
let eventListener: ((event: ProductEventV1) => void) | undefined;

const student: CurrentUser = {
  id: 'student-a',
  name: 'Ada Lovelace',
  email: 'ada@example.edu',
  image: null,
  hasCompletedOnboarding: true,
};

const timer: StudyTimerDTO = {
  deadlineAt: null,
  revision: 0,
  expiredRevision: null,
  resolvedExpiredRevision: null,
  finishedAt: null,
};

const session = (
  overrides: Partial<StudySessionDTO> = {},
): StudySessionDTO => ({
  id: 'session-1',
  courseId: 'course-1',
  title: 'Cell biology review',
  activity: 'understand-topic',
  targetAssignmentId: null,
  topic: 'Cell division',
  status: 'in-progress',
  revision: 1,
  generationEpoch: 1,
  createdAt: '2026-11-03T12:00:00.000Z',
  updatedAt: '2026-11-03T12:00:00.000Z',
  lastOpenedAt: '2026-11-03T12:00:00.000Z',
  draft: { text: '', revision: 0 },
  timer,
  ...overrides,
});

const message = (
  id: string,
  sequence: number,
  role: StudyMessageDTO['role'],
  parts: MessagePart[],
  overrides: Partial<StudyMessageDTO> = {},
): StudyMessageDTO => ({
  id,
  sessionId: 'session-1',
  sequence,
  role,
  turnId: null,
  createdAt: `2026-11-03T12:0${sequence}:00.000Z`,
  parts,
  status: 'accepted',
  gradeDerived: false,
  gradeConsentRevision: null,
  ...overrides,
});

const sourceReference: SourceReference = {
  sourceKind: 'course-material',
  sourceId: 'material-1',
  versionId: 'material-version-2',
  courseId: 'course-1',
  locator: { kind: 'page', page: 3 },
  title: 'Cell division notes',
  provenance: 'connected-source',
  observedAt: '2026-11-02T18:30:00.000Z',
  state: 'current',
};

const snapshot = (
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot => ({
  session: session(),
  messages: [],
  hasMoreBefore: false,
  activeTurn: null,
  sourceReferences: [],
  revision: 1,
  ...overrides,
});

const makeContextItem = (
  overrides: Partial<ContextItemDTO> = {},
): ContextItemDTO => ({
  id: 'item-1',
  title: 'Lecture notes',
  kind: 'document',
  provenance: 'user-uploaded',
  courseIds: ['course-1'],
  currentVersionId: 'version-1',
  status: 'complete',
  usable: true,
  createdAt: '2026-11-03T12:00:00.000Z',
  updatedAt: '2026-11-03T12:00:00.000Z',
  revision: 1,
  source: {
    sessionId: 'session-1',
    sourceId: null,
    sourceVersion: null,
    removed: false,
  },
  ...overrides,
});

const makeContextVersion = (
  overrides: Partial<ContextVersionDTO> = {},
): ContextVersionDTO => ({
  id: 'version-1',
  itemId: 'item-1',
  contentHash: 'abc123',
  mimeType: 'text/plain',
  byteLength: 128,
  pageCount: null,
  extractionStatus: 'complete',
  interpretedPages: [],
  uncertainty: null,
  createdAt: '2026-11-03T12:00:00.000Z',
  originalAvailable: true,
  locators: [],
  ...overrides,
});

const makeCourse = () =>
  ({ id: 'course-1', name: 'Biology 101' }) as CourseDetail;

const renderers: StudyDocumentRenderers = {
  ActivityHost: ({
    artifactId,
    attemptId,
    presentation,
    readOnly,
  }: {
    artifactId: string;
    attemptId: string;
    presentation: 'inline' | 'expanded';
    readOnly: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-slot': 'test-activity',
        'data-presentation': presentation,
        'data-read-only': String(readOnly),
      },
      `${artifactId}:${attemptId}`,
    ),
  PracticeView: ({
    attemptId,
    readOnly,
  }: {
    attemptId: string;
    readOnly?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-slot': 'test-practice', 'data-read-only': String(readOnly) },
      attemptId,
    ),
  DictationControl: ({ onProvisional, onFinal, onCancel }) =>
    createElement(
      'div',
      null,
      createElement(
        'button',
        { onClick: () => onProvisional('partial words') },
        'Partial',
      ),
      createElement(
        'button',
        {
          onClick: () =>
            onFinal({
              text: 'final words',
              composerRevision: 0,
              selection: { start: 0, end: 0 },
            }),
        },
        'Final',
      ),
      createElement('button', { onClick: onCancel }, 'Cancel dictation'),
    ),
  ProgressSummary: ({ courseId }) =>
    createElement('div', { 'data-slot': 'test-progress' }, courseId),
  readSourcePreview: vi.fn(async (_sessionId, reference) => ({
    reference,
    preview: {
      kind: 'text' as const,
      text: 'Observed cell division notes.',
      locators: [],
      partial: false,
      uncertainty: null,
    },
  })),
  openSource: vi.fn(async () => undefined),
};

const bridge = (getStudySession = vi.fn(async () => snapshot())) => {
  eventListener = undefined;
  const value = {
    getCurrentUser: vi.fn(async () => student),
    getCourse: vi.fn(async () => makeCourse()),
    getGradeSettings: vi.fn(async () => ({
      enabled: false,
      notes: '',
      revision: 0,
      collectedCount: 0,
      updatedAt: '2026-11-03T12:00:00.000Z',
    })),
    getStudySession,
    onProductEvent: vi.fn((listener: (event: ProductEventV1) => void) => {
      eventListener = listener;
      return () => {
        eventListener = undefined;
      };
    }),
    saveStudyDraft: vi.fn(async (_input) => ({ draftRevision: 1 })),
    sendStudyTurn: vi.fn(async (_input) => ({ turnId: 'turn-1', revision: 2 })),
    retryStudyTurn: vi.fn(async (_input) => ({
      turnId: 'turn-1',
      revision: 3,
    })),
    cancelStudyTurn: vi.fn(async () => undefined),
    getContextItem: vi.fn(async () => ({
      item: makeContextItem(),
      versions: [makeContextVersion()],
      preview: {
        kind: 'text' as const,
        text: 'Observed lecture note text.',
        locators: [],
        partial: false,
        uncertainty: null,
      },
    })),
    chooseContextFiles: vi.fn(async () => ({ items: [], cancelled: false })),
    reconcileStudyDeadline: vi.fn(async () => timer),
    finishStudySession: vi.fn(async () => session({ status: 'finished' })),
    extendStudySession: vi.fn(async () => timer),
    continueStudyUntimed: vi.fn(async () => timer),
  };
  window.scholar = value as unknown as typeof window.scholar;
  return value as unknown as StudyBridge;
};

const mountDocument = async (
  props: {
    accountId?: string;
    sessionId?: string;
    refreshEpoch?: number;
    readOnly?: boolean;
  } = {},
  bridgeOverride = bridge(),
  renderersOverride: StudyDocumentRenderers = renderers,
) => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(
        StudyDocumentRenderersProvider,
        { renderers: renderersOverride },
        createElement(StudyDocument, {
          accountId: props.accountId ?? 'student-a',
          sessionId: props.sessionId ?? 'session-1',
          refreshEpoch: props.refreshEpoch ?? 0,
          readOnly: props.readOnly ?? false,
        }),
      ),
    ),
  );
  return { container, bridge: bridgeOverride };
};

const click = async (button: HTMLButtonElement) =>
  act(async () => button.click());

const activityBridge = () => {
  let nextRun = 0;
  const listeners = new Map<string, (event: ActivityRuntimeChange) => void>();
  const value: ActivityHostBridge = {
    getArtifactVersion: vi.fn(async ({ artifactId, versionId }) => ({
      artifactId,
      versionId,
      title: `Graph ${artifactId}`,
      objective: 'Explore how slope changes a line.',
      runtimeVersion: 1,
      contentDigest: 'digest-1',
      createdAt: '2026-11-03T12:00:00.000Z',
      sourceReferences: [],
      available: true,
    })),
    getArtifactState: vi.fn(async ({ artifactId, versionId, attemptId }) => ({
      artifactId,
      versionId,
      attemptId,
      stateRevision: 2,
      state: { inputs: { slope: 2 } },
      updatedAt: '2026-11-03T12:00:00.000Z',
    })),
    mountActivity: vi.fn(async () => ({ runId: `run-${++nextRun}` })),
    updateActivityBounds: vi.fn(async () => undefined),
    closeActivity: vi.fn(async () => undefined),
    onActivityChange: vi.fn((runId, listener) => {
      listeners.set(runId, listener);
      return () => {
        listeners.delete(runId);
      };
    }),
    retryActivityCheckpoint: vi.fn(async () => undefined),
    resetArtifactAttempt: vi.fn(),
    saveArtifactToContext: vi.fn(async () =>
      makeContextItem({ kind: 'activity' }),
    ),
  };
  Object.assign(window.scholar, value);
  return {
    value,
    emit: (event: ActivityRuntimeChange) => listeners.get(event.runId)?.(event),
  };
};

const drain = async () => {
  for (let hop = 0; hop < 8; hop += 1) await Promise.resolve();
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.ResizeObserver ??=
    ResizeObserverStub as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('StudyDocument', () => {
  it('reloads the saved session for a new route epoch without losing the composer draft', async () => {
    const getStudySession = vi.fn(async () => snapshot());
    const currentBridge = bridge(getStudySession);
    const { container } = await mountDocument({}, currentBridge);
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('Expected the study composer.');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      setter?.call(textarea, 'Keep this unsaved question during refresh.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      root?.render(
        createElement(
          StudyDocumentRenderersProvider,
          { renderers },
          createElement(StudyDocument, {
            accountId: 'student-a',
            sessionId: 'session-1',
            readOnly: false,
            refreshEpoch: 1,
          }),
        ),
      );
    });
    await vi.waitFor(() => expect(getStudySession).toHaveBeenCalledTimes(2));
    expect(textarea.value).toBe('Keep this unsaved question during refresh.');
  });

  it('renders chronological messages and their parts in persisted order', async () => {
    const first = message('message-1', 1, 'student', [
      { kind: 'text', text: 'First question' },
      { kind: 'attachment', itemId: 'item-1', versionId: 'version-1' },
    ]);
    const second = message('message-2', 2, 'tutor', [
      { kind: 'text', text: 'First explanation' },
      { kind: 'citation', reference: sourceReference },
      {
        kind: 'activity',
        artifactId: 'artifact-1',
        versionId: 'v1',
        attemptId: 'attempt-1',
      },
      { kind: 'practice', practiceAttemptId: 'practice-1' },
      { kind: 'text', text: 'Follow-up explanation' },
    ]);
    const currentBridge = bridge(
      vi.fn(async () => snapshot({ messages: [second, first] })),
    );
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Follow-up explanation'),
    );

    const text = container.textContent ?? '';
    expect(text.indexOf('First question')).toBeLessThan(
      text.indexOf('First explanation'),
    );
    expect(text.indexOf('First explanation')).toBeLessThan(
      text.indexOf('Cell division notes'),
    );
    expect(text.indexOf('Cell division notes')).toBeLessThan(
      text.indexOf('artifact-1:attempt-1'),
    );
    expect(text.indexOf('artifact-1:attempt-1')).toBeLessThan(
      text.indexOf('practice-1'),
    );
    expect(text.indexOf('practice-1')).toBeLessThan(
      text.indexOf('Follow-up explanation'),
    );
  });

  it('shows the real title, course, activity, timer and session status', async () => {
    const currentBridge = bridge();
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.querySelector('h1')?.textContent).toBe(
        'Cell biology review',
      ),
    );

    expect(container.textContent).toContain('Biology 101');
    expect(container.textContent).toContain('Understand a topic');
    expect(container.textContent).toContain('In progress');
    expect(
      container.querySelector('button[aria-label="Leave study session"]'),
    ).not.toBeNull();
  });

  it('renders only one timer expiry resolution for repeated historical markers', async () => {
    const expiredTimer: StudyTimerDTO = {
      deadlineAt: '2026-11-03T11:59:00.000Z',
      revision: 2,
      expiredRevision: 2,
      resolvedExpiredRevision: null,
      finishedAt: null,
    };
    const expiryMessage = (id: string, sequence: number) =>
      message(id, sequence, 'system-status', [
        {
          kind: 'status',
          code: 'study-timer-expired',
          label: 'Your planned study time has ended.',
        },
        ...(id === 'expiry-current'
          ? [
              {
                kind: 'status' as const,
                code: 'study-timer-expired',
                label: 'Your planned study time has ended.',
              },
            ]
          : []),
      ]);
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          session: session({
            timer: expiredTimer,
            draft: { text: 'Keep this draft through expiry', revision: 4 },
          }),
          messages: [
            expiryMessage('expiry-old', 1),
            expiryMessage('expiry-current', 2),
          ],
        }),
      ),
    );
    currentBridge.finishStudySession = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'offline' });
    });
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Study time ended'),
    );
    expect(
      container.querySelector<HTMLTextAreaElement>('#study-message-input')
        ?.value,
    ).toBe('Keep this draft through expiry');
    const finishButton = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Finish session'));
    expect(finishButton).not.toBeUndefined();
    await click(finishButton!);

    expect(
      container.querySelectorAll('[data-slot="study-timer-expiry-summary"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain('Reconnect and retry');
    expect(
      container.querySelector<HTMLTextAreaElement>('#study-message-input')
        ?.value,
    ).toBe('Keep this draft through expiry');
  });

  it.each([
    {
      width: 1000,
      readOnly: false,
      reducedMotion: false,
      layout: 'side-by-side',
    },
    { width: 680, readOnly: false, reducedMotion: true, layout: 'stacked' },
    {
      width: 1000,
      readOnly: true,
      reducedMotion: true,
      layout: 'side-by-side',
    },
    { width: 680, readOnly: true, reducedMotion: false, layout: 'stacked' },
  ])(
    'keeps each chronological activity mounted across expansion in $layout readOnly=$readOnly reducedMotion=$reducedMotion',
    async ({ width, readOnly, reducedMotion, layout }) => {
      const matchMedia = window.matchMedia;
      vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
        ...matchMedia(query),
        matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
      }));
      vi.spyOn(
        HTMLElement.prototype,
        'getBoundingClientRect',
      ).mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-activity-runtime-slot')) {
          return this.closest('[data-activity-panel-target]')
            ? new DOMRect(40, 400, 600, 300)
            : new DOMRect(40, 80, 500, 300);
        }
        return new DOMRect(0, 0, width, 800);
      });
      const messages = ['artifact-1', 'artifact-2'].map((artifactId, index) =>
        message(`message-${index + 1}`, index + 1, 'tutor', [
          { kind: 'text', text: `Before ${artifactId}` },
          {
            kind: 'activity',
            artifactId,
            versionId: 'v1',
            attemptId: 'attempt-1',
          },
          { kind: 'text', text: `After ${artifactId}` },
        ]),
      );
      const currentBridge = bridge(vi.fn(async () => snapshot({ messages })));
      const runtime = activityBridge();
      const mounted = vi.fn();
      const unmounted = vi.fn();
      const TrackedActivityHost: NonNullable<
        StudyDocumentRenderers['ActivityHost']
      > = (props) => {
        useEffect(() => {
          mounted(props.artifactId);
          return () => {
            unmounted(props.artifactId);
          };
        }, [props.artifactId]);
        return createElement(ActualActivityHost, props);
      };
      const { container } = await mountDocument({ readOnly }, currentBridge, {
        ...renderers,
        ActivityHost: TrackedActivityHost,
      });
      await vi.waitFor(() =>
        expect(runtime.value.mountActivity).toHaveBeenCalledTimes(2),
      );
      const cards = [
        ...container.querySelectorAll<HTMLElement>('[data-activity-host]'),
      ];
      const runIds = cards.map((card) => card.dataset.runtime);
      expect(runIds.every((runId) => runId && runId !== 'closed')).toBe(true);
      expect(new Set(runIds).size).toBe(2);
      const composer = container.querySelector('textarea');
      const history = container.querySelector(
        '[aria-label="Conversation history"]',
      )!;
      Object.defineProperty(history, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 120,
      });
      history.setAttribute('style', 'overflow-y: auto');
      await act(async () =>
        runtime.emit({
          runId: runIds[0]!,
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          versionId: 'v1',
          attemptId: 'attempt-1',
          kind: 'checkpoint-acknowledged',
          stateRevision: 3,
        }),
      );

      for (const index of [0, 1, 0]) {
        const messageElement = container.querySelector(
          `[data-message-id="message-${index + 1}"]`,
        )!;
        const expand = [
          ...messageElement.querySelectorAll<HTMLButtonElement>(
            'button[aria-label^="Expand activity"]',
          ),
        ].at(-1)!;
        await act(async () => expand.focus());
        await click(expand);
        await act(
          async () => new Promise((resolve) => setTimeout(resolve, 80)),
        );
        expect(messageElement.querySelector('[data-activity-host]')).toBe(
          cards[index],
        );
        expect(mounted).toHaveBeenCalledTimes(2);
        expect(unmounted).not.toHaveBeenCalled();
        const target = container.querySelector('[data-activity-panel-target]')!;
        expect(
          target.querySelector('[data-activity-runtime-slot]'),
        ).not.toBeNull();
        expect(
          container
            .querySelector('[data-activity-panel]')
            ?.getAttribute('data-layout'),
        ).toBe(layout);
        expect(
          container
            .querySelector('[data-slot="resizable-handle"]')
            ?.getAttribute('aria-orientation'),
        ).toBe(layout === 'stacked' ? 'horizontal' : 'vertical');
        const collapse = target.querySelector<HTMLButtonElement>(
          'button[aria-label="Collapse activity"]',
        )!;
        await vi.waitFor(() => expect(document.activeElement).toBe(collapse));
        await vi.waitFor(() =>
          expect(runtime.value.updateActivityBounds).toHaveBeenCalledWith({
            runId: runIds[index],
            bounds: { x: 40, y: 400, width: 600, height: 300 },
            visible: true,
          }),
        );
        if (index === 0)
          expect(target.textContent).toContain('Saved progress: revision 3');
        expect(history.scrollTop).toBe(120);
        await click(collapse);
        await act(
          async () => new Promise((resolve) => setTimeout(resolve, 80)),
        );
        await vi.waitFor(() => expect(document.activeElement).toBe(expand));
        expect(
          cards[index]?.querySelector('[data-activity-runtime-slot]'),
        ).not.toBeNull();
        expect(cards[index]?.dataset.runtime).toBe(runIds[index]);
        expect(
          container.querySelector('[data-activity-panel-target]'),
        ).toBeNull();
        expect(container.querySelectorAll('[data-activity-host]')).toHaveLength(
          2,
        );
        expect(runtime.value.mountActivity).toHaveBeenCalledTimes(2);
        expect(runtime.value.closeActivity).not.toHaveBeenCalled();
        expect(runtime.value.getArtifactState).toHaveBeenCalledTimes(2);
        expect(history.scrollTop).toBe(120);
        expect(container.querySelector('textarea')).toBe(composer);
      }
      expect(
        vi
          .mocked(runtime.value.mountActivity)
          .mock.calls.every(([input]) => input.readOnly === readOnly),
      ).toBe(true);
      if (readOnly)
        expect(
          container.querySelector('[aria-label^="Activity options"]'),
        ).toBeNull();
      expect(runtime.value.saveArtifactToContext).not.toHaveBeenCalled();
      expect(runtime.value.resetArtifactAttempt).not.toHaveBeenCalled();
      await act(async () => {
        root?.unmount();
        root = undefined;
      });
      expect(unmounted).toHaveBeenCalledTimes(2);
      expect(runtime.value.closeActivity).toHaveBeenCalledTimes(2);
    },
  );

  it('saves the real activity to the authorized session course from inline and expanded views', async () => {
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          session: session({ courseId: 'authorized-course' }),
          messages: [
            message('message-1', 1, 'tutor', [
              { kind: 'citation', reference: sourceReference },
              {
                kind: 'activity',
                artifactId: 'artifact-1',
                versionId: 'v1',
                attemptId: 'attempt-1',
              },
            ]),
          ],
        }),
      ),
    );
    const runtime = activityBridge();
    const { container } = await mountDocument({}, currentBridge, {
      ...renderers,
      ActivityHost: ActualActivityHost,
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Graph artifact-1'),
    );

    for (const expanded of [false, true]) {
      if (expanded)
        await click(
          container.querySelector<HTMLButtonElement>(
            '[aria-label="Expand activity"]',
          )!,
        );
      const view = expanded
        ? container.querySelector('[data-activity-panel-target]')!
        : container;
      await click(
        view.querySelector<HTMLButtonElement>(
          '[aria-label="Activity options for Graph artifact-1"]',
        )!,
      );
      const saveToCourse = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((item) => item.textContent?.includes('Save to course'))!;
      expect(saveToCourse).toBeDefined();
      expect(saveToCourse.getAttribute('aria-disabled')).not.toBe('true');
      await act(async () => saveToCourse.click());
      expect(runtime.value.saveArtifactToContext).toHaveBeenLastCalledWith({
        artifactId: 'artifact-1',
        versionId: 'v1',
        courseId: 'authorized-course',
        requestId: expect.any(String),
      });
    }
    expect(runtime.value.saveArtifactToContext).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a message attachment can no longer resolve its source', async () => {
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          messages: [
            message('message-1', 1, 'student', [
              {
                kind: 'attachment',
                itemId: 'missing-item',
                versionId: 'missing-version',
              },
            ]),
          ],
        }),
      ),
    );
    currentBridge.getContextItem = vi.fn(async () => null);
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Attachment unavailable'),
    );

    expect(container.textContent).toContain('Provenance unavailable');
    expect(currentBridge.getContextItem).toHaveBeenCalledWith({
      itemId: 'missing-item',
      versionId: 'missing-version',
    });
  });

  it('keeps per-file status when one selected attachment lookup fails', async () => {
    const currentBridge = bridge();
    currentBridge.chooseContextFiles = vi.fn(async () => ({
      items: [
        {
          itemId: 'item-ready',
          operationId: 'operation-1',
          status: 'complete' as const,
        },
        {
          itemId: 'item-unavailable',
          operationId: 'operation-2',
          status: 'complete' as const,
        },
      ],
      cancelled: false,
    }));
    currentBridge.getContextItem = vi.fn(
      async ({ itemId }: { itemId: string; versionId?: string }) => {
        if (itemId === 'item-unavailable') throw new Error('lookup failed');
        return {
          item: makeContextItem({ id: itemId }),
          versions: [makeContextVersion({ itemId })],
          preview: {
            kind: 'text' as const,
            text: 'Selected lecture notes.',
            locators: [],
            partial: false,
            uncertainty: null,
          },
        };
      },
    );
    const { container } = await mountDocument({}, currentBridge);
    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Add attachment"]',
      )!,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Lecture notes');
      expect(container.textContent).toContain('Attachment unavailable');
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]',
      )?.disabled,
    ).toBe(true);
    expect(currentBridge.chooseContextFiles).toHaveBeenCalledWith({
      sessionId: 'session-1',
      courseId: 'course-1',
      saveToLibrary: false,
    });
  });

  it('loads a source version and displays its current or historical state before guarded open', async () => {
    const historical = { ...sourceReference, state: 'historical' as const };
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          messages: [
            message('message-1', 1, 'tutor', [
              { kind: 'citation', reference: sourceReference },
            ]),
          ],
          sourceReferences: [historical],
        }),
      ),
    );
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Cell division notes'),
    );
    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Inspect source Cell division notes"]',
      )!,
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Historical version'),
    );

    expect(document.body.textContent).toContain('material-version-2');
    expect(document.body.textContent).toContain(
      'Observed cell division notes.',
    );
    expect(renderers.openSource).not.toHaveBeenCalled();
  });

  it('opens the exact current citation through the guarded source callback', async () => {
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          messages: [
            message('message-1', 1, 'tutor', [
              { kind: 'citation', reference: sourceReference },
            ]),
          ],
          sourceReferences: [sourceReference],
        }),
      ),
    );
    const { container } = await mountDocument({}, currentBridge);
    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Inspect source Cell division notes"]',
      )!,
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Observed cell division notes.',
      ),
    );
    await click(
      document.body.querySelector<HTMLButtonElement>(
        'button[aria-label="Open current source"]',
      )!,
    );

    expect(renderers.openSource).toHaveBeenCalledWith(
      'session-1',
      sourceReference,
    );
  });

  it('uses updated source state after a session refresh', async () => {
    const removedReference = {
      ...sourceReference,
      state: 'removed' as const,
    };
    let currentSnapshot = snapshot({
      messages: [
        message('message-1', 1, 'tutor', [
          { kind: 'citation', reference: sourceReference },
        ]),
      ],
      sourceReferences: [sourceReference],
    });
    const currentBridge = bridge(vi.fn(async () => currentSnapshot));
    const { container } = await mountDocument({}, currentBridge);
    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Inspect source Cell division notes"]',
      )!,
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Observed cell division notes.',
      ),
    );

    currentSnapshot = snapshot({
      messages: [
        message('message-1', 1, 'tutor', [
          { kind: 'citation', reference: sourceReference },
        ]),
      ],
      sourceReferences: [removedReference],
      revision: 2,
    });
    await act(async () =>
      eventListener?.({
        version: 1,
        accountId: 'student-a',
        resource: 'study',
        targetId: 'session-1',
        revision: 2,
      }),
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Source removed'),
    );

    expect(
      document.body.querySelector('button[aria-label="Open current source"]'),
    ).toBeNull();
  });

  it('hides preview text when the source lookup reports an unavailable source', async () => {
    const unavailableRenderers: StudyDocumentRenderers = {
      ...renderers,
      readSourcePreview: vi.fn(async (_sessionId, reference) => ({
        reference: { ...reference, state: 'unavailable' as const },
        preview: {
          kind: 'text' as const,
          text: 'STALE PRIVATE SOURCE TEXT',
          locators: [],
          partial: false,
          uncertainty: null,
        },
      })),
    };
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          messages: [
            message('message-1', 1, 'tutor', [
              { kind: 'citation', reference: sourceReference },
            ]),
          ],
          sourceReferences: [sourceReference],
        }),
      ),
    );
    const { container } = await mountDocument(
      {},
      currentBridge,
      unavailableRenderers,
    );
    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Inspect source Cell division notes"]',
      )!,
    );
    await vi.waitFor(() =>
      expect(unavailableRenderers.readSourcePreview).toHaveBeenCalled(),
    );

    expect(document.body.textContent).not.toContain(
      'STALE PRIVATE SOURCE TEXT',
    );
    expect(document.body.textContent).toContain('Source unavailable');
  });

  it('hides revoked grade-derived text and citations from an out-of-date snapshot', async () => {
    const privateReference = {
      ...sourceReference,
      sourceKind: 'grade-evidence' as const,
    };
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          messages: [
            message(
              'message-1',
              1,
              'tutor',
              [
                { kind: 'text', text: 'PRIVATE GRADE FEEDBACK' },
                { kind: 'citation', reference: privateReference },
              ],
              { gradeDerived: true, gradeConsentRevision: 1 },
            ),
          ],
          sourceReferences: [privateReference],
        }),
      ),
    );
    currentBridge.getGradeSettings = vi.fn(async () => ({
      enabled: true,
      notes: '',
      revision: 2,
      collectedCount: 1,
      updatedAt: '2026-11-03T12:00:00.000Z',
    }));
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        'grade permission could not be confirmed',
      ),
    );

    expect(container.textContent).not.toContain('PRIVATE GRADE FEEDBACK');
    expect(container.textContent).not.toContain('Cell division notes');
  });

  it('hides grade-evidence citations when grade permission is unavailable', async () => {
    const privateReference = {
      ...sourceReference,
      sourceKind: 'grade-evidence' as const,
    };
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          messages: [
            message('message-1', 1, 'tutor', [
              { kind: 'text', text: 'General study guidance' },
              { kind: 'citation', reference: privateReference },
            ]),
          ],
          sourceReferences: [privateReference],
        }),
      ),
    );
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.textContent).toContain('General study guidance'),
    );

    expect(container.textContent).not.toContain('Cell division notes');
    expect(
      container.querySelector(
        'button[aria-label="Inspect source Cell division notes"]',
      ),
    ).toBeNull();
  });

  it('shows a retryable loading error instead of inventing an empty conversation', async () => {
    const currentBridge = bridge(
      vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('offline'), { code: 'offline' }),
        ),
    );
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.textContent).toContain('could not be loaded'),
    );

    expect(
      container.querySelector('button[aria-label="Retry loading session"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('No messages yet');
  });

  it('keeps failed message content and offers the service retry for its same turn', async () => {
    const failed = message(
      'student-message',
      1,
      'student',
      [{ kind: 'text', text: 'Please explain this' }],
      { turnId: 'turn-failed', status: 'failed' },
    );
    const currentBridge = bridge(
      vi.fn(async () => snapshot({ messages: [failed] })),
    );
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Please explain this'),
    );
    const retryButton = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent?.includes('Retry response'));
    expect(retryButton).not.toBeUndefined();
    await click(retryButton!);

    expect(currentBridge.retryStudyTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-failed',
      requestId: expect.any(String),
    });
  });

  it('keeps cached study navigation readable while blocking offline-local mutations', async () => {
    const expiredTimer: StudyTimerDTO = {
      deadlineAt: '2026-11-03T11:59:00.000Z',
      revision: 2,
      expiredRevision: 2,
      resolvedExpiredRevision: null,
      finishedAt: null,
    };
    const failedTurn = message(
      'student-message',
      1,
      'student',
      [{ kind: 'text', text: 'Saved study question' }],
      { turnId: 'turn-failed', status: 'failed' },
    );
    const savedLesson = message('tutor-message', 2, 'tutor', [
      { kind: 'text', text: 'Cached explanation.' },
      {
        kind: 'activity',
        artifactId: 'activity-1',
        versionId: 'version-1',
        attemptId: 'attempt-1',
      },
      { kind: 'practice', practiceAttemptId: 'practice-1' },
      { kind: 'citation', reference: sourceReference },
      {
        kind: 'status',
        code: 'study-timer-expired',
        label: 'Study timer expired',
      },
    ]);
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          session: session({
            draft: { text: 'Saved study question', revision: 4 },
            timer: expiredTimer,
          }),
          messages: [failedTurn, savedLesson],
          hasMoreBefore: true,
          sourceReferences: [sourceReference],
        }),
      ),
    );
    const { container } = await mountDocument(
      { readOnly: true },
      currentBridge,
    );

    expect(container.textContent).toContain('Saved study question');
    expect(container.textContent).toContain('Cached explanation.');
    expect(
      container
        .querySelector('[data-slot="test-activity"]')
        ?.getAttribute('data-read-only'),
    ).toBe('true');
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea')?.readOnly,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Inspect sources"]',
      )?.disabled,
    ).not.toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Add attachment"]',
      )?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Send message"]',
      )?.disabled,
    ).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.includes('Retry response'),
      )?.disabled,
    ).toBe(true);
    expect(
      container
        .querySelector('[data-slot="test-practice"]')
        ?.getAttribute('data-read-only'),
    ).toBe('true');
    expect(
      container.querySelector('[data-slot="study-timer-expiry-summary"]'),
    ).not.toBeNull();
    expect(currentBridge.getGradeSettings).not.toHaveBeenCalled();
    expect(currentBridge.saveStudyDraft).not.toHaveBeenCalled();
    expect(currentBridge.sendStudyTurn).not.toHaveBeenCalled();
    expect(currentBridge.retryStudyTurn).not.toHaveBeenCalled();
    expect(currentBridge.cancelStudyTurn).not.toHaveBeenCalled();
    expect(currentBridge.chooseContextFiles).not.toHaveBeenCalled();
    expect(currentBridge.reconcileStudyDeadline).not.toHaveBeenCalled();
  });

  it('keeps the real PracticeView readable and non-mutating in read-only StudyDocument mode', async () => {
    const practiceAttempt: PracticeSnapshot = {
      id: 'practice-1',
      courseId: 'course-1',
      sessionId: 'session-1',
      mode: 'quiz',
      feedbackMode: 'end',
      status: 'in-progress',
      revision: 1,
      assisted: false,
      priorAttemptId: null,
      questions: [
        {
          id: 'practice-question-1',
          kind: 'numeric',
          prompt: 'What is one plus one?',
          options: null,
          unit: null,
          objectiveIds: ['objective-1'],
          sourceReferences: [],
        },
      ],
      answers: [
        {
          questionId: 'practice-question-1',
          revision: 1,
          value: '2',
          savedAt: '2026-11-03T12:00:00.000Z',
        },
      ],
      feedback: [],
    };
    const getPracticeAttempt = vi.fn(async () => practiceAttempt);
    const savePracticeAnswer = vi.fn(async () => practiceAttempt);
    const submitPracticeAttempt = vi.fn(async () => practiceAttempt);
    const switchPracticeToGuided = vi.fn(async () => practiceAttempt);
    const retryPracticeAttempt = vi.fn(async () => practiceAttempt);
    const practiceMessage = message('practice-message', 1, 'tutor', [
      { kind: 'practice', practiceAttemptId: practiceAttempt.id },
    ]);
    const currentBridge = bridge(
      vi.fn(async () => snapshot({ messages: [practiceMessage] })),
    );
    Object.assign(window.scholar, {
      getPracticeAttempt,
      savePracticeAnswer,
      submitPracticeAttempt,
      switchPracticeToGuided,
      retryPracticeAttempt,
    });
    const renderersWithPractice: StudyDocumentRenderers = {
      ...renderers,
      PracticeView: ({ accountId, sessionId, attemptId, readOnly }) =>
        createElement(ActualPracticeView, {
          accountId,
          sessionId,
          attemptId,
          readOnly,
        }),
    };
    const { container } = await mountDocument(
      { readOnly: true },
      currentBridge,
      renderersWithPractice,
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain('What is one plus one?'),
    );

    const answerInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Answer for question 1"]',
    );
    expect(answerInput?.value).toBe('2');
    expect(answerInput?.disabled).toBe(true);
    expect(container.textContent).toContain(
      'Reconnect online to save pending answers',
    );
    expect(getPracticeAttempt).toHaveBeenCalledOnce();

    await act(async () =>
      container
        .querySelector('section[aria-labelledby^="practice-title-"] form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(savePracticeAnswer).not.toHaveBeenCalled();
    expect(submitPracticeAttempt).not.toHaveBeenCalled();
    expect(switchPracticeToGuided).not.toHaveBeenCalled();
    expect(retryPracticeAttempt).not.toHaveBeenCalled();
  });

  it('refreshes a fresh study snapshot when host read-only mode changes and reconnects', async () => {
    const getStudySession = vi
      .fn()
      .mockResolvedValueOnce(
        snapshot({ session: session({ title: 'Online snapshot' }) }),
      )
      .mockResolvedValueOnce(
        snapshot({ session: session({ title: 'Offline cached snapshot' }) }),
      )
      .mockResolvedValueOnce(
        snapshot({ session: session({ title: 'Fresh online snapshot' }) }),
      );
    const currentBridge = bridge(getStudySession);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const render = (readOnly: boolean) =>
      createElement(
        StudyDocumentRenderersProvider,
        { renderers },
        createElement(StudyDocument, {
          accountId: 'student-a',
          sessionId: 'session-1',
          readOnly,
        }),
      );

    await act(async () => root?.render(render(false)));
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Online snapshot'),
    );
    expect(currentBridge.getGradeSettings).toHaveBeenCalledOnce();

    await act(async () => root?.render(render(true)));
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Offline cached snapshot'),
    );
    expect(currentBridge.getGradeSettings).toHaveBeenCalledOnce();

    await act(async () => root?.render(render(false)));
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Fresh online snapshot'),
    );
    expect(getStudySession).toHaveBeenCalledTimes(3);
    expect(currentBridge.getGradeSettings).toHaveBeenCalledTimes(2);
  });
});

describe('useStudySession account and session fences', () => {
  it('discards a late session reply after the displayed account and session change', async () => {
    let resolveOld: ((value: SessionSnapshot) => void) | undefined;
    const getStudySession = vi.fn(({ sessionId }: { sessionId: string }) =>
      sessionId === 'session-old'
        ? new Promise<SessionSnapshot>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(
            snapshot({
              session: session({
                id: 'session-new',
                title: 'New account session',
              }),
            }),
          ),
    );
    bridge(getStudySession as never);
    const View = ({
      accountId,
      sessionId,
    }: {
      accountId: string;
      sessionId: string;
    }) => {
      const state = useStudySession(accountId, sessionId);
      return createElement(
        'div',
        null,
        state.snapshot?.session.title ?? 'Loading',
      );
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        createElement(View, {
          accountId: 'student-a',
          sessionId: 'session-old',
        }),
      ),
    );
    await act(async () =>
      root?.render(
        createElement(View, {
          accountId: 'student-b',
          sessionId: 'session-new',
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain('New account session'),
    );

    await act(async () =>
      resolveOld?.(
        snapshot({
          session: session({
            id: 'session-old',
            title: 'Stale account session',
          }),
        }),
      ),
    );

    expect(container.textContent).toContain('New account session');
    expect(container.textContent).not.toContain('Stale account session');
  });

  it('reloads only for an event matching the current account and session', async () => {
    const getStudySession = vi.fn(async () => snapshot());
    bridge(getStudySession);
    const View = () => {
      const state = useStudySession('student-a', 'session-1');
      return createElement(
        'div',
        null,
        state.snapshot?.session.title ?? 'Loading',
      );
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(View)));
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Cell biology review'),
    );
    const initialCalls = getStudySession.mock.calls.length;

    await act(async () =>
      eventListener?.({
        version: 1,
        accountId: 'student-b',
        resource: 'study',
        targetId: 'session-1',
        revision: 4,
      }),
    );
    await act(async () =>
      eventListener?.({
        version: 1,
        accountId: 'student-a',
        resource: 'study',
        targetId: 'another-session',
        revision: 5,
      }),
    );
    expect(getStudySession).toHaveBeenCalledTimes(initialCalls);

    await act(async () =>
      eventListener?.({
        version: 1,
        accountId: 'student-a',
        resource: 'study',
        targetId: 'session-1',
        revision: 6,
      }),
    );
    await act(drain);

    expect(getStudySession).toHaveBeenCalledTimes(initialCalls + 1);
  });

  it('preserves cached grade settings while read-only refresh skips refetching', async () => {
    const currentBridge = bridge();
    let study: ReturnType<typeof useStudySession> | null = null;
    const View = ({ readOnly }: { readOnly: boolean }) => {
      study = useStudySession('student-a', 'session-1', readOnly);
      return createElement(
        'div',
        null,
        study.snapshot?.session.title ?? 'Loading',
      );
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(createElement(View, { readOnly: false })),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Cell biology review'),
    );
    const cachedGradeSettings = study!.gradeSettings;
    expect(cachedGradeSettings).not.toBeNull();

    await act(async () =>
      root?.render(createElement(View, { readOnly: true })),
    );
    await vi.waitFor(() =>
      expect(currentBridge.getStudySession).toHaveBeenCalledTimes(2),
    );

    expect(currentBridge.getGradeSettings).toHaveBeenCalledOnce();
    expect(study!.gradeSettings).toEqual(cachedGradeSettings);
  });

  it('guards every study mutation callback in host read-only mode', async () => {
    const currentBridge = bridge();
    let study: ReturnType<typeof useStudySession> | null = null;
    const View = () => {
      study = useStudySession('student-a', 'session-1', true);
      return createElement(
        'div',
        null,
        study.snapshot?.session.title ?? 'Loading',
      );
    };
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(View)));
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Cell biology review'),
    );

    await expect(study!.saveDraft('offline edit', 0)).rejects.toMatchObject({
      code: 'host-read-only',
    });
    await expect(
      study!.sendTurn({
        text: 'offline message',
        attachmentIds: [],
        expectedDraftRevision: 0,
        composerRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'host-read-only' });
    await expect(study!.retryTurn('turn-1')).rejects.toMatchObject({
      code: 'host-read-only',
    });
    await expect(study!.stopTurn('turn-1')).rejects.toMatchObject({
      code: 'host-read-only',
    });
    await expect(study!.timerActions.reconcile()).rejects.toMatchObject({
      code: 'host-read-only',
    });
    await expect(study!.timerActions.finish()).rejects.toMatchObject({
      code: 'host-read-only',
    });
    await expect(study!.timerActions.extend(15)).rejects.toMatchObject({
      code: 'host-read-only',
    });
    await expect(study!.timerActions.continueUntimed()).rejects.toMatchObject({
      code: 'host-read-only',
    });
    await expect(study!.addAttachments()).resolves.toEqual([]);

    expect(currentBridge.saveStudyDraft).not.toHaveBeenCalled();
    expect(currentBridge.sendStudyTurn).not.toHaveBeenCalled();
    expect(currentBridge.retryStudyTurn).not.toHaveBeenCalled();
    expect(currentBridge.cancelStudyTurn).not.toHaveBeenCalled();
    expect(currentBridge.reconcileStudyDeadline).not.toHaveBeenCalled();
    expect(currentBridge.finishStudySession).not.toHaveBeenCalled();
    expect(currentBridge.extendStudySession).not.toHaveBeenCalled();
    expect(currentBridge.continueStudyUntimed).not.toHaveBeenCalled();
    expect(currentBridge.chooseContextFiles).not.toHaveBeenCalled();
  });
});

it('places a destructive leave control on the right and confirms that saved work is kept', async () => {
  const currentBridge = bridge();
  const { container } = await mountDocument({}, currentBridge);
  await vi.waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
  const header = container.querySelector('header')!;
  const leave = header.querySelector<HTMLButtonElement>(
    'button[aria-label="Leave study session"]',
  );
  expect(leave).not.toBeNull();
  expect(header.lastElementChild?.contains(leave)).toBe(true);
  expect(leave?.className).toContain('destructive');
  expect(container.querySelector('a[href="/dashboard/study"]')).toBeNull();
  await act(async () => leave!.click());
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain('nothing is deleted');
  expect(dialog?.querySelector('a[href="/dashboard/study"]')).not.toBeNull();
  const cancel = [
    ...dialog!.querySelectorAll<HTMLButtonElement>('button'),
  ].find((button) => button.textContent === 'Stay in session');
  await act(async () => cancel!.click());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(container.querySelector('h1')?.textContent).toBe(
    'Cell biology review',
  );
});
