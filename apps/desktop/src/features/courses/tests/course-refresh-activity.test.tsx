// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { toast } from '@scholaros/ui/components/toast';
import { CourseRefreshActivity } from '../components/course-refresh-activity';
import type { CourseRefreshActivityView as Activity } from '../components/course-refresh-activity';

vi.mock('@scholaros/ui/components/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

it('shows live actions, collapses, and toasts each terminal transition once', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const run: Activity = {
    id: 'run',
    key: 'course-1',
    status: 'running',
    events: ['Opening course page'],
  };
  await act(async () =>
    root.render(createElement(CourseRefreshActivity, { activity: [run] })),
  );
  const trigger = node.querySelector('button')!;
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(trigger.textContent).toContain('Refreshing courses…');
  await act(async () => trigger.click());
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(node.textContent).toContain('Opening course page');
  await act(async () => trigger.click());
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  for (const status of [
    'complete',
    'partial',
    'cancelled',
    'sign-in-required',
    'failed',
  ] as const) {
    await act(async () =>
      root.render(
        createElement(CourseRefreshActivity, {
          activity: [{ ...run, status }],
        }),
      ),
    );
  }
  expect(toast.success).toHaveBeenCalledTimes(4);
  for (const call of vi.mocked(toast.success).mock.calls) {
    expect(call[0]).toBe('Refresh complete');
  }
  expect(toast.warning).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledExactlyOnceWith(
    'Sign in to your academic source to refresh it.',
    expect.anything(),
  );
  await act(async () =>
    root.render(
      createElement(CourseRefreshActivity, {
        activity: [{ ...run, status: 'failed' }],
      }),
    ),
  );
  expect(toast.success).toHaveBeenCalledTimes(4);
  expect(toast.error).toHaveBeenCalledOnce();
  const diagnosticEvents = [
    'Opening course page',
    'Refresh detail: more collection pages remain unread.',
    'Some course data could not be read.',
    'Reading the course source timed out. Retry the refresh.',
    'Sign in to this resource in your study browser, then refresh.',
  ];
  await act(async () =>
    root.render(
      createElement(CourseRefreshActivity, {
        activity: [{ ...run, status: 'partial', events: diagnosticEvents }],
      }),
    ),
  );
  expect(node.textContent).toContain('Refresh complete');
  expect(toast.success).toHaveBeenCalledTimes(5);
  await act(async () => trigger.click());
  expect(node.textContent).toContain('Opening course page');
  expect(node.textContent).toContain('Sign in to this resource');
  expect(node.textContent).not.toContain('remain unread');
  expect(node.textContent).not.toContain('could not be read');
  expect(node.textContent).not.toContain('timed out');
  expect(diagnosticEvents).toHaveLength(5);
  await act(async () =>
    root.render(
      createElement(CourseRefreshActivity, {
        activity: [{ ...run, status: 'partial', events: diagnosticEvents }],
      }),
    ),
  );
  expect(toast.success).toHaveBeenCalledTimes(5);
  await act(async () => root.unmount());
  node.remove();
});

it('keeps a long refresh history collapsed and opens a bounded newest-first log without dropping events', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const events = Array.from(
    { length: 120 },
    (_, index) => `Opening course page ${index}`,
  );
  try {
    await act(async () =>
      root.render(
        createElement(CourseRefreshActivity, {
          activity: [
            {
              id: 'older',
              key: 'courses',
              status: 'complete',
              events: ['Checking an older connected source'],
            },
            { id: 'current', key: 'course-1', status: 'running', events },
          ],
        }),
      ),
    );
    const trigger = node.querySelector('button')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(node.querySelector('[data-slot="scroll-area"]')).toBeNull();
    await act(async () => trigger.click());
    const history = node.querySelector('[data-slot="scroll-area"]')!;
    expect(history.className).toContain('h-48');
    expect(history.textContent).toContain('Opening course page 0');
    expect(history.textContent).toContain('Opening course page 119');
    expect(history.querySelectorAll('[data-slot="trace-line"]')).toHaveLength(
      123,
    );
    expect(
      history.textContent!.indexOf('Opening course page 119'),
    ).toBeLessThan(history.textContent!.indexOf('Opening course page 0'));
    expect(history.textContent!.indexOf('Opening course page 0')).toBeLessThan(
      history.textContent!.indexOf('Checking an older connected source'),
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
