import {
  Bell,
  Brain,
  CircleAlert,
  CircleCheck,
  GraduationCap,
  HardDrive,
  LoaderCircle,
  MonitorSmartphone,
  Palette,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import type { SafeErrorCode, SettingsSection } from '../../../db/shared';
import type { SettingsSaveGroup } from '../../dashboard/settings-save-queue';

export type SettingsSaveStatus = 'saving' | 'saved' | 'error';
export type WorkspaceReplacementErrorCode = Extract<
  SafeErrorCode,
  'provider-failed' | 'revision-conflict' | 'session-changed'
>;

export const formatSettingsSection = (section: SettingsSection) => {
  switch (section) {
    case 'account':
      return { label: 'Account', Icon: Settings2 };
    case 'device':
      return { label: 'Device and browser', Icon: MonitorSmartphone };
    case 'connections':
      return { label: 'Connections and access', Icon: ShieldCheck };
    case 'personal-context':
      return { label: 'Personal context', Icon: Brain };
    case 'ai-navigation':
      return { label: 'AI and navigation', Icon: SlidersHorizontal };
    case 'background':
      return { label: 'Background sync and watch', Icon: RefreshCw };
    case 'grades':
      return { label: 'Grades', Icon: GraduationCap };
    case 'notifications':
      return { label: 'Notifications', Icon: Bell };
    case 'appearance':
      return { label: 'Appearance and accessibility', Icon: Palette };
    case 'local-data':
      return { label: 'Local data', Icon: HardDrive };
  }
};

export const formatSettingsSaveStatus = (status: SettingsSaveStatus) => {
  switch (status) {
    case 'saving':
      return { label: 'Saving settings', Icon: LoaderCircle };
    case 'saved':
      return { label: 'Settings saved', Icon: CircleCheck };
    case 'error':
      return { label: 'Settings need attention', Icon: CircleAlert };
  }
};

export const formatSettingsSaveGroup = (group: SettingsSaveGroup) => {
  switch (group) {
    case 'account':
      return 'Account settings';
    case 'device':
      return 'Device settings';
    case 'connections':
      return 'Connection settings';
    case 'personal-context':
      return 'Personal context';
    case 'navigation':
      return 'AI and navigation settings';
    case 'background':
      return 'Background settings';
    case 'grades':
      return 'Grade settings';
    case 'notifications':
      return 'Notification settings';
    case 'appearance':
      return 'Appearance settings';
    case 'local-data':
      return 'Local data settings';
    case 'watch':
      return 'Watch settings';
  }
};

export const formatWorkspaceReplacementError = (
  code: WorkspaceReplacementErrorCode,
) => {
  switch (code) {
    case 'provider-failed':
      return 'Could not verify that browser; your current workspace is unchanged.';
    case 'revision-conflict':
      return 'The selected browser changed. Refresh Settings before trying again.';
    case 'session-changed':
      return 'Your account changed; sign in again before replacing the browser.';
  }
};
