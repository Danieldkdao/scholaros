import type {
  DemoTutorAction,
  DemoTutorResult,
} from '@scholaros/services/ai/demo-tutor';

type DemoTutorDependencies = {
  enabled: () => boolean;
  generate: (
    action: DemoTutorAction,
    signal: AbortSignal,
  ) => Promise<DemoTutorResult>;
  now?: () => number;
};
const headers = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
export const demoTutorOptions = () =>
  new Response(null, { status: 204, headers });

export const createDemoTutorHandler = (dependencies: DemoTutorDependencies) => {
  let windowStarted = 0;
  let requests = 0;
  let inFlight = 0;
  const now = dependencies.now ?? Date.now;
  return async (request: Request) => {
    const fail = (status: number, code: string, error: string) =>
      Response.json({ code, error }, { status, headers });
    if (!dependencies.enabled())
      return fail(
        503,
        'demo-unavailable',
        'The live AI sample is not configured. The guided demo is still available.',
      );
    if (request.method !== 'POST')
      return fail(405, 'method-not-allowed', 'Use POST for this sample.');
    const declared = request.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > 256)
    )
      return fail(413, 'input-too-large', 'The sample request is too large.');
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return fail(415, 'invalid-input', 'Send a JSON sample action.');
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(30_000),
    ]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      void reader?.cancel().catch(() => undefined);
    };
    let action: DemoTutorAction;
    try {
      reader = request.body?.getReader();
      if (!reader) return fail(400, 'invalid-input', 'Choose a sample action.');
      signal.addEventListener('abort', cancel, { once: true });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      let text = '';
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 256) {
          cancel();
          return fail(
            413,
            'input-too-large',
            'The sample request is too large.',
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      signal.throwIfAborted();
      text += decoder.decode();
      const parsed = JSON.parse(text);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 1 ||
        !['explain', 'quiz', 'experiment'].includes(parsed.action)
      )
        return fail(
          400,
          'invalid-input',
          'Choose Explain, Quiz, or Experiment. Custom prompts and files are not accepted by the public demo.',
        );
      action = parsed.action;
    } catch {
      return signal.aborted
        ? fail(504, 'demo-timeout', 'The sample timed out. Please try again.')
        : fail(400, 'invalid-input', 'Choose a valid sample action.');
    } finally {
      signal.removeEventListener('abort', cancel);
      reader?.releaseLock();
    }
    // Use a global budget rather than trusting caller-supplied IP headers.
    const currentTime = now();
    if (currentTime - windowStarted >= 600_000) {
      windowStarted = currentTime;
      requests = 0;
    }
    if (inFlight >= 2 || requests >= 5)
      return fail(
        429,
        'demo-rate-limited',
        'The public sample is busy. Please try again later; the guided demo remains available.',
      );
    requests += 1;
    inFlight += 1;
    try {
      const result = await dependencies.generate(action, signal);
      signal.throwIfAborted();
      return Response.json(result, { headers });
    } catch {
      return signal.aborted
        ? fail(504, 'demo-timeout', 'The sample timed out. Please try again.')
        : fail(
            502,
            'demo-provider-failed',
            'The AI sample could not respond. Please try again.',
          );
    } finally {
      inFlight -= 1;
    }
  };
};
