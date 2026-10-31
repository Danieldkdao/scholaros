// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readPageEvidence } from '../services/page-evidence';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(['display: none', 'visibility: hidden', 'opacity: 0'])(
  'ignores a hidden sign-in form on a dashboard: %s',
  async (style) => {
    vi.stubGlobal(
      'location',
      new URL('https://www.khanacademy.org/profile/student/courses'),
    );
    document.body.innerHTML = `<div style="${style}"><input type="password"></div>`;
    const field = document.querySelector('input')!;
    vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 30,
    } as DOMRect);
    const page = { evaluate: async (read: () => unknown) => read() };
    expect((await readPageEvidence(page as never)).hasPasswordField).toBe(
      false,
    );
  },
);

it('detects a visible password field', async () => {
  vi.stubGlobal('location', new URL('https://school.edu/login'));
  document.body.innerHTML = '<input type="password">';
  const field = document.querySelector('input')!;
  vi.spyOn(field, 'getBoundingClientRect').mockReturnValue({
    width: 200,
    height: 30,
  } as DOMRect);
  const page = { evaluate: async (read: () => unknown) => read() };
  expect((await readPageEvidence(page as never)).hasPasswordField).toBe(true);
});
