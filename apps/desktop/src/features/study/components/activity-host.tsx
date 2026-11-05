'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity as ActivityIcon,
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  CircleHelp,
  History,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RotateCcw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { Button } from '@scholaros/ui/components/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@scholaros/ui/components/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@scholaros/ui/components/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { toast } from '@scholaros/ui/components/toast';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { cn } from '@scholaros/ui/lib/utils';
import { useConfirm } from '../../../hooks/use-confirm';
import { useActivityPanelContext } from './activity-panel';
import {
  formatActivityHostStatus,
  useActivityHost,
} from '../hooks/use-activity-host';
import type {
  ActivityHostBridge,
  ActivityHostStatus,
  ActivityHostStatusPresentation,
} from '../hooks/use-activity-host';
import type { ActivityPresentation } from '@scholaros/services/learning/activity-contracts';

export type ActivityHostProps = {
  accountId: string;
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  presentation?: ActivityPresentation;
  readOnly?: boolean;
  onExpand?: (presentation: ActivityPresentation) => void;
  courseId?: string | null;
  bridge?: ActivityHostBridge;
  className?: string;
};

type ActivityActionsProps = {
  title: string;
  courseId?: string | null;
  isSaving: boolean;
  isResetting: boolean;
  onSaveToContext: () => void;
  onSaveToCourse: () => void;
  onReset: () => void;
  onShowDetails: () => void;
};

const ActivityStatusIcon = ({
  status,
  className,
}: {
  status: ActivityHostStatusPresentation;
  className?: string;
}) => {
  const Icon: LucideIcon = (() => {
    switch (status.icon) {
      case 'loading':
      case 'pending':
        return LoaderCircle;
      case 'ready':
        return CheckCircle2;
      case 'error':
        return AlertTriangle;
      case 'info':
        return CircleHelp;
      default: {
        const exhaustive: never = status.icon;
        return exhaustive;
      }
    }
  })();
  return (
    <Icon
      className={cn(
        (status.icon === 'loading' || status.icon === 'pending') &&
          'animate-spin motion-reduce:animate-none',
        className,
      )}
      aria-hidden="true"
    />
  );
};

