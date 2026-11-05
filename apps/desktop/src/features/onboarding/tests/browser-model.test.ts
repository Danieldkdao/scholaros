import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientLLM } from '@browserbasehq/stagehand';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  current: vi.fn(),
  getCookie: vi.fn(),
  sessionCurrent: vi.fn(),
}));
vi.mock('../../../lib/auth/main', () => ({
  accountRequest: mocks.request,
  isAccountSessionCurrent: mocks.sessionCurrent,
}));
vi.mock('../../../lib/auth/client', () => ({
  authClient: { getCookie: mocks.getCookie },
}));

import { createBrowserModel } from '../services/browser-model';
import { BrowserCapabilityChangedError } from '../services/browser-mode';

const callbackParams = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read page.' }] }],
  responseFormat: {
    type: 'json_schema',
    name: 'extract_page',
    schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
} as unknown as Parameters<ClientLLM['generate']>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCookie.mockReturnValue('student-session');
  mocks.sessionCurrent.mockReturnValue(true);
  mocks.current.mockReturnValue(true);
  mocks.request.mockResolvedValue({
    role: 'assistant',
    content: { type: 'text', text: '{"title":"Biology"}' },
    outputFormat: 'json_schema',
    structuredContent: { title: 'Biology' },
  });
});

describe('desktop Stagehand model transport', () => {
  it('accepts the single text block sent by Stagehand 4.3 extraction', async () => {
    const signal = new AbortController().signal;
    const generate = createBrowserModel({ signal, isCurrent: mocks.current });
    await generate({
      ...callbackParams,
      messages: [
        { role: 'user', content: { type: 'text', text: 'Read page.' } },
      ],
    });
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/agent',
      { kind: 'browser-model', ...callbackParams },
      signal,
    );
  });
  it('reports invalid callback fields without sending their private contents', async () => {
    const generate = createBrowserModel({
      signal: new AbortController().signal,
      isCurrent: mocks.current,
    });
    await expect(
      generate({ ...callbackParams, temperature: 9 }),
    ).rejects.toThrow(/temperature/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('forwards callback input only through the authenticated endpoint', async () => {
    const signal = new AbortController().signal;
    const generate = createBrowserModel({ signal, isCurrent: mocks.current });
    await expect(generate(callbackParams)).resolves.toMatchObject({
      outputFormat: 'json_schema',
      structuredContent: { title: 'Biology' },
    });
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/agent',
      { kind: 'browser-model', ...callbackParams },
      signal,
    );
  });

  it('rejects a stale mission, changed session, or malformed callback response', async () => {
    const signal = new AbortController().signal;
    const generate = createBrowserModel({ signal, isCurrent: mocks.current });
    mocks.current.mockReturnValue(false);
    await expect(generate(callbackParams)).rejects.toThrow(/session/i);
    expect(mocks.request).not.toHaveBeenCalled();

    mocks.current.mockReturnValue(true);
    mocks.request.mockResolvedValueOnce({ outputFormat: 'text' });
    await expect(generate(callbackParams)).rejects.toThrow(/response/i);
  });

  it('keeps mission cancellation attached to this callback', async () => {
    const controller = new AbortController();
    const generate = createBrowserModel({
      signal: controller.signal,
      isCurrent: mocks.current,
    });
    controller.abort();
    await expect(generate(callbackParams)).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('preserves a typed server capability change instead of returning a generic error', async () => {
    const generate = createBrowserModel({
      signal: new AbortController().signal,
      isCurrent: mocks.current,
    });
    mocks.request.mockRejectedValueOnce(new Error('capability-changed'));

    await expect(generate(callbackParams)).rejects.toBeInstanceOf(
      BrowserCapabilityChangedError,
    );
  });
});

it('logs only bounded validation metadata when a malformed callback contains private payloads', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const secret = 'PRIVATE https://secret.invalid cookie=session schema-text';
  try {
    const generate = createBrowserModel({
      signal: new AbortController().signal,
      isCurrent: mocks.current,
    });
    await expect(
      generate({
        ...callbackParams,
        systemPrompt: secret.repeat(300),
        messages: [{ role: secret, content: [{ type: 'text', text: secret }] }],
        temperature: 9,
      } as never),
    ).rejects.toThrow(/unsupported/);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[Browser model validation]',
      expect.objectContaining({
        phase: 'request-rejected',
        issueCount: expect.any(Number),
        systemPromptLength: secret.length * 300,
        messageCount: 1,
      }),
    );
    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('secret.invalid');
    expect(serialized).not.toContain('cookie=session');
    expect(serialized).toContain('systemPrompt');
    expect(serialized).toContain('too_big');
  } finally {
    warn.mockRestore();
  }
});
