import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  AlertCircleIcon,
  CircleCheckIcon,
  FileTextIcon,
  LoaderCircleIcon,
  MicIcon,
  PaperclipIcon,
  SendIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  ContextProvenance,
  IngestionStatus,
} from '@scholaros/services/learning/context-contracts';
import type { TurnDTO } from '@scholaros/services/learning/study-contracts';
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@scholaros/ui/components/attachment';
import { Button } from '@scholaros/ui/components/button';
import { Card, CardContent } from '@scholaros/ui/components/card';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@scholaros/ui/components/input-group';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { toast } from '@scholaros/ui/components/toast';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import {
  formatStudyAttachmentStatus,
  formatStudyContextProvenance,
  isStudyAttachmentProcessing,
  isStudyAttachmentReady,
  isStudyAttachmentUnavailable,
} from './study-message';

type DraftValue = { text: string; revision: number };
type SendStudyTurnInput = {
  text: string;
  attachmentIds: string[];
  expectedDraftRevision: number;
  composerRevision: number;
};
type SendStudyTurnResult = { turnId: string; draftRevision: number | null };
type DraftSelection = { start: number; end: number };
type TurnStatusPresentation = {
  label: string;
  isWorking: boolean;
  Icon: LucideIcon;
};
export type StudyDictationFinal = {
  text: string;
  composerRevision: number;
  selection: DraftSelection;
};
export type StudyDictationControlProps = {
  sessionId: string;
  composerRevision: number;
  selection: DraftSelection;
  onProvisional: (text: string | null) => void;
  onFinal: (transcript: StudyDictationFinal) => void;
  onCancel: () => void;
  disabled: boolean;
};
export type StudyAttachment = {
  itemId: string;
  title: string;
  status: IngestionStatus;
  provenance: ContextProvenance | null;
  versionId: string | null;
  sourceRemoved: boolean;
};
export type StudyComposerProps = {
  sessionId: string;
  initialDraft: DraftValue;
  offline: boolean;
  readOnly?: boolean;
  activeTurn: TurnDTO | null;
  failedTurnId: string | null;
  timerExpired?: boolean;
  attachmentRevision?: number;
  onSend: (input: SendStudyTurnInput) => Promise<SendStudyTurnResult>;
  onStop: () => Promise<void>;
  onRetry: (turnId: string) => Promise<void>;
  onAddAttachments: () => Promise<StudyAttachment[]>;
  onRefreshAttachment?: (
    attachment: StudyAttachment,
  ) => Promise<StudyAttachment | null>;
  renderDictation?: (props: StudyDictationControlProps) => ReactNode;
};

const formatTurnStatus = (
  status: TurnDTO['status'],
): TurnStatusPresentation => {
  switch (status) {
    case 'preparing':
      return {
        label: 'Preparing a response',
        isWorking: true,
        Icon: LoaderCircleIcon,
      };
    case 'generating':
      return {
        label: 'Writing a response',
        isWorking: true,
        Icon: LoaderCircleIcon,
      };
    case 'checking':
      return {
        label: 'Checking a response',
        isWorking: true,
        Icon: LoaderCircleIcon,
      };
    case 'complete':
      return {
        label: 'Response ready',
        isWorking: false,
        Icon: CircleCheckIcon,
      };
    case 'failed':
      return {
        label: 'Response could not be completed',
        isWorking: false,
        Icon: AlertCircleIcon,
      };
    case 'cancelled':
      return { label: 'Response stopped', isWorking: false, Icon: XIcon };
  }
};

const getErrorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;

const formatComposerError = (error: unknown) => {
  switch (getErrorCode(error)) {
    case 'offline':
      return 'You are offline. Your draft is safe; connect before sending.';
    case 'needs-sign-in':
      return 'Sign in again to send this message.';
    case 'permission-revoked':
      return 'Access changed before this message could be sent.';
    case 'session-changed':
      return 'This session changed. Reopen it before sending.';
    case 'revision-conflict':
      return 'This session changed elsewhere. Your text is still here; try sending again.';
    case 'limit-exceeded':
      return 'This message or its attachments exceed the allowed limit.';
    case 'cancelled':
      return 'The message was not sent. Your draft is still here.';
    case 'storage-failed':
      return 'Your message could not be saved. Keep this screen open and retry.';
    case 'provider-failed':
      return 'The tutor could not respond. Your message is saved and can be retried.';
    default:
      return 'This action could not be completed. Your draft is still here.';
  }
};

