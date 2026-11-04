import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  Clock3Icon,
  HourglassIcon,
  LoaderCircleIcon,
} from 'lucide-react';
import type { StudyTimerDTO } from '@scholaros/services/learning/study-contracts';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { Input } from '@scholaros/ui/components/input';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { toast } from '@scholaros/ui/components/toast';

type TimerStatus = 'finished' | 'untimed' | 'running' | 'expired' | 'invalid';
export type StudyTimerActions = {
  reconcile: () => Promise<unknown>;
  finish: () => Promise<unknown>;
  extend: (durationMinutes: number) => Promise<unknown>;
  continueUntimed: () => Promise<unknown>;
};
type StudyTimerProps = {
  sessionId: string;
  timer: StudyTimerDTO;
  actions: StudyTimerActions;
};
type StudyTimerResolutionProps = {
  timer: StudyTimerDTO;
  summary: string;
  actions: StudyTimerActions;
};
type TimerResolutionAction = 'finish' | 'extend' | 'untimed';

type StatusPresentation = {
  label: string;
  Icon: typeof Clock3Icon;
};

const formatTimerStatus = (status: TimerStatus): StatusPresentation => {
  switch (status) {
    case 'finished':
      return { label: 'Finished', Icon: CheckCircle2Icon };
    case 'untimed':
      return { label: 'No timer', Icon: Clock3Icon };
    case 'running':
      return { label: 'Time remaining', Icon: HourglassIcon };
    case 'expired':
      return { label: 'Time is up', Icon: CalendarClockIcon };
    case 'invalid':
      return { label: 'Timer unavailable', Icon: AlertCircleIcon };
  }
};

const formatRemainingTime = (remainingMilliseconds: number) => {
  const remainingMinutes = Math.ceil(
    Math.max(0, remainingMilliseconds) / 60_000,
  );
  if (remainingMinutes < 60) return `${remainingMinutes} min left`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return minutes === 0 ? `${hours} hr left` : `${hours} hr ${minutes} min left`;
};

const formatTimerError = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    switch (error.code) {
      case 'offline':
        return 'The timer is still active in your saved session. Reconnect and retry.';
      case 'revision-conflict':
        return 'The timer changed elsewhere. Refresh the session and try again.';
      case 'permission-revoked':
        return 'Session access changed before the timer could be updated.';
      case 'session-changed':
        return 'The current session changed before the timer could be updated.';
      case 'cancelled':
        return 'The timer update was stopped.';
      case 'storage-failed':
        return 'The timer could not be saved. Your session is still available.';
      default:
        break;
    }
  }
  return 'The timer could not be updated. Your session is still available.';
};

const timerStatusOf = (timer: StudyTimerDTO, now: number): TimerStatus => {
  if (timer.finishedAt !== null) return 'finished';
  if (timer.deadlineAt === null) return 'untimed';
  const deadline = Date.parse(timer.deadlineAt);
  if (Number.isNaN(deadline)) return 'invalid';
  return now >= deadline ? 'expired' : 'running';
};

