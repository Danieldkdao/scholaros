import { setTimeout as delay } from 'node:timers/promises';

type TrafficOptions = {
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  intervalMs?: number;
};

type HostTrafficState = {
  cooldownUntil: number;
  lastStartedAt: number | null;
  queue: Promise<void>;
};

export const createMissionTrafficController = ({
  now = Date.now,
  sleep = (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  intervalMs = 1000,
}: TrafficOptions = {}) => {
  const schools = new Map<string, HostTrafficState>();
  let intervalController = new AbortController();
  const stateFor = (url: string) => {
    const host = new URL(url).hostname;
    let state = schools.get(host);
    if (!state) {
      state = {
        cooldownUntil: 0,
        lastStartedAt: null,
        queue: Promise.resolve(),
      };
      schools.set(host, state);
    }
    return state;
  };
  const cooldownError = (until: number) =>
    new Error(
      `Your school asked us to slow down. Wait about ${Math.max(1, Math.ceil((until - now()) / 1000))} seconds before trying again.`,
    );
  const recordRateLimit = (url: string, retryAfter?: string | null) => {
    const seconds =
      retryAfter &&
      /^\d+$/.test(retryAfter.trim()) &&
      Number.isFinite(Number(retryAfter))
        ? Number(retryAfter)
        : null;
    const date = retryAfter && seconds === null ? Date.parse(retryAfter) : NaN;
    const requestedUntil =
      seconds !== null
        ? now() + seconds * 1000
        : Number.isFinite(date)
          ? date
          : now() + 30000;
    const state = stateFor(url);
    state.cooldownUntil = Math.max(
      state.cooldownUntil,
      requestedUntil,
      now() + 5000,
    );
    return cooldownError(state.cooldownUntil);
  };
  const runTurn = async <T>(
    url: string,
    signal: AbortSignal,
    action: () => Promise<T>,
    onWait?: (milliseconds: number) => void,
  ) => {
    signal.throwIfAborted();
    const state = stateFor(url);
    const reserveTurn = async () => {
      while (true) {
        signal.throwIfAborted();
        const currentTime = now();
        if (state.cooldownUntil > currentTime)
          throw cooldownError(state.cooldownUntil);
        const earliestStart =
          state.lastStartedAt === null
            ? currentTime
            : state.lastStartedAt + intervalMs;
        const milliseconds = Math.max(0, earliestStart - currentTime);
        if (milliseconds > 0) {
          onWait?.(milliseconds);
          const configurationSignal = intervalController.signal;
          try {
            await sleep(
              milliseconds,
              AbortSignal.any([signal, configurationSignal]),
            );
          } catch (error) {
            signal.throwIfAborted();
            if (!configurationSignal.aborted) throw error;
          }
          continue;
        }
        signal.throwIfAborted();
        const startedAt = now();
        if (state.cooldownUntil > startedAt)
          throw cooldownError(state.cooldownUntil);
        if (
          state.lastStartedAt !== null &&
          startedAt - state.lastStartedAt < intervalMs
        )
          continue;
        state.lastStartedAt = startedAt;
        try {
          return await action();
        } finally {
          // Reserve through dispatch so slow browser validation cannot bunch clicks.
          state.lastStartedAt = now();
        }
      }
    };
    const turn = state.queue.then(reserveTurn, reserveTurn);
    state.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  };
  const waitForTurn = (
    url: string,
    signal: AbortSignal,
    onWait?: (milliseconds: number) => void,
  ) => runTurn(url, signal, async () => undefined, onWait);
  const assertPageContent = (url: string, text: string) => {
    if (
      /\b(?:too many requests|rate limit (?:exceeded|reached)|request limit exceeded)\b/i.test(
        text,
      )
    )
      throw recordRateLimit(url);
  };
  const setIntervalSeconds = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 5)
      throw new Error(
        'Navigation delay must be between half a second and five seconds.',
      );
    const updatedIntervalMs = seconds * 1000;
    if (updatedIntervalMs === intervalMs) return;
    intervalMs = updatedIntervalMs;
    intervalController.abort();
    intervalController = new AbortController();
  };
  return {
    waitForTurn,
    runTurn,
    recordRateLimit,
    assertPageContent,
    setIntervalSeconds,
  };
};

export const missionTraffic = createMissionTrafficController();
