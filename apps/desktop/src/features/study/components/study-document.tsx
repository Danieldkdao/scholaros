import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ActivityIcon,
  ArrowLeftIcon,
  BookOpenTextIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleDashedIcon,
  CirclePauseIcon,
  CircleStopIcon,
  FileTextIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type {
  MessagePart,
  StudyActivity,
  StudyMessageDTO,
  StudySessionDTO,
} from '@scholaros/services/learning/study-contracts';
import type { SourceReference } from '@scholaros/services/learning/context-contracts';
import { Button } from '@scholaros/ui/components/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogCancel,
} from '@scholaros/ui/components/alert-dialog';
import { useConfirm } from '../../../hooks/use-confirm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@scholaros/ui/components/empty';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@scholaros/ui/components/message-scroller';
import { Skeleton } from '@scholaros/ui/components/skeleton';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { ActivityPanel } from './activity-panel';
import type { StudyDictationControlProps } from './study-composer';
import { StudyComposer } from './study-composer';
import { StudyMessage } from './study-message';
import type { StudySourcePreview } from './study-source-panel';
import { StudySourcePanel } from './study-source-panel';
import { StudyTimer, StudyTimerResolution } from './study-timer';
import type { StudySessionErrorCode } from '../hooks/use-study-session';
import {
  formatStudySessionError,
  useStudySession,
} from '../hooks/use-study-session';

type ActivityHostProps = {
  accountId: string;
  sessionId: string;
  courseId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  presentation: 'inline' | 'expanded';
  readOnly: boolean;
  onExpand?: () => void;
};
type PracticeViewProps = {
  accountId: string;
  sessionId: string;
  attemptId: string;
  readOnly: boolean;
};
type ProgressSummaryProps = {
  accountId: string;
  courseId?: string;
  variant?: 'card' | 'embedded';
};
export type StudyDocumentRenderers = {
  ActivityHost?: ComponentType<ActivityHostProps>;
  PracticeView?: ComponentType<PracticeViewProps>;
  DictationControl?: ComponentType<StudyDictationControlProps>;
  ProgressSummary?: ComponentType<ProgressSummaryProps>;
  readSourcePreview?: (
    sessionId: string,
    reference: SourceReference,
  ) => Promise<StudySourcePreview | null>;
  openSource?: (sessionId: string, reference: SourceReference) => Promise<void>;
};
type StudyDocumentRenderersProviderProps = {
  renderers: StudyDocumentRenderers;
  children?: ReactNode;
};
type StudyDocumentProps = {
  accountId: string;
  sessionId: string;
  refreshEpoch?: number;
  readOnly?: boolean;
};
type SessionStatusPresentation = {
  label: string;
  Icon: typeof CircleCheckIcon;
};

const StudyDocumentRenderersContext =
  createContext<StudyDocumentRenderers | null>(null);

export const StudyDocumentRenderersProvider = ({
  renderers,
  children,
}: StudyDocumentRenderersProviderProps) => (
  <StudyDocumentRenderersContext.Provider value={renderers}>
    {children}
  </StudyDocumentRenderersContext.Provider>
);

const formatStudyActivity = (activity: StudyActivity) => {
  switch (activity) {
    case 'understand-topic':
      return 'Understand a topic';
    case 'prepare-exam':
      return 'Prepare for an exam';
    case 'practice-knowledge':
      return 'Practice what I know';
    case 'review-graded-mistakes':
      return 'Review graded mistakes';
    case 'assignment-start':
      return 'Help me get started on an assignment';
  }
};

const formatStudySessionStatus = (
  status: StudySessionDTO['status'],
): SessionStatusPresentation => {
  switch (status) {
    case 'saved':
      return { label: 'Saved', Icon: CircleDashedIcon };
    case 'in-progress':
      return { label: 'In progress', Icon: CircleCheckIcon };
    case 'finished':
      return { label: 'Finished', Icon: CircleStopIcon };
    case 'interrupted':
      return { label: 'Interrupted', Icon: CirclePauseIcon };
  }
};

const sourceKey = (reference: SourceReference) =>
  [
    reference.sourceKind,
    reference.sourceId,
    reference.courseId ?? '',
    reference.versionId ?? '',
    reference.locator ? JSON.stringify(reference.locator) : '',
  ].join(':');