export const StudyTimer = ({ sessionId, timer, actions }: StudyTimerProps) => {
  const [now, setNow] = useState(() => Date.now());
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const reconciledKeyRef = useRef<string | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const scopeKey = `${sessionId}:${timer.revision}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const status = timerStatusOf(timer, now);
  const deadline =
    timer.deadlineAt === null ? null : Date.parse(timer.deadlineAt);
  const remaining =
    deadline === null || Number.isNaN(deadline) ? null : deadline - now;
  const presentation = formatTimerStatus(status);
  const StatusIcon = presentation.Icon;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (status !== 'running' || timer.deadlineAt === null) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [status, timer.deadlineAt]);

  useEffect(() => {
    setReconcileError(null);
  }, [scopeKey]);

  const reconcile = useCallback(async () => {
    const key = scopeKey;
    if (pendingKeyRef.current === key || reconciledKeyRef.current === key)
      return;
    pendingKeyRef.current = key;
    reconciledKeyRef.current = key;
    setReconciling(true);
    try {
      await actions.reconcile();
      if (mountedRef.current && scopeRef.current === key)
        setReconcileError(null);
    } catch (error) {
      if (reconciledKeyRef.current === key) reconciledKeyRef.current = null;
      if (mountedRef.current && scopeRef.current === key) {
        const message = formatTimerError(error);
        setReconcileError(message);
        toast.error(message);
      }
    } finally {
      if (pendingKeyRef.current === key) {
        pendingKeyRef.current = null;
        if (mountedRef.current) setReconciling(false);
      }
    }
  }, [actions.reconcile, scopeKey]);

  useEffect(() => {
    if (
      status !== 'expired' ||
      timer.resolvedExpiredRevision === timer.revision ||
      timer.expiredRevision === timer.revision
    )
      return;
    void reconcile();
  }, [
    status,
    timer.expiredRevision,
    timer.resolvedExpiredRevision,
    timer.revision,
    reconcile,
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-1" data-slot="study-timer">
      <div
        className="flex min-w-0 items-center gap-2 text-base text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <StatusIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">
          {status === 'running' && remaining !== null
            ? formatRemainingTime(remaining)
            : presentation.label}
        </span>
        {reconciling && (
          <LoaderCircleIcon
            aria-label="Updating timer"
            className="size-4 motion-safe:animate-spin"
          />
        )}
      </div>
      {reconcileError && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-base text-destructive">{reconcileError}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void reconcile()}
          >
            Retry timer update
          </Button>
        </div>
      )}
    </div>
  );
};

export const StudyTimerResolution = ({
  timer,
  summary,
  actions,
}: StudyTimerResolutionProps) => {
  const [durationText, setDurationText] = useState('15');
  const [activeAction, setActiveAction] =
    useState<TimerResolutionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const busy = activeAction !== null;
  const unresolved =
    timer.expiredRevision !== null &&
    timer.resolvedExpiredRevision !== timer.expiredRevision;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setError(null);
  }, [timer.revision, timer.expiredRevision, timer.resolvedExpiredRevision]);

  if (!unresolved) return null;

  const durationMinutes = Number(durationText);
  const validDuration =
    Number.isInteger(durationMinutes) &&
    durationMinutes >= 1 &&
    durationMinutes <= 240;

  const run = async (
    actionName: TimerResolutionAction,
    action: () => Promise<unknown>,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActiveAction(actionName);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      if (mountedRef.current) {
        const message = formatTimerError(actionError);
        setError(message);
        toast.error(message);
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setActiveAction(null);
    }
  };

  return (
    <Card
      data-slot="study-timer-expiry-summary"
      className="gap-3 border-border bg-muted/30"
    >
      <CardHeader className="px-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClockIcon aria-hidden="true" className="size-4" />
          Study time ended
        </CardTitle>
      </CardHeader>
      <CardContent className="gap-3 px-0">
        <p className="text-base">{summary}</p>
        {error && (
          <p
            className="flex items-center gap-2 text-base text-destructive"
            role="alert"
          >
            <AlertCircleIcon aria-hidden="true" className="size-4 shrink-0" />
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-40 flex-1 flex-col gap-2">
            <label htmlFor="study-extension-minutes" className="text-base">
              Extend by minutes
            </label>
            <Input
              id="study-extension-minutes"
              aria-label="Extension in minutes"
              aria-invalid={!validDuration}
              aria-describedby="study-extension-help"
              className="w-full text-base"
              type="number"
              min={1}
              max={240}
              step={1}
              value={durationText}
              onChange={(event) => setDurationText(event.target.value)}
            />
            <span
              id="study-extension-help"
              className="text-base text-muted-foreground"
            >
              Choose 1 to 240 minutes.
            </span>
          </div>
          <Button
            type="button"
            variant="outline"
            aria-label="Extend session"
            aria-busy={activeAction === 'extend'}
            disabled={busy || !validDuration}
            onClick={() =>
              void run('extend', () => actions.extend(durationMinutes))
            }
          >
            <LoadingSwap isLoading={activeAction === 'extend'}>
              Extend session
            </LoadingSwap>
          </Button>
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 px-0">
        <Button
          type="button"
          variant="default"
          aria-busy={activeAction === 'finish'}
          disabled={busy}
          onClick={() => void run('finish', actions.finish)}
        >
          <LoadingSwap isLoading={activeAction === 'finish'}>
            Finish session
          </LoadingSwap>
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-label="Continue indefinitely"
          aria-busy={activeAction === 'untimed'}
          disabled={busy}
          onClick={() => void run('untimed', actions.continueUntimed)}
        >
          <LoadingSwap isLoading={activeAction === 'untimed'}>
            Continue indefinitely
          </LoadingSwap>
        </Button>
      </CardFooter>
    </Card>
  );
};
