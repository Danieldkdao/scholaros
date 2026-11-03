import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { sql } from 'drizzle-orm';

const browserMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  closeStagehand: vi.fn(),
  closeBrowser: vi.fn(),
  createStagehand: vi.fn(),
  createModel: vi.fn(),
  generateModel: vi.fn(),
  stopOwnedProcesses: vi.fn(),
}));

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-workspace-'));
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

vi.mock('@browserbasehq/stagehand', () => ({
  localBrowser: { launch: browserMocks.launch },
  Stagehand: { create: browserMocks.createStagehand },
}));

vi.mock('../services/browser-process', () => ({
  stopOwnedBrowserProcesses: browserMocks.stopOwnedProcesses,
}));
vi.mock('../services/browser-model', () => ({
  createBrowserModel: browserMocks.createModel,
}));

const installations = new Map([
  [
    'chrome-install',
    {
      id: 'chrome-install',
      browser: 'chrome' as const,
      name: 'Google Chrome',
      version: '1',
      icon: null,
      executable:
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
  ],
  [
    'edge-install',
    {
      id: 'edge-install',
      browser: 'edge' as const,
      name: 'Microsoft Edge',
      version: '1',
      icon: null,
      executable:
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    },
  ],
]);

vi.mock('../services/browser-discovery', () => ({
  getBrowserInstallation: (id: string) => {
    const installation = installations.get(id);
    if (!installation) throw new Error('Missing browser');
    return installation;
  },
}));

const { db } = await import('../../../db');
const { AcademicConnectionTable, BrowserWorkspaceTable } =
  await import('../../../db/schema');
const {
  closeWorkspace,
  commitWorkspaceReplacement,
  createWorkspace,
  getWorkspace,
  stageWorkspaceReplacement,
  cancelWorkspaceReplacement,
  withMissionStagehand,
} = await import('../services/browser-workspace');
const { profileDirectoryFor } = await import('../lib/profile-directory');

const accounts = { first: 'student-a', second: 'student-b' };

const browserFor = () => {
  const browser = {
    closed: false,
    context: {
      pages: vi.fn(async () => []),
      setDomainPolicy: vi.fn(async () => undefined),
      newPage: vi.fn(),
      setActivePage: vi.fn(),
      activePage: vi.fn(),
    },
    close: browserMocks.closeBrowser,
  };
  return browser;
};

const insertConnection = (userId: string, id: string, status = 'verified') =>
  db
    .insert(AcademicConnectionTable)
    .values({
      id,
      userId,
      name: 'Canvas',
      url: 'https://canvas.school.edu/courses',
      host: 'canvas.school.edu',
      kind: 'canvas',
      status: status as 'verified',
      verifiedAt: new Date().toISOString(),
    })
    .run();

beforeEach(async () => {
  await closeWorkspace();
  db.delete(AcademicConnectionTable).run();
  db.delete(BrowserWorkspaceTable).run();
  browserMocks.launch.mockReset();
  browserMocks.closeStagehand.mockReset();
  browserMocks.closeBrowser.mockReset();
  browserMocks.createStagehand.mockReset();
  browserMocks.createModel.mockReset();
  browserMocks.generateModel.mockReset();
  browserMocks.stopOwnedProcesses.mockReset();
  browserMocks.stopOwnedProcesses.mockResolvedValue(0);
  browserMocks.closeStagehand.mockResolvedValue(undefined);
  browserMocks.closeBrowser.mockResolvedValue(undefined);
  browserMocks.createStagehand.mockImplementation(async () => ({
    close: browserMocks.closeStagehand,
  }));
  browserMocks.createModel.mockReturnValue(browserMocks.generateModel);
  browserMocks.launch.mockImplementation(async () => browserFor());
});

afterEach(async () => {
  await closeWorkspace();
});

describe('browser workspace ownership', () => {
  it('reuses an active workspace only for the same account and installation', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    await createWorkspace(accounts.first, 'chrome-install');

    expect(browserMocks.launch).toHaveBeenCalledOnce();
    const workspace = await getWorkspace(accounts.first);
    expect(workspace.executable).toBe(
      installations.get('chrome-install')!.executable,
    );
    expect(browserMocks.launch).toHaveBeenCalledOnce();
  });

  it('binds an inout Stagehand instance to one mission and restores the base instance', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    const workspace = await getWorkspace(accounts.first);
    const signal = new AbortController().signal;
    const isCurrent = vi.fn(() => true);
    const result = await withMissionStagehand(
      workspace,
      { signal, isCurrent },
      async (stagehand) => stagehand,
    );

    expect(browserMocks.createStagehand).toHaveBeenCalledTimes(3);
    expect(browserMocks.createModel).toHaveBeenCalledWith({
      signal,
      isCurrent,
    });
    expect(browserMocks.createStagehand.mock.calls[1]?.[0]).toMatchObject({
      model: { generate: browserMocks.generateModel },
      selfHeal: false,
      logging: { level: 'off' },
    });
    expect(result).toBe(
      await browserMocks.createStagehand.mock.results[1]?.value,
    );
    expect(workspace.stagehand).toBe(
      await browserMocks.createStagehand.mock.results[2]?.value,
    );
  });

  it('launches the selected installation before recording a switch', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    await createWorkspace(accounts.first, 'edge-install');

    expect(browserMocks.launch).toHaveBeenCalledTimes(2);
    expect(browserMocks.launch.mock.calls[1]![0].executablePath).toBe(
      installations.get('edge-install')!.executable,
    );
    const saved = db.select().from(BrowserWorkspaceTable).get();
    expect(saved?.executable).toBe(
      installations.get('edge-install')!.executable,
    );
    expect(saved?.browser).toBe('edge');
    expect(browserMocks.closeStagehand).toHaveBeenCalledOnce();
    expect(browserMocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it('does not save a failed switch as the ready browser', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');
    browserMocks.launch.mockRejectedValueOnce(new Error('Launch failed'));

    await expect(
      createWorkspace(accounts.first, 'edge-install'),
    ).rejects.toThrow('The study browser could not start');

    const saved = db.select().from(BrowserWorkspaceTable).get();
    expect(saved?.executable).toBe(
      installations.get('chrome-install')!.executable,
    );
    expect(saved?.browser).toBe('chrome');
    expect(db.select().from(AcademicConnectionTable).get()?.status).toBe(
      'verified',
    );
  });

  it('demotes verified connections when the installation changes', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');

    await createWorkspace(accounts.first, 'edge-install');

    const connection = db.select().from(AcademicConnectionTable).get();
    expect(connection).toMatchObject({
      status: 'needs-sign-in',
      verifiedAt: null,
    });
  });

  it('demotes verified connections when the study profile was recreated', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');
    const profileDirectory = browserMocks.launch.mock.calls[0]![0]
      .userDataDir as string;
    await closeWorkspace();
    rmSync(profileDirectory, { recursive: true, force: true });

    await createWorkspace(accounts.first, 'chrome-install');

    expect(db.select().from(AcademicConnectionTable).get()?.status).toBe(
      'needs-sign-in',
    );
  });

  it('keeps verified connections when reusing the same installation', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');

    await createWorkspace(accounts.first, 'chrome-install');

    expect(db.select().from(AcademicConnectionTable).get()?.status).toBe(
      'verified',
    );
  });

  it('uses separate profiles for each account and installation', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    await createWorkspace(accounts.first, 'edge-install');
    await createWorkspace(accounts.second, 'chrome-install');

    const directories = browserMocks.launch.mock.calls.map(
      ([options]) => options.userDataDir as string,
    );
    expect(new Set(directories).size).toBe(3);
    expect(profileDirectoryFor('/data', accounts.first, '/chrome')).not.toBe(
      profileDirectoryFor('/data', accounts.second, '/chrome'),
    );
    expect(profileDirectoryFor('/data', accounts.first, '/chrome')).not.toBe(
      profileDirectoryFor('/data', accounts.first, '/edge'),
    );
  });

  it('reconnects with the same profile after an app restart', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    const profileDirectory = browserMocks.launch.mock.calls[0]![0]
      .userDataDir as string;
    await closeWorkspace();
    browserMocks.launch.mockClear();

    const workspace = await getWorkspace(accounts.first);

    expect(workspace.executable).toBe(
      installations.get('chrome-install')!.executable,
    );
    expect(browserMocks.launch).toHaveBeenCalledOnce();
    expect(browserMocks.launch.mock.calls[0]![0].userDataDir).toBe(
      profileDirectory,
    );
  });

  it('demotes verified connections when a mission recreates a missing profile', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');
    const profileDirectory = browserMocks.launch.mock.calls[0]![0]
      .userDataDir as string;
    await closeWorkspace();
    rmSync(profileDirectory, { recursive: true, force: true });

    await getWorkspace(accounts.first);

    expect(db.select().from(AcademicConnectionTable).get()?.status).toBe(
      'needs-sign-in',
    );
  });

  it('keeps verified connections when reconnecting an existing profile', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');
    await closeWorkspace();

    await getWorkspace(accounts.first);

    expect(db.select().from(AcademicConnectionTable).get()?.status).toBe(
      'verified',
    );
  });

  it('stops the ScholarOS-owned browser when its close never settles', async () => {
    vi.useFakeTimers();
    try {
      await createWorkspace(accounts.first, 'chrome-install');
      const profileDirectory = browserMocks.launch.mock.calls[0]![0]
        .userDataDir as string;
      browserMocks.closeBrowser.mockImplementationOnce(
        () => new Promise(() => undefined),
      );

      const closing = closeWorkspace();
      await vi.advanceTimersByTimeAsync(10_000);
      await closing;

      expect(browserMocks.stopOwnedProcesses).toHaveBeenCalledWith(
        profileDirectory,
        installations.get('chrome-install')!.executable,
      );
    } finally {
      vi.useRealTimers();
      browserMocks.closeBrowser.mockResolvedValue(undefined);
      browserMocks.stopOwnedProcesses.mockResolvedValue(0);
      await closeWorkspace();
    }
  });

  it('stops the ScholarOS-owned browser when its session close reports failure', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    const profileDirectory = browserMocks.launch.mock.calls[0]![0]
      .userDataDir as string;
    browserMocks.closeStagehand.mockRejectedValueOnce(
      new Error('CDP connection closed'),
    );

    await closeWorkspace();

    expect(browserMocks.stopOwnedProcesses).toHaveBeenCalledWith(
      profileDirectory,
      installations.get('chrome-install')!.executable,
    );
  });

  it('stops the ScholarOS-owned browser when its browser close reports failure', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    const profileDirectory = browserMocks.launch.mock.calls[0]![0]
      .userDataDir as string;
    browserMocks.closeBrowser.mockRejectedValueOnce(
      new Error('Browser already disconnected'),
    );

    await closeWorkspace();

    expect(browserMocks.stopOwnedProcesses).toHaveBeenCalledWith(
      profileDirectory,
      installations.get('chrome-install')!.executable,
    );
  });

  it('does not stop browser processes when close answers in time', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    await closeWorkspace();

    expect(browserMocks.stopOwnedProcesses).not.toHaveBeenCalled();
  });

  it('keeps the old verified workspace active until a candidate is committed', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');
    const previousWorkspace = await getWorkspace(accounts.first);
    const previousDirectory = previousWorkspace.profileDirectory;

    const candidate = await stageWorkspaceReplacement(accounts.first, {
      requestId: crypto.randomUUID(),
      browserId: 'edge-install',
    });

    expect(candidate.state).toBe('ready');
    expect(candidate.revision).toBe(1);
    expect(browserMocks.launch).toHaveBeenCalledTimes(2);
    expect(browserMocks.launch.mock.calls[1]![0].userDataDir).not.toBe(
      previousDirectory,
    );
    expect(db.select().from(BrowserWorkspaceTable).get()?.browser).toBe(
      'chrome',
    );
    expect(db.select().from(AcademicConnectionTable).get()?.status).toBe(
      'verified',
    );
    expect(await getWorkspace(accounts.first)).toBe(previousWorkspace);
    expect(browserMocks.closeBrowser).not.toHaveBeenCalled();

    await cancelWorkspaceReplacement(accounts.first, {
      operationId: candidate.operationId,
    });

    expect(db.select().from(BrowserWorkspaceTable).get()?.browser).toBe(
      'chrome',
    );
    expect(await getWorkspace(accounts.first)).toBe(previousWorkspace);
  });

  it('keeps the original workspace and connection verification after candidate failure', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');
    const previousWorkspace = await getWorkspace(accounts.first);
    browserMocks.launch.mockRejectedValueOnce(new Error('Candidate failed'));

    const candidate = await stageWorkspaceReplacement(accounts.first, {
      requestId: crypto.randomUUID(),
      browserId: 'edge-install',
    });

    expect(candidate.state).toBe('failed');
    expect(db.select().from(BrowserWorkspaceTable).get()?.browser).toBe(
      'chrome',
    );
    expect(db.select().from(AcademicConnectionTable).get()?.status).toBe(
      'verified',
    );
    expect(await getWorkspace(accounts.first)).toBe(previousWorkspace);
    expect(browserMocks.closeBrowser).not.toHaveBeenCalled();
  });

  it('commits a candidate only after its browser and executable are ready', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');
    const candidate = await stageWorkspaceReplacement(accounts.first, {
      requestId: crypto.randomUUID(),
      browserId: 'edge-install',
    });

    const committed = await commitWorkspaceReplacement(accounts.first, {
      operationId: candidate.operationId,
      expectedRevision: candidate.revision,
    });

    expect(committed.state).toBe('needs-sign-in');
    expect(committed.revision).toBe(candidate.revision + 1);
    expect(db.select().from(BrowserWorkspaceTable).get()).toMatchObject({
      browser: 'edge',
      executable: installations.get('edge-install')!.executable,
    });
    expect(db.select().from(AcademicConnectionTable).get()).toMatchObject({
      status: 'needs-sign-in',
      verifiedAt: null,
    });
    expect((await getWorkspace(accounts.first)).executable).toBe(
      installations.get('edge-install')!.executable,
    );
    expect(browserMocks.launch).toHaveBeenCalledTimes(2);
  });

  it('returns the committed replacement when the same commit is retried', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    const candidate = await stageWorkspaceReplacement(accounts.first, {
      requestId: crypto.randomUUID(),
      browserId: 'edge-install',
    });
    const commitInput = {
      operationId: candidate.operationId,
      expectedRevision: candidate.revision,
    };

    const committed = await commitWorkspaceReplacement(
      accounts.first,
      commitInput,
    );
    const retried = await commitWorkspaceReplacement(
      accounts.first,
      commitInput,
    );

    expect(retried).toEqual(committed);
    expect(retried.state).toBe('needs-sign-in');
    expect(browserMocks.launch).toHaveBeenCalledTimes(2);
    expect(browserMocks.closeBrowser).toHaveBeenCalledOnce();
  });

  it('rejects replacement requests without a UUID request ID', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    expect(() =>
      stageWorkspaceReplacement(accounts.first, {
        requestId: 'replacement-request-invalid',
        browserId: 'edge-install',
      }),
    ).toThrow('valid UUID');
    expect(browserMocks.launch).toHaveBeenCalledOnce();
  });

  it('keeps one account workspace from answering for another account', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    await createWorkspace(accounts.second, 'chrome-install');

    expect(browserMocks.closeStagehand).toHaveBeenCalledOnce();
    expect(browserMocks.launch).toHaveBeenCalledTimes(2);
    const firstWorkspace = await getWorkspace(accounts.first);
    expect(firstWorkspace.userId).toBe(accounts.first);
    expect(browserMocks.launch).toHaveBeenCalledTimes(3);
  });

  it('restores the previous runtime when candidate verification fails during commit', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    const previousWorkspace = await getWorkspace(accounts.first);
    const candidate = await stageWorkspaceReplacement(accounts.first, {
      requestId: crypto.randomUUID(),
      browserId: 'edge-install',
    });
    const candidateRuntime = (await browserMocks.launch.mock.results[1]!
      .value) as ReturnType<typeof browserFor>;
    candidateRuntime.context.pages.mockRejectedValueOnce(
      new Error('Candidate disconnected'),
    );
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const result = await Promise.race([
      commitWorkspaceReplacement(accounts.first, {
        operationId: candidate.operationId,
        expectedRevision: candidate.revision,
      }),
      new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), 100);
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    expect(result).not.toBe('timeout');
    expect(result).toMatchObject({
      state: 'failed',
      errorCode: 'provider-failed',
    });
    expect(db.select().from(BrowserWorkspaceTable).get()?.browser).toBe(
      'chrome',
    );
    expect(await getWorkspace(accounts.first)).toBe(previousWorkspace);
  });

  it('reopens the previous runtime when the replacement transaction fails', async () => {
    await createWorkspace(accounts.first, 'chrome-install');
    insertConnection(accounts.first, 'connection-a');
    const previousWorkspace = await getWorkspace(accounts.first);
    const candidate = await stageWorkspaceReplacement(accounts.first, {
      requestId: crypto.randomUUID(),
      browserId: 'edge-install',
    });
    db.run(
      sql.raw(`
        CREATE TRIGGER fail_browser_workspace_replacement
        BEFORE UPDATE ON browser_workspaces
        WHEN NEW.browser = 'edge'
        BEGIN
          SELECT RAISE(ABORT, 'replacement write failed');
        END;
      `),
    );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let result:
      | Awaited<ReturnType<typeof commitWorkspaceReplacement>>
      | 'timeout';
    try {
      result = await Promise.race([
        commitWorkspaceReplacement(accounts.first, {
          operationId: candidate.operationId,
          expectedRevision: candidate.revision,
        }),
        new Promise<'timeout'>((resolve) => {
          timeoutHandle = setTimeout(() => resolve('timeout'), 100);
        }),
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      db.run(
        sql.raw('DROP TRIGGER IF EXISTS fail_browser_workspace_replacement'),
      );
    }

    expect(result).not.toBe('timeout');
    expect(result).toMatchObject({ state: 'failed' });
    expect(db.select().from(BrowserWorkspaceTable).get()?.browser).toBe(
      'chrome',
    );
    expect(db.select().from(AcademicConnectionTable).get()).toMatchObject({
      status: 'verified',
    });
    const restoredWorkspace = await getWorkspace(accounts.first);
    expect(restoredWorkspace.executable).toBe(previousWorkspace.executable);
    expect(restoredWorkspace.profileDirectory).toBe(
      previousWorkspace.profileDirectory,
    );
    expect(browserMocks.launch).toHaveBeenCalledTimes(3);
  });
});
