import { expect, it } from 'vitest';
import {
  getSettingsSaveState,
  queueWatchSettingsSave,
  reconcileSettingsSaveDraft,
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
