import {
  BookOpen,
  CalendarDays,
  GraduationCap,
  House,
  Layers,
  ListChecks,
  Monitor,
  Moon,
  Plug,
  Settings,
  Sun,
} from 'lucide-react';
import type { DashboardPage } from './navigation';
import type { ThemePreference } from './themes';
import type {
  ConnectionKindFilter,
  ConnectionStatusFilter,
} from './connection-filters';
import {
  formatConnectionStatus,
  formatResourceKind,
} from '../../onboarding/lib/formatters';

export const formatDashboardPage = (page: DashboardPage) => {
  switch (page) {
    case 'today':
      return { title: 'Today', Icon: House };
    case 'courses':
      return { title: 'Courses', Icon: BookOpen };
    case 'study':
      return { title: 'Study', Icon: GraduationCap };
    case 'planner':
      return { title: 'Planner', Icon: CalendarDays };
    case 'connections':
      return { title: 'Connections', Icon: Plug };
    case 'settings':
      return { title: 'Settings', Icon: Settings };
  }
};

export const formatTheme = (theme: ThemePreference) => {
  switch (theme) {
    case 'light':
      return { label: 'Light', Icon: Sun };
    case 'dark':
      return { label: 'Dark', Icon: Moon };
    case 'system':
      return { label: 'System', Icon: Monitor };
  }
};

// The filters widen the card statuses and kinds with an 'all' bucket, so reuse
// their formatting and keep only the catch-all wording here.
export const formatConnectionStatusFilter = (filter: ConnectionStatusFilter) =>
  filter === 'all'
    ? { label: 'All statuses', Icon: ListChecks }
    : formatConnectionStatus(filter);

export const formatConnectionKindFilter = (filter: ConnectionKindFilter) =>
  filter === 'all'
    ? { label: 'All kinds', Icon: Layers }
    : formatResourceKind(filter);
