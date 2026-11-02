// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { toast } from '@scholaros/ui/components/toast';
import { CourseRefreshActivity } from '../components/course-refresh-activity';
import type { CourseRefreshActivity as Activity } from '../types';

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
  expect(node.textContent).toContain('Opening course page');
  const trigger = node.querySelector('button')!;
  await act(async () => trigger.click());
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  for (const status of [
    'complete',
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
  expect(toast.success).toHaveBeenCalledWith(
    'Refresh stopped',
    expect.anything(),
  );
  expect(toast.error).toHaveBeenCalledWith(
    'Sign in to your academic source to refresh it.',
    expect.anything(),
  );
  expect(toast.error).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.render(
      createElement(CourseRefreshActivity, {
        activity: [{ ...run, status: 'failed' }],
      }),
    ),
  );
  expect(toast.error).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  node.remove();
});
