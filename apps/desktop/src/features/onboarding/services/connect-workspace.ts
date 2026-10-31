import { createConnectBrowser } from './connect-browser';
import type { getWorkspace } from './browser-workspace';
import type { Page } from '@browserbasehq/stagehand';
import type { AcademicConnection } from '../types';
import type { protectMissionPage } from './mission-request-guard';
import { isAcademicUrl } from '../lib/browser-policy';
import type { ConnectionCandidateSchema } from '@scholaros/services/ai/schemas';

type Workspace = Awaited<ReturnType<typeof getWorkspace>>;

type Options = {
  context: Workspace['browser']['context'];
  cdpUrl: string;
  accountId: string;
  sites: { candidates: ConnectionCandidateSchema[] };
  protect: typeof protectMissionPage;
  terminateWorkspace: () => Promise<void>;
  capture: (
    accountId: string,
    page: Page,
    isCurrent: () => boolean,
    host: string,
    signal: AbortSignal,
  ) => Promise<AcademicConnection | void>;
};

export const createConnectWorkspace = async ({
  context,
  cdpUrl,
  accountId,
  sites,
  protect,
  capture,
  terminateWorkspace,
}: Options) => {
  const hosts = [
    ...new Set(
      sites.candidates.map((candidate) => new URL(candidate.url).hostname),
    ),
  ];
  const existingPages = await context.pages();
  const existingIds = new Set(existingPages.map((page) => page.pageId));
  try {
    await context.setDomainPolicy({
      allowedDomains: hosts,
      blockedDomains: [],
    });
  } catch (error) {
    await terminateWorkspace();
    throw error;
  }
  let manualPage: Awaited<ReturnType<typeof context.newPage>> | null = null;
  try {
    const browser = createConnectBrowser({
      createPage: () => context.newPage(),
      protect: (page, host, onSignIn) =>
        protect(page, cdpUrl, [host], (blocked) => {
          if (
            blocked.resourceType === 'Document' &&
            (blocked.signInWall || blocked.mainFrame) &&
            isAcademicUrl(`https://${blocked.host}/`)
          )
            onSignIn(blocked.host);
        }),
      capture: async (page, host, signal, assertReadable) => {
        const captured = await capture(
          accountId,
          page,
          () => {
            signal.throwIfAborted();
            assertReadable();
            return true;
          },
          host,
          signal,
        );
        return captured?.status === 'needs-sign-in'
          ? 'needs-sign-in'
          : 'connected';
      },
    });
    return {
      ...browser,
      inspect: async (
        candidate: ConnectionCandidateSchema,
        signal: AbortSignal,
      ) => {
        signal.throwIfAborted();
        await context.setDomainPolicy({
          allowedDomains: hosts,
          blockedDomains: [],
        });
        signal.throwIfAborted();
        return browser.inspect(candidate, signal);
      },
      prepareHandoff: async (destination: string, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (
          !sites.candidates.some((candidate) => candidate.url === destination)
        )
          throw new Error('Choose an approved site to sign in.');
        // Only student-controlled sign-in browsing is unrestricted; automated
        // inspection restores the approved-site policy before reading pages.
        await context.setDomainPolicy(null);
        signal.throwIfAborted();
        if (!manualPage) manualPage = await context.newPage();
        signal.throwIfAborted();
        await context.setActivePage(manualPage);
        signal.throwIfAborted();
        await manualPage.goto(destination, { timeout: 20_000 });
        signal.throwIfAborted();
      },
      close: async () => {
        try {
          await browser.close();
          await manualPage?.close();
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const remaining = (await context.pages()).filter(
              (page) =>
                !existingIds.has(page.pageId) &&
                page.pageId !== manualPage?.pageId,
            );
            if (!remaining.length) {
              await context.setDomainPolicy(null);
              return;
            }
            // A rejected close usually only means the tab already went away, so
            // sweep every tab and let the next poll decide what truly survived.
            await Promise.allSettled(remaining.map((page) => page.close()));
          }
          throw new Error('Could not close connection tabs.');
        } catch (error) {
          await manualPage?.close().catch(() => undefined);
          await terminateWorkspace();
          throw error;
        }
      },
    };
  } catch (error) {
    try {
      await context.setDomainPolicy(null);
    } catch {
      await terminateWorkspace();
    }
    throw error;
  }
};
