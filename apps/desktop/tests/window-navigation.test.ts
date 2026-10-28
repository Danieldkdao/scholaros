import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { protectWindowNavigation } from '../src/lib/window-navigation';

const setupNavigation = (currentUrl: string) => {
  const contents = {
    getURL: vi.fn(() => currentUrl),
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  protectWindowNavigation(contents as unknown as WebContents);
  const navigate = (url: string) => {
    const event = { url, preventDefault: vi.fn() };
    const listener = contents.on.mock.calls.find(
      ([name]) => name === 'will-navigate',
    )?.[1];
    expect(listener).toBeTypeOf('function');
    listener(event);
    return event;
  };
  return { contents, navigate };
};

describe('window navigation protection', () => {
  it.each([
    'http://localhost:5173/',
    'file:///Applications/ScholarOS.app/Contents/Resources/app/index.html',
  ])('allows a reload of the currently loaded page: %s', (url) => {
    const { navigate } = setupNavigation(url);
    expect(navigate(url).preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.com/',
    'http://localhost:5173/other-page',
    'http://localhost:5174/',
    'http://localhost:5173.evil.example/',
    'file:///etc/passwd',
  ])('blocks navigation away from the current page: %s', (url) => {
    const { navigate } = setupNavigation('http://localhost:5173/');
    expect(navigate(url).preventDefault).toHaveBeenCalledOnce();
  });

  it('continues to deny new windows', () => {
    const { contents } = setupNavigation('http://localhost:5173/');
    expect(contents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({
      action: 'deny',
    });
  });
});