const collectSourceReferences = (
  messages: StudyMessageDTO[],
  sessionReferences: SourceReference[],
  gradeEvidenceVisible: boolean,
) => {
  const uniqueReferences = new Map<string, SourceReference>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.kind === 'citation' &&
        (part.reference.sourceKind !== 'grade-evidence' || gradeEvidenceVisible)
      )
        uniqueReferences.set(sourceKey(part.reference), part.reference);
    }
  }
  for (const reference of sessionReferences) {
    if (reference.sourceKind !== 'grade-evidence')
      uniqueReferences.set(sourceKey(reference), reference);
  }
  return [...uniqueReferences.values()];
};

const activityKey = (
  messageId: string,
  part: Extract<MessagePart, { kind: 'activity' }>,
) => [messageId, part.artifactId, part.versionId, part.attemptId].join(':');

const LoadingStudyDocument = () => (
  <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="flex shrink-0 items-center justify-end gap-3 border-b p-4">
      <Skeleton className="size-9 rounded-md" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-6 w-56 max-w-full" />
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>
    </header>
    <section
      aria-label="Loading study session"
      className="flex min-h-0 flex-1 flex-col justify-end gap-5 p-6"
    >
      <p
        role="status"
        aria-live="polite"
        className="text-base text-muted-foreground"
      >
        Loading study session
      </p>
      <Skeleton className="h-20 w-3/4 self-end rounded-xl" />
      <Skeleton className="h-28 w-4/5 rounded-xl" />
      <Skeleton className="h-20 w-2/3 self-end rounded-xl" />
    </section>
  </main>
);

