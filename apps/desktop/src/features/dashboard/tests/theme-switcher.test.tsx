// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { ThemeSwitcher } = await import('../theme-switcher');
const { Providers } = await import('../../../components/providers');

const STORAGE_KEY = 'scholaros-theme';

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

const mount = async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Providers, null, createElement(ThemeSwitcher)));
  });
};

const trigger = () => container.querySelector('button');

const openMenu = async () => {
  await act(async () => {
    for (const type of [
      'pointerdown',
      'mousedown',
      'pointerup',
      'mouseup',
      'click',
    ])
      trigger()!.dispatchEvent(
        type.startsWith('pointer')
          ? new PointerEvent(type, { bubbles: true })
          : new MouseEvent(type, { bubbles: true }),
      );
  });
};

const options = () => [
  ...(document.body.querySelectorAll(
    '[data-slot="dropdown-menu-radio-item"]',
  ) ?? []),
];

const choose = async (label: string) => {
  const option = options().find((item) => item.textContent?.includes(label));
  expect(option, `missing a "${label}" theme option`).toBeTruthy();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const checkedOption = () =>
  options().find((item) => item.getAttribute('aria-checked') === 'true');

// jsdom reports a media query list without the legacy listener next-themes uses.
const installMatchMedia = () => {
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
};

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  document.documentElement.className = '';
  installMatchMedia();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('theme switcher', () => {
  it('labels the control with the current theme', async () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    await mount();
    expect(trigger()?.getAttribute('aria-label')).toContain('Dark');
  });

  it('offers light, dark, and system', async () => {
    await mount();
    await openMenu();
    expect(options().map((option) => option.textContent)).toEqual([
      'Light',
      'Dark',
      'System',
    ]);
  });

  it('marks the stored theme as selected', async () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    await mount();
    await openMenu();
    expect(checkedOption()?.textContent).toBe('Dark');
  });

  it('applies a chosen theme through the shared provider', async () => {
    localStorage.setItem(STORAGE_KEY, 'system');
    await mount();
    await openMenu();
    await choose('Dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('returns to the system theme without another storage key', async () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    await mount();
    await openMenu();
    await choose('System');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('system');
    expect(localStorage.length).toBe(1);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('does not keep a second theme store', async () => {
    await mount();
    await openMenu();
    await choose('Light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(localStorage.length).toBe(1);
  });
});
