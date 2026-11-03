import { useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@scholaros/ui/components/trace';
import { toast } from '@scholaros/ui/components/toast';
import { cn } from '@scholaros/ui/lib/utils';
import type { CourseRefreshActivity as RefreshActivity } from '../types';
import { formatRefreshActivity } from '../lib/formatters';

export const CourseRefreshActivity = ({
  activity = [],
}: {
  activity?: RefreshActivity[];
}) => {
  const observed = useRef(new Map<string, RefreshActivity['status']>());
  useEffect(() => {
    for (const run of activity) {
      const previous = observed.current.get(run.id);
      if (previous && previous !== run.status && run.status !== 'running') {
        const { label } = formatRefreshActivity(run.status);
        if (run.status === 'failed')
          toast.error(run.events.at(-1) ?? label, {
            id: `course-refresh-${run.key}`,
          });
        else if (run.status === 'sign-in-required')
          toast.error('Sign in to your academic source to refresh it.', {
            id: `course-refresh-${run.key}`,
          });
        else toast.success(label, { id: `course-refresh-${run.key}` });
      }
      observed.current.set(run.id, run.status);
    }
  }, [activity]);
  if (!activity.length) return null;
  return (
    <Trace aria-label="Refresh activity">
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine className="text-base">
            <TraceIcon>
              <Activity />
            </TraceIcon>
            <TraceTitle>Refresh activity</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex max-h-64 flex-col gap-3 overflow-y-auto scroll-fade-y">
          {activity.map((run) => {
            const status = formatRefreshActivity(run.status);
            return (
              <div key={run.id} className="flex flex-col gap-2">
                {run.events.map((event, index) => (
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
                    run.status === 'running'
                      ? 'running'
                      : run.status === 'failed'
                        ? 'error'
                        : undefined
                  }
                >
                  <TraceIcon>
                    <status.Icon
                      className={cn(run.status === 'running' && 'animate-spin')}
                    />
                  </TraceIcon>
                  <TraceTitle>{status.label}</TraceTitle>
                </TraceLine>
              </div>
            );
          })}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};
