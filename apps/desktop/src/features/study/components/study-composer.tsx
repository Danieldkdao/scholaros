import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useDebouncer } from '@tanstack/react-pacer';
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
import { cn } from '@scholaros/ui/lib/utils';
import {
  formatStudyAttachmentStatus,
  formatStudyContextProvenance,
  isStudyAttachmentProcessing,
  isStudyAttachmentReady,
  isStudyAttachmentUnavailable,
} from './study-message';

type DraftValue = { text: string; revision: number };
type DraftSaveResult = { draftRevision: number };
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
type ComposerStatus = 'error' | 'saving' | 'sending' | 'saved';
type ComposerStatusPresentation = {
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
  attachmentRevision?: number;
  onSaveDraft: (
    text: string,
    expectedDraftRevision: number,
  ) => Promise<DraftSaveResult>;
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

const formatComposerStatus = (
  status: ComposerStatus,
  error: string | null,
): ComposerStatusPresentation => {
  switch (status) {
    case 'error':
      return {
        label: error ?? 'The message could not be completed.',
        isWorking: false,
        Icon: AlertCircleIcon,
      };
    case 'saving':
      return { label: 'Saving draft', isWorking: true, Icon: LoaderCircleIcon };
    case 'sending':
      return {
        label: 'Sending message',
        isWorking: true,
        Icon: LoaderCircleIcon,
      };
    case 'saved':
      return { label: 'Draft saved', isWorking: false, Icon: CircleCheckIcon };
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
      return 'Your draft changed elsewhere. Your text is still here; retry to save it.';
    case 'limit-exceeded':
      return 'This message or its attachments exceed the allowed limit.';
    case 'cancelled':
      return 'The message was not sent. Your draft is still here.';
    case 'storage-failed':
      return 'Your draft could not be saved. Keep this screen open and retry.';
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
  attachmentRevision = 0,
  onSaveDraft,
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
  const [saving, setSaving] = useState(false);
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
  const savedTextRef = useRef(initialDraft.text);
  const expectedDraftRevisionRef = useRef(initialDraft.revision);
  const saveQueueRef = useRef(Promise.resolve());
  const savingRequestRef = useRef(false);
  const submittingRef = useRef(false);
  const stoppingRef = useRef(false);
  const mountedRef = useRef(true);
  const saveDraftRef = useRef(onSaveDraft);
  const sendRef = useRef(onSend);
  const requestSelectionRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  saveDraftRef.current = onSaveDraft;
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
    if (textRef.current === savedTextRef.current) {
      expectedDraftRevisionRef.current = initialDraft.revision;
      savedTextRef.current = initialDraft.text;
      textRef.current = initialDraft.text;
      setText(initialDraft.text);
    }
  }, [initialDraft.revision, initialDraft.text]);

  useEffect(() => {
    if (!offline) setOfflineFromService(false);
  }, [offline]);

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
  }, [attachmentRevision, onRefreshAttachment]);

  useEffect(() => {
    const caret = requestSelectionRef.current;
    if (caret === null) return;
    requestSelectionRef.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [text]);

  const saveText = async (nextText: string) => {
    if (readOnlyRef.current) return;
    if (nextText === savedTextRef.current) return;
    if (submittingRef.current) return;
    if (mountedRef.current) setSaving(true);
    savingRequestRef.current = true;
    try {
      const result = await saveDraftRef.current(
        nextText,
        expectedDraftRevisionRef.current,
      );
      expectedDraftRevisionRef.current = result.draftRevision;
      savedTextRef.current = nextText;
      if (mountedRef.current && textRef.current === nextText) {
        setSaving(false);
        setError(null);
      }
    } catch (saveError) {
      if (mountedRef.current) {
        setSaving(false);
        setError(formatComposerError(saveError));
        toast.error(formatComposerError(saveError));
      }
      throw saveError;
    } finally {
      savingRequestRef.current = false;
      if (mountedRef.current && readOnlyRef.current) setSaving(false);
    }
  };

  const flushDraft = () => {
    if (readOnlyRef.current) return;
    if (submittingRef.current || textRef.current === savedTextRef.current)
      return;
    const nextText = textRef.current;
    saveQueueRef.current = saveQueueRef.current
      .then(() => saveText(nextText))
      .catch(() => undefined);
    return saveQueueRef.current;
  };

  const debouncer = useDebouncer(flushDraft, {
    wait: 500,
    onUnmount: (instance) => instance.flush(),
  });

  useEffect(() => {
    if (!readOnly) {
      if (textRef.current !== savedTextRef.current) debouncer.maybeExecute();
      return;
    }
    debouncer.cancel();
    setProvisionalTranscript(null);
    if (!savingRequestRef.current) setSaving(false);
  }, [debouncer, readOnly]);

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
    setSaving(nextText !== savedTextRef.current);
    debouncer.maybeExecute();
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
  const composerStatus = formatComposerStatus(
    error ? 'error' : saving ? 'saving' : submitting ? 'sending' : 'saved',
    error,
  );
  const ComposerStatusIcon = composerStatus.Icon;
  const ActiveTurnStatusIcon = activeTurnStatus?.Icon;
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
    : offline || offlineFromService
      ? 'Connect to send; your draft remains saved.'
      : activeTurnStatus?.isWorking
        ? 'A response is already being prepared.'
        : hasProcessingAttachment
          ? 'Wait for selected files to finish processing.'
          : hasUnavailableAttachment
            ? 'Remove or replace unreadable files before sending.'
            : !hasPayload
              ? 'Enter a message or attach a readable file.'
              : null;
  const sendDisabled = submitting || Boolean(sendingDisabledReason);

  const submit = async () => {
    if (readOnlyRef.current || submittingRef.current || sendDisabled) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setOfflineFromService(false);
    debouncer.cancel();
    const submittedText = textRef.current;
    const submittedRevision = composerRevisionRef.current;
    const submittedAttachmentIds = readyAttachments.map(
      (attachment) => attachment.itemId,
    );
    try {
      await saveQueueRef.current;
      if (submittedText !== savedTextRef.current) {
        const saved = await saveDraftRef.current(
          submittedText,
          expectedDraftRevisionRef.current,
        );
        expectedDraftRevisionRef.current = saved.draftRevision;
        savedTextRef.current = submittedText;
      }
      const result = await sendRef.current({
        text: submittedText,
        attachmentIds: submittedAttachmentIds,
        expectedDraftRevision: expectedDraftRevisionRef.current,
        composerRevision: submittedRevision,
      });
      if (result.draftRevision === null) {
        if (mountedRef.current)
          setError(
            'Message accepted; draft status is still syncing, so this text stays here for safety.',
          );
        return;
      }
      expectedDraftRevisionRef.current = result.draftRevision;
      savedTextRef.current = '';
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
          setSaving(false);
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
      if (mountedRef.current) {
        setSubmitting(false);
        if (textRef.current !== savedTextRef.current) debouncer.maybeExecute();
      } else if (textRef.current !== savedTextRef.current) {
        const remainingText = textRef.current;
        saveQueueRef.current = saveQueueRef.current
          .then(() => saveText(remainingText))
          .catch(() => undefined);
      }
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
    if (readOnlyRef.current || !failedTurnId || submittingRef.current) return;
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
      className="flex w-full flex-col gap-2 border-t bg-background p-4"
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
                size="sm"
              >
                <AttachmentMedia>
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
                  <AttachmentTitle>{attachment.title}</AttachmentTitle>
                  <AttachmentDescription className="flex flex-wrap items-center gap-1 text-base">
                    <StatusIcon aria-hidden="true" className="size-4" />
                    <span>{status.label}</span>
                    <span aria-hidden="true">/</span>
                    <span>
                      {formatStudyContextProvenance(attachment.provenance)}
                    </span>
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
      <InputGroup className="h-auto w-full flex-col items-stretch gap-2 rounded-xl p-2">
        <InputGroupTextarea
          ref={textareaRef}
          id="study-message-input"
          aria-label="Message"
          aria-describedby={
            sendingDisabledReason
              ? 'study-composer-status study-send-reason'
              : 'study-composer-status'
          }
          className="min-h-20 max-h-56 w-full resize-y text-base"
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
          onBlur={() => {
            debouncer.flush();
            if (error) void flushDraft();
          }}
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
                disabled: submitting || Boolean(activeTurnStatus?.isWorking),
              })
            ) : (
              <TooltipWrapper
                content={
                  readOnly
                    ? 'Reconnect online to use dictation.'
                    : 'Speech input is unavailable in this build.'
                }
              >
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  aria-label="Dictation unavailable"
                  disabled
                >
                  <MicIcon aria-hidden="true" />
                </InputGroupButton>
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
                      readOnly || submitting || offline || offlineFromService
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
      <p
        id="study-composer-status"
        role="status"
        aria-live="polite"
        className={cn(
          'flex items-center gap-2 text-base',
          error ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        <ComposerStatusIcon
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0',
            composerStatus.isWorking && 'motion-safe:animate-spin',
          )}
        />
        <span>{composerStatus.label}</span>
      </p>
      {activeTurnStatus?.isWorking && (
        <p className="sr-only" aria-live="polite">
          {ActiveTurnStatusIcon && (
            <ActiveTurnStatusIcon
              aria-hidden="true"
              className="motion-safe:animate-spin"
            />
          )}
          {activeTurnStatus.label}
        </p>
      )}
    </form>
  );
};
