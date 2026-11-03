import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTrustedWindow,
  installTrustedFocusedWebContentsGuard,
  isTrustedWebContents,
  registerTrustedWindow,
  requireTrustedSender,
} from '../src/lib/trusted-windows';

type FakeFrame = { url: string };
type FakeContents = {
  id: number;
  mainFrame: FakeFrame;
  getURL: () => string;
  isDestroyed: () => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};
type FakeWindow = {
  webContents: FakeContents;
  isDestroyed: () => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (
    event: string,
    listener: (...args: unknown[]) => void,
  ) => void;
};

const makeWindow = (id: number, documentUrl: string) => {
  const contentsListeners = new Map<string, (...args: unknown[]) => void>();
  const windowListeners = new Map<string, (...args: unknown[]) => void>();
  const contents: FakeContents = {
    id,
    mainFrame: { url: documentUrl },
    getURL: () => contents.mainFrame.url,
    isDestroyed: () => false,
    on: (event, listener) => contentsListeners.set(event, listener),
    once: (event, listener) => contentsListeners.set(event, listener),
    removeListener: (event) => contentsListeners.delete(event),
  };
  const window: FakeWindow = {
    webContents: contents,
    isDestroyed: () => false,
    on: (event, listener) => windowListeners.set(event, listener),
    once: (event, listener) => windowListeners.set(event, listener),
    removeListener: (event) => windowListeners.delete(event),
  };
  return { window, contents, contentsListeners, windowListeners };
};

const trustedWindows: (() => void)[] = [];
afterEach(() => {
  for (const unregister of trustedWindows.splice(0)) unregister();
});

describe('trusted application windows', () => {
  it('accepts only the registered main frame and exact app document', () => {
    const { window, contents } = makeWindow(
      11,
      'file:///Applications/ScholarOS/renderer/index.html#/dashboard',
    );
    trustedWindows.push(
      registerTrustedWindow(
        window as never,
        'file:///Applications/ScholarOS/renderer/index.html',
      ),
    );

    expect(
      requireTrustedSender({
        sender: contents as never,
        senderFrame: contents.mainFrame as never,
      }),
    ).toBe(window);
    expect(getTrustedWindow()).toBe(window);
  });

  it('rejects subframes, remote documents, and unregistered BrowserWindows', () => {
    const registered = makeWindow(21, 'https://app.local/index.html#/');
    trustedWindows.push(
      registerTrustedWindow(
        registered.window as never,
        'https://app.local/index.html',
      ),
    );
    const remote = makeWindow(22, 'https://school.example/course');

    expect(() =>
      requireTrustedSender({
        sender: registered.contents as never,
        senderFrame: { url: 'https://app.local/index.html#/child' } as never,
      }),
    ).toThrow('Untrusted application frame.');
    expect(() =>
      requireTrustedSender({
        sender: remote.contents as never,
        senderFrame: remote.contents.mainFrame as never,
      }),
    ).toThrow('Untrusted application frame.');
    expect(() =>
      requireTrustedSender({
        sender: registered.contents as never,
        senderFrame: { url: 'https://app.local/other.html' } as never,
      }),
    ).toThrow('Untrusted application frame.');
  });

  it('blocks unexpected main-frame navigation and revokes trust on destruction', () => {
    const { window, contents, contentsListeners } = makeWindow(
      31,
      'https://app.local/index.html',
    );
    trustedWindows.push(
      registerTrustedWindow(window as never, 'https://app.local/index.html'),
    );
    const preventDefault = vi.fn();

    contentsListeners.get('will-frame-navigate')?.({
      isMainFrame: true,
      url: 'https://outside.example/',
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();

    contentsListeners.get('destroyed')?.();
    expect(() =>
      requireTrustedSender({
        sender: contents as never,
        senderFrame: contents.mainFrame as never,
      }),
    ).toThrow('Untrusted application frame.');
    expect(getTrustedWindow()).toBeNull();
  });

  it('only forwards focused-window errors to a currently trusted renderer', () => {
    const trusted = makeWindow(41, 'https://app.local/index.html');
    const remote = makeWindow(42, 'https://outside.example/');
    trustedWindows.push(
      registerTrustedWindow(
        trusted.window as never,
        'https://app.local/index.html',
      ),
    );
    let focusedContents = trusted.contents;
    const focusApi = { getFocusedWebContents: () => focusedContents as never };
    const restore = installTrustedFocusedWebContentsGuard(focusApi as never);

    expect(isTrustedWebContents(trusted.contents as never)).toBe(true);
    expect(focusApi.getFocusedWebContents()).toBe(trusted.contents);
    focusedContents = remote.contents;
    expect(focusApi.getFocusedWebContents()).toBeNull();
    trusted.contents.mainFrame.url = 'https://outside.example/';
    focusedContents = trusted.contents;
    expect(focusApi.getFocusedWebContents()).toBeNull();

    restore();
    expect(focusApi.getFocusedWebContents()).toBe(trusted.contents);
  });
});
