import type { ConnectionCandidateSchema } from '@scholaros/services/ai/schemas';
import { isAcademicUrl } from '../lib/browser-policy';
import type { AgentActivity } from '../types';

export type ConnectRunResult = {
  host: string;
  status: 'connected' | 'needs-sign-in' | 'blocked';
};

export type ConnectRunState = {
  accountId: string | null;
  status:
    | 'idle'
    | 'running'
    | 'awaiting-user'
    | 'complete'
    | 'blocked'
    | 'cancelled';
  events: AgentActivity[];
  awaiting: { host: string; destination: string; note: string | null } | null;
  results: ConnectRunResult[];
};

type Inspection = { status: 'readable' | 'sign-in' | 'blocked'; host: string };

type Dependencies = {
  prepareHandoff?: (destination: string, signal: AbortSignal) => Promise<void>;
  noteForHost?: (accountId: string, host: string) => string | null;
  inspect: (
    candidate: ConnectionCandidateSchema,
    signal: AbortSignal,
  ) => Promise<Inspection>;
  capture: (
    candidate: ConnectionCandidateSchema,
    signal: AbortSignal,
  ) => Promise<void | 'connected' | 'needs-sign-in'>;
};

const emptyState = (): ConnectRunState => ({
  accountId: null,
  status: 'idle',
  events: [],
  awaiting: null,
  results: [],
});

export const createConnectRun = (dependencies: Dependencies) => {
  let state = emptyState();
  let controller: AbortController | null = null;
  let resume: (() => void) | null = null;
  let generation = 0;
  const listeners = new Set<(state: ConnectRunState) => void>();
  const notify = () => {
    for (const listener of listeners) listener(structuredClone(state));
  };
  const event = (activity: AgentActivity) => {
    state.events.push(activity);
    notify();
  };
  const waitForUser = (signal: AbortSignal) =>
    new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => finish(undefined, false), 300_000);
      const onAbort = () => finish(signal.reason ?? new Error('Cancelled'));
      const finish = (error?: unknown, continued = true) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resume = null;
        if (error) reject(error);
        else resolve(continued);
      };
      resume = () => finish();
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  const start = async (
    accountId: string,
    candidates: ConnectionCandidateSchema[],
    externalSignal?: AbortSignal,
  ) => {
    if (controller) throw new Error('A connection run is already active.');
    if (!candidates.length) throw new Error('Approve at least one site.');
    controller = new AbortController();
    const run = ++generation;
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    state = { ...emptyState(), accountId, status: 'running' };
    notify();
    try {
      for (const candidate of candidates) {
        signal.throwIfAborted();
        const host = new URL(candidate.url).hostname;
        event({ type: 'opening', detail: host });
        let inspection = await dependencies.inspect(candidate, signal);
        signal.throwIfAborted();
        if (
          inspection.status === 'sign-in' &&
          isAcademicUrl(`https://${inspection.host}/`)
        ) {
          await dependencies.prepareHandoff?.(candidate.url, signal);
          signal.throwIfAborted();
          state.status = 'awaiting-user';
          state.awaiting = {
            host: inspection.host,
            destination: host,
            note: dependencies.noteForHost?.(accountId, host) ?? null,
          };
          const handoff = waitForUser(signal);
          notify();
          const continued = await handoff;
          signal.throwIfAborted();
          state.status = 'running';
          state.awaiting = null;
          notify();
          if (continued) {
            inspection = await dependencies.inspect(candidate, signal);
            signal.throwIfAborted();
          } else {
            inspection = { status: 'blocked', host };
          }
        }
        if (inspection.status === 'readable' && inspection.host === host) {
          const captured = await dependencies.capture(candidate, signal);
          signal.throwIfAborted();
          state.results.push({
            host,
            status:
              captured === 'needs-sign-in' ? 'needs-sign-in' : 'connected',
          });
        } else state.results.push({ host, status: 'blocked' });
        notify();
      }
      state.status = 'complete';
      event({ type: 'complete' });
    } catch {
      if (generation !== run) return;
      state.status = signal.aborted ? 'cancelled' : 'blocked';
      state.awaiting = null;
      event({ type: signal.aborted ? 'cancelled' : 'blocked' });
    } finally {
      controller = null;
    }
  };
  const getState = (accountId: string) =>
    state.accountId === accountId ? structuredClone(state) : emptyState();
  const resumeRun = (accountId: string) => {
    if (state.accountId === accountId && state.status === 'awaiting-user')
      resume?.();
  };
  const cancel = (accountId: string) => {
    if (state.accountId === accountId) controller?.abort();
  };
  const fail = (accountId: string) => {
    if (state.accountId !== accountId) return;
    state.status = 'blocked';
    state.awaiting = null;
    event({ type: 'blocked' });
  };
  const reset = () => {
    generation += 1;
    controller?.abort();
    state = emptyState();
    notify();
  };
  const subscribe = (listener: (state: ConnectRunState) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return { start, getState, resume: resumeRun, cancel, reset, fail, subscribe };
};
