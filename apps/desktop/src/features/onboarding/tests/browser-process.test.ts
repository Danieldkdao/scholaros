import { describe, expect, it, vi } from 'vitest';
import {
  createOwnedBrowserStopper,
  type BrowserProcess,
} from '../services/browser-process';

const executable =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const studyProfile = '/data/scholaros/study-profiles/account/browser';
const otherProfile = '/data/scholaros/study-profiles/other/browser';
const personalProfile =
  '/Users/student/Library/Application Support/Google/Chrome';

const chrome = (profile: string) =>
  `${executable} --user-data-dir=${profile} --remote-debugging-port=9222`;

const table = (entries: BrowserProcess[]) =>
  vi.fn(async () => entries satisfies BrowserProcess[]);

const sequencedTable = (batches: BrowserProcess[][]) => {
  let call = 0;
  return vi.fn(async (): Promise<BrowserProcess[]> => {
    const batch = batches[Math.min(call, batches.length - 1)]!;
    call += 1;
    return batch;
  });
};

const stopperFor = (
  entries: BrowserProcess[] | BrowserProcess[][],
  delay = async () => undefined,
) => {
  const terminate = vi.fn(async () => undefined);
  const forceTerminate = vi.fn(async () => undefined);
  const listProcesses = Array.isArray(entries[0])
    ? sequencedTable(entries as BrowserProcess[][])
    : table(entries as BrowserProcess[]);
  const stopper = createOwnedBrowserStopper({
    listProcesses,
    terminate,
    forceTerminate,
    delay,
  });
  return { stopper, terminate, forceTerminate };
};

describe('owned study browser processes', () => {
  it('terminates only the browser using a ScholarOS study profile', async () => {
    const { stopper, terminate } = stopperFor([
      { pid: 100, command: chrome(studyProfile) },
      { pid: 200, command: chrome(personalProfile) },
    ]);

    const stopped = await stopper.stop(studyProfile, executable);

    expect(stopped).toBe(1);
    expect(terminate).toHaveBeenCalledWith(100);
    expect(terminate).not.toHaveBeenCalledWith(200);
  });

  it('leaves Chrome helper processes for the parent to close', async () => {
    const { stopper, terminate } = stopperFor([
      { pid: 100, command: chrome(studyProfile) },
      {
        pid: 101,
        command: `${executable} Helper --type=renderer --user-data-dir=${studyProfile}`,
      },
    ]);

    expect(await stopper.stop(studyProfile, executable)).toBe(1);
    expect(terminate).not.toHaveBeenCalledWith(101);
  });

  it('leaves an unrelated command that mentions the profile path', async () => {
    const { stopper, terminate } = stopperFor([
      {
        pid: 300,
        command: `/bin/zsh -c grep -- "--user-data-dir=${studyProfile}"`,
      },
    ]);

    expect(await stopper.stop(studyProfile, executable)).toBe(0);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('keeps one account profile from stopping another account browser', async () => {
    const { stopper, terminate } = stopperFor([
      { pid: 100, command: chrome(otherProfile) },
    ]);

    expect(await stopper.stop(studyProfile, executable)).toBe(0);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('force stops a browser that ignores the first signal', async () => {
    const owned = { pid: 100, command: chrome(studyProfile) };
    const { stopper, forceTerminate } = stopperFor([[owned], [owned]]);

    expect(await stopper.stop(studyProfile, executable)).toBe(1);
    expect(forceTerminate).toHaveBeenCalledWith(100);
  });

  it('does not force stop a browser that exits after the first signal', async () => {
    const { stopper, forceTerminate } = stopperFor([
      [{ pid: 100, command: chrome(studyProfile) }],
      [],
    ]);

    expect(await stopper.stop(studyProfile, executable)).toBe(1);
    expect(forceTerminate).not.toHaveBeenCalled();
  });

  it('waits the grace period before checking for survivors', async () => {
    const delay = vi.fn(async () => undefined);
    const { stopper } = stopperFor(
      [{ pid: 100, command: chrome(studyProfile) }],
      delay,
    );

    await stopper.stop(studyProfile, executable);
    expect(delay).toHaveBeenCalledOnce();
  });

  it('reports nothing stopped when the process list is unavailable', async () => {
    const terminate = vi.fn(async () => undefined);
    const stopper = createOwnedBrowserStopper({
      listProcesses: vi.fn(async (): Promise<BrowserProcess[]> => {
        throw new Error('ps unavailable');
      }),
      terminate,
      forceTerminate: vi.fn(async () => undefined),
      delay: async () => undefined,
    });

    expect(await stopper.stop(studyProfile, executable)).toBe(0);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('treats a browser that exits while stopping as stopped', async () => {
    const stopper = createOwnedBrowserStopper({
      listProcesses: table([
        { pid: 100, command: chrome(studyProfile) },
        { pid: 101, command: chrome(studyProfile) },
      ]),
      terminate: vi.fn(async (pid: number) => {
        if (pid === 100) throw new Error('No such process');
      }),
      forceTerminate: vi.fn(async () => undefined),
      delay: async () => undefined,
    });

    expect(await stopper.stop(studyProfile, executable)).toBe(2);
  });
});

it('does not terminate another profile whose directory merely starts with this profile', async () => {
  const { stopper, terminate } = stopperFor([
    { pid: 701, command: chrome(studyProfile + '-other') },
  ]);
  expect(await stopper.stop(studyProfile, executable)).toBe(0);
  expect(terminate).not.toHaveBeenCalled();
});
it('recognizes a quoted Windows executable and profile path', async () => {
  const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profile = 'C:\\Users\\Student Name\\ScholarOS\\study-profiles\\account';
  const { stopper, terminate } = stopperFor([
    {
      pid: 702,
      command: `"${exe}" --user-data-dir="${profile}" --remote-debugging-port=1234`,
    },
  ]);
  expect(await stopper.stop(profile, exe)).toBe(1);
  expect(terminate).toHaveBeenCalledWith(702);
});
