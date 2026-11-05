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
    if (!parsedRequest.success) {
      const fields = new Set([
        'kind',
        'browserNavigationMode',
        'configurationRevision',
        'messages',
        'role',
        'content',
        'type',
        'text',
        'annotations',
        'audience',
        'priority',
        'lastModified',
        'systemPrompt',
        'temperature',
        'stopSequences',
        'responseFormat',
        'name',
        'description',
        'schema',
      ]);
      const issues = parsedRequest.error.issues.slice(0, 8).map((issue) => ({
        path:
          issue.path
            .slice(0, 8)
            .map((part) =>
              typeof part === 'number'
                ? Math.min(Math.max(0, part), 1000)
                : typeof part === 'string' && fields.has(part)
                  ? part
                  : 'field',
            )
            .join('.')
            .slice(0, 160) || 'request',
        code: issue.code,
      }));
      const messages = Array.isArray(request.messages) ? request.messages : [];
      const knownRoles = new Set([
        'user',
        'assistant',
        'system',
        'developer',
        'tool',
      ]);
      try {
        console.warn('[Browser model validation]', {
          phase: 'request-rejected',
          issueCount: parsedRequest.error.issues.length,
          issues,
          systemPromptLength:
            typeof request.systemPrompt === 'string'
              ? request.systemPrompt.length
              : 0,
          messageCount: messages.length,
          messageRoles: messages
            .slice(0, 24)
            .map((message) =>
              message &&
              typeof message === 'object' &&
              knownRoles.has(message.role)
                ? message.role
                : 'unsupported',
            ),
          sampledMessageTextLength: messages
            .slice(0, 24)
            .reduce((total, message) => {
              const content: unknown =
                message && typeof message === 'object' ? message.content : null;
              if (typeof content === 'string') return total + content.length;
              const parts = Array.isArray(content)
                ? content.slice(0, 32)
                : [content];
              return (
                total +
                parts.reduce(
                  (sum, part) =>
                    sum +
                    (part &&
                    typeof part === 'object' &&
                    'text' in part &&
                    typeof part.text === 'string'
                      ? part.text.length
                      : 0),
                  0,
                )
              );
            }, 0),
        });
      } catch {
        // Diagnostics never change validation or expose the rejected request.
      }
      throw new Error(
        `The browser model request is unsupported: ${issues
          .map((issue) => `${issue.path} ${issue.code}`)
          .join(', ')
          .slice(0, 200)}.`,
      );
    }
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
