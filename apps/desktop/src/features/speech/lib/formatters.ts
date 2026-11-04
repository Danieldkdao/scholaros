import {
  CircleAlert,
  CircleCheck,
  CloudOff,
  Loader2,
  Mic,
  MicOff,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export const dictationStatuses = [
  'idle',
  'requesting-permission',
  'recording',
  'stopping',
  'final',
  'denied',
  'offline',
  'disconnected',
  'unsupported',
  'empty',
  'failed',
  'cancelled',
] as const;

export type DictationStatus = (typeof dictationStatuses)[number];

export type DictationStatusPresentation = {
  label: string;
  Icon: LucideIcon;
};

export const formatDictationStatus = (
  status: DictationStatus,
): DictationStatusPresentation => {
  switch (status) {
    case 'idle':
      return { label: 'Dictation is ready.', Icon: Mic };
    case 'requesting-permission':
      return { label: 'Requesting microphone permission.', Icon: Loader2 };
    case 'recording':
      return { label: 'Listening; transcript text is provisional.', Icon: Mic };
    case 'stopping':
      return { label: 'Finishing your transcript.', Icon: Loader2 };
    case 'final':
      return { label: 'Transcript ready to edit.', Icon: CircleCheck };
    case 'denied':
      return { label: 'Microphone permission was denied.', Icon: MicOff };
    case 'offline':
      return { label: 'Reconnect to transcribe speech.', Icon: CloudOff };
    case 'disconnected':
      return {
        label: 'Dictation disconnected; your draft is unchanged.',
        Icon: CloudOff,
      };
    case 'unsupported':
      return {
        label: 'A microphone is unavailable on this device.',
        Icon: MicOff,
      };
    case 'empty':
      return {
        label: 'No speech was recognized; your draft is unchanged.',
        Icon: MicOff,
      };
    case 'failed':
      return {
        label: 'Dictation failed; your draft is unchanged.',
        Icon: CircleAlert,
      };
    case 'cancelled':
      return {
        label: 'Dictation cancelled; your draft is unchanged.',
        Icon: MicOff,
      };
    default: {
      const exhaustiveStatus: never = status;
      return { label: exhaustiveStatus, Icon: CircleAlert };
    }
  }
};
