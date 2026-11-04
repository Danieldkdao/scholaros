'use client';

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode, RefCallback } from 'react';
import { cn } from '@scholaros/ui/lib/utils';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@scholaros/ui/components/resizable';
import {
  getActivityLayout,
  type ActivityLayout,
} from '../lib/activity-geometry';

type ActivityPanelContextValue = {
  activeActivityId: string | null;
  panelTarget: HTMLDivElement | null;
  panelTargetRef: RefCallback<HTMLDivElement>;
  setActiveActivity: (activityId: string | null) => void;
  layout: ActivityLayout;
};

type ActivityPanelProps = {
  children: ReactNode;
  className?: string;
};

const ActivityPanelContext = createContext<ActivityPanelContextValue | null>(
  null,
);

export const useActivityPanelContext = () => useContext(ActivityPanelContext);

export const ActivityPanel = ({ children, className }: ActivityPanelProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeActivityId, setActiveActivity] = useState<string | null>(null);
  const [panelTarget, setPanelTarget] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<ActivityLayout>('side-by-side');
  const panelTargetRef: RefCallback<HTMLDivElement> = setPanelTarget;
  const contextValue = useMemo<ActivityPanelContextValue>(
    () => ({
      activeActivityId,
      panelTarget,
      panelTargetRef,
      setActiveActivity,
      layout,
    }),
    [activeActivityId, layout, panelTarget],
  );

  useLayoutEffect(() => {
    // A removed or withheld message can unmount the portal owner.
    if (activeActivityId && panelTarget && !panelTarget.hasChildNodes())
      setActiveActivity(null);
  }, [activeActivityId, children, panelTarget]);

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const updateLayout = (width: number) => setLayout(getActivityLayout(width));
    updateLayout(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () =>
        updateLayout(element.getBoundingClientRect().width);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateLayout(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <ActivityPanelContext.Provider value={contextValue}>
      <div
        ref={rootRef}
        className={cn('h-full min-h-0 w-full', className)}
        data-activity-panel
        data-layout={layout}
      >
        <ResizablePanelGroup
          id="study-activity-panel"
          orientation={layout === 'stacked' ? 'vertical' : 'horizontal'}
          className="h-full min-h-0 w-full"
        >
          <ResizablePanel
            id="study-document"
            defaultSize={activeActivityId ? '64%' : '100%'}
            minSize={layout === 'stacked' ? '12rem' : '24rem'}
            className="min-h-0 min-w-0 overflow-hidden"
          >
            {children}
          </ResizablePanel>
          {activeActivityId && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="study-activity"
                defaultSize="36%"
                minSize={layout === 'stacked' ? '20rem' : '20rem'}
                className="min-h-0 min-w-0 overflow-hidden"
              >
                <section
                  className="h-full min-h-0 overflow-hidden"
                  aria-label="Expanded activity panel"
                >
                  <div
                    id="study-activity-runtime-panel"
                    ref={panelTargetRef}
                    className="h-full min-h-0 w-full"
                    data-activity-panel-target
                  />
                </section>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </ActivityPanelContext.Provider>
  );
};
