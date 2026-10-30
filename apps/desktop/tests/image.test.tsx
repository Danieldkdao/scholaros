// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useTheme } from 'next-themes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import logoDark from '@scholaros/assets/images/logo-dark.png';
import logoLight from '@scholaros/assets/images/logo-light.png';
import { ThemeProvider } from '@scholaros/ui/components/theme-provider';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { Image } = await import('../src/components/image');

type TestImageProps = ComponentProps<typeof Image>;

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

const mount = async (props: TestImageProps) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(ThemeProvider, {
        clientOnly: true,
        children: createElement(Image, props),
      }),
    );
  });
};

const src = () => container.querySelector('img')?.getAttribute('src');

const SwitchableImage = () => {
  const { setTheme } = useTheme();
  return createElement(
    'div',
    null,
    createElement(Image, {
      src: { light: logoLight, dark: logoDark },
      alt: 'ScholarOS',
    }),
    createElement('button', { onClick: () => setTheme('dark') }, 'Use dark'),
  );
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
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
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe('theme-aware image', () => {
  it('uses the light asset in light mode', async () => {
    localStorage.setItem('scholaros-theme', 'light');
    await mount({
      src: { light: logoLight, dark: logoDark },
      alt: 'ScholarOS',
    });
    expect(src()).toBe(logoLight);
  });

  it('uses the dark asset in dark mode', async () => {
    localStorage.setItem('scholaros-theme', 'dark');
    await mount({
      src: { light: logoLight, dark: logoDark },
      alt: 'ScholarOS',
    });
    expect(src()).toBe(logoDark);
  });

  it('keeps the light asset in dark mode when no dark variant is given', async () => {
    localStorage.setItem('scholaros-theme', 'dark');
    await mount({ src: { light: logoLight }, alt: 'ScholarOS' });
    expect(src()).toBe(logoLight);
  });

  it('follows the theme when it changes after mount', async () => {
    localStorage.setItem('scholaros-theme', 'light');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ThemeProvider, {
          clientOnly: true,
          children: createElement(SwitchableImage),
        }),
      );
    });
    expect(src()).toBe(logoLight);
    await act(async () => {
      container
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(src()).toBe(logoDark);
  });

  it('passes the remaining image attributes through', async () => {
    localStorage.setItem('scholaros-theme', 'light');
    await mount({
      src: { light: logoLight },
      alt: 'ScholarOS logo',
      width: 28,
      height: 28,
      className: 'size-7 object-contain',
      draggable: false,
    });
    const image = container.querySelector('img')!;
    expect(image.getAttribute('alt')).toBe('ScholarOS logo');
    expect(image.getAttribute('width')).toBe('28');
    expect(image.className).toContain('size-7');
    expect(image.getAttribute('draggable')).toBe('false');
  });
});
