import { useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@scholaros/ui/components/trace';
import { ScrollArea } from '@scholaros/ui/components/scroll-area';
import { toast } from '@scholaros/ui/components/toast';
import { cn } from '@scholaros/ui/lib/utils';
import type { CourseRefreshActivity as CourseRefreshActivityData } from '../types';
import { formatRefreshActivity } from '../lib/formatters';

export type CourseRefreshActivityView = Omit<
  CourseRefreshActivityData,
  'status'
> & { status: CourseRefreshActivityData['status'] | 'partial' };

export const CourseRefreshActivity = ({
  activity = [],
}: {
  activity?: CourseRefreshActivityView[];
}) => {
  const observed = useRef(
    new Map<string, CourseRefreshActivityView['status']>(),
  );
  useEffect(() => {
    for (const run of activity) {
      const previous = observed.current.get(run.id);
      if (previous && previous !== run.status && run.status !== 'running') {
        const formatted = formatRefreshActivity(run.status);
        const toastId = `course-refresh-${run.key}`;
        switch (formatted.kind) {
          case 'complete':
            toast.success(formatted.label, { id: toastId });
            break;
          case 'partial':
          case 'cancelled':
            toast.warning(formatted.label, { id: toastId });
            break;
          case 'sign-in-required':
            toast.error('Sign in to your academic source to refresh it.', {
              id: toastId,
            });
            break;
          case 'failed':
            toast.error(run.events.at(-1) ?? formatted.label, { id: toastId });
            break;
          case 'running':
            break;
        }
      }
      observed.current.set(run.id, run.status);
    }
  }, [activity]);
  const latestRun = activity.at(-1);
  if (!latestRun) return null;
  const latestStatus = formatRefreshActivity(latestRun.status);
  return (
    <Trace aria-label="Refresh activity">
      <TraceCollapsible defaultOpen={false}>
        <TraceCollapsibleTrigger>
          <TraceLine className="text-base">
            <TraceIcon>
              <latestStatus.Icon
                className={cn(
                  latestRun.status === 'running' && 'motion-safe:animate-spin',
                )}
              />
            </TraceIcon>
            <TraceTitle>Refresh activity</TraceTitle>
            <TraceDescription className="text-base">
              {latestStatus.label}
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <ScrollArea
            className="h-48 w-full"
            role="region"
            aria-label="Refresh activity history"
          >
            <div className="flex flex-col gap-3 pr-3">
              {[...activity].reverse().map((run) => {
                const status = formatRefreshActivity(run.status);
                return (
                  <div key={run.id} className="flex flex-col gap-2">
                    {[...run.events]
                      .reverse()
                      .filter((event) =>
                        /^(?:Opening|Checking|Waiting|Reading (?:assignments|announcements)$|Saved \d+|Read \d+|Sign[ -]in)\b/i.test(
                          event,
                        ),
                      )
                      .map((event, index) => (
                        <TraceLine
                          key={`${run.id}-${index}`}
                          className="animate-in fade-in slide-in-from-top-1 text-base duration-300 motion-reduce:animate-none"
                        >
                          <TraceIcon>
                            <Activity />
                          </TraceIcon>
                          <span className="min-w-0 break-words">{event}</span>
                        </TraceLine>
                      ))}
                    <TraceLine
                      className="text-base"
                      status={
                        status.kind === 'running'
                          ? 'running'
                          : status.kind === 'failed' ||
                              status.kind === 'sign-in-required'
                            ? 'error'
                            : undefined
                      }
                    >
                      <TraceIcon>
                        <status.Icon
                          className={cn(
                            run.status === 'running' && 'animate-spin',
                          )}
                        />
                      </TraceIcon>
                      <TraceTitle>{status.label}</TraceTitle>
                    </TraceLine>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};
