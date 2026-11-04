// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StudyMessageDTO } from '@scholaros/services/learning/study-contracts';
import { StudyMessage } from '../components/study-message';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});
const message = (
  overrides: Partial<StudyMessageDTO> = {},
): StudyMessageDTO => ({
  id: 'message-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  sequence: 1,
  role: 'student',
  status: 'accepted',
  createdAt: '2026-11-04T12:00:00Z',
  gradeDerived: false,
  gradeConsentRevision: null,
  parts: [{ kind: 'text', text: 'Help me understand loops.' }],
  ...overrides,
});
const render = async (value: StudyMessageDTO) => {
  await act(async () =>
    root.render(
      createElement(StudyMessage, {
        message: value,
        gradeContentVisible: true,
        gradeEvidenceVisible: true,
        onInspectSource: vi.fn(),
      }),
    ),
  );
  return container.querySelector('[role="article"]')!;
};
it('uses a bounded borderless student bubble and moves focus-reveal metadata below it', async () => {
  const article = await render(message());
  const bubble = article.querySelector('[data-slot="card"]');
  expect(bubble).not.toBeNull();
  expect(bubble?.className).toContain('border-0');
  expect(bubble?.className).toContain('max-w-');
  expect(article.getAttribute('data-align')).toBe('end');
  expect(article.textContent).not.toContain('You');
  expect(article.querySelector('[data-slot="message-header"]')).toBeNull();
  const metadata = article.querySelector('[data-slot="message-footer"]')!;
  expect(metadata.querySelector('time')).not.toBeNull();
  expect(metadata.className).toContain('group-hover/study-message:opacity-100');
  expect(metadata.className).toContain(
    'group-focus-within/study-message:opacity-100',
  );
  expect(
    bubble!.compareDocumentPosition(metadata) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const group = container.querySelector('[data-message-id]') as HTMLElement;
  expect(group.tabIndex).toBe(0);
  act(() => group.focus());
  expect(document.activeElement).toBe(group);
});
it('keeps tutor text unboxed and failure information visible without a redundant failure badge', async () => {
  const article = await render(
    message({
      role: 'tutor',
      status: 'failed',
      parts: [
        { kind: 'text', text: 'Your saved explanation is still here.' },
        {
          kind: 'status',
          code: 'failed',
          label: 'The response could not be completed.',
        },
      ],
    }),
  );
  expect(article.querySelector('[data-slot="card"]')).toBeNull();
  expect(article.textContent).toContain(
    'Your saved explanation is still here.',
  );
  expect(article.textContent).toContain('The response could not be completed.');
  expect(article.textContent).not.toContain('Could not finish');
  expect(article.textContent).not.toContain('ScholarOS');
  expect(article.querySelector('[role="status"]')).not.toBeNull();
});
it('formats tutor Markdown while preserving student text', async () => {
  await render(
    message({
      role: 'tutor',
      parts: [{ kind: 'text', text: '## Loops\n\nUse **repetition**.' }],
    }),
  );
  expect(container.querySelector('h2')?.textContent).toBe('Loops');
  expect(container.querySelector('strong')?.textContent).toBe('repetition');
  await render(
    message({
      parts: [{ kind: 'text', text: '**Student text stays literal**' }],
    }),
  );
  expect(container.querySelector('strong')).toBeNull();
  expect(container.textContent).toContain('**Student text stays literal**');
});
it.each([
  ['feature-unavailable', 'Study responses are unavailable right now.'],
  [
    'provider-failed',
    'The study service could not finish this response. Please try again.',
  ],
  ['rate-limited', 'The study service is busy. Please try again shortly.'],
  ['offline', 'Reconnect to the internet to continue this response.'],
])(
  'shows a safe explanation for %s without rendering provider text',
  async (code, label) => {
    await render(
      message({
        role: 'system-status',
        status: 'failed',
        parts: [{ kind: 'status', code, label: 'UNTRUSTED_SECRET_ERROR' }],
      }),
    );
    expect(container.textContent).toContain(label);
    expect(container.textContent).not.toContain('UNTRUSTED_SECRET_ERROR');
  },
);
it('keeps source inspection host-owned beside formatted tutor text', async () => {
  const reference = {
    sourceKind: 'course-material' as const,
    sourceId: 'material-1',
    versionId: 'version-1',
    courseId: 'course-1',
    locator: { kind: 'page' as const, page: 2 },
    title: 'Course notes',
    provenance: 'connected-source' as const,
    observedAt: null,
    state: 'current' as const,
  };
  const onInspectSource = vi.fn();
  await act(async () =>
    root.render(
      createElement(StudyMessage, {
        message: message({
          role: 'tutor',
          parts: [
            { kind: 'text', text: '**Saved explanation**' },
            { kind: 'citation', reference },
          ],
        }),
        gradeContentVisible: true,
        gradeEvidenceVisible: true,
        onInspectSource,
      }),
    ),
  );
  const sourceButton = container.querySelector(
    '[aria-label="Inspect source Course notes"]',
  ) as HTMLButtonElement;
  expect(container.querySelector('strong')?.textContent).toBe(
    'Saved explanation',
  );
  act(() => sourceButton.click());
  expect(onInspectSource).toHaveBeenCalledWith(reference);
});
