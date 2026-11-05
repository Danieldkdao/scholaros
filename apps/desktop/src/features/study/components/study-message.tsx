import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from 'cn';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleHelpIcon,
  FileTextIcon,
  LoaderCircleIcon,
  XCircleIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  ContextProvenance,
  IngestionStatus,
  SourceReference,
} from '@scholaros/services/learning/context-contracts';
import type {
  MessagePart,
  StudyMessageDTO,
} from '@scholaros/services/learning/study-contracts';
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from '@scholaros/ui/components/attachment';
import { Spinner } from '@scholaros/ui/components/spinner';
import { Button } from '@scholaros/ui/components/button';
import { Card, CardContent } from '@scholaros/ui/components/card';
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageGroup,
} from '@scholaros/ui/components/message';
import type { StudyAttachmentDetails } from '../hooks/use-study-session';
import { StudyMarkdown } from './study-markdown';

type AttachmentPresentation = {
  label: string;
  Icon: LucideIcon;
  state: 'idle' | 'processing' | 'error' | 'done';
};
export type StudyMessageProps = {
  message: StudyMessageDTO;
  streaming?: boolean;
  suppressProgress?: boolean;
  gradeContentVisible: boolean;
  gradeEvidenceVisible: boolean;
  loadAttachment?: (
    itemId: string,
    versionId: string,
  ) => Promise<StudyAttachmentDetails | null>;
  onInspectSource: (reference: SourceReference) => void;
  renderSpecialPart?: (
    part: MessagePart,
    message: StudyMessageDTO,
  ) => ReactNode | null;
};

type AttachmentPartProps = {
  itemId: string;
  versionId: string;
  loadAttachment?: StudyMessageProps['loadAttachment'];
};

export const formatStudyAttachmentStatus = (
  status: IngestionStatus,
  sourceRemoved = false,
): AttachmentPresentation => {
  if (sourceRemoved)
    return { label: 'Source removed', Icon: XCircleIcon, state: 'error' };
  switch (status) {
    case 'queued':
      return {
        label: 'Waiting to read',
        Icon: LoaderCircleIcon,
        state: 'processing',
      };
    case 'processing':
      return {
        label: 'Reading file',
        Icon: LoaderCircleIcon,
        state: 'processing',
      };
    case 'complete':
      return { label: 'Ready', Icon: CheckCircle2Icon, state: 'done' };
    case 'partial':
      return { label: 'Partly read', Icon: AlertCircleIcon, state: 'done' };
    case 'unreadable':
      return { label: 'Unreadable', Icon: AlertCircleIcon, state: 'error' };
    case 'unsupported':
      return {
        label: 'Unsupported file',
        Icon: AlertCircleIcon,
        state: 'error',
      };
    case 'failed':
      return { label: 'Could not read', Icon: AlertCircleIcon, state: 'error' };
    case 'cancelled':
      return {
        label: 'Reading stopped',
        Icon: AlertCircleIcon,
        state: 'error',
      };
  }
};

export const formatStudyContextProvenance = (
  provenance: ContextProvenance | null,
) => {
  if (provenance === null) return 'Provenance unavailable';
  switch (provenance) {
    case 'user-authored':
      return 'Written in ScholarOS';
    case 'user-uploaded':
      return 'Uploaded by you';
    case 'connected-source':
      return 'Connected course source';
    case 'ai-generated':
      return 'Created with ScholarOS';
  }
};

export const isStudyAttachmentReady = (
  status: IngestionStatus,
  versionId: string | null,
  sourceRemoved = false,
) =>
  !sourceRemoved &&
  (status === 'complete' || status === 'partial') &&
  versionId !== null;

export const isStudyAttachmentProcessing = (
  status: IngestionStatus,
  sourceRemoved = false,
) => !sourceRemoved && (status === 'queued' || status === 'processing');

export const isStudyAttachmentUnavailable = (
  status: IngestionStatus,
  sourceRemoved = false,
) =>
  sourceRemoved ||
  status === 'unreadable' ||
  status === 'unsupported' ||
  status === 'failed' ||
  status === 'cancelled';

