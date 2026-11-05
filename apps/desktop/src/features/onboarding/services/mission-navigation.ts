import { missionTraffic } from './mission-traffic';
import { readPage, readPageUrl } from './page-content';
import { waitForMissionPage } from './page-readiness';
import type { Page } from '@browserbasehq/stagehand';
import {
  academicPageIdentity,
  isAcademicUrl,
  isReadNavigation,
} from '../lib/browser-policy';
import type { AccountContinuation } from './account-continuation';

type PolicyContext = {
  setDomainPolicy: (policy: {
    allowedDomains: string[];
    blockedDomains: string[];
  }) => Promise<unknown>;
};

type MissionNavigationOptions = {
  scopeId?: string;
  onNavigate?: (url: string) => void;
  onPageOpened?: (url: string) => void;
  onWait?: (milliseconds: number) => void;
};
const browserRenderingCaches = new WeakMap<
  PolicyContext,
  Map<string, Set<string>>
>();

// Stagehand applies its domain policy to subresources too. Learn only observed
// rendering origins; the mission guard retains the original navigation hosts.
export const createMissionNavigator = (
  context: PolicyContext | (() => PolicyContext),
  hosts: string[],
  signal: AbortSignal,
  isCurrent: () => boolean = () => true,
  options: MissionNavigationOptions = {},
): ((
  page: Page,
  url: string,
  continuation?: AccountContinuation,
) => Promise<void>) => {
  if (typeof context === 'function') {
    const navigators = new WeakMap<
      PolicyContext,
      ReturnType<typeof createMissionNavigator>
    >();
    return (page, url, continuation) => {
      // Stagehand replaces its context when a mission changes the model callback.
      const current = context();
      let navigator = navigators.get(current);
      if (!navigator) {
        navigator = createMissionNavigator(
          current,
          hosts,
          signal,
          isCurrent,
          options,
        );
        navigators.set(current, navigator);
      }
      return navigator(page, url, continuation);
    };
  }
  // A relaunched browser must bootstrap its own rendering dependencies.
  let renderingCache = browserRenderingCaches.get(context);
  if (!renderingCache) {
    renderingCache = new Map();
    browserRenderingCaches.set(context, renderingCache);
  }
  const cacheKey = options.scopeId
    ? JSON.stringify([options.scopeId, [...hosts].sort()])
    : null;
  const renderingHosts =
    (cacheKey && renderingCache.get(cacheKey)) || new Set(hosts);
  const cachedHosts = [...renderingHosts].filter(
    (host) => !hosts.includes(host),
  );
  if (cacheKey) {
    if (renderingCache.size >= 100 && !renderingCache.has(cacheKey))
      renderingCache.delete(renderingCache.keys().next().value!);
    renderingCache.set(cacheKey, renderingHosts);
  }
  let initialized = false;
  const assertActive = () => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error('Your session changed; sign in again.');
  };
  return async (
    page: Page,
    url: string,
    continuation?: AccountContinuation,
  ) => {
    assertActive();
    if (!isReadNavigation(url, hosts))
      throw new Error(
        'This destination is outside your connected academic resources.',
      );
    const continuationDomains = continuation?.domains ?? [];
    for (const domain of continuationDomains) renderingHosts.add(domain);
    if (!initialized) {
      initialized = true;
      if (cachedHosts.length && !continuation)
        await context.setDomainPolicy({
          allowedDomains: [...renderingHosts],
          blockedDomains: [],
        });
    }
    if (continuation)
      await context.setDomainPolicy({
        allowedDomains: [...renderingHosts],
        blockedDomains: [],
      });
    const goTo = async (reload = false) => {
      const destination = reload ? await readPageUrl(page) : url;
      await missionTraffic.waitForTurn(destination, signal, options.onWait);
      assertActive();
      let response: Awaited<ReturnType<Page['goto']>> | undefined;
      try {
        response = reload
          ? await page.reload({ timeout: 12_000 })
          : await page.goto(url, { timeout: 12_000 });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/\bwaitForMainLoadState\(domcontentloaded\) timed out after \d+ms\b/.test(
            error.message,
          )
        )
          throw error;
        const expected = academicPageIdentity(destination);
        const matchesDestination = (actual: string) => {
          const identity = academicPageIdentity(actual);
          if (!expected || !identity || !isReadNavigation(actual, hosts))
            return false;
          if (identity === expected) return true;
          // Schoology's observed enrollment root resolves to its materials tab.
          const target = new URL(destination);
          const live = new URL(actual);
          return (
            (target.hostname === 'schoology.com' ||
              target.hostname.endsWith('.schoology.com')) &&
            target.origin === live.origin &&
            /^\/course\/\d+\/?$/.test(target.pathname) &&
            live.pathname ===
              `${target.pathname.replace(/\/$/, '')}/materials` &&
            target.search === live.search &&
            target.hash === live.hash
          );
        };
        assertActive();
        let liveUrl = await readPageUrl(page);
        if (continuation?.isAuthenticationUrl(liveUrl)) {
          await continuation.resume(page, signal, isCurrent);
          liveUrl = await readPageUrl(page);
        }
        if (!matchesDestination(liveUrl)) throw error;
        await waitForMissionPage(page, 'resource', signal, { timeoutMs: 1500 });
        assertActive();
        const snapshot = await readPage(page, true);
        const after = await readPageUrl(page);
        if (
          snapshot.password ||
          snapshot.error ||
          !snapshot.text?.trim() ||
          !matchesDestination(after) ||
          snapshot.url !== academicPageIdentity(after)
        )
          throw error;
        assertActive();
      }
      if (response) {
        const retryAfter = Object.entries(response.headers()).find(
          ([name]) => name.toLowerCase() === 'retry-after',
        )?.[1];
        if (
          response.status() === 429 ||
          (response.status() === 503 && retryAfter)
        )
          throw missionTraffic.recordRateLimit(destination, retryAfter);
      }
      options.onPageOpened?.(await readPageUrl(page));
    };
    options.onNavigate?.(url);
    await goTo();
    for (let attempt = 0; attempt < (continuation ? 4 : 2); attempt += 1) {
      assertActive();
      const currentUrl = await readPageUrl(page);
      if (
        !isReadNavigation(currentUrl, hosts) &&
        !continuation?.isAuthenticationUrl(currentUrl)
      )
        throw new Error('The page left your connected academic resources.');
      const origins = await page.evaluate(() => {
        const urls = [
          ...[
            ...document.querySelectorAll<HTMLElement>(
              'script[src], link[rel="stylesheet"][href], link[rel="preload"][href], link[rel="modulepreload"][href], img[src], source[src], video[src], audio[src], iframe[src]',
            ),
          ].map(
            (element) =>
              element.getAttribute('src') ?? element.getAttribute('href') ?? '',
          ),
          ...performance
            .getEntriesByType('resource')
            .filter((entry) =>
              [
                'script',
                'link',
                'img',
                'css',
                'audio',
                'video',
                'iframe',
              ].includes((entry as PerformanceResourceTiming).initiatorType),
            )
            .map((entry) => entry.name),
        ];
        return [
          ...new Set(
            urls.flatMap((value) => {
              try {
                return [new URL(value, document.baseURI).origin];
              } catch {
                return [];
              }
            }),
          ),
        ].slice(0, 64);
      });
      assertActive();
      let changed = false;
      for (const origin of origins) {
        if (!isAcademicUrl(origin)) continue;
        const host = new URL(origin).hostname;
        if (renderingHosts.has(host)) continue;
        renderingHosts.add(host);
        changed = true;
      }
      if (!changed) {
        if (continuation?.isAuthenticationUrl(currentUrl)) {
          await continuation.resume(page, signal, isCurrent);
          continue;
        }
        return;
      }
      await context.setDomainPolicy({
        allowedDomains: [...renderingHosts],
        blockedDomains: [],
      });
      assertActive();
      await goTo(true);
    }
    await continuation?.resume(page, signal, isCurrent);
    assertActive();
  };
};
