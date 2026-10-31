import { expect, it, vi } from 'vitest';
import { createConnectRuntime } from '../services/connect-runtime';
import { createConnectionApprovalStore } from '../services/connection-approval';

it('consumes approval once, pauses for the student, then captures and releases the browser', async () => {
  const approvals = createConnectionApprovalStore();
  const proposal = approvals.propose('student', [
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  approvals.approve('student', proposal.id, proposal.candidates);
  const release = vi.fn();
  const inspect = vi
    .fn()
    .mockResolvedValueOnce({ status: 'sign-in', host: 'school.edu' })
    .mockResolvedValueOnce({ status: 'readable', host: 'school.edu' });
  const capture = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const runtime = createConnectRuntime({
    approvals,
    acquire: vi.fn(async () => ({
      signal: new AbortController().signal,
      release,
    })),
    browser: vi.fn(async () => ({ inspect, capture, close })),
  });
  await runtime.start('student', proposal.id);
  await vi.waitFor(() =>
    expect(runtime.getState('student').status).toBe('awaiting-user'),
  );
  expect(capture).not.toHaveBeenCalled();
  await expect(runtime.start('student', proposal.id)).rejects.toThrow();
  runtime.resume('student');
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(capture).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(runtime.getState('student').results).toEqual([
    { host: 'school.edu', status: 'connected' },
  ]);
  await expect(runtime.start('student', proposal.id)).rejects.toThrow();
});
