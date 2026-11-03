import {
  Bell,
  BellOff,
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
} from 'lucide-react';
import type {
  NotificationCategory,
  NotificationStatus,
} from '@scholaros/services/learning/notification-contracts';
import type { NotificationPermission } from '../services/notification-policy';

export const formatNotificationCategory = (category: NotificationCategory) => {
  switch (category) {
    case 'connection-attention':
      return {
        label: 'Connection needs attention',
        description: 'A connected account needs you to review its access.',
      };
    case 'sync-completed':
      return {
        label: 'Sync completed',
        description: 'A requested course sync finished.',
      };
    case 'sync-failed':
      return {
        label: 'Sync failed',
        description: 'A course sync could not finish.',
      };
    case 'context-completed':
      return {
        label: 'Context ready',
        description: 'A selected learning item is ready to review.',
      };
    case 'context-failed':
      return {
        label: 'Context could not be prepared',
        description: 'A selected learning item needs attention.',
      };
    case 'tutor-ready':
      return {
        label: 'Study response ready',
        description: 'A study response is ready while ScholarOS is away.',
      };
    case 'activity-ready':
      return {
        label: 'Study activity ready',
        description: 'A study activity is ready to continue.',
      };
    case 'timer-expired':
      return {
        label: 'Study timer ended',
        description: 'A study session timer reached its deadline.',
      };
    case 'deadline-reminder':
      return {
        label: 'Upcoming deadline',
        description: 'An optional reminder for a supported course deadline.',
      };
  }
};

export const formatNotificationStatus = (status: NotificationStatus) => {
  switch (status) {
    case 'queued':
      return { label: 'Waiting to deliver', Icon: CalendarClock };
    case 'claimed':
      return { label: 'Delivering', Icon: LoaderCircle };
    case 'delivered':
      return { label: 'Delivered', Icon: CircleCheck };
    case 'suppressed':
      return { label: 'Suppressed', Icon: BellOff };
    case 'failed':
      return { label: 'Not delivered', Icon: CircleAlert };
    case 'cancelled':
      return { label: 'Cancelled', Icon: CircleX };
  }
};

export const formatNotificationPermission = (
  permission: NotificationPermission,
) => {
  switch (permission) {
    case 'granted':
      return { label: 'Allowed', Icon: Bell };
    case 'denied':
      return { label: 'Blocked in system settings', Icon: BellOff };
    case 'unsupported':
      return { label: 'Unavailable on this device', Icon: CircleAlert };
    case 'unknown':
      return { label: 'Permission not confirmed', Icon: CircleAlert };
  }
};

export const formatNotificationCopy = (category: NotificationCategory) => {
  switch (category) {
    case 'connection-attention':
      return {
        title: 'Connection needs attention',
        body: 'ScholarOS needs you to review a connected account.',
      };
    case 'sync-completed':
      return {
        title: 'Sync complete',
        body: 'Your academic information is ready to review.',
      };
    case 'sync-failed':
      return {
        title: 'Sync could not finish',
        body: 'A course sync needs your attention.',
      };
    case 'context-completed':
      return {
        title: 'Context ready',
        body: 'A selected learning item is ready to review.',
      };
    case 'context-failed':
      return {
        title: 'Context needs attention',
        body: 'ScholarOS could not prepare a selected learning item.',
      };
    case 'tutor-ready':
      return {
        title: 'Study response ready',
        body: 'Your study session has an update.',
      };
    case 'activity-ready':
      return {
        title: 'Study activity ready',
        body: 'A study activity is ready to continue.',
      };
    case 'timer-expired':
      return {
        title: 'Study time ended',
        body: 'Your session timer has ended.',
      };
    case 'deadline-reminder':
      return {
        title: 'Upcoming deadline',
        body: 'Review an upcoming course deadline.',
      };
  }
};
