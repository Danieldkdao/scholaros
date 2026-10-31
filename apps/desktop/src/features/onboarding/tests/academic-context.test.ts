import { beforeEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-context-'));
  testPaths.userData = userData;
  return {
    app: {
      getPath: () => userData,
      getAppPath: () => process.cwd(),
      isPackaged: false,
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
    },
  };
});

const { join } = await import('node:path');
const Database = (await import('better-sqlite3')).default;
const { db } = await import('../../../db');
const {
  AcademicConnectionTable,
  AcademicContextEntryTable,
  AcademicContextTable,
} = await import('../../../db/schema');
const { getOnboardingState, removeAcademicConnection, applyAcademicDiscovery } =
  await import('../services/store');
const { discoveryEntriesFromPage } = await import('../lib/academic-discovery');

const studentA = 'student-a';
const studentB = 'student-b';

const insertConnection = (userId: string, id: string) =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id,
      userId,
      name: 'Canvas',
      url: 'https://canvas.school.edu/courses',
      host: 'canvas.school.edu',
      kind: 'canvas',
      status: 'verified',
      verifiedAt: new Date().toISOString(),
    })
    .run();

const drafts = [
  {
    connectionId: 'connection-a',
    label: 'Biology 101',
    url: 'https://canvas.school.edu/courses/1',
    role: 'course' as const,
    evidenceUrl: 'https://canvas.school.edu/courses',
  },
  {
    connectionId: 'connection-a',
    label: 'Canvas courses',
    url: 'https://canvas.school.edu/courses',
    role: 'resource' as const,
    evidenceUrl: 'https://canvas.school.edu/courses',
  },
];

beforeEach(() => {
  db.delete(AcademicContextEntryTable).run();
  db.delete(AcademicContextTable).run();
  db.delete(AcademicConnectionTable).run();
});

const discovered = (
  connectionId: string,
  entries = drafts,
  outcome = 'courses' as const,
) => ({ connectionId, outcome, entries });

