import { expect, it, vi } from 'vitest';
import {
  getSettingsSaveState,
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
