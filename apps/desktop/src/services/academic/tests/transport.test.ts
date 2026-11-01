import { mkdtemp, rm } from 'node:fs/promises';
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
