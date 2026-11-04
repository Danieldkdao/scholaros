import {
  CircleAlert,
  CircleOff,
  Clock3,
  Eye,
  LoaderCircle,
  LogIn,
  Network,
  Pause,
  RefreshCw,
  ShieldAlert,
  WifiOff,
} from 'lucide-react';
import type { WatchTargetFailureCategory } from '../../../db/shared';
import type { WatchHealthSummary, WatchRuntimeStatus } from '../types';

export const formatWatchRuntimeStatus = (status: WatchRuntimeStatus) => {
  switch (status) {
    case 'off':
      return { label: 'Off', Icon: CircleOff };
    case 'starting':
      return { label: 'Starting', Icon: LoaderCircle };
    case 'watching':
      return { label: 'Watching', Icon: Eye };
    case 'checking':
      return { label: 'Checking pages', Icon: RefreshCw };
    case 'updating':
      return { label: 'Updating course data', Icon: LoaderCircle };
    case 'paused':
      return { label: 'Paused', Icon: Pause };
    case 'needs-sign-in':
      return { label: 'Sign in required', Icon: LogIn };
    case 'blocked':
      return { label: 'Needs attention', Icon: ShieldAlert };
  }
};

export const formatWatchUrlLabel = (value: string) => {
  try {
    const url = new URL(value);
    const path = `${url.pathname === '/' ? '' : url.pathname}${url.hash}`;
    return `${url.hostname}${path || '/'}`;
  } catch {
    return value;
  }
};

export const formatWatchFailureCategory = (
  category: WatchTargetFailureCategory,
) => {
  switch (category) {
    case 'needs-sign-in':
      return { label: 'Sign in required', Icon: LogIn };
    case 'rate-limited':
      return { label: 'Waiting for the school site', Icon: Clock3 };
    case 'network':
      return { label: 'Connection problem', Icon: WifiOff };
    case 'navigation':
      return { label: 'Page could not be checked', Icon: Network };
    case 'scope-changed':
      return { label: 'Page access changed', Icon: ShieldAlert };
    case 'unknown':
      return { label: 'Needs attention', Icon: CircleAlert };
  }
};

export const formatWatchPendingAge = (
  pendingSince: string | null,
  now = Date.now(),
) => {
  if (!pendingSince) return null;
  const startedAt = Date.parse(pendingSince);
  if (!Number.isFinite(startedAt)) return null;
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
};

export const formatWatchTimestamp = (timestamp: string | null) => {
  if (!timestamp) return 'Not checked yet';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Not checked yet';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

export const summarizeWatchHealth = (
  health: WatchHealthSummary,
  now?: number,
) => ({
  pending: `${health.pendingRevisionCount} pending ${health.pendingRevisionCount === 1 ? 'change' : 'changes'}`,
  pendingAge: formatWatchPendingAge(health.oldestPendingSince, now),
  estimatedAge: health.oldestPendingSinceEstimated,
  lastSuccessfulCheckAt: formatWatchTimestamp(health.lastSuccessfulCheckAt),
  nextRetryAt: health.nextRetryAt
    ? formatWatchTimestamp(health.nextRetryAt)
    : null,
});
