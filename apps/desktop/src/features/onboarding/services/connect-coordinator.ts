import { createConnectRun } from './connect-run';
import type { ConnectionCandidateSchema } from '@scholaros/services/ai/schemas';
import type { createConnectBrowser } from './connect-browser';

type ApprovedSites = {
  candidates: ConnectionCandidateSchema[];
};

type ConnectBrowser = Omit<
  ReturnType<typeof createConnectBrowser>,
  'prepareHandoff'
> & {
  prepareHandoff?: (destination: string, signal: AbortSignal) => Promise<void>;
};

type Dependencies = {
  noteForHost?: (accountId: string, host: string) => string | null;
  acquire: (
    accountId: string,
  ) => Promise<{ release: () => void; signal: AbortSignal }>;
  browser: (accountId: string, sites: ApprovedSites) => Promise<ConnectBrowser>;
};

export const createConnectCoordinator = (dependencies: Dependencies) => {
  let busy = false;
  let generation = 0;
  let browser: ConnectBrowser | null = null;
  let finishing: Promise<void> | null = null;
  const run = createConnectRun({
    prepareHandoff: (destination, signal) =>
      browser?.prepareHandoff?.(destination, signal) ?? Promise.resolve(),
    noteForHost: dependencies.noteForHost,
    inspect: (candidate, signal) => {
      if (!browser) throw new Error('Browser unavailable.');
      return browser.inspect(candidate, signal);
    },
    capture: (candidate, signal) => {
      if (!browser) throw new Error('Browser unavailable.');
      return browser.capture(candidate, signal);
    },
  });
  const start = async (accountId: string, sites: ApprovedSites) => {
    if (busy) throw new Error('A connection run is already active.');
    if (!sites.candidates.length) throw new Error('Approve at least one site.');
    busy = true;
    const currentGeneration = ++generation;
    let release: (() => void) | null = null;
    try {
      const ownership = await dependencies.acquire(accountId);
      release = ownership.release;
      ownership.signal.throwIfAborted();
      if (currentGeneration !== generation)
        throw new Error('Connection run cancelled.');
      browser = await dependencies.browser(accountId, sites);
      if (currentGeneration !== generation)
        throw new Error('Connection run cancelled.');
      ownership.signal.throwIfAborted();
      const currentBrowser = browser;
      const currentRelease = release;
      finishing = run
        .start(accountId, sites.candidates, ownership.signal)
        .finally(async () => {
          try {
            await currentBrowser.close();
          } catch {
            run.fail(accountId);
          } finally {
            browser = null;
            currentRelease();
            busy = false;
            finishing = null;
          }
        });
    } catch (error) {
      try {
        if (browser) await browser.close();
      } finally {
        browser = null;
        release?.();
        busy = false;
      }
      throw error;
    }
  };
  const cancel = async (accountId: string) => {
    run.cancel(accountId);
    await finishing;
  };
  const reset = () => {
    generation += 1;
    run.reset();
  };
  return {
    start,
    isBusy: () => busy,
    cancel,
    getState: run.getState,
    resume: run.resume,
    subscribe: run.subscribe,
    reset,
  };
};
