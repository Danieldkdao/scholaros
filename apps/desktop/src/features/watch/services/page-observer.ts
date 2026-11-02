import type { Page } from '@browserbasehq/stagehand';
import type { ObservedPage } from '../../onboarding/lib/academic-discovery';
import { isReadNavigation } from '../../onboarding/lib/browser-policy';
import { readPage } from '../../onboarding/services/page-content';
import type { PageMutationState, WatchPageSnapshot } from '../types';

const observerKey = '__scholarOsWatchObserverV1';
const disabledKey = '__scholarOsWatchObserverDisabledV1';

type BrowserObserverState = {
  root: Element;
  observer: MutationObserver;
  revision: number;
  url: string;
  documentId: string;
  onRouteChange: () => void;
  disconnect: () => void;
};

type BrowserWindow = Window & {
  [observerKey]?: BrowserObserverState;
  [disabledKey]?: boolean;
};

function installObserverInDocument() {
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', installObserverInDocument, {
      once: true,
    });
    return;
  }
  const observerKey = '__scholarOsWatchObserverV1';
  const disabledKey = '__scholarOsWatchObserverDisabledV1';
  const targetWindow = window as BrowserWindow;
  const existingObserver = targetWindow[observerKey];
  if (existingObserver?.root === document.documentElement) return;
  existingObserver?.disconnect();
  targetWindow[disabledKey] = false;

  const observerState: BrowserObserverState = {
    root: document.documentElement,
    observer: null as unknown as MutationObserver,
    revision: 0,
    url: location.href,
    documentId: `${Date.now()}-${Math.random()}`,
    onRouteChange: () => {},
    disconnect: () => {},
  };
  const bumpRevision = () => {
    observerState.revision = Math.min(
      Number.MAX_SAFE_INTEGER,
      observerState.revision + 1,
    );
  };
  const updateRoute = () => {
    if (observerState.url === location.href) return;
    observerState.url = location.href;
    bumpRevision();
  };
  const isOwnedNode = (node: Node) => {
    const element =
      node instanceof Element ? node : (node.parentElement ?? undefined);
    return !!element?.closest(
      '[data-scholaros-watch-owned], [data-scholaros-watch-internal]',
    );
  };
  observerState.observer = new MutationObserver((records) => {
    const meaningful = records.some((record) => {
      if (isOwnedNode(record.target)) return false;
      if (
        record.type === 'childList' &&
        [...record.addedNodes, ...record.removedNodes].every(isOwnedNode)
      )
        return false;
      return true;
    });
    if (meaningful) bumpRevision();
  });
  observerState.observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'href',
      'aria-label',
      'aria-checked',
      'aria-selected',
      'aria-expanded',
      'data-state',
      'data-status',
      'datetime',
    ],
  });
  observerState.onRouteChange = updateRoute;
  window.addEventListener('popstate', updateRoute);
  window.addEventListener('hashchange', updateRoute);
  observerState.disconnect = () => {
    observerState.observer.disconnect();
    window.removeEventListener('popstate', updateRoute);
    window.removeEventListener('hashchange', updateRoute);
  };
  targetWindow[observerKey] = observerState as BrowserObserverState;
}

const initializedPages = new WeakSet<Page>();

export const installPageObserver = async (page: Page) => {
  if (!initializedPages.has(page)) {
    await page.addInitScript(installObserverInDocument);
    initializedPages.add(page);
  }
  await page.evaluate(installObserverInDocument);
};

export const readPageMutationState = async (
  page: Page,
): Promise<PageMutationState> =>
  page.evaluate(() => {
    const targetWindow = window as BrowserWindow;
    const observerState = targetWindow['__scholarOsWatchObserverV1'];
    if (!observerState)
      return {
        revision: 0,
        url: location.href,
        documentId: `${Date.now()}-${Math.random()}`,
        installed: false,
      };
    observerState.onRouteChange();
    return {
      revision: observerState.revision,
      url: location.href,
      documentId: observerState.documentId,
      installed: true,
    };
  });

export const disconnectPageObserver = async (page: Page) =>
  page.evaluate(() => {
    const targetWindow = window as BrowserWindow;
    targetWindow['__scholarOsWatchObserverV1']?.disconnect();
    delete targetWindow['__scholarOsWatchObserverV1'];
    targetWindow['__scholarOsWatchObserverDisabledV1'] = true;
  });

const readWatchMetadata = async (page: Page) =>
  page.evaluate(() => {
    const content =
      [
        ...document.querySelectorAll<HTMLElement>(
          'main, [role="main"], #content',
        ),
      ].find((element) => (element.innerText ?? '').trim().length > 0) ??
      document.body;
    const textLength = content.innerText.replace(/\s+/g, ' ').trim().length;
    const statusNodes = [
      ...document.querySelectorAll<HTMLElement>(
        '[role="status"], [role="alert"], [aria-live], [data-status], [data-state], time[datetime], [aria-checked], [aria-selected]',
      ),
    ];
    const statuses = statusNodes
      .filter(
        (element) =>
          !!element.getClientRects().length &&
          !element.closest(
            '[hidden], [inert], [data-scholaros-watch-owned], [data-scholaros-watch-internal]',
          ),
      )
      .map((element) => {
        const state = [
          element.getAttribute('data-status'),
          element.getAttribute('data-state'),
          element.getAttribute('aria-checked'),
          element.getAttribute('aria-selected'),
          element.getAttribute('aria-expanded'),
          element.getAttribute('datetime'),
        ]
          .filter(Boolean)
          .join(' ');
        const label = (
          element.getAttribute('aria-label') ||
          element.innerText ||
          element.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();
        return `${state} ${label}`.trim().slice(0, 500);
      })
      .filter(Boolean);
    return {
      url: location.href,
      ready: document.readyState === 'complete',
      textLength,
      statuses: [...new Set(statuses)].slice(0, 100),
    };
  });

export const readWatchPageSnapshot = async (
  page: Page,
  options: {
    allowedHosts: string[];
    recipeVersion: number;
    signal: AbortSignal;
  },
): Promise<WatchPageSnapshot> => {
  options.signal.throwIfAborted();
  const before = await readPageMutationState(page);
  const pageSnapshot = (await readPage(page)) as ObservedPage & {
    error?: boolean;
    password?: boolean;
  };
  options.signal.throwIfAborted();
  if (
    pageSnapshot.error ||
    !isReadNavigation(pageSnapshot.url, options.allowedHosts)
  )
    throw new Error('The watched page could not be verified.');
  if (pageSnapshot.password)
    throw new Error('This resource needs you to sign in again.');
  const metadata = await readWatchMetadata(page);
  options.signal.throwIfAborted();
  const after = await readPageMutationState(page);
  if (metadata.url !== pageSnapshot.url || after.url !== pageSnapshot.url)
    throw new Error('The watched page changed during observation.');

  return {
    url: pageSnapshot.url,
    title: pageSnapshot.title,
    text: pageSnapshot.text ?? '',
    links: pageSnapshot.links
      .filter((link) => isReadNavigation(link.url, options.allowedHosts))
      .map((link) => ({
        label: link.label.slice(0, 300),
        url: link.url,
        context: (link.context ?? '').slice(0, 200),
      }))
      .slice(0, 300),
    statuses: metadata.statuses,
    complete:
      metadata.ready &&
      !pageSnapshot.linksTruncated &&
      metadata.textLength <= (pageSnapshot.text?.length ?? 0) &&
      before.documentId === after.documentId &&
      before.revision === after.revision,
    recipeVersion: options.recipeVersion,
  };
};
