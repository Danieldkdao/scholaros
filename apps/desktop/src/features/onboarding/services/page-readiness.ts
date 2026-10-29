import type { Page } from '@browserbasehq/stagehand';
import type { AcademicConnection } from '../types';

type PageReadiness = {
  ready: boolean;
  signIn: boolean;
  documentLoading: boolean;
  blank: boolean;
};

export type ReadinessOptions = {
  timeoutMs?: number;
  pollMs?: number;
  assertReadable?: () => void;
};

const defaultTimeoutMs = 6_000;
const defaultPollMs = 250;

// Stagehand serializes this function into the page, so it cannot reference
// anything outside its own body.
const probeReadiness = (kind: string): PageReadiness => {
  const selectors: Record<string, string> = {
    canvas:
      '.ic-DashboardCard, #dashboard-activity, #course_home_content, a[href*="/courses/"]',
    classroom: 'a[href*="/c/"], [data-course-id]',
    resource: 'main, [role="main"], #content',
  };
  const shell =
    [
      ...document.querySelectorAll<HTMLElement>(
        'main, [role="main"], #content',
      ),
    ].find((element) => (element.innerText ?? '').trim().length > 0) ??
    document.body ??
    document.documentElement;
  const text = (shell?.innerText ?? '').trim();
  const provider = document.querySelector(selectors[kind] ?? 'main');
  const hasVisibleLinks = [
    ...document.querySelectorAll<HTMLAnchorElement>('a[href]'),
  ].some(
    (anchor) =>
      anchor.getClientRects().length > 0 &&
      !!(anchor.innerText || anchor.getAttribute('aria-label') || '').trim(),
  );
  return {
    ready:
      document.readyState !== 'loading' &&
      ((text.length > (kind === 'resource' ? 160 : 24) &&
        (!!provider || text.length > 240)) ||
        (text.length > 0 && hasVisibleLinks)),
    signIn: !!document.querySelector('input[type="password"]'),
    documentLoading: document.readyState === 'loading',
    blank: text.length < 20,
  };
};

const abortError = () => new DOMException('Aborted', 'AbortError');

const sleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, milliseconds);
    const cancel = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', cancel, { once: true });
  });

const notReady = (documentLoading: boolean): PageReadiness => ({
  ready: false,
  signIn: false,
  documentLoading,
  blank: !documentLoading,
});

const boundedProbe = (
  page: Page,
  kind: string,
  signal: AbortSignal,
  remainingMs: number,
) =>
  new Promise<PageReadiness>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    };
    const cancel = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(
      () => {
        cleanup();
        resolve(notReady(true));
      },
      Math.max(0, remainingMs),
    );
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener('abort', cancel, { once: true });
    void page.evaluate(probeReadiness, kind).then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });

export const waitForMissionPage = async (
  page: Page,
  kind: AcademicConnection['kind'],
  signal: AbortSignal,
  {
    timeoutMs = defaultTimeoutMs,
    pollMs = defaultPollMs,
    assertReadable,
  }: ReadinessOptions = {},
) => {
  const deadline = Date.now() + timeoutMs;
  let last = notReady(true);
  while (Date.now() < deadline) {
    if (signal.aborted) throw abortError();
    assertReadable?.();
    try {
      last = await boundedProbe(page, kind, signal, deadline - Date.now());
    } catch {
      // A page mid-navigation or a busy extension is only "not ready yet".
      last = notReady(true);
    }
    assertReadable?.();
    if (last.signIn)
      throw new Error('This resource needs you to sign in again.');
    if (last.ready) return;
    await sleep(pollMs, signal);
  }
  // Slow providers still count once real text is on screen.
  if (last.documentLoading || last.blank)
    throw new Error(
      'The page didn’t finish loading. Try again or skip for now.',
    );
};
