import {
  Ban,
  BookOpen,
  Compass,
  ListChecks,
  CircleCheck,
  CircleAlert,
  CircleDashed,
  CirclePause,
  CircleStop,
  Clock,
  Globe,
  KeyRound,
  ShieldCheck,
  MessageSquare,
  SlidersHorizontal,
  Sparkles,
  Flag,
  Layers,
  Monitor,
  RefreshCw,
  CalendarDays,
  Megaphone,
  Link as LinkIcon,
} from 'lucide-react';
import type {
  AgentActivity,
  OnboardingStep,
  ConnectionStatus,
  PreviewPrompt,
  BrowserId,
  BrowserWorkspaceStatus,
  DiscoveryStatus,
  AcademicContextEntryRole,
  BackgroundSyncStatus,
  PreviewCard,
  PreviewState,
} from '../types';
import type { ConnectRunResult } from '../services/connect-run';

export const formatAgentActivity = (event: AgentActivity) => {
  switch (event.type) {
    case 'waiting':
      return {
        label: 'Giving your school a moment before continuing',
        Icon: Clock,
      };
    case 'opening':
      return {
        label: event.detail
          ? `Opening ${event.detail}`
          : 'Opening your academic workspace',
        Icon: Globe,
      };
    case 'navigating':
      return {
        label: event.detail
          ? `Navigating to ${event.detail}`
          : 'Finding the next page',
        Icon: Compass,
      };
    case 'reading':
      return {
        label: event.detail
          ? `Reading ${event.detail}`
          : 'Reading course information',
        Icon: BookOpen,
      };
    case 'checking':
      return {
        label:
          event.detail ?? 'Checking the results against your course materials',
        Icon: ListChecks,
      };
    case 'complete':
      return {
        label: `Checked ${event.detail ?? 'your'} results against your course pages`,
        Icon: CircleCheck,
      };
    case 'blocked':
      return { label: 'Your agent needs a little help', Icon: CircleAlert };
    case 'cancelled':
      return { label: 'Preview stopped', Icon: CircleStop };
  }
};

export const formatOnboardingStep = (step: OnboardingStep) => {
  switch (step) {
    case 'welcome':
      return {
        label: 'Your workspace',
        title: 'Your classes, connected.',
        description:
          'A private study workspace that learns your classes so it can help you learn.',
        Icon: ShieldCheck,
      };
    case 'browser':
      return {
        label: 'Study browser',
        title: 'Make room for learning.',
        description:
          'Choose a browser for your separate ScholarOS study workspace.',
        Icon: Globe,
      };
    case 'resources':
      return {
        label: 'Your resources',
        title: 'Bring your classes together.',
        description:
          'Find your school or a service, sign in, then connect the site you want to share.',
        Icon: BookOpen,
      };
    case 'context':
      return {
        label: 'A little context',
        title: 'You know your classes best.',
        description:
          'Add any optional details that would help ScholarOS understand your classes.',
        Icon: MessageSquare,
      };
    case 'preferences':
      return {
        label: 'Your preferences',
        title: 'On your terms.',
        description:
          'Choose when ScholarOS can help; you can change these preferences later.',
        Icon: SlidersHorizontal,
      };
    case 'preview':
      return {
        label: 'Meet your agent',
        title: 'See your agent in action.',
        description:
          'Try one quick task with your connected resources, or skip for now.',
        Icon: Sparkles,
      };
    case 'review':
      return {
        label: 'Ready to learn',
        title: 'A good place to start.',
        description:
          'Your study workspace is ready; everything here stays under your control.',
        Icon: Flag,
      };
  }
};

export const formatConnectionStatus = (status: ConnectionStatus) => {
  switch (status) {
    case 'verified':
      return { label: 'Access verified', Icon: ShieldCheck };
    case 'confirmed':
      return { label: 'Confirmed by you', Icon: CircleCheck };
    case 'needs-sign-in':
      return { label: 'Needs confirmation', Icon: CircleAlert };
  }
};

// One entry per site the agent tried, so the run panel can show what happened
// without re-deciding the wording for each state.
export const formatConnectRunResult = (status: ConnectRunResult['status']) => {
  switch (status) {
    case 'connected':
      return {
        label: 'Connected',
        Icon: CircleCheck,
        className: 'text-primary',
      };
    case 'needs-sign-in':
      return {
        label: 'Needs confirmation',
        Icon: CircleAlert,
        className: 'text-muted-foreground',
      };
    case 'blocked':
      return { label: 'Blocked', Icon: Ban, className: 'text-destructive' };
  }
};

export const formatPreviewPrompt = (prompt: PreviewPrompt) => {
  switch (prompt) {
    case 'courses':
      return { label: 'Find my courses', Icon: BookOpen };
    case 'assignments':
      return { label: 'Show upcoming assignments', Icon: CalendarDays };
    case 'announcements':
      return { label: 'Find recent announcements', Icon: Megaphone };
  }
};

export const formatBrowser = (browser: BrowserId) => {
  switch (browser) {
    case 'chrome':
      return { label: 'Google Chrome', Icon: Globe };
    case 'edge':
      return { label: 'Microsoft Edge', Icon: Layers };
    case 'brave':
      return { label: 'Brave', Icon: ShieldCheck };
  }
};

