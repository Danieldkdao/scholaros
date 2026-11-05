import { randomUUID } from 'node:crypto';

type DemoFetchOptions = {
  enabled: () => boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;

const responseUsage = async (response: Response) => {
  if (!response.headers.get('content-type')?.includes('application/json'))
    return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  let text = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > 512_000) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
    }
    text += decoder.decode();
    const usage = JSON.parse(text)?.usage;
    if (!usage || typeof usage !== 'object') return null;
    return {
      inputTokens: count(usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
      totalTokens: count(usage.total_tokens),
      reasoningTokens: count(
        usage.completion_tokens_details?.reasoning_tokens ??
          usage.output_tokens_details?.reasoning_tokens,
      ),
    };
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
};

/** Opt-in metadata only. Never log headers, prompts, outputs, or raw errors. */
export const createMetaDemoFetch =
  ({
    enabled,
    fetchImpl = (input, init) => globalThis.fetch(input, init),
    log = (line) => console.info(line),
  }: DemoFetchOptions): typeof fetch =>
  async (input, init) => {
    if (!enabled()) return fetchImpl(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    const endpoint =
      url.origin === 'https://api.meta.ai'
        ? `${url.origin}${url.pathname}`
        : 'other-endpoint';
    let model = 'unknown';
    try {
      const requestedModel =
        typeof init?.body === 'string' ? JSON.parse(init.body)?.model : null;
      if (
        typeof requestedModel === 'string' &&
        /^muse-[a-z0-9.-]{1,80}$/.test(requestedModel)
      )
        model = requestedModel;
    } catch {
      /* Request validation remains the provider's responsibility. */
    }
    const metadata = { requestId: randomUUID(), endpoint, model };
    const started = performance.now();
    const emit = (fields: Record<string, unknown>) => {
      try {
        log(
          `[Meta API] ${JSON.stringify({ timestamp: new Date().toISOString(), ...metadata, ...fields })}`,
        );
      } catch {
        /* Logging must never break an inference request. */
      }
    };
    emit({ phase: 'start' });
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      emit({
        phase: 'network-error',
        status: null,
        durationMs: Math.round(performance.now() - started),
        usage: null,
      });
      throw error;
    }
    const usage = await responseUsage(response);
    emit({
      phase: 'complete',
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      usage,
    });
    return response;
  };
