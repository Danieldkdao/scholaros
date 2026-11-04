import { expect, it, vi } from 'vitest';
import { createDefaultNotificationSettings } from '../../notifications/services/notification-policy';
import {
  clearSettingsSaveState,
  getSettingsSaveState,
  queueNotificationSettingsSave,
  queueSettingsSave,
  queueWatchSettingsSave,
  reconcileSettingsSaveDraft,
  retrySettingsSave,
} from '../settings-save-queue';

it('keeps a failed watcher draft across remounts until saved settings match it', async () => {
  const accountId = `watch-draft-${crypto.randomUUID()}`;
  const draft = {
    watchEnabled: true,
    watchUrls: ['https://canvas.school.edu/courses/biology'],
  };
  await expect(
    queueWatchSettingsSave(accountId, draft, async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
  expect(getSettingsSaveState(accountId).draft.watchSettings).toEqual(draft);

  reconcileSettingsSaveDraft(accountId, {
    watchSettings: { watchEnabled: false, watchUrls: [] },
  });
  expect(getSettingsSaveState(accountId).draft.watchSettings).toEqual(draft);

  await queueWatchSettingsSave(accountId, draft, async () => undefined);
  reconcileSettingsSaveDraft(accountId, { watchSettings: draft });
  expect(getSettingsSaveState(accountId).draft.watchSettings).toBeUndefined();
});

it('keeps a watch failure when an unrelated navigation save succeeds', async () => {
  const accountId = `watch-navigation-${crypto.randomUUID()}`;
  const watchDraft = {
    watchEnabled: true,
    watchUrls: ['https://canvas.school.edu/courses/biology'],
  };

  await expect(
    queueWatchSettingsSave(accountId, watchDraft, async () => {
      throw new Error('watch offline');
    }),
  ).rejects.toThrow('watch offline');
  await queueSettingsSave(
    accountId,
    { decisionTimeSeconds: 2 },
    async () => undefined,
  );

  const state = getSettingsSaveState(accountId);
  expect(state.error).toBe('watch offline');
  expect(state.groups.watch?.error).toBe('watch offline');
  expect(state.groups.navigation?.error).toBeNull();
  expect(state.draft.watchSettings).toEqual(watchDraft);

  reconcileSettingsSaveDraft(accountId, {
    decisionTimeSeconds: 2,
    watchSettings: { watchEnabled: false, watchUrls: [] },
  });
  expect(getSettingsSaveState(accountId).draft).toEqual({
    watchSettings: watchDraft,
  });
});

it('retries only the failed settings group and clears its matching revision', async () => {
  const accountId = `watch-retry-${crypto.randomUUID()}`;
  const watchDraft = {
    watchEnabled: true,
    watchUrls: ['https://canvas.school.edu/courses/biology'],
  };
  const saveWatchSettings = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('watch offline'))
    .mockResolvedValueOnce(undefined);

  await expect(
    queueWatchSettingsSave(accountId, watchDraft, saveWatchSettings),
  ).rejects.toThrow('watch offline');
  await expect(
    queueSettingsSave(
      accountId,
      { decisionTimeSeconds: 2 },
      async () => undefined,
    ),
  ).resolves.toBeUndefined();

  await retrySettingsSave(accountId, 'watch');

  expect(saveWatchSettings).toHaveBeenCalledTimes(2);
  expect(getSettingsSaveState(accountId).groups.watch?.error).toBeNull();
  expect(getSettingsSaveState(accountId).groups.navigation?.revision).toBe(1);
});

it('saves the full latest draft before clearing a same-group failure', async () => {
  const accountId = `settings-merged-draft-${crypto.randomUUID()}`;
  let savedDraft:
    | { decisionTimeSeconds?: number; blockedWords?: string[] }
    | undefined;
  await expect(
    queueSettingsSave(accountId, { decisionTimeSeconds: 2 }, async () => {
      throw new Error('navigation unavailable');
    }),
  ).rejects.toThrow('navigation unavailable');

  const saved = await queueSettingsSave(
    accountId,
    { blockedWords: ['quiz'] },
    async (draft?: {
      decisionTimeSeconds?: number;
      blockedWords?: string[];
    }) => {
      savedDraft = draft;
    },
  );

  expect(savedDraft).toEqual({
    decisionTimeSeconds: 2,
    blockedWords: ['quiz'],
  });
  await saved;
  reconcileSettingsSaveDraft(accountId, {
    decisionTimeSeconds: 2,
    blockedWords: ['quiz'],
  });
  expect(getSettingsSaveState(accountId).groups.navigation).toMatchObject({
    error: null,
    draft: {},
  });
});

it('restores an interrupted save after restart and retries with a fresh handler', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage;
  vi.stubGlobal('window', { localStorage: storage });
  try {
    vi.resetModules();
    const firstQueue = await import('../settings-save-queue');
    const accountId = `settings-restart-${crypto.randomUUID()}`;
    void firstQueue.queueSettingsSave(
      accountId,
      { decisionTimeSeconds: 2 },
      () => new Promise<void>(() => undefined),
    );

    vi.resetModules();
    const restartedQueue = await import('../settings-save-queue');
    const restored = restartedQueue.getSettingsSaveState(accountId);
    expect(restored.draft.decisionTimeSeconds).toBe(2);
    expect(restored.pending).toBe(0);
    expect(restored.groups.navigation?.error).toContain('interrupted');

    const save = vi.fn(async () => undefined);
    restartedQueue.registerSettingsSaveRetry(
      accountId,
      'navigation',
      async () => save(),
    );
    await restartedQueue.retrySettingsSave(accountId, 'navigation');

    expect(save).toHaveBeenCalledOnce();
    expect(
      restartedQueue.getSettingsSaveState(accountId).groups.navigation,
    ).toMatchObject({
      pending: 0,
      error: null,
      draft: {},
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('restores typed notification drafts after a renderer restart', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage;
  vi.stubGlobal('window', { localStorage: storage });
  try {
    vi.resetModules();
    const firstQueue = await import('../settings-save-queue');
    const accountId = `notification-restart-${crypto.randomUUID()}`;
    const defaults = createDefaultNotificationSettings();
    const draft = {
      ...defaults,
      enabled: true,
      categories: { ...defaults.categories, 'sync-completed': true },
    };
    void firstQueue.queueNotificationSettingsSave(
      accountId,
      draft,
      () => new Promise<void>(() => undefined),
    );

    vi.resetModules();
    const restartedQueue = await import('../settings-save-queue');
    const restored = restartedQueue.getSettingsSaveState(accountId);
    expect(restored.draft.notificationSettings).toEqual(draft);
    expect(restored.groups.notifications?.error).toContain('interrupted');

    const retriedDrafts: unknown[] = [];
    restartedQueue.registerSettingsSaveRetry(
      accountId,
      'notifications',
      async (retryDraft) => {
        retriedDrafts.push(retryDraft.notificationSettings);
      },
    );
    await restartedQueue.retrySettingsSave(accountId, 'notifications');
    expect(retriedDrafts).toEqual([draft]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('clears failed notification drafts only when persisted preferences match', async () => {
  const accountId = `notification-reconcile-${crypto.randomUUID()}`;
  const defaults = createDefaultNotificationSettings();
  const draft = {
    ...defaults,
    enabled: true,
    categories: { ...defaults.categories, 'sync-completed': true },
  };
  await expect(
    queueNotificationSettingsSave(accountId, draft, async () => {
      throw new Error('notification service offline');
    }),
  ).rejects.toThrow('notification service offline');

  reconcileSettingsSaveDraft(accountId, {
    notificationSettings: { ...defaults, revision: 4 },
  });
  expect(getSettingsSaveState(accountId).groups.notifications?.error).toBe(
    'notification service offline',
  );
  expect(getSettingsSaveState(accountId).draft.notificationSettings).toEqual(
    draft,
  );

  reconcileSettingsSaveDraft(accountId, {
    notificationSettings: { ...draft, revision: 5 },
  });
  expect(getSettingsSaveState(accountId).groups.notifications).toMatchObject({
    error: null,
    draft: {},
  });
});

it('retains a matching notification draft while newer saves are pending', async () => {
  const accountId = `notification-stale-persisted-${crypto.randomUUID()}`;
  const defaults = createDefaultNotificationSettings();
  const changed = { ...defaults, enabled: true };
  let releaseFirst!: () => void;
  const firstSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
  );
  const first = queueNotificationSettingsSave(accountId, changed, firstSave);
  await vi.waitFor(() => expect(firstSave).toHaveBeenCalledOnce());
  const second = queueNotificationSettingsSave(
    accountId,
    defaults,
    async () => undefined,
  );

  reconcileSettingsSaveDraft(accountId, {
    notificationSettings: { ...defaults, revision: 0 },
  });

  expect(getSettingsSaveState(accountId).groups.notifications).toMatchObject({
    pending: 2,
    draft: { notificationSettings: defaults },
  });

  releaseFirst();
  await first;
  await second;
});

it('clears local retry drafts and fences queued writes after data removal', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage;
  vi.stubGlobal('window', { localStorage: storage });
  try {
    const accountId = `settings-delete-${crypto.randomUUID()}`;
    const save = vi.fn(async () => undefined);
    const pending = queueSettingsSave(
      accountId,
      { decisionTimeSeconds: 2 },
      save,
    );

    clearSettingsSaveState(accountId);
    await pending;

    expect(save).not.toHaveBeenCalled();
    expect(getSettingsSaveState(accountId).draft).toEqual({});
    expect(storage.getItem('scholaros-settings-save-state-v1')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
