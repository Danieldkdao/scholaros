import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  formatContextRole,
  formatContextUrl,
  formatDiscoveryStatus,
  formatObservedAt,
} from '../lib/formatters';
import type { OnboardingState } from '../types';

type DiscoverySummaryProps = {
  state: OnboardingState;
  busy: boolean;
  onDiscover: () => Promise<void>;
};

export const DiscoverySummary = ({
  state,
  busy,
  onDiscover,
}: DiscoverySummaryProps) => {
  const [discovering, setDiscovering] = useState(false);
  const status = formatDiscoveryStatus(state.discovery.status);
  const canDiscover =
    state.workspace?.ready === true &&
    state.connections.some(
      (connection) => connection.status !== 'needs-sign-in',
    );
  const discover = async () => {
    setDiscovering(true);
    try {
      await onDiscover();
    } finally {
      setDiscovering(false);
    }
  };
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start gap-3 leading-6">
        <div className="h-lh flex items-center justify-center">
          <status.Icon className="size-5 text-primary" />
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{status.label}</span>
            <p className="text-muted-foreground">{status.description}</p>
            {state.discovery.discoveredAt && (
              <span className="text-muted-foreground">
                Last checked {formatObservedAt(state.discovery.discoveredAt)}
              </span>
            )}
          </div>

          <Button
            variant="secondary"
            className="text-base"
            disabled={!canDiscover || busy || discovering}
            onClick={() => void discover()}
          >
            <LoadingSwap isLoading={discovering}>
              <span className="flex items-center gap-2">
                <RefreshCw className="size-5" />
                {state.discovery.status === 'pending'
                  ? 'Discover my courses'
                  : 'Refresh course map'}
              </span>
            </LoadingSwap>
          </Button>
          {!canDiscover && (
            <p className="text-muted-foreground">
              Confirm a connected resource to discover its course pages.
            </p>
          )}
          {state.discovery.message && (
            <p className="text-muted-foreground">{state.discovery.message}</p>
          )}
          {state.discovery.entries.length > 0 && (
            <div className="flex flex-col gap-4">
              {state.connections.map((connection) => {
                const entries = state.discovery.entries.filter(
                  (entry) => entry.connectionId === connection.id,
                );
                if (!entries.length) return null;
                return (
                  <div key={connection.id} className="flex flex-col gap-2">
                    <p className="font-medium">{connection.name}</p>
                    <ul className="flex flex-col gap-2">
                      {entries.map((entry) => {
                        const role = formatContextRole(entry.role);
                        return (
                          <li
                            key={entry.id}
                            className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/40 p-3"
                          >
                            <role.Icon className="size-5 shrink-0 text-primary" />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate">{entry.label}</span>
                              <span className="truncate text-muted-foreground">
                                Observed on{' '}
                                {formatContextUrl(entry.evidenceUrl)}
                              </span>
                            </span>
                            <TooltipWrapper content={role.description}>
                              <span
                                tabIndex={0}
                                className="text-muted-foreground"
                              >
                                {role.label}
                              </span>
                            </TooltipWrapper>
                            <span className="truncate text-muted-foreground">
                              {formatContextUrl(entry.url)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
