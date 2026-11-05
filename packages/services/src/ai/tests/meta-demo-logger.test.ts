import { expect, it, vi } from 'vitest';
import { createMetaDemoFetch } from '../models/meta-demo-logger';

it('logs only allowlisted metadata from a real completed response', async () => {
  const log = vi.fn();
  const payload = {
    model: 'muse-spark-1.3',
    messages: [{ content: 'PRIVATE_STUDENT_TEXT' }],
  };
  const fetcher = createMetaDemoFetch({
    enabled: () => true,
    log,
    fetchImpl: async () =>
      Response.json({
        choices: [{ message: { content: 'PRIVATE_RESPONSE' } }],
        usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
      }),
  });
  const response = await fetcher(
    'https://api.meta.ai/v1/chat/completions?secret=PRIVATE_KEY',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer PRIVATE_KEY' },
      body: JSON.stringify(payload),
    },
  );
  expect(await response.json()).toHaveProperty('choices');
  const output = log.mock.calls.flat().join(' ');
  expect(output).toContain('muse-spark-1.3');
  expect(output).toContain('https://api.meta.ai/v1/chat/completions');
  expect(output).toContain('"status":200');
  expect(output).toContain('"inputTokens":12');
  expect(output).not.toContain('PRIVATE');
});

it('does not log or inspect response bodies when disabled', async () => {
  const log = vi.fn();
  const response = Response.json({ test: true });
  const clone = vi.spyOn(response, 'clone');
  const fetcher = createMetaDemoFetch({
    enabled: () => false,
    log,
    fetchImpl: async () => response,
  });
  expect(await fetcher('https://api.meta.ai/v1/chat/completions')).toBe(
    response,
  );
  expect(clone).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

it('never logs provider error messages and preserves the original failure', async () => {
  const log = vi.fn();
  const error = new Error('PRIVATE_KEY PRIVATE_STUDENT_TEXT');
  const fetcher = createMetaDemoFetch({
    enabled: () => true,
    log,
    fetchImpl: async () => {
      throw error;
    },
  });
  await expect(fetcher('https://api.meta.ai/v1/chat/completions')).rejects.toBe(
    error,
  );
  expect(log.mock.calls.flat().join(' ')).toContain('network-error');
  expect(log.mock.calls.flat().join(' ')).not.toContain('PRIVATE');
});
