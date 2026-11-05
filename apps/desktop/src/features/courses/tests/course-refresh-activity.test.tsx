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
  expect(toast.success).toHaveBeenNthCalledWith(
    1,
    'Refresh complete',
    expect.anything(),
  );
  expect(toast.success).toHaveBeenCalledOnce();
  expect(toast.error).toHaveBeenNthCalledWith(
    1,
    'Sign in to your academic source to refresh it.',
    expect.anything(),
  );
  expect(toast.error).toHaveBeenNthCalledWith(
    2,
    'Opening course page',
    expect.anything(),
  );
  expect(toast.error).toHaveBeenCalledTimes(2);
  expect(toast.warning).toHaveBeenCalledTimes(2);
  expect(toast.warning).toHaveBeenNthCalledWith(
    1,
    'Refresh incomplete',
    expect.anything(),
  );
  expect(toast.warning).toHaveBeenNthCalledWith(
    2,
    'Refresh stopped',
    expect.anything(),
  );
  await act(async () =>
    root.render(
      createElement(CourseRefreshActivity, {
        activity: [{ ...run, status: 'failed' }],
      }),
    ),
  );
  expect(toast.error).toHaveBeenCalledTimes(2);
  await act(async () =>
    root.render(
      createElement(CourseRefreshActivity, {
        activity: [{ ...run, status: 'partial' }],
      }),
    ),
  );
  expect(toast.warning).toHaveBeenCalledTimes(3);
  expect(toast.warning).toHaveBeenNthCalledWith(
    3,
    'Refresh incomplete',
    expect.anything(),
  );
  await act(async () =>
    root.render(
      createElement(CourseRefreshActivity, {
        activity: [{ ...run, status: 'partial' }],
      }),
    ),
  );
  expect(toast.warning).toHaveBeenCalledTimes(3);
  await act(async () => root.unmount());
  node.remove();
});

it('keeps a long refresh history collapsed and opens a bounded newest-first log without dropping events', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const events = Array.from(
    { length: 120 },
    (_, index) => `Refresh event ${index}`,
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
              events: ['Older run event'],
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
    expect(history.textContent).toContain('Refresh event 0');
    expect(history.textContent).toContain('Refresh event 119');
    expect(history.querySelectorAll('[data-slot="trace-line"]')).toHaveLength(
      123,
    );
    expect(history.textContent!.indexOf('Refresh event 119')).toBeLessThan(
      history.textContent!.indexOf('Refresh event 0'),
    );
    expect(history.textContent!.indexOf('Refresh event 0')).toBeLessThan(
      history.textContent!.indexOf('Older run event'),
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
