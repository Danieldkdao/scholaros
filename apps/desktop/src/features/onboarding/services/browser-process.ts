import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const maxListBuffer = 16 * 1024 * 1024;

export type BrowserProcess = { pid: number; command: string };

export type OwnedBrowserStopper = {
  stop: (profileDirectory: string, executable: string) => Promise<number>;
};

type StopperDependencies = {
  listProcesses: () => Promise<BrowserProcess[]>;
  terminate: (pid: number) => Promise<void>;
  forceTerminate: (pid: number) => Promise<void>;
  delay: (milliseconds: number) => Promise<void>;
  graceMs?: number;
};

const ownedGraceMs = 1200;
const isWindows = process.platform === 'win32';
const processPid = process.pid;

// Chrome helper processes inherit --user-data-dir, so only the parent browser
// counts: its own profile flag plus the binary ScholarOS launched. That keeps
// personal profiles and unrelated command lines out of reach.
const escapePattern = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ownedBy = (
  entries: BrowserProcess[],
  profile: string,
  executable: string,
) => {
  const profileFlag = new RegExp(
    `(?:^|\\s)--user-data-dir=(?:"${escapePattern(profile)}"|${escapePattern(profile)})(?=\\s|$)`,
  );
  return entries.filter((entry) => {
    const prefix = entry.command.startsWith(`"${executable}"`)
      ? `"${executable}"`
      : executable;
    const remainder = entry.command.slice(prefix.length);
    return (
      entry.pid !== processPid &&
      entry.command.startsWith(prefix) &&
      /^\s/.test(remainder) &&
      profileFlag.test(remainder) &&
      !entry.command.includes('--type=')
    );
  });
};

const parseProcessList = (stdout: string): BrowserProcess[] =>
  stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });

const listPosixProcesses = async () => {
  const { stdout } = await run('ps', ['-axww', '-o', 'pid=,args='], {
    maxBuffer: maxListBuffer,
    timeout: 5000,
  });
  return parseProcessList(stdout);
};

const listWindowsProcesses = async () => {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
    ],
    { maxBuffer: maxListBuffer, timeout: 5000 },
  );
  return parseProcessList(stdout);
};

const listProcesses = isWindows ? listWindowsProcesses : listPosixProcesses;

const terminateProcess = async (pid: number) => {
  if (isWindows) {
    await run('taskkill', ['/PID', String(pid)], { timeout: 5000 });
    return;
  }
  process.kill(pid, 'SIGTERM');
};

const forceTerminateProcess = async (pid: number) => {
  if (isWindows) {
    await run('taskkill', ['/PID', String(pid), '/F', '/T'], { timeout: 5000 });
    return;
  }
  process.kill(pid, 'SIGKILL');
};

const delayProcessExit = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const createOwnedBrowserStopper = ({
  listProcesses: list,
  terminate,
  forceTerminate,
  delay,
  graceMs = ownedGraceMs,
}: StopperDependencies): OwnedBrowserStopper => {
  const owned = async (profile: string, executable: string) => {
    try {
      return ownedBy(await list(), profile, executable);
    } catch {
      return [];
    }
  };
  const stop = async (profileDirectory: string, executable: string) => {
    const matches = await owned(profileDirectory, executable);
    if (!matches.length) return 0;
    // Graceful exit first so Chrome flushes cookies into the study profile.
    for (const match of matches)
      await terminate(match.pid).catch(() => undefined);
    await delay(graceMs);
    const survivors = await owned(profileDirectory, executable);
    for (const survivor of survivors)
      await forceTerminate(survivor.pid).catch(() => undefined);
    return matches.length;
  };
  return { stop };
};

export const stopOwnedBrowserProcesses = (
  profileDirectory: string,
  executable: string,
) =>
  createOwnedBrowserStopper({
    listProcesses,
    terminate: terminateProcess,
    forceTerminate: forceTerminateProcess,
    delay: delayProcessExit,
  }).stop(profileDirectory, executable);
