import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronDownIcon,
  ExternalLink,
  Sparkles,
  Square,
} from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { cn } from '@scholaros/ui/lib/utils';
import {
  formatAgentActivity,
  formatCard,
  formatPreviewPrompt,
  formatPreviewStatus,
} from '../lib/formatters';
import { watchPreview } from '../lib/preview-channel';
import { previewPrompts } from '../schemas';
import type { PreviewPrompt, PreviewState } from '../types';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@scholaros/ui/components/collapsible';

const emptyPreview = (accountId: string): PreviewState => ({
  accountId,
  status: 'idle',
  events: [],
  cards: [],
  message: null,
});

type PreviewStepProps = {
  accountId: string;
  enabled: boolean;
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
};

export const PreviewStep = ({
  accountId,
  enabled,
  busy,
  run,
}: PreviewStepProps) => {
  const [preview, setPreview] = useState<PreviewState>(() =>
    emptyPreview(accountId),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState<PreviewPrompt | null>(null);
  useEffect(() => {
    setPreview(emptyPreview(accountId));
    const watcher = watchPreview({
      accountId,
      fetchPreview: () => window.scholar.getPreview(accountId),
      subscribe: (listener) => window.scholar.onPreviewChange(listener),
      onState: setPreview,
      onNotice: setNotice,
      onSessionExpired: (message) => {
        setPreview((current) => ({
          ...current,
          status: 'blocked',
          message,
        }));
        setNotice(message);
      },
    });
    return () => {
      watcher.stop();
      void window.scholar.cancelPreview(accountId).catch(() => undefined);
    };
  }, [accountId]);
  const running = preview.status === 'running';
  const status = formatPreviewStatus(preview.status);

  const counts = useMemo(() => {
    const courseCount = preview.cards.filter(
      (card) => card.kind === 'course',
    ).length;
    const assignmentCount = preview.cards.filter(
      (card) => card.kind === 'assignment',
    ).length;
    const announcementCount = preview.cards.filter(
      (card) => card.kind === 'announcement',
    ).length;

    return {
      courseCount,
      assignmentCount,
      announcementCount,
      totalCount: preview.cards.length,
    };
  }, [preview.cards]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        {previewPrompts.map((prompt) => {
          const { label, Icon } = formatPreviewPrompt(prompt);
          return (
            <Button
              key={prompt}
              variant="outline"
              className="h-auto justify-start gap-3 p-4 text-base"
              disabled={!enabled || busy || running}
              onClick={() =>
                void run(async () => {
                  setStarting(prompt);
                  try {
                    await window.scholar.startPreview(prompt);
                  } finally {
                    setStarting(null);
                  }
                })
              }
            >
              <LoadingSwap isLoading={starting === prompt}>
                <span className="flex items-center gap-3">
                  <Icon className="size-5 text-primary" />
                  {label}
                </span>
              </LoadingSwap>
            </Button>
          );
        })}
      </div>
      {!enabled && (
        <p className="text-muted-foreground">
          Connect and confirm an academic resource to try your agent, or skip
          for now.
        </p>
      )}
      {notice && (
        <p role="status" className="text-muted-foreground">
          {notice}
        </p>
      )}
      {preview.status !== 'idle' && (
        <div
          className="flex flex-col gap-4 rounded-xl border bg-card p-5"
          aria-live="polite"
        >
          <div className="flex items-center gap-3">
            <status.Icon
              className={cn(
                'size-5 text-primary',
                running && 'motion-safe:animate-pulse',
              )}
            />
            <p className="flex-1 font-medium">{status.label}</p>
            {running && (
              <TooltipWrapper content="Stop preview">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Stop preview"
                  onClick={() =>
                    void run(async () => {
                      await window.scholar.cancelPreview(accountId);
                    })
                  }
                >
                  <Square className="size-5" />
                </Button>
              </TooltipWrapper>
            )}
          </div>
          {preview.events.slice(-5).map((event, index) => {
            const { label, Icon } = formatAgentActivity(event);
            return (
              <div
                key={`${index}-${event.type}-${event.detail ?? ''}`}
                className="flex items-center gap-3 text-muted-foreground motion-safe:animate-in motion-safe:fade-in"
              >
                <Icon className="size-5 shrink-0" />
                <p className="truncate">{label}</p>
              </div>
            );
          })}
          {preview.message && (
            <p className="text-muted-foreground">{preview.message}</p>
          )}
        </div>
      )}
      {counts.totalCount > 0 ? (
        <Collapsible className="rounded-lg w-full mt-2">
          <CollapsibleTrigger className="cursor-pointer font-medium group/more-info flex items-center gap-2 justify-between w-full">
            <div className="flex items-center gap-2 flex-wrap">
              {counts.courseCount > 0 && (
                <span className="font-medium">
                  {counts.courseCount}{' '}
                  {counts.courseCount === 1 ? 'course' : 'courses'} found
                </span>
              )}
              {counts.assignmentCount > 0 && (
                <span className="font-medium">
                  {counts.assignmentCount}{' '}
                  {counts.assignmentCount === 1 ? 'assignment' : 'assignments'}{' '}
                  found
                </span>
              )}
              {counts.announcementCount > 0 && (
                <span className="font-medium">
                  {counts.announcementCount}{' '}
                  {counts.announcementCount === 1
                    ? 'announcement'
                    : 'announcements'}{' '}
                  found
                </span>
              )}
            </div>
            <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-panel-open/more-info:rotate-180 motion-reduce:transition-none" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 flex flex-col gap-3">
            {preview.cards.map((card, index) => {
              const { label, Icon } = formatCard(card.kind);
              return (
                <article
                  key={`${card.sourceUrl}-${index}`}
                  className="flex flex-col gap-3 rounded-xl border bg-card p-5 motion-safe:animate-in motion-safe:fade-in"
                >
                  <div className="flex items-center gap-3 text-primary">
                    <Icon className="size-5" />
                    <span>{label}</span>
                  </div>
                  <h3 className="text-xl font-semibold">{card.title}</h3>
                  {card.course && (
                    <p>
                      <span className="font-medium">Course from page:</span>{' '}
                      {card.course}
                    </p>
                  )}
                  {card.date && (
                    <p className="flex items-center gap-2">
                      <CalendarDays className="size-4 text-muted-foreground" />
                      <span>
                        <span className="font-medium">Due date from page:</span>{' '}
                        {card.date}
                      </span>
                    </p>
                  )}
                  <Collapsible className="rounded-lg w-full">
                    <CollapsibleTrigger className="cursor-pointer font-medium group/more-info flex items-center gap-2 justify-between md:justify-start w-full">
                      <span className="font-medium">More details</span>
                      <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-panel-open/more-info:rotate-180 motion-reduce:transition-none" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-3 text-muted-foreground">
                      <blockquote className="border-l-2 border-border pl-3 flex flex-col gap-3 text-muted-foreground">
                        {card.detail && (
                          <p className="flex items-start gap-2 text-muted-foreground leading-6">
                            <div className="h-lh flex items-center justify-center">
                              <Sparkles className="mt-0.5 size-4 shrink-0" />
                            </div>
                            <span>
                              <span className="font-medium">AI summary:</span>{' '}
                              {card.detail}
                            </span>
                          </p>
                        )}
                        {card.excerpt}
                      </blockquote>
                    </CollapsibleContent>
                  </Collapsible>
                  <Button
                    variant="ghost"
                    className="self-start text-base"
                    onClick={() =>
                      void run(() => window.scholar.openSource(card.sourceUrl))
                    }
                  >
                    <ExternalLink className="size-5" />
                    View source
                  </Button>
                </article>
              );
            })}
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <p className="text-muted-foreground font-medium">No items found</p>
      )}
      {preview.status === 'complete' && (
        <p className="text-muted-foreground">
          Preview results are temporary and aren’t saved to your account.
        </p>
      )}
    </div>
  );
};