export const formatCard = (kind: PreviewCard['kind']) => {
  switch (kind) {
    case 'course':
      return { label: 'Course', Icon: BookOpen };
    case 'assignment':
      return { label: 'Assignment', Icon: CalendarDays };
    case 'announcement':
      return { label: 'Announcement', Icon: Megaphone };
  }
};

export const formatPreviewStatus = (status: PreviewState['status']) => {
  switch (status) {
    case 'idle':
      return { label: 'Choose a task to begin', Icon: Sparkles };
    case 'running':
      return { label: 'Your agent is exploring', Icon: Compass };
    case 'complete':
      return {
        label: 'Results checked against your course pages',
        Icon: CircleCheck,
      };
    case 'blocked':
      return { label: 'Try again or skip for now', Icon: CircleAlert };
    case 'cancelled':
      return { label: 'Preview stopped', Icon: CircleStop };
  }
};

export const formatBackgroundSyncStatus = (status: BackgroundSyncStatus) => {
  switch (status) {
    case 'off':
      return { label: 'Background sync off', Icon: CircleStop };
    case 'waiting':
      return { label: 'Waiting for the next sync', Icon: Clock };
    case 'syncing':
      return { label: 'Syncing course information', Icon: RefreshCw };
    case 'paused':
      return { label: 'Background sync paused', Icon: CirclePause };
    case 'blocked':
      return { label: 'Background sync needs attention', Icon: CircleAlert };
  }
};

export const formatDiscoveryStatus = (status: DiscoveryStatus) => {
  switch (status) {
    case 'pending':
      return {
        label: 'Not discovered yet',
        description:
          'Run discovery to map the course pages available in your connected resources.',
        Icon: Compass,
      };
    case 'running':
      return {
        label: 'Checking your resources',
        description: 'ScholarOS is reading your connected pages.',
        Icon: RefreshCw,
      };
    case 'complete':
      return {
        label: 'Course map up to date',
        description:
          'These entries were observed on your connected pages; roles come from the page text around each link.',
        Icon: CircleCheck,
      };
    case 'partial':
      return {
        label: 'Course map partly checked',
        description:
          'Some resources were read; others could not, so the map may be missing courses.',
        Icon: CircleAlert,
      };
    case 'empty':
      return {
        label: 'No courses listed',
        description:
          'Your course pages were readable and showed no courses at the last check.',
        Icon: CircleDashed,
      };
    case 'inconclusive':
      return {
        label: 'Discovery not conclusive',
        description:
          'Pages loaded, but ScholarOS could not identify a course list on them.',
        Icon: CircleDashed,
      };
    case 'blocked':
      return {
        label: 'Resources could not be read',
        description:
          'None of your connected resources could be opened safely, so the map is unchanged.',
        Icon: Ban,
      };
    case 'needs-sign-in':
      return {
        label: 'Sign-in needed',
        description:
          'Open the study browser, sign in, and refresh the course map.',
        Icon: KeyRound,
      };
    case 'cancelled':
      return {
        label: 'Refresh stopped',
        description:
          'The last course map is unchanged because this refresh was stopped.',
        Icon: CircleStop,
      };
    case 'failed':
      return {
        label: 'Discovery needs attention',
        description:
          'The last discovery attempt could not finish; retry or skip for now.',
        Icon: CircleAlert,
      };
  }
};

export const formatContextRole = (role: AcademicContextEntryRole) => {
  switch (role) {
    case 'course':
      return {
        label: 'Course, inferred',
        description: 'Inferred from a course page address',
        Icon: BookOpen,
      };
    case 'resource':
      return {
        label: 'Page, observed',
        description: 'Observed in your connected resource',
        Icon: LinkIcon,
      };
  }
};

export const formatContextUrl = (value: string) => {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return value;
  }
};

export const formatObservedAt = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

export const formatWorkspaceStatus = (status: BrowserWorkspaceStatus) => {
  switch (status) {
    case 'ready':
      return {
        label: 'Study browser verified',
        description: 'This computer has a separate, verified study workspace.',
        Icon: ShieldCheck,
      };
    case 'browser-missing':
      return {
        label: 'Browser not found',
        description:
          'The browser for this workspace was removed or moved; choose an installed browser again.',
        Icon: CircleAlert,
      };
    case 'profile-missing':
      return {
        label: 'Study profile missing',
        description:
          'The separate study profile was removed; create the workspace again on this computer.',
        Icon: CircleAlert,
      };
    case 'unverified':
      return {
        label: 'Connection not verified',
        description:
          'The study browser was not verified; choose it again to reconnect.',
        Icon: CircleAlert,
      };
  }
};

export const formatLaunchAtLogin = (enabled: boolean) =>
  enabled
    ? { label: 'Launch at login on', Icon: CircleCheck }
    : { label: 'Launch at login off', Icon: CircleStop };

export const formatResourceKind = (
  kind: 'canvas' | 'classroom' | 'resource',
) => {
  switch (kind) {
    case 'canvas':
      return { label: 'Canvas', Icon: BookOpen };
    case 'classroom':
      return { label: 'Google Classroom', Icon: Monitor };
    case 'resource':
      return { label: 'Academic resource', Icon: LinkIcon };
  }
};
