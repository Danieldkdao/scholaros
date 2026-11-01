import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'scholaros-restart-'));
  return {
    app: {
      getPath: () => directory,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      once: vi.fn(),
      on: vi.fn(),
    },
  };
});
const { db } = await import('../../../db');
const { AcademicConnectionTable } = await import('../../../db/schema');
const { applyAcademicDiscovery } = await import('../services/store');

it('keeps discovered context when the database owner exits and a new connection opens', () => {
  db.insert(AcademicConnectionTable)
    .values({
      id: 'connection',
      userId: 'student',
      name: 'Canvas',
      url: 'https://canvas.school.edu/courses',
      host: 'canvas.school.edu',
      kind: 'canvas',
      status: 'verified',
    })
    .run();
  applyAcademicDiscovery('student', [
    {
      connectionId: 'connection',
      outcome: 'courses',
      entries: [
        {
          connectionId: 'connection',
          label: 'Biology 101',
          url: 'https://canvas.school.edu/courses/1',
          role: 'course',
          evidenceUrl: 'https://canvas.school.edu/courses',
        },
      ],
    },
  ]);
  const filename = db.$client.name;
  db.$client.close();
  const reopened = new Database(filename);
  try {
    expect(
      reopened
        .prepare('select label, role from academic_context_entries')
        .all(),
    ).toEqual([{ label: 'Biology 101', role: 'course' }]);
  } finally {
    reopened.close();
  }
});
