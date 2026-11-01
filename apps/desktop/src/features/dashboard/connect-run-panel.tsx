import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { useEffect, useState } from 'react';
import { Button } from '@scholaros/ui/components/button';
import { cn } from 'cn';
import {
  formatAgentActivity,
  formatConnectRunResult,
} from '../onboarding/lib/formatters';
import { errorMessage } from '../../lib/error-message';
import type { ConnectRunState } from '../onboarding/services/connect-run';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@scholaros/ui/components/collapsible';
import { ChevronDownIcon, PlayIcon, SquareIcon } from 'lucide-react';

export const ConnectRunPanel = () => {
  const [state, setState] = useState<ConnectRunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let accountId: string | null = null;
    const buffer: { state: ConnectRunState | null; version: number } = {
      state: null,
      version: 0,
    };
    const receive = (next: ConnectRunState) => {
      buffer.state = next;
      buffer.version += 1;
      if (!active || !accountId || next.accountId !== accountId) return;
      setState(next);
    };
    const unsubscribe = window.scholar.onConnectChange(receive);
    void (async () => {
      try {
        const user = await window.scholar.getCurrentUser();
        if (!active || !user) return;
        accountId = user.id;
        const version = buffer.version;
        const snapshot = await window.scholar.getConnectRun();
        if (!active) return;
        receive(
          buffer.version !== version && buffer.state?.accountId === accountId
            ? buffer.state
            : snapshot,
        );
      } catch (cause) {
        if (active)
          setError(errorMessage(cause, 'Could not load connection activity.'));
      }
    })();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  if (!state || state.status === 'idle')
    return error ? <p role="alert">{error}</p> : null;
  const act = async (action: () => Promise<void>) => {
    try {
      setError(null);
      await action();
    } catch (cause) {
      setError(errorMessage(cause, 'Could not update the connection run.'));
    }
  };
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 @container"
      aria-label="Connection activity"
    >
      <Collapsible className="flex flex-col gap-3">
        <CollapsibleTrigger className="cursor-pointer font-medium group/more-info flex items-center gap-2 justify-between @3xl:justify-start w-full">
          <span className="font-medium">Connection Activity</span>
          <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-panel-open/more-info:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3">
          {state.events.slice(-5).map((event, index) => {
            const formatted = formatAgentActivity(event);
            return (
              <div
                key={`${index}-${event.type}`}
                className="flex items-center gap-2"
              >
                <formatted.Icon className="size-5" />
                <span>{formatted.label}</span>
              </div>
            );
          })}
        </CollapsibleContent>
      </Collapsible>
      {state.awaiting && (
        <div className="flex flex-col gap-2">
          <p className="text-base">
            Sign in in the study browser, then continue.
          </p>
          <p className="text-base">Destination {state.awaiting.destination}</p>
          {state.awaiting.note && (
            <p className="text-base">{state.awaiting.note}</p>
          )}
          <div className="flex items-center gap-2">
            <TooltipWrapper content="Continue">
              <Button
                aria-label="Continue"
                onClick={() =>
                  void act(() => window.scholar.resumeConnectRun())
                }
              >
                <PlayIcon />
              </Button>
            </TooltipWrapper>
            <TooltipWrapper content="Stop">
              <Button
                variant="outline"
                aria-label="Stop"
                onClick={() =>
                  void act(() => window.scholar.cancelConnectRun())
                }
              >
                <SquareIcon />
              </Button>
            </TooltipWrapper>
          </div>
        </div>
      )}
      {state.status === 'running' && (
        <Button
          className="self-start"
          variant="outline"
          onClick={() => void act(() => window.scholar.cancelConnectRun())}
        >
          Stop
        </Button>
      )}
      {state.results.length > 0 &&
        state.results.map((result) => {
          const outcome = formatConnectRunResult(result.status);
          return (
            <div
              key={result.host}
              data-slot="connect-result"
              className="flex min-w-0 items-center gap-2"
            >
              <outcome.Icon
                className={cn('size-5 shrink-0', outcome.className)}
              />
              <span className="min-w-0 flex-1 w-full @3xl:max-w-50 truncate">
                {result.host}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {outcome.label}
              </span>
            </div>
          );
        })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
};