describe('durable academic context', () => {
  it('starts pending until discovery is run', () => {
    expect(getOnboardingState(studentA).discovery).toEqual({
      status: 'pending',
      message: null,
      discoveredAt: null,
      coverage: {},
      entries: [],
    });
  });

  it('reports when general notes were omitted from a discovery request', () => {
    insertConnection(studentA, 'connection-a');
    const result = applyAcademicDiscovery(
      studentA,
      [discovered('connection-a')],
      { notesOmitted: true },
    );
    expect(result.discovery.message).toContain(
      'Some general notes were omitted',
    );
    expect(getOnboardingState(studentA).discovery.message).toContain(
      'Some general notes were omitted',
    );
  });

  it('persists observed course and resource entry points', () => {
    insertConnection(studentA, 'connection-a');
    applyAcademicDiscovery(studentA, [discovered('connection-a')]);

    const state = getOnboardingState(studentA);
    expect(state.discovery.status).toBe('complete');
    expect(state.discovery.coverage).toEqual({
      'connection-a': 'courses',
    });
    expect(state.discovery.entries).toMatchObject(drafts);
  });

  it('keeps discovered context across a database restart', () => {
    insertConnection(studentA, 'connection-a');
    applyAcademicDiscovery(studentA, [discovered('connection-a')]);

    const reopened = new Database(
      join(testPaths.userData, 'data', 'scholaros.sqlite'),
    );
    const rows = reopened
      .prepare('select label, role from academic_context_entries')
      .all();
    reopened.close();
    expect(rows).toEqual([
      { label: 'Biology 101', role: 'course' },
      { label: 'Canvas courses', role: 'resource' },
    ]);
  });

  it('keeps one account context isolated from another', () => {
    insertConnection(studentA, 'connection-a');
    insertConnection(studentB, 'connection-b');
    applyAcademicDiscovery(studentA, [discovered('connection-a')]);

    expect(getOnboardingState(studentB).discovery.entries).toEqual([]);
    expect(getOnboardingState(studentB).discovery.status).toBe('pending');
    expect(getOnboardingState(studentB).discovery.coverage).toEqual({});
  });

  it('invalidates entries from a removed connection', () => {
    insertConnection(studentA, 'connection-a');
    insertConnection(studentA, 'connection-b');
    applyAcademicDiscovery(studentA, [
      discovered('connection-a'),
      discovered('connection-b', [
        {
          connectionId: 'connection-b',
          label: 'Chemistry 201',
          url: 'https://canvas.school.edu/courses/2',
          role: 'course',
          evidenceUrl: 'https://canvas.school.edu/courses',
        },
      ]),
    ]);

    removeAcademicConnection(studentA, 'connection-a');

    const state = getOnboardingState(studentA);
    expect(state.discovery.entries.map((entry) => entry.label)).toEqual([
      'Chemistry 201',
    ]);
    expect(state.discovery.entries[0]?.connectionId).toBe('connection-b');
    expect(state.discovery.coverage).toEqual({ 'connection-b': 'courses' });
  });

  it('returns to pending when the last contextual connection is removed', () => {
    insertConnection(studentA, 'connection-a');
    applyAcademicDiscovery(studentA, [discovered('connection-a')]);
    removeAcademicConnection(studentA, 'connection-a');

    expect(getOnboardingState(studentA).discovery).toMatchObject({
      status: 'pending',
      message: null,
      discoveredAt: null,
      coverage: {},
      entries: [],
    });
  });

  it('preserves the previous map when a later run cannot read the resource', () => {
    insertConnection(studentA, 'connection-a');
    applyAcademicDiscovery(studentA, [discovered('connection-a')]);
    const firstDiscoveredAt =
      getOnboardingState(studentA).discovery.discoveredAt;

    applyAcademicDiscovery(studentA, [
      { connectionId: 'connection-a', outcome: 'blocked', entries: [] },
    ]);

    const state = getOnboardingState(studentA);
    expect(state.discovery.status).toBe('blocked');
    expect(state.discovery.entries).toHaveLength(2);
    expect(state.discovery.discoveredAt).toBe(firstDiscoveredAt);
  });

  it('reports partial coverage when only one resource could be read', () => {
    insertConnection(studentA, 'connection-a');
    insertConnection(studentA, 'connection-b');

    applyAcademicDiscovery(studentA, [
      discovered('connection-a'),
      { connectionId: 'connection-b', outcome: 'blocked', entries: [] },
    ]);

    const state = getOnboardingState(studentA);
    expect(state.discovery.status).toBe('partial');
    expect(state.discovery.message).toContain('1 of 2');
    expect(state.discovery.coverage).toEqual({
      'connection-a': 'courses',
      'connection-b': 'blocked',
    });
  });

  it('separates a readable list with no courses from an unreadable page', () => {
    insertConnection(studentA, 'connection-a');
    applyAcademicDiscovery(studentA, [
      {
        connectionId: 'connection-a',
        outcome: 'empty',
        entries: [
          {
            connectionId: 'connection-a',
            label: 'Courses',
            url: 'https://canvas.school.edu/courses',
            role: 'resource',
            evidenceUrl: 'https://canvas.school.edu/courses',
          },
        ],
      },
    ]);

    const emptyState = getOnboardingState(studentA);
    expect(emptyState.discovery.status).toBe('empty');
    expect(emptyState.discovery.discoveredAt).not.toBeNull();

    applyAcademicDiscovery(studentA, [
      { connectionId: 'connection-a', outcome: 'blocked', entries: [] },
    ]);
    expect(getOnboardingState(studentA).discovery.status).toBe('blocked');
  });

  it('keeps the last successful map when a refresh is cancelled', () => {
    insertConnection(studentA, 'connection-a');
    applyAcademicDiscovery(studentA, [discovered('connection-a')]);

    applyAcademicDiscovery(studentA, [], { cancelled: true });

    const state = getOnboardingState(studentA);
    expect(state.discovery.status).toBe('cancelled');
    expect(state.discovery.entries).toHaveLength(2);
    expect(state.discovery.coverage).toEqual({ 'connection-a': 'courses' });
  });

  it('extracts course entries without duplicating connection details', () => {
    const entries = discoveryEntriesFromPage(
      {
        id: 'connection-a',
        name: 'Canvas',
        url: 'https://canvas.school.edu/courses',
        host: 'canvas.school.edu',
        kind: 'canvas',
        status: 'verified',
        verifiedAt: null,
        notes: null,
        favicon: null,
      },
      {
        url: 'https://canvas.school.edu/courses',
        title: 'Courses',
        links: [
          {
            label: 'Biology 101',
            url: 'https://canvas.school.edu/courses/1',
          },
          {
            label: 'Settings',
            url: 'https://canvas.school.edu/profile/settings',
          },
        ],
      },
    );
    expect(entries).toMatchObject([
      {
        connectionId: 'connection-a',
        label: 'Biology 101',
        url: 'https://canvas.school.edu/courses/1',
        role: 'course',
      },
      {
        connectionId: 'connection-a',
        label: 'Courses',
        url: 'https://canvas.school.edu/courses',
        role: 'resource',
      },
    ]);
    expect(entries[0]).not.toHaveProperty('host');
    expect(entries[0]).not.toHaveProperty('connectionName');
  });
});

describe('refresh preservation regressions', () => {
  it('retains saved courses after an inconclusive refresh', () => {
    insertConnection(studentA, 'connection-a');
    applyAcademicDiscovery(studentA, [discovered('connection-a')]);
    const previous = getOnboardingState(studentA).discovery;
    applyAcademicDiscovery(studentA, [
      { connectionId: 'connection-a', outcome: 'inconclusive', entries: [] },
    ]);
    expect(getOnboardingState(studentA).discovery.entries).toEqual(
      previous.entries,
    );
  });
  it('does not apply completed partial results from a cancelled refresh', () => {
    insertConnection(studentA, 'connection-a');
    applyAcademicDiscovery(studentA, [discovered('connection-a')]);
    const previous = getOnboardingState(studentA).discovery;
    applyAcademicDiscovery(
      studentA,
      [{ connectionId: 'connection-a', outcome: 'empty', entries: [] }],
      { cancelled: true },
    );
    const current = getOnboardingState(studentA).discovery;
    expect(current.entries).toEqual(previous.entries);
    expect(current.discoveredAt).toBe(previous.discoveredAt);
    expect(current.coverage).toEqual(previous.coverage);
  });
});
