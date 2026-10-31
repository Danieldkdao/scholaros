import { missionTraffic } from './mission-traffic';
import type { Page } from '@browserbasehq/stagehand';
import { isAcademicUrl, isReadNavigation } from '../lib/browser-policy';
import type { AccountContinuation } from './account-continuation';

type PolicyContext = {
  setDomainPolicy: (policy: {
    allowedDomains: string[];
    blockedDomains: string[];
  }) => Promise<unknown>;
};

type MissionNavigationOptions = {
  scopeId?: string;
  onWait?: (milliseconds: number) => void;
};
const renderingCache = new Map<string, string[]>();

// Stagehand applies its domain policy to subresources too. Learn only observed
// rendering origins; the mission guard retains the original navigation hosts.
export const createMissionNavigator = (
  context: PolicyContext,
  hosts: string[],
  signal: AbortSignal,
  isCurrent: () => boolean = () => true,
  options: MissionNavigationOptions = {},
) => {
  const cacheKey = options.scopeId
    ? JSON.stringify([options.scopeId, [...hosts].sort()])
    : null;
  const cachedHosts = cacheKey ? (renderingCache.get(cacheKey) ?? []) : [];
  const renderingHosts = new Set([...hosts, ...cachedHosts]);
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
        allowedDomains: [...renderingHosts, ...continuationDomains],
        blockedDomains: [],
      });
    const goTo = async (reload = false) => {
      const destination = reload ? await page.url() : url;
      await missionTraffic.waitForTurn(destination, signal, options.onWait);
      assertActive();
      const response = reload
        ? await page.reload({ timeout: 12_000 })
        : await page.goto(url, { timeout: 12_000 });
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
    };
    await goTo();
    for (let attempt = 0; attempt < (continuation ? 4 : 2); attempt += 1) {
      assertActive();
      const currentUrl = await page.url();
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
        allowedDomains: [...renderingHosts, ...continuationDomains],
        blockedDomains: [],
      });
      if (cacheKey) {
        if (renderingCache.size >= 100 && !renderingCache.has(cacheKey))
          renderingCache.delete(renderingCache.keys().next().value!);
        renderingCache.set(cacheKey, [...renderingHosts]);
      }
      assertActive();
      await goTo(true);
    }
    await continuation?.resume(page, signal, isCurrent);
    assertActive();
  };
};
