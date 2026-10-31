import type { Page } from '@browserbasehq/stagehand';
import type { ConnectionCandidateSchema } from '@scholaros/services/ai/schemas';
import { isReadNavigation } from '../lib/browser-policy';
import { readPageEvidence } from './page-evidence';
import { isSignInPage } from '../lib/connection-policy';
import type { MissionProtection } from './mission-request-guard';

type Dependencies = {
  createPage: () => Promise<Page>;
  protect: (
    page: Page,
    host: string,
    onSignIn: (host: string) => void,
  ) => Promise<MissionProtection>;
  capture: (
    page: Page,
    host: string,
    signal: AbortSignal,
    assertReadable: () => void,
  ) => Promise<void | 'connected' | 'needs-sign-in'>;
};

export const createConnectBrowser = (dependencies: Dependencies) => {
  let held: {
    page: Page;
    protection: MissionProtection;
    host: string;
    removeAbort: () => void;
  } | null = null;
  const close = async () => {
    const previous = held;
    held = null;
    if (previous) {
      previous.removeAbort();
      await previous.protection();
    }
  };
  const inspect = async (
    candidate: ConnectionCandidateSchema,
    signal: AbortSignal,
  ): Promise<{ status: 'readable' | 'sign-in' | 'blocked'; host: string }> => {
    await close();
    signal.throwIfAborted();
    const host = new URL(candidate.url).hostname;
    if (!isReadNavigation(candidate.url, [host]))
      return { status: 'blocked' as const, host };
    const page = await dependencies.createPage();
    const onAbort = () => {
      void page.close().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const removeAbort = () => signal.removeEventListener('abort', onAbort);
    let protection: MissionProtection | null = null;
    let signInHost: string | null = null;
    const signIn = Promise.withResolvers<string>();
    try {
      protection = await dependencies.protect(page, host, (blockedHost) => {
        signInHost = blockedHost;
        signIn.resolve(blockedHost);
      });
      signal.throwIfAborted();
      const navigation = await Promise.race([
        page.goto(candidate.url, { timeout: 20_000 }).then(
          () => ({ kind: 'loaded' as const }),
          () => ({ kind: 'unreadable' as const }),
        ),
        signIn.promise.then((blockedHost) => ({
          kind: 'sign-in' as const,
          host: blockedHost,
        })),
      ]);
      signal.throwIfAborted();
      if (navigation.kind === 'sign-in')
        return { status: 'sign-in' as const, host: navigation.host };
      // Browser policy may reject a redirect before interception sees its URL.
      if (navigation.kind === 'unreadable')
        return { status: 'sign-in' as const, host: signInHost ?? host };
      protection.assertReadable();
      const evidence = await readPageEvidence(page);
      protection.assertReadable();
      signal.throwIfAborted();
      if (evidence.host !== host)
        return { status: 'blocked' as const, host: evidence.host };
      if (
        evidence.hasPasswordField ||
        isSignInPage(evidence.host, evidence.pathname)
      )
        return { status: 'sign-in' as const, host };
      if (!isReadNavigation(await page.url(), [host]))
        return { status: 'blocked' as const, host };
      held = { page, protection, host, removeAbort };
      protection = null;
      return { status: 'readable' as const, host };
    } catch {
      signal.throwIfAborted();
      if (signInHost) return { status: 'sign-in' as const, host: signInHost };
      return { status: 'blocked' as const, host };
    } finally {
      if (!held) removeAbort();
      if (protection) await protection();
      else if (!held) await page.close().catch(() => undefined);
    }
  };
  const capture = async (
    candidate: ConnectionCandidateSchema,
    signal: AbortSignal,
  ) => {
    const current = held;
    const host = new URL(candidate.url).hostname;
    if (!current || current.host !== host)
      throw new Error('The inspected site is no longer available.');
    try {
      signal.throwIfAborted();
      current.protection.assertReadable();
      return await dependencies.capture(
        current.page,
        host,
        signal,
        current.protection.assertReadable,
      );
    } finally {
      await close();
    }
  };
  return { inspect, capture, close };
};
