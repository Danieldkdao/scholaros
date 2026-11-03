import type { ClientLLM } from '@browserbasehq/stagehand';
import {
  browserModelResponseSchema,
  browserModelRequestSchema,
} from '@scholaros/services/ai/browser-schemas';
import { authClient } from '../../../lib/auth/client';
import {
  accountRequest,
  isAccountSessionCurrent,
} from '../../../lib/auth/main';
import { toBrowserCapabilityError } from './browser-mode';

type BrowserModelOptions = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

export const createBrowserModel =
  ({ signal, isCurrent }: BrowserModelOptions): ClientLLM['generate'] =>
  async (params) => {
    signal.throwIfAborted();
    const cookie = authClient.getCookie();
    if (!cookie.trim() || !isCurrent() || !isAccountSessionCurrent(cookie))
      throw new Error('Your session changed before browser inference started.');
    const request = {
      kind: 'browser-model',
      messages: params.messages,
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.temperature === undefined
        ? {}
        : { temperature: params.temperature }),
      ...(params.stopSequences === undefined
        ? {}
        : { stopSequences: params.stopSequences }),
      responseFormat: params.responseFormat,
    };
    const parsedRequest = browserModelRequestSchema.safeParse(request);
    if (!parsedRequest.success)
      throw new Error(
        `The browser model request is unsupported: ${parsedRequest.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.code}`)
          .join(', ')
          .slice(0, 200)}.`,
      );
    let result: unknown;
    try {
      result = await accountRequest('/api/agent', parsedRequest.data, signal);
    } catch (error) {
      throw toBrowserCapabilityError(error);
    }
    signal.throwIfAborted();
    if (!isCurrent() || !isAccountSessionCurrent(cookie))
      throw new Error(
        'Your session changed while browser inference was running.',
      );
    const parsed = browserModelResponseSchema.safeParse(result);
    if (!parsed.success)
      throw new Error('The browser inference response was invalid.');
    return parsed.data as Awaited<ReturnType<ClientLLM['generate']>>;
  };
