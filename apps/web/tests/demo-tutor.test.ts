import { describe, expect, it, vi } from 'vitest';
import {
  createDemoTutorHandler,
  demoTutorOptions,
} from '../src/lib/demo-tutor-handler';

const request = (body: unknown = { action: 'explain' }) =>
  new Request('https://example.test/api/demo/tutor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const result = {
  text: 'A Python loop visits each list item.',
  model: 'muse-spark-1.3',
};

describe('database-free anonymous AI demo', () => {
  it('is opt-in and never calls inference while disabled', async () => {
    const generate = vi.fn();
    const response = await createDemoTutorHandler({
      enabled: () => false,
      generate,
    })(request());
    expect(response.status).toBe(503);
    expect(generate).not.toHaveBeenCalled();
  });
  it('accepts fixed samples without authentication, credentials, or private context', async () => {
    const generate = vi.fn(async () => result);
    const response = await createDemoTutorHandler({
      enabled: () => true,
      generate,
    })(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(generate).toHaveBeenCalledWith('explain', expect.any(AbortSignal));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.has('Set-Cookie')).toBe(false);
  });
  it.each([
    { action: 'custom' },
    { action: 'explain', question: 'Private input' },
    { action: 'quiz', files: [] },
    [],
    null,
  ])('rejects non-fixed input %#', async (input) => {
    const generate = vi.fn();
    const response = await createDemoTutorHandler({
      enabled: () => true,
      generate,
    })(request(input));
    expect(response.status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });
  it('enforces the actual streamed byte limit even with a lying content-length', async () => {
    const generate = vi.fn();
    const oversized = request({ action: 'explain', text: 'x'.repeat(1024) });
    oversized.headers.set('content-length', '1');
    const response = await createDemoTutorHandler({
      enabled: () => true,
      generate,
    })(oversized);
    expect(response.status).toBe(413);
    expect(generate).not.toHaveBeenCalled();
  });
  it('bounds the public budget without trusting spoofed IP headers and resets after ten minutes', async () => {
    let now = 1;
    const generate = vi.fn(async () => result);
    const handler = createDemoTutorHandler({
      enabled: () => true,
      generate,
      now: () => now,
    });
    for (let index = 0; index < 5; index++)
      expect((await handler(request())).status).toBe(200);
    const spoofed = request();
    spoofed.headers.set('x-forwarded-for', '192.0.2.50');
    expect((await handler(spoofed)).status).toBe(429);
    expect(generate).toHaveBeenCalledTimes(5);
    now = 600_001;
    expect((await handler(request({ action: 'quiz' }))).status).toBe(200);
  });
  it('admits at most two concurrent calls and releases slots after failure', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generate = vi.fn(async () => {
      await pending;
      throw new Error('private-provider-error');
    });
    const handler = createDemoTutorHandler({ enabled: () => true, generate });
    const first = handler(request());
    const second = handler(request());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect((await handler(request())).status).toBe(429);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.every((response) => response.status === 502)).toBe(true);
    expect(await responses[0]!.text()).not.toContain('private-provider-error');
    expect((await handler(request())).status).toBe(502);
  });
  it('offers credential-free preflight for the desktop demo', () => {
    const response = demoTutorOptions();
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type',
    );
    expect(response.headers.has('Access-Control-Allow-Credentials')).toBe(
      false,
    );
  });
});

it('applies a thirty-second provider deadline and returns only a safe timeout error', async () => {
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(controller.signal);
  try {
    const generate = vi.fn(
      async (_action, signal: AbortSignal) =>
        new Promise<typeof result>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('private-timeout-data')),
            { once: true },
          );
        }),
    );
    const pending = createDemoTutorHandler({ enabled: () => true, generate })(
      request(),
    );
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(timeout).toHaveBeenCalledWith(30_000);
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.text()).not.toContain('private-timeout-data');
  } finally {
    timeout.mockRestore();
  }
});
