import { beforeEach, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/auth/main', () => ({ accountRequest: request }));
import { resolveConnectionCandidates } from '../services/connection-resolver';
beforeEach(() => vi.resetAllMocks());
it('validates the service response before it reaches the renderer', async () => {
  request.mockResolvedValue({
    candidates: [
      { name: 'School', url: 'https://school.edu', provider: 'unknown' },
    ],
  });
  expect(
    await resolveConnectionCandidates('school', new AbortController().signal),
  ).toEqual([
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
});
it('rejects insecure and local destinations returned by the service', async () => {
  request.mockResolvedValue({
    candidates: [{ name: 'Bad', url: 'http://127.0.0.1', provider: 'unknown' }],
  });
  await expect(
    resolveConnectionCandidates('school', new AbortController().signal),
  ).rejects.toThrow();
});
