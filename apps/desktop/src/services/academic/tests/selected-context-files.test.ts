const observedOpenCalls = vi.hoisted(() => ({
  calls: [] as Array<[unknown, unknown]>,
  handles: [] as unknown[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (filePath, flags, mode) => {
    observedOpenCalls.calls.push([filePath, flags]);
    const fileHandle = await actual.open(filePath, flags, mode);
    observedOpenCalls.handles.push(fileHandle);
    return fileHandle;
  };
  return { ...actual, open };
});

import { constants } from 'node:fs';
import {
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { contextFileLimits } from '../../../features/context/services/file-validation';
import {
  createSelectedContextFileRegistry,
  type SelectedContextFileBinding,
} from '../selected-context-files';

const context = { userId: 'student-a', epoch: 4 };
const binding = {
  itemId: 'item-a',
  revision: 3,
  sessionId: 'session-a',
  courseId: 'course-a',
};

let directory: string;
let registry: ReturnType<typeof createSelectedContextFileRegistry>;

beforeEach(async () => {
  observedOpenCalls.calls.length = 0;
  observedOpenCalls.handles.length = 0;
  directory = await mkdtemp(path.join(tmpdir(), 'selected-context-files-'));
  registry = createSelectedContextFileRegistry();
});

afterEach(async () => {
  await registry.clear();
  await rm(directory, { recursive: true, force: true });
});

it('registers a real selected file and exposes only safe metadata', async () => {
  const filePath = path.join(directory, 'notes.txt');
  await writeFile(filePath, 'bounded note');

  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  expect(registered.info).toEqual({
    fileName: 'notes.txt',
    contentType: 'text/plain',
    byteLength: 12,
  });
  expect(registered.ticketId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(JSON.stringify(registered)).not.toContain(directory);
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toEqual(registered.info);
});

it('does not expose a path-like selected filename in metadata', async () => {
  const filePath = path.join(
    directory,
    ['C:', 'private', 'notes.txt'].join('\\'),
  );
  await writeFile(filePath, 'bounded note');

  await expect(
    registry.register(context, filePath, binding),
  ).resolves.toBeNull();
});

it('binds inspection to the registered account and lifecycle epoch', async () => {
  const filePath = path.join(directory, 'notes.txt');
  await writeFile(filePath, 'bounded note');
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');

  await expect(
    registry.inspect(
      { ...context, userId: 'student-b' },
      registered.ticketId,
      binding,
    ),
  ).resolves.toBeNull();
  await expect(
    registry.inspect(
      { ...context, epoch: context.epoch + 1 },
      registered.ticketId,
      binding,
    ),
  ).resolves.toBeNull();
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toEqual(registered.info);
});

it('binds inspection to the item, revision, session, and course', async () => {
  const filePath = path.join(directory, 'notes.txt');
  await writeFile(filePath, 'bounded note');
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');

  const mismatches: SelectedContextFileBinding[] = [
    { ...binding, itemId: 'item-b' },
    { ...binding, revision: binding.revision + 1 },
    { ...binding, sessionId: 'session-b' },
    { ...binding, courseId: 'course-b' },
  ];
  for (const mismatch of mismatches)
    await expect(
      registry.inspect(context, registered.ticketId, mismatch),
    ).resolves.toBeNull();
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toEqual(registered.info);
});

it('returns null for malformed inspection binding input', async () => {
  const filePath = path.join(directory, 'notes.txt');
  await writeFile(filePath, 'bounded note');
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');

  await expect(
    registry.inspect(context, registered.ticketId, undefined as never),
  ).resolves.toBeNull();
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toEqual(registered.info);
});

it('invalidates a ticket when its selected path is replaced', async () => {
  const filePath = path.join(directory, 'notes.txt');
  const originalPath = path.join(directory, 'original.txt');
  await writeFile(filePath, 'same size');
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  await rename(filePath, originalPath);
  await writeFile(filePath, 'new bytes');

  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
  await rm(filePath);
  await rename(originalPath, filePath);
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
});

it('invalidates a ticket when the file is modified in place', async () => {
  const filePath = path.join(directory, 'notes.txt');
  await writeFile(filePath, 'original');
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  await writeFile(filePath, 'modified');
  await utimes(filePath, new Date(), new Date('2030-01-01T00:00:00.000Z'));

  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
});

it('invalidates a ticket when file size changes even if mtime is restored', async () => {
  const filePath = path.join(directory, 'notes.txt');
  const stableTime = new Date('2030-01-01T00:00:00.000Z');
  await writeFile(filePath, 'original');
  await utimes(filePath, stableTime, stableTime);
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  await writeFile(filePath, 'changed-size');
  await utimes(filePath, stableTime, stableTime);

  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
});

it('invalidates same-size content changes even when mtime is restored', async () => {
  const filePath = path.join(directory, 'notes.txt');
  const stableTime = new Date('2030-01-01T00:00:00.000Z');
  await writeFile(filePath, 'original');
  await utimes(filePath, stableTime, stableTime);
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  await writeFile(filePath, 'modified');
  await utimes(filePath, stableTime, stableTime);

  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
});

it('expires pending tickets after five minutes', async () => {
  vi.useFakeTimers();
  try {
    const filePath = path.join(directory, 'notes.txt');
    await writeFile(filePath, 'bounded note');
    const registered = await registry.register(context, filePath, binding);

    expect(registered).not.toBeNull();
    if (!registered) throw new Error('Expected a selected-file ticket.');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    await expect(
      registry.inspect(context, registered.ticketId, binding),
    ).resolves.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('rejects files larger than the shared document limit and closes the opened handle', async () => {
  const filePath = path.join(directory, 'large.txt');
  await writeFile(filePath, '');
  await truncate(filePath, contextFileLimits.documentBytes + 1);

  await expect(
    registry.register(context, filePath, binding),
  ).resolves.toBeNull();
  const fileHandle = observedOpenCalls.handles.at(-1) as
    | { stat: () => Promise<unknown> }
    | undefined;
  expect(fileHandle).toBeDefined();
  await expect(fileHandle!.stat()).rejects.toThrow();
});

it('allows eight empty files but rejects a ninth pending ticket', async () => {
  const registrations = [];
  for (let index = 0; index < contextFileLimits.batchFiles; index += 1) {
    const filePath = path.join(directory, `empty-${index}.txt`);
    await writeFile(filePath, '');
    registrations.push(await registry.register(context, filePath, binding));
  }

  expect(registrations.every(Boolean)).toBe(true);
  expect(registrations[0]?.info.byteLength).toBe(0);
  const ninthPath = path.join(directory, 'empty-ninth.txt');
  await writeFile(ninthPath, '');

  await expect(
    registry.register(context, ninthPath, binding),
  ).resolves.toBeNull();
});

it('shares the P09 aggregate byte budget across pending tickets', async () => {
  const fileLength = Math.ceil(contextFileLimits.batchBytes / 3) + 1;
  const registrations = [];
  for (let index = 0; index < 3; index += 1) {
    const filePath = path.join(directory, `aggregate-${index}.txt`);
    await writeFile(filePath, '');
    await truncate(filePath, fileLength);
    registrations.push(await registry.register(context, filePath, binding));
  }

  expect(registrations.slice(0, 2).every(Boolean)).toBe(true);
  expect(registrations[2]).toBeNull();
});

it('rejects a selected symbolic link', async () => {
  const filePath = path.join(directory, 'notes.txt');
  const linkPath = path.join(directory, 'link.txt');
  await writeFile(filePath, 'bounded note');
  await symlink(filePath, linkPath);

  await expect(
    registry.register(context, linkPath, binding),
  ).resolves.toBeNull();
});

it('opens regular files without following symlinks when supported', async () => {
  if (constants.O_NOFOLLOW === undefined) return;
  const filePath = path.join(directory, 'notes.txt');
  await writeFile(filePath, 'bounded note');

  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  const flags = observedOpenCalls.calls.find(
    ([candidate]) => candidate === filePath,
  )?.[1];
  expect(typeof flags).toBe('number');
  if (typeof flags === 'number')
    expect(flags & constants.O_NOFOLLOW).not.toBe(0);
});

it('reads a registered file once and returns only its bytes', async () => {
  const filePath = path.join(directory, 'notes.txt');
  const contents = Buffer.from('bounded note');
  await writeFile(filePath, contents);
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  const firstRead = await registry.read(
    context,
    registered.ticketId,
    binding,
    registered.info,
    contextFileLimits.documentBytes,
    new AbortController().signal,
  );

  expect(firstRead).toEqual(contents);
  await expect(
    registry.read(
      context,
      registered.ticketId,
      binding,
      registered.info,
      contextFileLimits.documentBytes,
      new AbortController().signal,
    ),
  ).resolves.toBeNull();
});

it('returns empty bytes for an empty selected file', async () => {
  const filePath = path.join(directory, 'empty.txt');
  await writeFile(filePath, '');
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  await expect(
    registry.read(
      context,
      registered.ticketId,
      binding,
      registered.info,
      contextFileLimits.documentBytes,
      new AbortController().signal,
    ),
  ).resolves.toEqual(Buffer.alloc(0));
});

it('does not consume a ticket when maxBytes is smaller than its file', async () => {
  const filePath = path.join(directory, 'notes.txt');
  const contents = Buffer.alloc(128 * 1024, 0x61);
  await writeFile(filePath, contents);
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  await expect(
    registry.read(
      context,
      registered.ticketId,
      binding,
      registered.info,
      64 * 1024,
      new AbortController().signal,
    ),
  ).resolves.toBeNull();
  await expect(
    registry.read(
      context,
      registered.ticketId,
      binding,
      registered.info,
      contextFileLimits.documentBytes,
      new AbortController().signal,
    ),
  ).resolves.toEqual(contents);
});

it('preserves a ticket when read account, epoch, or binding does not match', async () => {
  const filePath = path.join(directory, 'notes.txt');
  const contents = Buffer.from('bounded note');
  await writeFile(filePath, contents);
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  const mismatchedReads = [
    {
      context: { ...context, userId: 'student-b' },
      binding,
    },
    {
      context: { ...context, epoch: context.epoch + 1 },
      binding,
    },
    {
      context,
      binding: { ...binding, revision: binding.revision + 1 },
    },
    {
      context,
      binding: { ...binding, sessionId: 'session-b' },
    },
  ];
  for (const mismatch of mismatchedReads)
    await expect(
      registry.read(
        mismatch.context,
        registered.ticketId,
        mismatch.binding,
        registered.info,
        contextFileLimits.documentBytes,
        new AbortController().signal,
      ),
    ).resolves.toBeNull();

  await expect(
    registry.read(
      context,
      registered.ticketId,
      binding,
      registered.info,
      contextFileLimits.documentBytes,
      new AbortController().signal,
    ),
  ).resolves.toEqual(contents);
});

it('cancels a chunked read when its caller aborts', async () => {
  const filePath = path.join(directory, 'large.txt');
  await writeFile(filePath, '');
  await truncate(filePath, 512 * 1024);
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  const controller = new AbortController();
  const read = registry.read(
    context,
    registered.ticketId,
    binding,
    registered.info,
    contextFileLimits.documentBytes,
    controller.signal,
  );
  controller.abort();

  await expect(read).resolves.toBeNull();
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
});

it('clear aborts and waits for an in-flight read', async () => {
  const filePath = path.join(directory, 'large.txt');
  await writeFile(filePath, '');
  await truncate(filePath, 512 * 1024);
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  const read = registry.read(
    context,
    registered.ticketId,
    binding,
    registered.info,
    contextFileLimits.documentBytes,
    new AbortController().signal,
  );
  const cleared = registry.clear();

  await cleared;
  await expect(read).resolves.toBeNull();
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
});

it('clear closes handles for pending tickets', async () => {
  const filePath = path.join(directory, 'notes.txt');
  await writeFile(filePath, 'bounded note');
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  const fileHandle = observedOpenCalls.handles.at(-1) as
    | { stat: () => Promise<unknown> }
    | undefined;
  expect(fileHandle).toBeDefined();

  await registry.clear();

  await expect(fileHandle!.stat()).rejects.toThrow();
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
});

it('discards a pending ticket only within its registered account and epoch', async () => {
  const filePath = path.join(directory, 'notes.txt');
  await writeFile(filePath, 'bounded note');
  const registered = await registry.register(context, filePath, binding);

  expect(registered).not.toBeNull();
  if (!registered) throw new Error('Expected a selected-file ticket.');
  await registry.discard(
    { ...context, userId: 'student-b' },
    registered.ticketId,
  );
  await registry.discard(
    { ...context, epoch: context.epoch + 1 },
    registered.ticketId,
  );
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toEqual(registered.info);

  await registry.discard(context, registered.ticketId);
  await registry.discard(context, registered.ticketId);
  await expect(
    registry.inspect(context, registered.ticketId, binding),
  ).resolves.toBeNull();
});
