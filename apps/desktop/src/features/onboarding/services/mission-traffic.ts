import { setTimeout as delay } from 'node:timers/promises';

type TrafficOptions = {
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<unknown>;
  intervalMs?: number;
};

export const createMissionTrafficController = ({
  now = Date.now,
  sleep = (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  intervalMs = 1000,
}: TrafficOptions = {}) => {
  const schools = new Map<string, { nextAt: number; cooldownUntil: number }>();
  const stateFor = (url: string) => {
    const host = new URL(url).hostname;
    let state = schools.get(host);
    if (!state) {
      state = { nextAt: 0, cooldownUntil: 0 };
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
  const waitForTurn = async (
    url: string,
    signal: AbortSignal,
    onWait?: (milliseconds: number) => void,
  ) => {
    signal.throwIfAborted();
    const state = stateFor(url);
    if (state.cooldownUntil > now()) throw cooldownError(state.cooldownUntil);
    const scheduledAt = Math.max(now(), state.nextAt);
    state.nextAt = scheduledAt + intervalMs;
    const milliseconds = scheduledAt - now();
    if (milliseconds > 0) {
      onWait?.(milliseconds);
      await sleep(milliseconds, signal);
    }
    signal.throwIfAborted();
    if (state.cooldownUntil > now()) throw cooldownError(state.cooldownUntil);
  };
  const assertPageContent = (url: string, text: string) => {
    if (
      /\b(?:too many requests|rate limit (?:exceeded|reached)|request limit exceeded)\b/i.test(
        text,
      )
    )
      throw recordRateLimit(url);
  };
  const setIntervalSeconds = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 5)
      throw new Error(
        'Decision time must be greater than zero and at most five seconds.',
      );
    intervalMs = seconds * 1000;
  };
  return {
    waitForTurn,
    recordRateLimit,
    assertPageContent,
    setIntervalSeconds,
  };
};

export const missionTraffic = createMissionTrafficController();
