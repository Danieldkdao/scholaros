import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WatchTargetSelectData } from '../../../db/schema';
import {
  createWatchBrowserSession,
  settleWatchPage,
} from '../services/browser-session';
import type { PageMutationState, WatchPageSnapshot } from '../types';

const target = (id: string): WatchTargetSelectData => ({
  id,
  userId: 'student-a',
  connectionId: 'connection-a',
  courseId: 'course-a',
  requestedUrl: `https://canvas.school.edu/courses/1/assignments/${id}`,
  verifiedUrl: `https://canvas.school.edu/courses/1/assignments/${id}/verified`,
  urlIdentity: `https://canvas.school.edu/courses/1/assignments/${id}`,
  lastAttemptAt: null,
  lastSuccessfulCheckAt: null,
  detectedFingerprint: null,
  processedFingerprint: null,
  pendingChange: false,
  pendingSince: null,
  pendingSinceEstimated: false,
  lastFailureCategory: null,
  nextCheckAt: null,
  status: 'active',
  failureCount: 0,
  retryAt: null,
  recipeVersion: 1,
  createdAt: '2026-11-01T12:00:00.000Z',
  updatedAt: '2026-11-01T12:00:00.000Z',
});

const snapshot = (url: string): WatchPageSnapshot => ({
  url,
  title: 'Assignments',
  text: 'Quiz 1',
  links: [],
  statuses: [],
  complete: true,
  recipeVersion: 1,
});

afterEach(() => vi.useRealTimers());

