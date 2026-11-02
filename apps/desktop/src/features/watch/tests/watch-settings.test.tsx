// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { WatchSettings as WatchSettingsValue } from '../types';
import { WatchSettings } from '../components/watch-settings';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: Record<string, unknown>) =>
    createElement('a', { href: to, ...props }, children as string),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const connection = {
  id: 'canvas-connection',
  name: 'Canvas',
  host: 'canvas.school.edu',
  url: 'https://canvas.school.edu/courses',
  status: 'verified' as const,
  isCourseResource: true,
};

const mount = async (
  settings: WatchSettingsValue,
  onSave = vi.fn(async (next: WatchSettingsValue) => next),
  connections = [connection],
  accountId = `student-${crypto.randomUUID()}`,
  focusOnMount = false,
) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(WatchSettings, {
        accountId,
        settings,
        connections,
        status: 'off',
        onSave,
        focusOnMount,
      }),
    ),
  );
  return { container, root, onSave };
};

const changeInput = async (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const submit = async (container: HTMLElement) =>
  act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const click = async (element: Element) =>
  act(async () =>
    element.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );

it('disables watching and links to Connections when no course resource exists', async () => {
  const { container, root } = await mount(
    { watchEnabled: false, watchUrls: [] },
    undefined,
    [],
  );
  const toggle = container.querySelector(
    '[role="switch"]',
  ) as HTMLButtonElement;
  expect(toggle.getAttribute('aria-disabled')).toBe('true');
  expect(container.textContent).toContain(
    'Add a course resource connection to enable watching.',
  );
  expect(
    container.querySelector('a[href="/dashboard/connections"]'),
  ).not.toBeNull();
  await act(async () => root.unmount());
});

it('scrolls to and focuses the watcher section after a direct settings link', async () => {
  const { container, root } = await mount(
    { watchEnabled: false, watchUrls: [] },
    undefined,
    [],
    `focus-${crypto.randomUUID()}`,
    true,
  );
  const section = container.querySelector('#watch-course-pages');
  expect(document.activeElement).toBe(section);
  await act(async () => root.unmount());
});

it('shows configured home pages as defaults when the custom URL list is empty', async () => {
  const { container, root } = await mount({
    watchEnabled: true,
    watchUrls: [],
  });
  expect(container.textContent).toContain('Default');
  expect(container.textContent).toContain('canvas.school.edu/courses');
  expect(container.querySelector('[aria-label^="Remove "]')).toBeNull();
  await act(async () => root.unmount());
});

it('adds a validated custom URL, replaces defaults, and restores input focus', async () => {
  const save = vi.fn(async (next: WatchSettingsValue) => next);
  const { container, root } = await mount(
    { watchEnabled: true, watchUrls: [] },
    save,
  );
  const input = container.querySelector<HTMLInputElement>('input[name="url"]')!;
  await changeInput(
    input,
    'https://canvas.school.edu/courses/biology/assignments',
  );
  await submit(container);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith({
    watchEnabled: true,
    watchUrls: ['https://canvas.school.edu/courses/biology/assignments'],
  });
  expect(container.textContent).not.toContain('Default');
  expect(container.textContent).toContain(
    'canvas.school.edu/courses/biology/assignments',
  );
  expect(document.activeElement).toBe(input);
  await act(async () => root.unmount());
});

it('shows invalid and duplicate URLs inline and does not save them', async () => {
  const save = vi.fn(async (next: WatchSettingsValue) => next);
  const { container, root } = await mount(
    {
      watchEnabled: true,
      watchUrls: ['https://canvas.school.edu/courses/biology/assignments'],
    },
    save,
  );
  const input = container.querySelector<HTMLInputElement>('input[name="url"]')!;
  await changeInput(input, 'http://127.0.0.1/admin');
  await submit(container);
  expect(container.textContent).toContain('secure public HTTPS');
  await changeInput(
    input,
    'https://canvas.school.edu/courses/biology/assignments',
  );
  await submit(container);
  expect(container.textContent).toContain('already being watched');
  expect(save).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('removes the last custom URL to return to default targets', async () => {
  const customUrl = 'https://canvas.school.edu/courses/biology/assignments';
  const save = vi.fn(async (next: WatchSettingsValue) => next);
  const { container, root } = await mount(
    { watchEnabled: true, watchUrls: [customUrl] },
    save,
  );
  await click(
    container.querySelector('[aria-label="Remove ' + customUrl + '"]')!,
  );
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith({ watchEnabled: true, watchUrls: [] });
  expect(container.textContent).toContain('Default');
  expect(container.textContent).toContain('canvas.school.edu/courses');
  await act(async () => root.unmount());
});

it('hides configuration while disabled and keeps custom URLs for re-enabling', async () => {
  const customUrl = 'https://canvas.school.edu/courses/biology/assignments';
  const save = vi.fn(async (next: WatchSettingsValue) => next);
  const { container, root } = await mount(
    { watchEnabled: true, watchUrls: [customUrl] },
    save,
  );
  const toggle = container.querySelector('[role="switch"]')!;
  await click(toggle);
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith({
    watchEnabled: false,
    watchUrls: [customUrl],
  });
  expect(
    container.querySelector('[aria-label="Custom course pages"]'),
  ).toBeNull();
  await click(container.querySelector('[role="switch"]')!);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(container.querySelector(`[title="${customUrl}"]`)).not.toBeNull();
  await act(async () => root.unmount());
});