export const StudyComposer = ({
  sessionId,
  initialDraft,
  offline,
  readOnly = false,
  activeTurn,
  failedTurnId,
  timerExpired = false,
  attachmentRevision = 0,
  onSend,
  onStop,
  onRetry,
  onAddAttachments,
  onRefreshAttachment,
  renderDictation,
}: StudyComposerProps) => {
  const [text, setText] = useState(initialDraft.text);
  const [attachments, setAttachments] = useState<StudyAttachment[]>([]);
  const [composerRevision, setComposerRevision] = useState(0);
  const [selection, setSelection] = useState<DraftSelection>({
    start: 0,
    end: 0,
  });
  const [provisionalTranscript, setProvisionalTranscript] = useState<
    string | null
  >(null);
  const [recoverableTranscript, setRecoverableTranscript] = useState<
    string | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [addingAttachments, setAddingAttachments] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offlineFromService, setOfflineFromService] = useState(false);
  const textRef = useRef(text);
  const composerRevisionRef = useRef(composerRevision);
  const readOnlyRef = useRef(readOnly);
  const selectionRef = useRef(selection);
  const attachmentsRef = useRef(attachments);
  const expectedDraftRevisionRef = useRef(initialDraft.revision);
  const submittingRef = useRef(false);
  const stoppingRef = useRef(false);
  const mountedRef = useRef(true);
  const sendRef = useRef(onSend);
  const requestSelectionRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  sendRef.current = onSend;
  attachmentsRef.current = attachments;
  readOnlyRef.current = readOnly;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    expectedDraftRevisionRef.current = Math.max(
      expectedDraftRevisionRef.current,
      initialDraft.revision,
    );
  }, [initialDraft.revision]);

  useEffect(() => {
    if (!offline) setOfflineFromService(false);
  }, [offline]);

  const selectedAttachmentIds = JSON.stringify(
    attachments.map((attachment) => attachment.itemId),
  );

  useEffect(() => {
    if (!onRefreshAttachment || attachmentsRef.current.length === 0) return;
    let active = true;
    void Promise.all(
      attachmentsRef.current.map((attachment) =>
        onRefreshAttachment(attachment),
      ),
    ).then((refreshed) => {
      if (!active) return;
      const nextAttachments = refreshed.filter(
        (attachment): attachment is StudyAttachment => attachment !== null,
      );
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);
    });
    return () => {
      active = false;
    };
  }, [attachmentRevision, onRefreshAttachment, selectedAttachmentIds]);

  useEffect(() => {
    const caret = requestSelectionRef.current;
    if (caret === null) return;
    requestSelectionRef.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [text]);

  useEffect(() => {
    if (readOnly) setProvisionalTranscript(null);
  }, [readOnly]);

  const updateText = (nextText: string, nextSelection?: DraftSelection) => {
    if (readOnlyRef.current) return;
    textRef.current = nextText;
    composerRevisionRef.current += 1;
    setComposerRevision(composerRevisionRef.current);
    setText(nextText);
    const next = nextSelection ?? {
      start: textareaRef.current?.selectionStart ?? nextText.length,
      end: textareaRef.current?.selectionEnd ?? nextText.length,
    };
    selectionRef.current = next;
    setSelection(next);
    setError(null);
  };

  const insertTranscript = (transcript: string, target: DraftSelection) => {
    if (readOnlyRef.current) return;
    const start = Math.max(0, Math.min(target.start, textRef.current.length));
    const end = Math.max(start, Math.min(target.end, textRef.current.length));
    const nextText = `${textRef.current.slice(0, start)}${transcript}${textRef.current.slice(end)}`;
    const caret = start + transcript.length;
    requestSelectionRef.current = caret;
    setRecoverableTranscript(null);
    setProvisionalTranscript(null);
    updateText(nextText, { start: caret, end: caret });
  };

  const captureSelection = (input: HTMLTextAreaElement) => {
    const next = { start: input.selectionStart, end: input.selectionEnd };
    selectionRef.current = next;
    setSelection(next);
  };

  const onDictationFinal = (transcript: StudyDictationFinal) => {
    if (!mountedRef.current || readOnlyRef.current) return;
    setProvisionalTranscript(null);
    if (!transcript.text.trim()) return;
    if (transcript.composerRevision !== composerRevisionRef.current) {
      setRecoverableTranscript(transcript.text);
      return;
    }
    insertTranscript(transcript.text, transcript.selection);
  };

  const addAttachments = async () => {
    if (
      readOnlyRef.current ||
      addingAttachments ||
      attachmentsRef.current.length >= 8
    )
      return;
    setAddingAttachments(true);
    setError(null);
    try {
      const selected = await onAddAttachments();
      if (!mountedRef.current) return;
      const combined = [...attachmentsRef.current];
      for (const attachment of selected) {
        if (
          combined.length >= 8 ||
          combined.some((existing) => existing.itemId === attachment.itemId)
        )
          continue;
        combined.push(attachment);
      }
      attachmentsRef.current = combined;
      setAttachments(combined);
    } catch (selectionError) {
      if (mountedRef.current) {
        const message = formatComposerError(selectionError);
        setError(message);
        toast.error(message);
      }
    } finally {
      if (mountedRef.current) setAddingAttachments(false);
    }
  };

  const removeAttachment = (itemId: string) => {
    if (readOnlyRef.current) return;
    const nextAttachments = attachmentsRef.current.filter(
      (attachment) => attachment.itemId !== itemId,
    );
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);
  };

  const activeTurnStatus = activeTurn
    ? formatTurnStatus(activeTurn.status)
    : null;
  const hasProcessingAttachment = attachments.some((attachment) =>
    isStudyAttachmentProcessing(attachment.status, attachment.sourceRemoved),
  );
  const hasUnavailableAttachment = attachments.some((attachment) =>
    isStudyAttachmentUnavailable(attachment.status, attachment.sourceRemoved),
  );
  const readyAttachments = attachments.filter((attachment) =>
    isStudyAttachmentReady(
      attachment.status,
      attachment.versionId,
      attachment.sourceRemoved,
    ),
  );
  const hasPayload = text.trim().length > 0 || readyAttachments.length > 0;
  const sendingDisabledReason = readOnly
    ? 'Reconnect online to change this draft, attach files, or send a message.'
    : timerExpired
      ? 'Your study time ended. Extend the session or continue without a timer.'
      : offline || offlineFromService
        ? 'Connect to send; your text stays here.'
        : hasProcessingAttachment
          ? 'Wait for selected files to finish processing.'
          : hasUnavailableAttachment
            ? 'Remove or replace unreadable files before sending.'
            : null;
  const sendDisabled =
    submitting ||
    activeTurnStatus?.isWorking ||
    !hasPayload ||
    Boolean(sendingDisabledReason);

  const submit = async () => {
    if (readOnlyRef.current || submittingRef.current || sendDisabled) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setOfflineFromService(false);
    const submittedText = textRef.current;
    const submittedRevision = composerRevisionRef.current;
    const submittedAttachmentIds = readyAttachments.map(
      (attachment) => attachment.itemId,
    );
    try {
      const result = await sendRef.current({
        text: submittedText,
        attachmentIds: submittedAttachmentIds,
        expectedDraftRevision: expectedDraftRevisionRef.current,
        composerRevision: submittedRevision,
      });
      if (result.draftRevision !== null)
        expectedDraftRevisionRef.current = result.draftRevision;
      const remainingAttachments = attachmentsRef.current.filter(
        (attachment) => !submittedAttachmentIds.includes(attachment.itemId),
      );
      attachmentsRef.current = remainingAttachments;
      if (mountedRef.current) setAttachments(remainingAttachments);
      if (composerRevisionRef.current === submittedRevision) {
        textRef.current = '';
        composerRevisionRef.current += 1;
        selectionRef.current = { start: 0, end: 0 };
        if (mountedRef.current) {
          setText('');
          setComposerRevision(composerRevisionRef.current);
          setSelection({ start: 0, end: 0 });
        }
      }
    } catch (sendError) {
      if (mountedRef.current) {
        const message = formatComposerError(sendError);
        setError(message);
        if (getErrorCode(sendError) === 'offline') setOfflineFromService(true);
        toast.error(message);
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const stop = async () => {
    if (readOnlyRef.current || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      await onStop();
    } catch (stopError) {
      if (mountedRef.current) {
        const message = formatComposerError(stopError);
        setError(message);
        toast.error(message);
      }
    } finally {
      stoppingRef.current = false;
      if (mountedRef.current) setStopping(false);
    }
  };

  const retry = async () => {
    if (
      readOnlyRef.current ||
      timerExpired ||
      !failedTurnId ||
      submittingRef.current
    )
      return;
    submittingRef.current = true;
    try {
      setSubmitting(true);
      await onRetry(failedTurnId);
      if (mountedRef.current) setError(null);
    } catch (retryError) {
      if (mountedRef.current) {
        const message = formatComposerError(retryError);
        setError(message);
        toast.error(message);
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent;
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.repeat ||
      nativeEvent.isComposing ||
      nativeEvent.keyCode === 229
    )
      return;
    event.preventDefault();
    void submit();
  };

  return (
    <form
      className="flex w-full shrink-0 flex-col gap-2 p-4"
      aria-label="Study message composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {attachments.length > 0 && (
        <AttachmentGroup
          aria-label="Selected study attachments"
          className="flex-wrap overflow-visible"
        >
          {attachments.map((attachment) => {
            const status = formatStudyAttachmentStatus(
              attachment.status,
              attachment.sourceRemoved,
            );
            const StatusIcon = status.Icon;
            return (
              <Attachment
                key={attachment.itemId}
                state={
                  isStudyAttachmentProcessing(
                    attachment.status,
                    attachment.sourceRemoved,
                  )
                    ? 'processing'
                    : isStudyAttachmentUnavailable(
                          attachment.status,
                          attachment.sourceRemoved,
                        )
                      ? 'error'
                      : 'done'
                }
                size="default"
              >
                <AttachmentMedia
                  role={status.state === 'processing' ? 'status' : undefined}
                  aria-label={
                    status.state === 'processing' ? status.label : undefined
                  }
                >
                  {isStudyAttachmentProcessing(
                    attachment.status,
                    attachment.sourceRemoved,
                  ) ? (
                    <LoaderCircleIcon
                      aria-hidden="true"
                      className="motion-safe:animate-spin"
                    />
                  ) : (
                    <FileTextIcon aria-hidden="true" />
                  )}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle className="text-base">
                    {attachment.title}
                  </AttachmentTitle>
                  <AttachmentDescription className="flex flex-col items-start gap-1 text-sm">
                    <span>
                      {formatStudyContextProvenance(attachment.provenance)}
                    </span>
                    {status.state === 'error' && (
                      <span className="flex items-center gap-1">
                        <StatusIcon aria-hidden="true" className="size-4" />
                        {status.label}
                      </span>
                    )}
                  </AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <TooltipWrapper content="Remove from this message">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${attachment.title} from message`}
                      disabled={readOnly}
                      onClick={() => removeAttachment(attachment.itemId)}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </TooltipWrapper>
                </AttachmentActions>
              </Attachment>
            );
          })}
        </AttachmentGroup>
      )}
      {recoverableTranscript !== null && (
        <Card data-slot="recoverable-transcript" className="gap-2 p-3">
          <CardContent className="gap-2 px-0">
            <p className="text-base text-muted-foreground">
              Your draft changed while you were dictating. Insert the transcript
              where your cursor is now, or dismiss it.
            </p>
            <p className="whitespace-pre-wrap text-base">
              {recoverableTranscript}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={readOnly}
                onClick={() =>
                  insertTranscript(recoverableTranscript, selectionRef.current)
                }
              >
                Insert dictated text
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRecoverableTranscript(null)}
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <label htmlFor="study-message-input" className="sr-only">
        Message
      </label>
      <InputGroup className="h-auto w-full flex-col items-stretch gap-2 rounded-xl border-0 bg-transparent p-2 shadow-none has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-transparent">
        <InputGroupTextarea
          ref={textareaRef}
          id="study-message-input"
          aria-label="Message"
          aria-describedby={
            [
              error ? 'study-composer-error' : null,
              sendingDisabledReason ? 'study-send-reason' : null,
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
          className="min-h-20 max-h-56 w-full resize-none border-0 bg-transparent text-base shadow-none dark:bg-transparent"
          maxLength={8000}
          rows={3}
          readOnly={readOnly}
          value={text}
          placeholder="Ask about your course or share what you are working through…"
          onChange={(event) => updateText(event.target.value)}
          onSelect={(event) => {
            captureSelection(event.currentTarget);
          }}
          onKeyUp={(event) => captureSelection(event.currentTarget)}
          onMouseUp={(event) => captureSelection(event.currentTarget)}
          onClick={(event) => captureSelection(event.currentTarget)}
          onKeyDown={handleKeyDown}
        />
        {provisionalTranscript && (
          <p
            role="status"
            aria-live="polite"
            className="px-2 text-base text-muted-foreground"
          >
            Hearing: {provisionalTranscript}
          </p>
        )}
        <InputGroupAddon align="inline-end" className="w-full justify-between">
          <div className="flex items-center gap-2">
            <TooltipWrapper content="Add attachment">
              <InputGroupButton
                type="button"
                size="icon-sm"
                aria-label="Add attachment"
                aria-busy={addingAttachments}
                disabled={
                  readOnly || addingAttachments || attachments.length >= 8
                }
                onClick={() => void addAttachments()}
              >
                <LoadingSwap isLoading={addingAttachments}>
                  <PaperclipIcon aria-hidden="true" />
                </LoadingSwap>
              </InputGroupButton>
            </TooltipWrapper>
            {renderDictation && !readOnly ? (
              renderDictation({
                sessionId,
                composerRevision,
                selection,
                onProvisional: (transcript) => {
                  if (mountedRef.current && !readOnlyRef.current)
                    setProvisionalTranscript(transcript);
                },
                onFinal: onDictationFinal,
                onCancel: () => {
                  if (mountedRef.current) setProvisionalTranscript(null);
                },
                disabled:
                  offline ||
                  offlineFromService ||
                  submitting ||
                  Boolean(activeTurnStatus?.isWorking),
              })
            ) : (
              <TooltipWrapper
                content={
                  readOnly
                    ? 'Reconnect online to use dictation.'
                    : 'Speech input is unavailable in this build.'
                }
              >
                <span className="inline-flex" tabIndex={0}>
                  <InputGroupButton
                    type="button"
                    size="icon-sm"
                    aria-label="Dictation unavailable"
                    disabled
                  >
                    <MicIcon aria-hidden="true" />
                  </InputGroupButton>
                </span>
              </TooltipWrapper>
            )}
          </div>
          <div className="flex items-center gap-2">
            {activeTurnStatus?.isWorking ? (
              <TooltipWrapper content="Stop response">
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label="Stop response"
                  aria-busy={stopping}
                  disabled={readOnly || stopping}
                  onClick={() => void stop()}
                >
                  <LoadingSwap isLoading={stopping}>
                    <SquareIcon aria-hidden="true" />
                  </LoadingSwap>
                </InputGroupButton>
              </TooltipWrapper>
            ) : (
              <>
                {failedTurnId && (
                  <Button
                    type="button"
                    variant="outline"
                    aria-busy={submitting}
                    disabled={
                      readOnly ||
                      timerExpired ||
                      submitting ||
                      offline ||
                      offlineFromService
                    }
                    onClick={() => void retry()}
                  >
                    <LoadingSwap isLoading={submitting}>
                      Retry response
                    </LoadingSwap>
                  </Button>
                )}
                <TooltipWrapper content="Send message">
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    aria-label="Send message"
                    aria-busy={submitting}
                    disabled={sendDisabled}
                  >
                    <LoadingSwap isLoading={submitting}>
                      <SendIcon aria-hidden="true" />
                    </LoadingSwap>
                  </InputGroupButton>
                </TooltipWrapper>
              </>
            )}
          </div>
        </InputGroupAddon>
      </InputGroup>
      {sendingDisabledReason && (
        <p id="study-send-reason" className="text-base text-muted-foreground">
          {sendingDisabledReason}
        </p>
      )}
      {error && (
        <p
          id="study-composer-error"
          role="alert"
          className="text-base text-destructive"
        >
          {error}
        </p>
      )}
    </form>
  );
};
