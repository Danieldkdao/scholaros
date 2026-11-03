import {
  Ban,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Clock3,
  FileQuestion,
  Loader2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { IngestionStatus } from '@scholaros/services/learning/context-contracts';

export type IngestionStatusPresentation = {
  label: string;
  icon: LucideIcon;
};

export const formatIngestionStatus = (
  status: IngestionStatus,
): IngestionStatusPresentation => {
  switch (status) {
    case 'queued':
      return { label: 'Queued', icon: Clock3 };
    case 'processing':
      return { label: 'Processing', icon: Loader2 };
    case 'complete':
      return { label: 'Ready', icon: CheckCircle2 };
    case 'partial':
      return { label: 'Partially ready', icon: CircleAlert };
    case 'unreadable':
      return { label: 'Unreadable', icon: FileQuestion };
    case 'unsupported':
      return { label: 'Unsupported', icon: Ban };
    case 'failed':
      return { label: 'Failed', icon: CircleX };
    case 'cancelled':
      return { label: 'Cancelled', icon: CircleX };
  }
};