const LeaveSessionButton = () => {
  const confirmation = useConfirm<boolean>();
  return (
    <>
      <Button
        type="button"
        variant="destructive"
        aria-label="Leave study session"
        onClick={() => confirmation.request(true)}
      >
        <ArrowLeftIcon aria-hidden="true" />
        <span>Leave session</span>
      </Button>
      <AlertDialog
        open={confirmation.pending !== null}
        onOpenChange={(open) => {
          if (!open) confirmation.cancel();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this study session?</AlertDialogTitle>
            <AlertDialogDescription>
              Your saved session, messages, and materials are kept; nothing is
              deleted. Return from Study history whenever you are ready. A
              running timer continues until its deadline.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay in session</AlertDialogCancel>
            <Button
              nativeButton={false}
              render={<Link to="/dashboard/study" />}
              variant="destructive"
              aria-label="Confirm leave study session"
            >
              Leave session
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

const SessionLoadError = ({
  code,
  onRetry,
}: {
  code: StudySessionErrorCode;
  onRetry: () => void;
}) => (
  <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="flex shrink-0 items-center justify-end gap-3 border-b p-4">
      <LeaveSessionButton />
    </header>
    <Empty role="alert" className="min-h-0 flex-1 border-0 p-6">
      <EmptyMedia variant="icon">
        <TriangleAlertIcon aria-hidden="true" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>This study session could not be loaded</EmptyTitle>
        <EmptyDescription className="text-base">
          {formatStudySessionError(code, 'load')}
        </EmptyDescription>
      </EmptyHeader>
      <Button
        type="button"
        variant="outline"
        aria-label="Retry loading session"
        onClick={onRetry}
      >
        Try again
      </Button>
    </Empty>
  </main>
);

export const StudyDocument = ({
  accountId,
  sessionId,
  refreshEpoch = 0,
  readOnly = false,
}: StudyDocumentProps) => {
  const study = useStudySession(accountId, sessionId, readOnly, refreshEpoch);
  const renderers = useContext(StudyDocumentRenderersContext);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<SourceReference | null>(
    null,
  );
  const [progressOpen, setProgressOpen] = useState(false);
  const snapshot = study.snapshot;
  const session = snapshot?.session;

  useEffect(() => {
    setSourcesOpen(false);
    setSelectedSource(null);
    setProgressOpen(false);
  }, [accountId, sessionId]);

  const messages = useMemo(
    () =>
      [...(snapshot?.messages ?? [])].sort(
        (first, second) => first.sequence - second.sequence,
      ),
    [snapshot?.messages],
  );
  const gradeContentVisible = study.gradeSettings?.enabled === true;
  const sourceMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          !message.gradeDerived ||
          Boolean(
            gradeContentVisible &&
            message.gradeConsentRevision === study.gradeSettings?.revision,
          ),
      ),
    [gradeContentVisible, messages, study.gradeSettings?.revision],
  );
  const sourceReferences = useMemo(
    () =>
      collectSourceReferences(
        sourceMessages,
        snapshot?.sourceReferences ?? [],
        gradeContentVisible,
      ),
    [gradeContentVisible, sourceMessages, snapshot?.sourceReferences],
  );
  const failedTurnMessage = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'student' &&
        message.status === 'failed' &&
        message.turnId,
    );
  const timerExpiryMessageId = [...messages]
    .reverse()
    .find((message) =>
      message.parts.some(
        (part) => part.kind === 'status' && part.code === 'study-timer-expired',
      ),
    )?.id;
  const sessionStatus = session
    ? formatStudySessionStatus(session.status)
    : null;
  const SessionStatusIcon = sessionStatus?.Icon;
  const DictationControl = renderers?.DictationControl;
  const ProgressSummary = renderers?.ProgressSummary;

  if (study.loading && !snapshot) return <LoadingStudyDocument />;
  if (!snapshot || !session) {
    return (
      <SessionLoadError
        code={study.errorCode ?? 'unknown'}
        onRetry={() => void study.reload()}
      />
    );
  }

  let timerResolutionRendered = false;
  const renderSpecialPart = (part: MessagePart, message: StudyMessageDTO) => {
    if (part.kind === 'activity') {
      const ActivityHost = renderers?.ActivityHost;
      if (!ActivityHost) return null;
      return (
        <ActivityHost
          key={activityKey(message.id, part)}
          accountId={accountId}
          sessionId={sessionId}
          courseId={session.courseId}
          artifactId={part.artifactId}
          versionId={part.versionId}
          attemptId={part.attemptId}
          presentation="inline"
          readOnly={readOnly}
        />
      );
    }
    if (part.kind === 'practice') {
      const PracticeView = renderers?.PracticeView;
      return PracticeView ? (
        <PracticeView
          accountId={accountId}
          sessionId={sessionId}
          attemptId={part.practiceAttemptId}
          readOnly={readOnly}
        />
      ) : null;
    }
    if (
      part.kind === 'status' &&
      part.code === 'study-timer-expired' &&
      message.id === timerExpiryMessageId &&
      !timerResolutionRendered
    ) {
      timerResolutionRendered = true;
      return (
        <StudyTimerResolution
          timer={session.timer}
          summary="Your planned study time has ended."
          actions={study.timerActions}
          readOnly={readOnly}
        />
      );
    }
    return null;
  };

  const conversation = (
    <MessageScrollerProvider
      key={`${accountId}:${sessionId}`}
      autoScroll
      defaultScrollPosition="end"
    >
      <MessageScroller>
        <MessageScrollerViewport
          aria-label="Conversation history"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          preserveScrollOnPrepend
          className="px-4 py-6 md:px-8"
        >
          <MessageScrollerContent className="mx-auto w-full max-w-5xl gap-6">
            {snapshot.hasMoreBefore && (
              <div className="flex flex-col items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={study.olderMessagesLoading}
                  aria-label="Load earlier messages"
                  aria-busy={study.olderMessagesLoading}
                  onClick={() => void study.loadOlderMessages()}
                >
                  <LoadingSwap isLoading={study.olderMessagesLoading}>
                    Load earlier messages
                  </LoadingSwap>
                </Button>
                {study.olderMessagesErrorCode && (
                  <p
                    className="flex items-center gap-2 text-base text-destructive"
                    role="alert"
                  >
                    <TriangleAlertIcon
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    Earlier messages could not be loaded.
                  </p>
                )}
              </div>
            )}
            {messages.length === 0 ? (
              <Empty className="min-h-56 border-0 p-6">
                <EmptyMedia variant="icon">
                  <ActivityIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>Your study session is ready</EmptyTitle>
                  <EmptyDescription className="text-base">
                    Start with a question or attach course material; no tutor
                    response is shown until one is actually saved.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              messages.map((message) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  className="mx-auto w-full max-w-4xl"
                >
                  <StudyMessage
                    message={message}
                    streaming={message.id === study.streamingMessageId}
                    gradeContentVisible={
                      !message.gradeDerived ||
                      Boolean(
                        gradeContentVisible &&
                        message.gradeConsentRevision ===
                          study.gradeSettings?.revision,
                      )
                    }
                    gradeEvidenceVisible={gradeContentVisible}
                    loadAttachment={study.loadAttachment}
                    onInspectSource={(reference) => {
                      setSelectedSource(reference);
                      setSourcesOpen(true);
                    }}
                    renderSpecialPart={renderSpecialPart}
                  />
                </MessageScrollerItem>
              ))
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton aria-label="Scroll to latest message" />
      </MessageScroller>
    </MessageScrollerProvider>
  );

  return (
    <main className="flex h-dvh max-h-dvh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="truncate text-lg font-semibold">{session.title}</h1>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-base text-muted-foreground">
              <span className="flex min-w-0 items-center gap-2">
                <BookOpenTextIcon
                  aria-hidden="true"
                  className="size-4 shrink-0"
                />
                <span className="truncate">
                  {study.courseName ?? 'Course unavailable'}
                </span>
              </span>
              <CircleIcon
                aria-hidden="true"
                className="size-1 shrink-0 fill-current"
              />
              <span>{formatStudyActivity(session.activity)}</span>
              <CircleIcon
                aria-hidden="true"
                className="size-1 shrink-0 fill-current"
              />
              {sessionStatus && SessionStatusIcon && (
                <span className="flex items-center gap-2">
                  <SessionStatusIcon aria-hidden="true" className="size-4" />
                  {sessionStatus.label}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StudyTimer
            key={`${accountId}:${sessionId}`}
            sessionId={sessionId}
            timer={session.timer}
            actions={study.timerActions}
            readOnly={readOnly}
          />
          <TooltipWrapper content="Inspect sources">
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Inspect sources"
              aria-haspopup="dialog"
              onClick={() => setSourcesOpen(true)}
            >
              <FileTextIcon aria-hidden="true" />
            </Button>
          </TooltipWrapper>
          {ProgressSummary && (
            <TooltipWrapper content="Learning progress">
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="Learning progress"
                aria-haspopup="dialog"
                onClick={() => setProgressOpen(true)}
              >
                <SparklesIcon aria-hidden="true" />
              </Button>
            </TooltipWrapper>
          )}
          <LeaveSessionButton />
        </div>
      </header>
      {readOnly && (
        <p
          role="status"
          className="border-b px-4 py-2 text-base text-muted-foreground"
        >
          Reconnect online to send messages, update practice, or change study
          time.
        </p>
      )}
      {study.refreshErrorCode && (
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2"
          role="status"
        >
          <p className="flex items-center gap-2 text-base text-muted-foreground">
            <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
            Latest updates are unavailable. The saved conversation remains
            visible.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void study.reload()}
          >
            Refresh session
          </Button>
        </div>
      )}
      <section
        aria-label="Study conversation"
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      >
        <ActivityPanel key={`${accountId}:${sessionId}`} className="flex-1">
          {conversation}
        </ActivityPanel>
      </section>
      <div className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-background">
        <StudyComposer
          key={`${accountId}:${sessionId}:composer`}
          sessionId={sessionId}
          initialDraft={session.draft}
          offline={study.offline}
          readOnly={readOnly}
          activeTurn={snapshot.activeTurn}
          failedTurnId={failedTurnMessage?.turnId ?? null}
          attachmentRevision={study.attachmentRevision}
          onSend={study.sendTurn}
          onStop={async () => {
            if (snapshot.activeTurn)
              await study.stopTurn(snapshot.activeTurn.id);
          }}
          onRetry={study.retryTurn}
          onAddAttachments={study.addAttachments}
          onRefreshAttachment={study.refreshAttachment}
          renderDictation={
            DictationControl
              ? (props) => <DictationControl {...props} />
              : undefined
          }
        />
      </div>
      <StudySourcePanel
        key={`${accountId}:${sessionId}:source-panel`}
        sessionId={sessionId}
        open={sourcesOpen}
        references={sourceReferences}
        selectedReference={selectedSource}
        gradeContentVisible={gradeContentVisible}
        readSourcePreview={renderers?.readSourcePreview}
        openSource={renderers?.openSource}
        onOpenChange={setSourcesOpen}
        onSelectReference={setSelectedSource}
      />
      {ProgressSummary && (
        <Dialog open={progressOpen} onOpenChange={setProgressOpen}>
          <DialogContent
            aria-describedby="study-progress-description"
            className="max-h-[85vh] w-full max-w-2xl overflow-y-auto"
          >
            <DialogHeader>
              <DialogTitle>Learning progress</DialogTitle>
              <DialogDescription id="study-progress-description">
                Progress reflects saved learning evidence, not official grades.
              </DialogDescription>
            </DialogHeader>
            <ProgressSummary
              accountId={accountId}
              courseId={session.courseId}
              variant="embedded"
            />
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
};
