import {
  CircleOff,
  Eye,
  LoaderCircle,
  LogIn,
  Pause,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type { WatchRuntimeStatus } from '../types';

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
