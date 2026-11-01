import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAcademicServer, academicRequest } from '../transport';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const server = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scholar-service-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const read = vi.fn(async () => ({ courses: ['cached'] }));
  const service = await createAcademicServer({
    directory,
    actions: new Map([['getCourses', read]]),
  });
  cleanups.push(service.close);
  return { ...service, read };
};
it('returns cached data and rejects unauthorized clients before dispatch', async () => {
  const service = await server();
  await expect(
    academicRequest(service.endpoint, 'getCourses'),
  ).resolves.toEqual({ courses: ['cached'] });
  await expect(
    academicRequest({ ...service.endpoint, token: 'invalid' }, 'getCourses'),
  ).rejects.toThrow('Unauthorized');
  expect(service.read).toHaveBeenCalledOnce();
});
it('rejects unsupported operations and protocol versions', async () => {
  const service = await server();
  await expect(academicRequest(service.endpoint, 'execute')).rejects.toThrow();
  await expect(
    academicRequest({ ...service.endpoint, version: 2 }, 'getCourses'),
  ).rejects.toThrow();
  expect(service.read).not.toHaveBeenCalled();
});
it('does not start a second owner in the same directory and can restart after shutdown', async () => {
  const service = await server();
  await expect(
    createAcademicServer({ directory: service.directory, actions: new Map() }),
  ).rejects.toThrow();
  await service.close();
  const restarted = await createAcademicServer({
    directory: service.directory,
    actions: new Map([['getCourses', service.read]]),
  });
  cleanups.push(restarted.close);
  await expect(
    academicRequest(restarted.endpoint, 'getCourses'),
  ).resolves.toEqual({ courses: ['cached'] });
});

it('replaces stale endpoint metadata even when its recorded PID is alive', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scholar-service-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, 'owner.json'),
    JSON.stringify({ pid: process.pid }),
  );
  await writeFile(
    path.join(directory, 'endpoint.json'),
    JSON.stringify({ version: 1, address: 'stale', token: 'stale' }),
  );

  const service = await createAcademicServer({
    directory,
    actions: new Map([['health', async () => ({ ready: true })]]),
  });
  cleanups.push(service.close);

  const owner = JSON.parse(
    await readFile(path.join(directory, 'owner.json'), 'utf8'),
  ) as { instanceId?: unknown };
  const endpoint = JSON.parse(
    await readFile(path.join(directory, 'endpoint.json'), 'utf8'),
  ) as { instanceId?: unknown };
  expect(owner.instanceId).toEqual(expect.any(String));
  expect(endpoint.instanceId).toBe(owner.instanceId);
  await expect(academicRequest(service.endpoint, 'health')).resolves.toEqual({
    ready: true,
  });
});

it('does not remove endpoint metadata that belongs to a replacement instance', async () => {
  const service = await server();
  const replacement = { ...service.endpoint, instanceId: 'replacement' };
  await writeFile(
    path.join(service.directory, 'owner.json'),
    JSON.stringify({ pid: process.pid, instanceId: 'replacement' }),
  );
  await writeFile(
    path.join(service.directory, 'endpoint.json'),
    JSON.stringify(replacement),
  );

  await service.close();

  await expect(
    readFile(path.join(service.directory, 'endpoint.json'), 'utf8'),
  ).resolves.toBe(JSON.stringify(replacement));
  await expect(
    readFile(path.join(service.directory, 'owner.json'), 'utf8'),
  ).resolves.toBe(
    JSON.stringify({ pid: process.pid, instanceId: 'replacement' }),
  );
  if (process.platform !== 'win32')
    await rm(service.endpoint.address, { force: true });
});

it('authenticates subscriptions before delivering scoped events and reports disconnects', async () => {
  const { subscribeAcademic } = await import('../transport');
  const service = await server();
  const listener = vi.fn();
  const disconnected = vi.fn();
  const unsubscribe = await subscribeAcademic(
    service.endpoint,
    listener,
    disconnected,
  );
  cleanups.push(async () => unsubscribe());
  service.publish('scholar:coursesChange', {
    accountId: 'student',
    courseId: 'course-1',
  });
  await vi.waitFor(() =>
    expect(listener).toHaveBeenCalledWith('scholar:coursesChange', {
      accountId: 'student',
      courseId: 'course-1',
    }),
  );
  await service.close();
  await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
});
