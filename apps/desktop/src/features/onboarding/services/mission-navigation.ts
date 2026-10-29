import { missionTraffic } from './mission-traffic';
import type { Page } from '@browserbasehq/stagehand';
import { isAcademicUrl, isReadNavigation } from '../lib/browser-policy';

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
  return async (page: Page, url: string) => {
    assertActive();
    if (!isReadNavigation(url, hosts))
      throw new Error(
        'This destination is outside your connected academic resources.',
      );
    if (!initialized) {
      initialized = true;
      if (cachedHosts.length)
        await context.setDomainPolicy({
          allowedDomains: [...renderingHosts],
          blockedDomains: [],
        });
    }
    const goTo = async () => {
      await missionTraffic.waitForTurn(url, signal, options.onWait);
      assertActive();
      const response = await page.goto(url, { timeout: 12_000 });
      if (response) {
        const retryAfter = Object.entries(response.headers()).find(
          ([name]) => name.toLowerCase() === 'retry-after',
        )?.[1];
        if (
          response.status() === 429 ||
          (response.status() === 503 && retryAfter)
        )
          throw missionTraffic.recordRateLimit(url, retryAfter);
      }
    };
    await goTo();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertActive();
      if (!isReadNavigation(await page.url(), hosts))
        throw new Error('The page left your connected academic resources.');
      const origins = await page.evaluate(() => {
        const urls = [
          ...[
            ...document.querySelectorAll<HTMLElement>(
              'script[src], link[rel="stylesheet"][href], link[rel="preload"][href], link[rel="modulepreload"][href], img[src], source[src], video[src], audio[src]',
            ),
          ].map(
            (element) =>
              element.getAttribute('src') ?? element.getAttribute('href') ?? '',
          ),
          ...performance
            .getEntriesByType('resource')
            .filter((entry) =>
              ['script', 'link', 'img', 'css', 'audio', 'video'].includes(
                (entry as PerformanceResourceTiming).initiatorType,
              ),
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
      if (!changed) return;
      await context.setDomainPolicy({
        allowedDomains: [...renderingHosts],
        blockedDomains: [],
      });
      if (cacheKey) {
        if (renderingCache.size >= 100 && !renderingCache.has(cacheKey))
          renderingCache.delete(renderingCache.keys().next().value!);
        renderingCache.set(cacheKey, [...renderingHosts]);
      }
      assertActive();
      await goTo();
    }
    assertActive();
  };
};
