// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import type { StaticImageData } from 'next/image';
import { ThemeProvider } from '@scholaros/ui/components/theme-provider';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Image } from '../src/components/image';

// The Next image pipeline needs the compiler and the optimizer route, so the
// test renders a plain img and asserts on the props our wrapper resolves.
vi.mock('next/image', () => ({
  default: ({ src, ...rest }: Record<string, unknown>) => {
    const resolved =
      typeof src === 'object' && src !== null && 'src' in src
        ? (src as { src: string }).src
        : src;
    return <img {...(rest as ComponentProps<'img'>)} src={String(resolved)} />;
  },
}));

const light: StaticImageData = {
  src: '/logo-light.png',
  width: 1254,
  height: 1254,
};
const dark: StaticImageData = {
  src: '/logo-dark.png',
  width: 1254,
  height: 1254,
};

const show = (source: { light: StaticImageData; dark?: StaticImageData }) =>
  render(
    <ThemeProvider>
      <Image src={source} alt="ScholarOS" />
    </ThemeProvider>,
  );

const shownSrc = () => screen.getByRole('img').getAttribute('src');

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

afterEach(() => cleanup());

test('uses the light asset in light mode', () => {
  localStorage.setItem('scholaros-theme', 'light');
  show({ light, dark });
  expect(shownSrc()).toBe('/logo-light.png');
});

test('uses the dark asset in dark mode', () => {
  localStorage.setItem('scholaros-theme', 'dark');
  show({ light, dark });
  expect(shownSrc()).toBe('/logo-dark.png');
});

test('keeps the light asset in dark mode when no dark variant is given', () => {
  localStorage.setItem('scholaros-theme', 'dark');
  show({ light });
  expect(shownSrc()).toBe('/logo-light.png');
});

test('passes the remaining image props to Next', () => {
  localStorage.setItem('scholaros-theme', 'light');
  render(
    <ThemeProvider>
      <Image
        src={{ light }}
        alt="ScholarOS logo"
        width={84}
        height={28}
        className="h-7 w-auto"
      />
    </ThemeProvider>,
  );
  const image = screen.getByRole('img');
  expect(image.getAttribute('alt')).toBe('ScholarOS logo');
  expect(image.getAttribute('width')).toBe('84');
  expect(image.className).toContain('h-7');
});
