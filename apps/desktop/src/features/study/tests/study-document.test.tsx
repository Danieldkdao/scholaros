// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
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
import type { ProductEventV1 } from '@scholaros/services/learning/product-contracts';
import type { CurrentUser } from '../../onboarding/types';
import type { CourseDetail } from '../../courses/types';

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
  }: {
    artifactId: string;
    attemptId: string;
    presentation: 'inline' | 'expanded';
  }) =>
    createElement(
      'div',
      { 'data-slot': 'test-activity', 'data-presentation': presentation },
      `${artifactId}:${attemptId}`,
    ),
  PracticeView: ({ attemptId }) =>
    createElement('div', { 'data-slot': 'test-practice' }, attemptId),
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
  props: { accountId?: string; sessionId?: string } = {},
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
        }),
      ),
    ),
  );
  return { container, bridge: bridgeOverride };
};

const click = async (button: HTMLButtonElement) =>
  act(async () => button.click());

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
});

describe('StudyDocument', () => {
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
      container.querySelector('a[href="/dashboard/study"]'),
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

  it('moves one activity host into a resizable panel and restores focus on collapse', async () => {
    const currentBridge = bridge(
      vi.fn(async () =>
        snapshot({
          messages: [
            message('message-1', 1, 'tutor', [
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
    const { container } = await mountDocument({}, currentBridge);
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-presentation="inline"]'),
      ).not.toBeNull(),
    );
    const expandButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand activity artifact-1"]',
    )!;
    await click(expandButton);

    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-presentation="expanded"]'),
      ).not.toBeNull(),
    );
    expect(
      container.querySelectorAll('[data-slot="test-activity"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector(
        '[data-slot="resizable-panel-group"] [aria-orientation]',
      ),
    ).not.toBeNull();
    expect(document.activeElement?.textContent).toContain(
      'Interactive activity',
    );

    await click(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse activity panel"]',
      )!,
    );
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-presentation="inline"]'),
      ).not.toBeNull(),
    );
    expect(
      container.querySelectorAll('[data-slot="test-activity"]'),
    ).toHaveLength(1);
    expect(document.activeElement).toBe(
      container.querySelector(
        'button[aria-label="Expand activity artifact-1"]',
      ),
    );
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
});
