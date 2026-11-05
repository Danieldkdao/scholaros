import { useEffect, useState } from 'react';
import { Square, X } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scholaros/ui/components/dialog';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import type {
  AcceptedTranscript,
  DraftSelection,
} from '../lib/transcript-state';
import { formatDictationStatus } from '../lib/formatters';
import { useDictation } from '../hooks/use-dictation';

type DictationControlProps = {
  sessionId: string;
  composerRevision: number;
  selection: DraftSelection;
  onProvisional: (text: string | null) => void;
  onFinal: (transcript: AcceptedTranscript) => void;
  onCancel: () => void;
  disabled?: boolean;
};

export const DictationControl = ({
  sessionId,
  composerRevision,
  selection,
  onProvisional,
  onFinal,
  onCancel,
  disabled = false,
}: DictationControlProps) => {
  const [isDisclosureOpen, setDisclosureOpen] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  const [hasAcknowledgedTransmission, setHasAcknowledgedTransmission] =
    useState(false);
  const dictation = useDictation({
    sessionId,
    composerRevision,
    onProvisional,
    onFinal,
    onCancel,
    disabled,
  });
  const presentation = formatDictationStatus(dictation.status);
  const StatusIcon = presentation.Icon;
  const isRecording = dictation.status === 'recording';
  const isRequesting = dictation.status === 'requesting-permission';
  const isStopping = dictation.status === 'stopping';
  const isActive = isRecording || isRequesting || isStopping;
  const buttonLabel = isRecording
    ? 'Stop dictation'
    : isStopping
      ? 'Finishing dictation'
      : isRequesting
        ? 'Requesting microphone permission'
        : 'Start dictation';
  const showLoading = isRequesting || isStopping;
  const unavailableReason = !online
    ? 'Reconnect to transcribe speech.'
    : disabled
      ? 'Dictation is unavailable while the session is busy.'
      : dictation.status === 'denied' || dictation.status === 'unsupported'
        ? presentation.label
        : null;

  const beginDictation = () => {
    setDisclosureOpen(false);
    setHasAcknowledgedTransmission(true);
    void dictation.start(selection);
  };

  const requestDictation = () => {
    if (hasAcknowledgedTransmission) {
      void dictation.start(selection);
      return;
    }
    setDisclosureOpen(true);
  };

  const button = (
    <Button
      aria-label={buttonLabel}
      disabled={Boolean(unavailableReason) || isRequesting || isStopping}
      onClick={isRecording ? () => void dictation.stop() : requestDictation}
      size="icon"
      variant="ghost"
    >
      <LoadingSwap isLoading={showLoading}>
        {isRecording ? (
          <Square aria-hidden="true" />
        ) : (
          <StatusIcon aria-hidden="true" />
        )}
      </LoadingSwap>
    </Button>
  );

  return (
    <div className="flex items-center gap-2">
      {unavailableReason ? (
        <TooltipWrapper content={unavailableReason}>
          <span className="inline-flex" tabIndex={0}>
            {button}
          </span>
        </TooltipWrapper>
      ) : (
        button
      )}
      {dictation.status === 'denied' && (
        <Button
          variant="link"
          size="sm"
          onClick={async () => {
            setSettingsError(null);
            try {
              await window.scholar.openMicrophoneSettings();
            } catch {
              setSettingsError(
                'Could not open settings. Open System Settings → Privacy & Security → Microphone.',
              );
            }
          }}
        >
          Open microphone settings
        </Button>
      )}
      {settingsError && (
        <span role="alert" className="text-base text-destructive">
          {settingsError}
        </span>
      )}
      {isActive && (
        <TooltipWrapper content="Cancel dictation">
          <Button
            aria-label="Cancel dictation"
            onClick={() => void dictation.cancel()}
            size="icon"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </Button>
        </TooltipWrapper>
      )}
      {dictation.status !== 'idle' && (
        <span
          className="text-base text-muted-foreground"
          aria-live="polite"
          role="status"
        >
          {presentation.label}
        </span>
      )}
      <Dialog onOpenChange={setDisclosureOpen} open={isDisclosureOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Dictation sends audio to Meta</DialogTitle>
            <DialogDescription>
              Microphone audio is sent to Meta for transcription; your tutor
              only receives editable text after you press Send.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDisclosureOpen(false)} variant="outline">
              Not now
            </Button>
            <Button onClick={beginDictation}>Start recording</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
