import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'scholaros-owner-'));
  return {
    app: {
      getPath: () => directory,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      once: vi.fn(),
    },
  };
});
it('allows Studio to read committed data while the academic service writes', async () => {
  const { db } = await import('../../../db');
  const { SettingTable } = await import('../../../db/schema');
  db.insert(SettingTable)
    .values({ userId: 'studio-reader', updatedAt: '2026-10-31T12:00:00Z' })
    .run();
  const studio = new Database(db.$client.name, { timeout: 1 });
  try {
    const read = studio.prepare('SELECT step FROM settings WHERE user_id = ?');
    expect(read.get('studio-reader')).toEqual({ step: 'welcome' });
    db.$client.transaction(() => {
      db.$client
        .prepare('UPDATE settings SET step = ? WHERE user_id = ?')
        .run('browser', 'studio-reader');
      expect(read.get('studio-reader')).toEqual({ step: 'welcome' });
    })();
    expect(read.get('studio-reader')).toEqual({ step: 'browser' });
  } finally {
    studio.close();
    db.$client.close();
  }
});
