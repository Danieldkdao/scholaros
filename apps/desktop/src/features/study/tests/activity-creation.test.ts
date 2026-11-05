import { expect, it, vi } from 'vitest';
import { createActivityWithValidationRepair } from '../services/activity-creation';
const requestId = '11111111-1111-4111-8111-111111111111';
const saved = {
  artifactId: 'artifact',
  versionId: 'version',
  attemptId: 'attempt',
};
it('regenerates a rejected generated artifact once with a distinct deterministic request ID', async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce({
      code: 'invalid-input',
      validationReason: 'unsafe-content',
    })
    .mockResolvedValueOnce(saved);
  await expect(
    createActivityWithValidationRepair(requestId, create),
  ).resolves.toEqual(saved);
  expect(create).toHaveBeenCalledTimes(2);
  const repairedId = create.mock.calls[1]![0];
  expect(repairedId).not.toBe(requestId);
  expect(repairedId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  const repeated = vi
    .fn()
    .mockRejectedValueOnce({
      code: 'invalid-input',
      validationReason: 'non-interactive',
    })
    .mockResolvedValueOnce(saved);
  await createActivityWithValidationRepair(requestId, repeated);
  expect(repeated.mock.calls[1]![0]).toBe(repairedId);
});
it.each([
  'permission-revoked',
  'cancelled',
  'scope-denied',
  'provider-failed',
  'storage-failed',
])('never retries a %s failure', async (code) => {
  const error = { code };
  const create = vi.fn().mockRejectedValue(error);
  await expect(
    createActivityWithValidationRepair(requestId, create),
  ).rejects.toBe(error);
  expect(create).toHaveBeenCalledOnce();
});
it('bounds repeated validation failure to two attempts', async () => {
  const create = vi.fn().mockRejectedValue({
    code: 'invalid-input',
    validationReason: 'unsafe-content',
  });
  await expect(
    createActivityWithValidationRepair(requestId, create),
  ).rejects.toMatchObject({ validationReason: 'unsafe-content' });
  expect(create).toHaveBeenCalledTimes(2);
});

it('passes only the bounded validation reason to its one repair attempt', async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce({
      code: 'invalid-input',
      validationReason: 'non-interactive',
      message: 'PRIVATE generated HTML and source text',
    })
    .mockResolvedValueOnce(saved);
  await createActivityWithValidationRepair(requestId, create);
  expect(create.mock.calls[0]).toEqual([requestId]);
  expect(create.mock.calls[1]).toEqual([expect.any(String), 'non-interactive']);
  expect(JSON.stringify(create.mock.calls)).not.toContain('PRIVATE');
});