describe('watch browser session', () => {
  it('recreates a failed page on its next permitted retry', async () => {
    const createPage = vi.fn(async () => ({}) as never);
    const readSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error('Page closed'))
      .mockResolvedValue(snapshot(target('1').requestedUrl));
    const release = vi.fn(async () => undefined);
    const session = createWatchBrowserSession({
      createPage,
      protectPage: async () => ({ release }),
      navigate: async () => undefined,
      readSnapshot,
      installObserver: async () => undefined,
      readMutationState: async () => ({
        revision: 0,
        url: 'https://canvas.school.edu/',
        documentId: 'one',
        installed: true,
      }),
      disconnectObserver: async () => undefined,
      settle: async () => undefined,
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    });
    const signal = new AbortController().signal;
    await expect(
      session.checkTarget(target('1'), signal, { reload: true }),
    ).rejects.toThrow('Page closed');
    await session.checkTarget(target('1'), signal, { reload: true });

    expect(createPage).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    await session.closeAll();
  });

  it('keeps the page limit when two new targets replace existing pages concurrently', async () => {
    let created = 0;
    let open = 0;
    let maximumOpen = 0;
    const session = createWatchBrowserSession({
      createPage: async () => {
        created += 1;
        open += 1;
        maximumOpen = Math.max(maximumOpen, open);
        return {} as never;
      },
      protectPage: async () => ({
        release: async () => {
          open -= 1;
        },
      }),
      navigate: async () => undefined,
      readSnapshot: async (_page, pageTarget) =>
        snapshot(pageTarget.requestedUrl),
      installObserver: async () => undefined,
      readMutationState: async () => ({
        revision: 0,
        url: 'https://canvas.school.edu/',
        documentId: 'one',
        installed: true,
      }),
      disconnectObserver: async () => undefined,
      settle: async () => undefined,
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    });
    const signal = new AbortController().signal;
    await session.checkTarget(target('1'), signal, { reload: true });
    await session.checkTarget(target('2'), signal, { reload: true });
    await Promise.all(
      ['3', '4'].map((id) =>
        session.checkTarget(target(id), signal, { reload: true }),
      ),
    );

    expect(created).toBe(4);
    expect(session.getPageCount()).toBe(2);
    expect(maximumOpen).toBe(2);
    await session.closeAll();
    expect(open).toBe(0);
  });

  it('keeps at most two protected pages and closes the least recently used page', async () => {
    const pages = [
      { close: vi.fn(async () => undefined) },
      { close: vi.fn(async () => undefined) },
      { close: vi.fn(async () => undefined) },
    ];
    let pageIndex = 0;
    const releases = [
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ];
    const session = createWatchBrowserSession({
      createPage: async () => pages[pageIndex++] as never,
      protectPage: vi
        .fn()
        .mockResolvedValueOnce({ release: releases[0] })
        .mockResolvedValueOnce({ release: releases[1] })
        .mockResolvedValueOnce({ release: vi.fn(async () => undefined) }),
      navigate: vi.fn(async () => undefined),
      readSnapshot: async (_page, pageTarget) =>
        snapshot(pageTarget.verifiedUrl ?? pageTarget.requestedUrl),
      installObserver: vi.fn(async () => undefined),
      readMutationState: vi.fn(async () => ({
        revision: 0,
        url: 'https://canvas.school.edu/',
        documentId: 'document-1',
        installed: true,
      })),
      disconnectObserver: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      now: vi
        .fn()
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(2)
        .mockReturnValue(3),
    });

    await session.checkTarget(target('1'), new AbortController().signal, {
      reload: true,
    });
    await session.checkTarget(target('2'), new AbortController().signal, {
      reload: true,
    });
    await session.checkTarget(target('3'), new AbortController().signal, {
      reload: true,
    });

    expect(session.getPageCount()).toBe(2);
    expect(releases[0]).toHaveBeenCalledOnce();
    await session.closeAll();
  });

  it('uses a verified destination for revisits and leaves the loaded page in place on mutation checks', async () => {
    const page = { close: vi.fn(async () => undefined) };
    const navigate = vi.fn(async () => undefined);
    const session = createWatchBrowserSession({
      createPage: async () => page as never,
      protectPage: async () => ({ release: vi.fn(async () => undefined) }),
      navigate,
      readSnapshot: async (_page, pageTarget) =>
        snapshot(pageTarget.verifiedUrl ?? pageTarget.requestedUrl),
      installObserver: vi.fn(async () => undefined),
      readMutationState: vi.fn(async () => ({
        revision: 0,
        url: 'https://canvas.school.edu/',
        documentId: 'document-1',
        installed: true,
      })),
      disconnectObserver: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    });

    await session.checkTarget(target('1'), new AbortController().signal, {
      reload: true,
    });
    await session.checkTarget(target('1'), new AbortController().signal, {
      reload: false,
    });

    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      page,
      target('1'),
      expect.any(AbortSignal),
      'https://canvas.school.edu/courses/1/assignments/1/verified',
    );
    await session.closeAll();
  });

  it('requests one settled mutation check after the page has been quiet', async () => {
    vi.useFakeTimers();
    const page = { close: vi.fn(async () => undefined) };
    let revision = 0;
    const onMutation = vi.fn(async () => undefined);
    const session = createWatchBrowserSession({
      createPage: async () => page as never,
      protectPage: async () => ({ release: vi.fn(async () => undefined) }),
      navigate: vi.fn(async () => undefined),
      readSnapshot: async (_page, pageTarget) =>
        snapshot(pageTarget.verifiedUrl ?? pageTarget.requestedUrl),
      installObserver: vi.fn(async () => undefined),
      readMutationState: vi.fn(
        async (): Promise<PageMutationState> => ({
          revision,
          url: 'https://canvas.school.edu/courses/1/assignments/1/verified',
          documentId: 'document-1',
          installed: true,
        }),
      ),
      disconnectObserver: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      sleep: (milliseconds, signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
      onMutation,
    });

    await session.checkTarget(target('1'), new AbortController().signal, {
      reload: true,
    });
    await vi.advanceTimersByTimeAsync(250);
    revision = 1;
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(onMutation).toHaveBeenCalledOnce());

    await session.closeAll();
  });

  it('makes concurrent closeAll calls await the same page-release barrier', async () => {
    let releasePage!: () => void;
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePage = resolve;
        }),
    );
    const session = createWatchBrowserSession({
      createPage: async () => ({}) as never,
      protectPage: async () => ({ release }),
      navigate: async () => undefined,
      readSnapshot: async (_page, pageTarget) =>
        snapshot(pageTarget.requestedUrl),
      installObserver: async () => undefined,
      readMutationState: async () => ({
        revision: 0,
        url: 'https://canvas.school.edu/',
        documentId: 'one',
        installed: true,
      }),
      disconnectObserver: async () => undefined,
      settle: async () => undefined,
      sleep: async (_milliseconds, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
    });
    await session.checkTarget(target('1'), new AbortController().signal, {
      reload: true,
    });

    let firstSettled = false;
    let secondSettled = false;
    const first = session.closeAll().then(() => {
      firstSettled = true;
    });
    const second = session.closeAll().then(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    releasePage();
    await Promise.all([first, second]);
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(true);
  });

  it('waits for one quiet second and caps mutation settling at five seconds', async () => {
    const page = {} as never;
    let clock = 0;
    let revision = 0;
    const readMutationState = vi.fn(
      async (): Promise<PageMutationState> => ({
        revision,
        url: 'https://canvas.school.edu/courses/1/assignments',
        documentId: 'document-1',
        installed: true,
      }),
    );
    const sleep = async (milliseconds: number) => {
      clock += milliseconds;
      revision += 1;
    };

    await settleWatchPage(page, new AbortController().signal, {
      readMutationState,
      now: () => clock,
      sleep,
    });

    expect(clock).toBe(5000);
    expect(readMutationState).toHaveBeenCalledTimes(21);
  });
});
