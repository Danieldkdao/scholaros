import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@browserbasehq/stagehand';
import type { WatchTargetSelectData } from '../../../db/schema';
import {
  maxMutationSettleMs,
  maxWatchedPages,
  mutationQuietMs,
} from '../constants';
import type { PageMutationState, WatchPageSnapshot } from '../types';

type WatchPageProtection = {
  release: () => Promise<void>;
  assertReadable?: () => void;
};
type BrowserSessionDependencies = {
  createPage: (
    target: WatchTargetSelectData,
    signal: AbortSignal,
  ) => Promise<Page>;
  protectPage: (
    page: Page,
    target: WatchTargetSelectData,
    signal: AbortSignal,
  ) => Promise<WatchPageProtection>;
  navigate: (
    page: Page,
    target: WatchTargetSelectData,
    signal: AbortSignal,
    url: string,
  ) => Promise<void>;
  readSnapshot: (
    page: Page,
    target: WatchTargetSelectData,
    signal: AbortSignal,
  ) => Promise<WatchPageSnapshot>;
  installObserver: (page: Page) => Promise<void>;
  readMutationState: (page: Page) => Promise<PageMutationState>;
  disconnectObserver: (page: Page) => Promise<void>;
  settle: (page: Page, signal: AbortSignal) => Promise<void>;
  onMutation?: (targetId: string) => void | Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
};

type WatchPageHandle = {
  page: Page;
  target: WatchTargetSelectData;
  protection: WatchPageProtection;
  monitorController: AbortController;
  removeAbortListener: () => void;
  mutationState: PageMutationState;
  lastUsedAt: number;
  monitor: Promise<void>;
};

export const settleWatchPage = async (
  page: Page,
  signal: AbortSignal,
  dependencies: {
    readMutationState: (page: Page) => Promise<PageMutationState>;
    now?: () => number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  },
) => {
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds, abortSignal) =>
      delay(milliseconds, undefined, { signal: abortSignal }));
  const startedAt = now();
  let quietStartedAt = startedAt;
  let lastState = await dependencies.readMutationState(page);
  while (now() - startedAt < maxMutationSettleMs) {
    signal.throwIfAborted();
    await sleep(
      Math.min(250, maxMutationSettleMs - (now() - startedAt)),
      signal,
    );
    signal.throwIfAborted();
    const currentState = await dependencies.readMutationState(page);
    if (
      currentState.revision !== lastState.revision ||
      currentState.url !== lastState.url ||
      currentState.documentId !== lastState.documentId
    ) {
      quietStartedAt = now();
      lastState = currentState;
    }
    if (now() - quietStartedAt >= mutationQuietMs) return;
  }
};

export const createWatchBrowserSession = (
  dependencies: BrowserSessionDependencies,
) => {
  const pages = new Map<string, WatchPageHandle>();
  let pageQueue: Promise<unknown> = Promise.resolve();
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  let mutationHandler = dependencies.onMutation;
  const closeHandle = async (handle: WatchPageHandle) => {
    handle.monitorController.abort();
    handle.removeAbortListener();
    await handle.monitor.catch(() => undefined);
    await dependencies.disconnectObserver(handle.page).catch(() => undefined);
    try {
      await handle.protection.release();
    } catch {
      await handle.page.close().catch(() => undefined);
    }
  };
  const watchMutations = async (handle: WatchPageHandle) => {
    let mutationStartedAt: number | null = null;
    let lastMutationAt: number | null = null;
    while (!handle.monitorController.signal.aborted) {
      try {
        await sleep(250, handle.monitorController.signal);
        const currentState = await dependencies.readMutationState(handle.page);
        if (
          currentState.revision !== handle.mutationState.revision ||
          currentState.url !== handle.mutationState.url ||
          currentState.documentId !== handle.mutationState.documentId
        ) {
          const changedAt = now();
          mutationStartedAt ??= changedAt;
          lastMutationAt = changedAt;
          handle.mutationState = currentState;
        }
        if (
          lastMutationAt !== null &&
          (now() - lastMutationAt >= mutationQuietMs ||
            now() - mutationStartedAt! >= maxMutationSettleMs)
        ) {
          mutationStartedAt = null;
          lastMutationAt = null;
          await mutationHandler?.(handle.target.id);
          handle.mutationState = await dependencies.readMutationState(
            handle.page,
          );
        }
      } catch {
        break;
      }
    }
  };
  const createHandle = async (
    target: WatchTargetSelectData,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const page = await dependencies.createPage(target, signal);
    let protection: WatchPageProtection | null = null;
    try {
      protection = await dependencies.protectPage(page, target, signal);
      await dependencies.installObserver(page);
      const mutationState = await dependencies.readMutationState(page);
      const monitorController = new AbortController();
      const abortMonitor = () => monitorController.abort(signal.reason);
      signal.addEventListener('abort', abortMonitor, { once: true });
      const handle = {
        page,
        target,
        protection,
        monitorController,
        removeAbortListener: () =>
          signal.removeEventListener('abort', abortMonitor),
        mutationState,
        lastUsedAt: now(),
        monitor: Promise.resolve(),
      } satisfies WatchPageHandle;
      handle.monitor = watchMutations(handle);
      pages.set(target.id, handle);
      return handle;
    } catch (error) {
      if (protection) await protection.release().catch(() => undefined);
      else await page.close().catch(() => undefined);
      throw error;
    }
  };
  const reserveHandle = async (
    target: WatchTargetSelectData,
    signal: AbortSignal,
  ) => {
    const existingHandle = pages.get(target.id);
    if (existingHandle) {
      existingHandle.target = target;
      return existingHandle;
    }
    if (pages.size >= maxWatchedPages) {
      const leastRecentlyUsed = [...pages.values()].sort(
        (left, right) => left.lastUsedAt - right.lastUsedAt,
      )[0];
      if (leastRecentlyUsed) {
        pages.delete(leastRecentlyUsed.target.id);
        await closeHandle(leastRecentlyUsed);
      }
    }
    return createHandle(target, signal);
  };
  const getOrCreateHandle = (
    target: WatchTargetSelectData,
    signal: AbortSignal,
  ) => {
    const operation = pageQueue.then(() => reserveHandle(target, signal));
    pageQueue = operation.catch(() => undefined);
    return operation;
  };
  const checkTarget = async (
    target: WatchTargetSelectData,
    signal: AbortSignal,
    options: { reload: boolean },
  ) => {
    signal.throwIfAborted();
    const handle = await getOrCreateHandle(target, signal);
    try {
      signal.throwIfAborted();
      if (options.reload) {
        await dependencies.navigate(
          handle.page,
          target,
          signal,
          target.verifiedUrl ?? target.requestedUrl,
        );
        await dependencies.settle(handle.page, signal);
      }
      handle.protection.assertReadable?.();
      const snapshot = await dependencies.readSnapshot(
        handle.page,
        target,
        signal,
      );
      signal.throwIfAborted();
      handle.protection.assertReadable?.();
      handle.target = target;
      handle.lastUsedAt = now();
      handle.mutationState = await dependencies.readMutationState(handle.page);
      return snapshot;
    } catch (error) {
      if (pages.get(target.id) === handle) pages.delete(target.id);
      await closeHandle(handle);
      throw error;
    }
  };
  const closeAll = async () => {
    await pageQueue;
    const handles = [...pages.values()];
    pages.clear();
    await Promise.all(handles.map(closeHandle));
  };
  return {
    checkTarget,
    closeAll,
    setMutationHandler: (handler: typeof mutationHandler) => {
      mutationHandler = handler;
    },
    getPageCount: () => pages.size,
  };
};