const ActivityActions = ({
  title,
  courseId,
  isSaving,
  isResetting,
  onSaveToContext,
  onSaveToCourse,
  onReset,
  onShowDetails,
}: ActivityActionsProps) => (
  <DropdownMenu>
    <TooltipWrapper content={isSaving ? 'Saving activity' : 'Activity options'}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Activity options for ${title}`}
            disabled={isSaving || isResetting}
          />
        }
      >
        <MoreHorizontal aria-hidden="true" />
      </DropdownMenuTrigger>
    </TooltipWrapper>
    <DropdownMenuContent align="end">
      <DropdownMenuItem disabled={isSaving} onClick={onSaveToContext}>
        <BookmarkPlus aria-hidden="true" />
        <LoadingSwap isLoading={isSaving}>Save to Context</LoadingSwap>
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!courseId || isSaving}
        onClick={onSaveToCourse}
      >
        <BookmarkPlus aria-hidden="true" />
        Save to course
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onShowDetails}>
        <History aria-hidden="true" />
        Activity details
      </DropdownMenuItem>
      <DropdownMenuItem disabled={isResetting} onClick={onReset}>
        <RotateCcw aria-hidden="true" />
        Reset activity
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

const ActivityRuntimeSlot = ({
  title,
  expanded,
  slotRef,
}: {
  title: string;
  expanded: boolean;
  slotRef: Ref<HTMLDivElement>;
}) => (
  <div
    ref={slotRef}
    className={cn(
      'min-h-0 w-full overflow-hidden rounded-lg bg-background',
      expanded ? 'h-full min-h-[20rem]' : 'h-[65dvh] min-h-105 max-h-170',
    )}
    role="region"
    aria-label={`Interactive activity: ${title}`}
    tabIndex={-1}
    data-activity-runtime-slot
  />
);

export const ActivityHost = ({
  accountId,
  sessionId,
  artifactId,
  versionId,
  attemptId,
  presentation = 'inline',
  readOnly = false,
  onExpand,
  courseId,
  bridge,
  className,
}: ActivityHostProps) => {
  const host = useActivityHost({
    accountId,
    sessionId,
    artifactId,
    versionId,
    attemptId,
    presentation,
    readOnly,
    bridge,
  });
  const activityPanel = useActivityPanelContext();
  const hostId = useId();
  const [localPresentation, setLocalPresentation] =
    useState<ActivityPresentation>(presentation);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const confirmation = useConfirm<boolean>();
  const inlineExpandButtonRef = useRef<HTMLButtonElement>(null);
  const panelCollapseButtonRef = useRef<HTMLButtonElement>(null);
  const inlineCardRef = useRef<HTMLDivElement>(null);
  const pendingScrollAnchor = useRef<ReturnType<
    typeof host.scrollAnchorFor
  > | null>(null);
  const setPanelActivity = activityPanel?.setActiveActivity;
  const isExpanded = activityPanel
    ? activityPanel.activeActivityId === hostId
    : localPresentation === 'expanded';
  const title = host.version?.title || 'Learning activity';
  const objective =
    host.version?.objective || 'Explore this learning activity.';
  const scrollAnchorFor = host.scrollAnchorFor;
  const restoreScrollAnchor = host.restoreScrollAnchor;

  useEffect(() => {
    if (presentation !== 'expanded' || !setPanelActivity) return;
    setPanelActivity(hostId);
  }, [hostId, presentation, setPanelActivity]);

  useEffect(() => {
    if (!pendingScrollAnchor.current) return;
    const anchor = pendingScrollAnchor.current;
    const timer = window.setTimeout(() => {
      restoreScrollAnchor(anchor);
      const focusTarget = isExpanded
        ? panelCollapseButtonRef.current
        : inlineExpandButtonRef.current;
      focusTarget?.focus({ preventScroll: true });
      pendingScrollAnchor.current = null;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isExpanded, restoreScrollAnchor]);

  const setPresentation = useCallback(
    (nextPresentation: ActivityPresentation) => {
      if (isExpanded === (nextPresentation === 'expanded')) return;
      pendingScrollAnchor.current = scrollAnchorFor(inlineCardRef.current);
      if (activityPanel) {
        activityPanel.setActiveActivity(
          nextPresentation === 'expanded' ? hostId : null,
        );
      } else {
        setLocalPresentation(nextPresentation);
      }
      onExpand?.(nextPresentation);
    },
    [activityPanel, hostId, isExpanded, onExpand, scrollAnchorFor],
  );

  const saveArtifact = async (targetCourseId?: string | null) => {
    if (readOnly) return;
    setIsSaving(true);
    try {
      await host.saveArtifact(targetCourseId);
      toast.success(
        targetCourseId
          ? 'Activity saved to course'
          : 'Activity saved to Context',
      );
    } catch {
      toast.error(
        targetCourseId
          ? 'Could not save this activity to the course.'
          : 'Could not save this activity to Context.',
      );
    } finally {
      setIsSaving(false);
    }
  };

  const resetActivity = async () => {
    if (readOnly) return;
    setIsResetting(true);
    try {
      await host.resetAttempt();
      confirmation.cancel();
      toast.success('Activity reset; the prior attempt remains in history.');
    } catch {
      toast.error('Could not reset this activity.');
    } finally {
      setIsResetting(false);
    }
  };

  const renderActions = (): ReactNode =>
    readOnly ? null : (
      <ActivityActions
        title={title}
        courseId={courseId}
        isSaving={isSaving}
        isResetting={isResetting}
        onSaveToContext={() => void saveArtifact()}
        onSaveToCourse={() => void saveArtifact(courseId)}
        onReset={() => confirmation.request(true)}
        onShowDetails={() => setDetailsOpen(true)}
      />
    );

  const runtimeSlot = (
    <ActivityRuntimeSlot
      title={title}
      expanded={isExpanded}
      slotRef={host.slotRef}
    />
  );
  const expandedRuntime =
    activityPanel?.panelTarget && isExpanded
      ? createPortal(
          <div className="flex h-full min-h-0 flex-col gap-3 p-4">
            <div className="flex shrink-0 items-center justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="truncate text-lg font-semibold">{title}</h2>
                <p className="line-clamp-2 text-base text-muted-foreground">
                  {objective}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <TooltipWrapper content="Collapse activity">
                  <Button
                    ref={panelCollapseButtonRef}
                    variant="ghost"
                    size="icon"
                    aria-label="Collapse activity"
                    aria-expanded="true"
                    onClick={() => setPresentation('inline')}
                  >
                    <Minimize2 aria-hidden="true" />
                  </Button>
                </TooltipWrapper>
                {renderActions()}
              </div>
            </div>
            {runtimeSlot}
            {readOnly && (
              <p role="status" className="text-base text-muted-foreground">
                {host.status === 'checkpoint-error' ||
                host.status === 'runtime-error'
                  ? 'Reconnect online to retry this activity.'
                  : 'Read-only activity; changes stay in this viewing session.'}
              </p>
            )}
            <ActivityStatus status={host.status} announce={false} />
            {host.status === 'ready' && host.savedState && (
              <p className="text-base text-muted-foreground">
                Saved progress: revision {host.lastAcknowledgedRevision}
              </p>
            )}
            {host.errorMessage && (
              <p className="text-base text-destructive" role="alert">
                {host.errorMessage}
              </p>
            )}
          </div>,
          activityPanel.panelTarget,
        )
      : null;

  return (
    <>
      <div ref={inlineCardRef}>
        <Card
          className={cn('w-full min-w-0', className)}
          data-activity-host
          data-expanded={isExpanded}
          data-runtime={host.runId ?? 'closed'}
        >
          <CardHeader>
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle className="flex items-center gap-2 truncate">
                <ActivityIcon
                  className="size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="truncate">{title}</span>
              </CardTitle>
              <CardDescription>{objective}</CardDescription>
            </div>
            <CardAction className="flex items-center gap-1">
              <TooltipWrapper
                content={isExpanded ? 'Collapse activity' : 'Expand activity'}
              >
                <Button
                  ref={inlineExpandButtonRef}
                  variant="ghost"
                  size="icon"
                  aria-label={
                    isExpanded ? 'Collapse activity' : 'Expand activity'
                  }
                  aria-expanded={isExpanded}
                  aria-controls={
                    activityPanel && isExpanded
                      ? 'study-activity-runtime-panel'
                      : undefined
                  }
                  onClick={() =>
                    setPresentation(isExpanded ? 'inline' : 'expanded')
                  }
                >
                  {isExpanded ? (
                    <Minimize2 aria-hidden="true" />
                  ) : (
                    <Maximize2 aria-hidden="true" />
                  )}
                </Button>
              </TooltipWrapper>
              {renderActions()}
            </CardAction>
          </CardHeader>
          <CardContent>
            <ActivityStatus status={host.status} announce={!isExpanded} />
            {host.status === 'ready' && host.savedState && !isExpanded && (
              <p className="text-base text-muted-foreground">
                Saved progress: revision {host.lastAcknowledgedRevision}
              </p>
            )}
            {host.errorMessage && !isExpanded && (
              <p className="text-base text-destructive" role="alert">
                {host.errorMessage}
              </p>
            )}
            {host.status === 'unsupported' || host.status === 'unavailable' ? (
              <Empty className="min-h-0 py-6">
                <EmptyHeader>
                  <EmptyTitle>
                    {host.status === 'unsupported'
                      ? 'This activity cannot be opened yet'
                      : 'This activity is unavailable'}
                  </EmptyTitle>
                  <EmptyDescription>
                    The saved activity remains unchanged. Try again after the
                    app is updated or reconnects.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : isExpanded && activityPanel ? (
              <p className="text-base text-muted-foreground">
                This activity is open in the side panel; its saved progress
                stays with this message.
              </p>
            ) : (
              <div className="flex min-w-0 flex-col gap-3">
                {runtimeSlot}
                {readOnly ? (
                  host.status === 'checkpoint-error' ||
                  host.status === 'runtime-error' ? (
                    <p
                      role="status"
                      className="text-base text-muted-foreground"
                    >
                      Reconnect online to retry this activity.
                    </p>
                  ) : (
                    <p
                      role="status"
                      className="text-base text-muted-foreground"
                    >
                      Read-only activity; changes stay in this viewing session.
                    </p>
                  )
                ) : host.status === 'checkpoint-error' ||
                  host.status === 'runtime-error' ? (
                  <Button
                    variant="outline"
                    aria-label={
                      host.status === 'checkpoint-error'
                        ? 'Retry saving activity progress'
                        : 'Retry activity'
                    }
                    onClick={() => void host.retry()}
                  >
                    Retry activity
                  </Button>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      {expandedRuntime}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activity details</DialogTitle>
            <DialogDescription>
              The activity version is immutable. Reset starts a new attempt and
              preserves prior attempts.
            </DialogDescription>
          </DialogHeader>
          {host.version ? (
            <dl className="flex flex-col gap-2 text-base">
              <div className="flex flex-wrap items-baseline gap-2">
                <dt className="font-medium">Version:</dt>
                <dd className="text-muted-foreground">
                  {host.version.versionId}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-2">
                <dt className="font-medium">Attempt:</dt>
                <dd className="text-muted-foreground">{host.attemptId}</dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-2">
                <dt className="font-medium">Saved progress:</dt>
                <dd className="text-muted-foreground">
                  revision {host.lastAcknowledgedRevision}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-2">
                <dt className="font-medium">Sources:</dt>
                <dd className="text-muted-foreground">
                  {host.version.sourceReferences.length}
                </dd>
              </div>
            </dl>
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(confirmation.pending)}
        onOpenChange={(open) => {
          if (!open && !isResetting) confirmation.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset this activity?</AlertDialogTitle>
            <AlertDialogDescription>
              Reset starts a new attempt with the saved default state. Your
              earlier activity attempts remain in history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isResetting}
              onClick={() => void resetActivity()}
            >
              <LoadingSwap isLoading={isResetting}>Reset activity</LoadingSwap>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const ActivityStatus = ({
  status,
  announce = true,
}: {
  status: ActivityHostStatus;
  announce?: boolean;
}) => {
  const formattedStatus = formatActivityHostStatus(status);
  const statusClassName =
    formattedStatus.icon === 'error'
      ? 'text-destructive'
      : 'text-muted-foreground';
  return (
    <div
      className="flex items-center gap-2 text-base"
      role="status"
      aria-live={announce ? 'polite' : 'off'}
    >
      <ActivityStatusIcon
        status={formattedStatus}
        className={statusClassName}
      />
      <span>{formattedStatus.label}</span>
    </div>
  );
};