const formatSafeStatusPart = (code: string) => {
  switch (code) {
    case 'preparing':
      return 'Preparing your study context';
    case 'generating':
      return 'Working on a response';
    case 'checking':
      return 'Checking the response';
    case 'study-timer-expired':
      return 'Your planned study time has ended.';
    case 'grade-content-withheld':
      return 'Some past tutor content is unavailable because grade access changed.';
    case 'source-removed':
      return 'A cited source was removed.';
    case 'cancelled':
      return 'The response was stopped.';
    case 'interrupted':
      return 'The response was interrupted.';
    case 'failed':
      return 'The response could not be completed.';
    case 'learning-action-unavailable':
      return 'Your explanation is saved, but a learning activity could not be created. Please try again.';
    case 'safe-response-unavailable':
      return 'The tutor could not safely prepare this response. Try asking about a concept or another source.';
    case 'feature-unavailable':
      return 'Study responses are unavailable right now.';
    case 'provider-failed':
      return 'The study service could not finish this response. Please try again.';
    case 'rate-limited':
      return 'The study service is busy. Please try again shortly.';
    case 'offline':
      return 'Reconnect to the internet to continue this response.';
    default:
      return 'Study session update';
  }
};

const formatMessageTime = (createdAt: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(createdAt));

const AttachmentPart = ({
  itemId,
  versionId,
  loadAttachment,
}: AttachmentPartProps) => {
  const [details, setDetails] = useState<
    StudyAttachmentDetails | null | undefined
  >(undefined);

  useEffect(() => {
    if (!loadAttachment) {
      setDetails(null);
      return;
    }
    let active = true;
    setDetails(undefined);
    void loadAttachment(itemId, versionId)
      .then((attachment) => {
        if (active) setDetails(attachment);
      })
      .catch(() => {
        if (active) setDetails(null);
      });
    return () => {
      active = false;
    };
  }, [itemId, versionId, loadAttachment]);

  const title =
    details?.title ??
    (details === undefined ? 'Loading source' : 'Attachment unavailable');
  const status = details
    ? formatStudyAttachmentStatus(details.status, details.sourceRemoved)
    : details === undefined
      ? formatStudyAttachmentStatus('processing')
      : formatStudyAttachmentStatus('failed');
  const StatusIcon = status.Icon;

  return (
    <Attachment
      data-slot="study-message-attachment"
      data-item-id={itemId}
      state={status.state}
      size="default"
    >
      <AttachmentMedia
        role={status.state === 'processing' ? 'status' : undefined}
        aria-label={status.state === 'processing' ? status.label : undefined}
      >
        {status.state === 'processing' ? (
          <LoaderCircleIcon
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        ) : (
          <FileTextIcon aria-hidden="true" />
        )}
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle className="text-base">{title}</AttachmentTitle>
        <AttachmentDescription className="flex flex-col items-start gap-1 text-sm">
          {details && (
            <span>{formatStudyContextProvenance(details.provenance)}</span>
          )}
          {status.state === 'error' && (
            <span className="flex items-center gap-1">
              <StatusIcon aria-hidden="true" className="size-4" />
              {status.label}
            </span>
          )}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
};

const TextPart = ({ text }: { text: string }) => (
  <p className="whitespace-pre-wrap break-words text-base">{text}</p>
);

const SourcePart = ({
  reference,
  onInspectSource,
}: {
  reference: SourceReference;
  onInspectSource: (reference: SourceReference) => void;
}) => (
  <Button
    type="button"
    size="sm"
    variant="outline"
    aria-label={`Inspect source ${reference.title}`}
    className="h-auto max-w-full whitespace-normal text-base"
    onClick={() => onInspectSource(reference)}
  >
    <FileTextIcon aria-hidden="true" />
    <span className="break-words">{reference.title}</span>
    <span className="text-muted-foreground">
      {reference.locator?.kind === 'page'
        ? `Page ${reference.locator.page}`
        : ''}
    </span>
  </Button>
);

const StatusPart = ({ code }: { code: string }) => {
  const status = formatSafeStatusPart(code);
  const isProgress = ['preparing', 'generating', 'checking'].includes(code);
  return (
    <p
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-base text-muted-foreground"
    >
      {isProgress ? (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-4 motion-safe:animate-spin"
        />
      ) : (
        <CircleHelpIcon aria-hidden="true" className="size-4" />
      )}
      <span>{status}</span>
    </p>
  );
};

export const StudyMessage = ({
  message,
  streaming = false,
  suppressProgress = false,
  gradeContentVisible,
  gradeEvidenceVisible,
  loadAttachment,
  onInspectSource,
  renderSpecialPart,
}: StudyMessageProps) => {
  const isStudent = message.role === 'student';
  const isSystem = message.role === 'system-status';
  const hiddenGradeContent = message.gradeDerived && !gradeContentVisible;
  const parts = hiddenGradeContent ? [] : message.parts;

  const content = (
    <>
      {hiddenGradeContent && (
        <Card data-slot="grade-content-withheld" className="gap-2 p-3">
          <CardContent className="gap-2 px-0">
            <p className="flex items-center gap-2 text-base text-muted-foreground">
              <AlertCircleIcon aria-hidden="true" className="size-4 shrink-0" />
              Some past tutor content is hidden because current grade permission
              could not be confirmed.
            </p>
          </CardContent>
        </Card>
      )}
      {parts.map((part, index) => {
        const key = `${message.id}:${index}`;
        const specialPart = renderSpecialPart?.(part, message);
        if (specialPart !== null && specialPart !== undefined) {
          return (
            <div key={key} className="min-w-0">
              {specialPart}
            </div>
          );
        }
        switch (part.kind) {
          case 'text':
            return message.role === 'tutor' ? (
              <StudyMarkdown key={key} text={part.text} streaming={streaming} />
            ) : (
              <TextPart key={key} text={part.text} />
            );
          case 'citation':
            if (
              part.reference.sourceKind === 'grade-evidence' &&
              !gradeEvidenceVisible
            )
              return null;
            return (
              <SourcePart
                key={key}
                reference={part.reference}
                onInspectSource={onInspectSource}
              />
            );
          case 'attachment':
            return (
              <AttachmentPart
                key={key}
                itemId={part.itemId}
                versionId={part.versionId}
                loadAttachment={loadAttachment}
              />
            );
          case 'activity':
          case 'practice':
            return (
              <Card key={key} className="gap-2 p-3">
                <CardContent className="gap-2 px-0">
                  <p className="flex items-center gap-2 text-base text-muted-foreground">
                    <CircleHelpIcon
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    This learning activity is unavailable right now; the
                    conversation is still saved.
                  </p>
                </CardContent>
              </Card>
            );
          case 'status':
            if (
              suppressProgress &&
              ['preparing', 'generating', 'checking'].includes(part.code)
            )
              return null;
            return <StatusPart key={key} code={part.code} />;
        }
      })}
    </>
  );

  return (
    <MessageGroup
      data-message-id={message.id}
      tabIndex={0}
      className="group/study-message gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <Message
        align={isStudent ? 'end' : 'start'}
        role="article"
        aria-label={
          isStudent
            ? 'Your message'
            : isSystem
              ? 'Study session update'
              : 'Tutor response'
        }
        className="text-base"
      >
        <MessageContent
          className={cn(
            'gap-2 text-base',
            isStudent ? 'items-end' : 'items-start',
          )}
        >
          {isStudent ? (
            <Card className="w-fit max-w-[85%] gap-0 rounded-2xl border-0 bg-card py-3 shadow-none ring-0 sm:max-w-[75%]">
              <CardContent className="flex min-w-0 flex-col gap-3 px-4">
                {content}
              </CardContent>
            </Card>
          ) : (
            <div
              data-slot="study-message-body"
              className="flex w-full min-w-0 flex-col gap-3"
            >
              {content}
            </div>
          )}
          <MessageFooter className="flex flex-wrap items-center gap-2 px-0 text-base opacity-0 transition-opacity group-hover/study-message:opacity-100 group-focus-within/study-message:opacity-100 motion-reduce:transition-none">
            <time
              className="text-base text-muted-foreground"
              dateTime={message.createdAt}
            >
              {formatMessageTime(message.createdAt)}
            </time>
            {message.status === 'interrupted' && <span>Interrupted</span>}
          </MessageFooter>
        </MessageContent>
      </Message>
    </MessageGroup>
  );
};

export const StudyThinkingReply = () => (
  <MessageGroup data-slot="study-thinking">
    <Message
      align="start"
      role="article"
      aria-label="Tutor response"
      aria-busy="true"
    >
      <MessageContent>
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 text-base text-muted-foreground"
        >
          <Spinner
            aria-hidden="true"
            role="presentation"
            aria-label={undefined}
            className="animate-none motion-safe:animate-spin"
          />
          <span>Thinking…</span>
        </p>
      </MessageContent>
    </Message>
  </MessageGroup>
);
