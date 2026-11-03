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
});
