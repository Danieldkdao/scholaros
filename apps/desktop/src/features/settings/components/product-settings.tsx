import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { CircleAlert } from 'lucide-react';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldTitle,
} from '@scholaros/ui/components/field';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { Switch } from '@scholaros/ui/components/switch';
import { cn } from '@scholaros/ui/lib/utils';
import { ThemeSwitcher } from '../../dashboard/theme-switcher';
import { AgentSettings } from '../../dashboard/agent-settings';
import { defaultConnectionSearch } from '../../dashboard/lib/connection-filters';
import {
  getSettingsSaveState,
  queueSettingsGroupSave,
  reconcileSettingsSaveDraft,
  retrySettingsSave,
  settingsSaveGroups,
  settingsUpdateFromSaveDraft,
  subscribeSettingsSaveState,
} from '../../dashboard/settings-save-queue';
import { settingsUpdateSchema } from '../../onboarding/schemas';
import type { SettingsUpdateSchema } from '../../onboarding/schemas';
import type {
  OnboardingState,
  WatchRuntimeState,
} from '../../onboarding/types';
import type { WatchHealthSummary, WatchSettings } from '../../watch/types';
import { WatchSettings as WatchSettingsComponent } from '../../watch/components/watch-settings';
import { settingsSections } from '../../../db/shared';
import type { SettingsSection } from '../../../db/shared';
import {
  formatSettingsSaveGroup,
  formatSettingsSaveStatus,
  formatSettingsSection,
} from '../lib/formatters';
import type { SettingsSaveStatus } from '../lib/formatters';
import { DeviceSettings } from './device-settings';
import type { DeviceReplacementActions } from './device-settings';
import { LocalDataSettings } from './local-data-settings';

type SettingsLeafSections = Partial<
  Record<'grades' | 'personal-context' | 'notifications', ReactNode>
>;

type ProductSettingsProps = {
  accountId: string;
  state: OnboardingState;
  section?: SettingsSection | 'watch';
  watchSettings: WatchSettings | null;
  watchRuntime: WatchRuntimeState | null;
  watchHealth?: WatchHealthSummary | null;
  watchError?: string | null;
  leafSettings?: SettingsLeafSections;
  replacementActions?: DeviceReplacementActions | null;
  onSettingsSave: (
    changes: SettingsUpdateSchema,
  ) => Promise<OnboardingState | void>;
  onWatchSave: (settings: WatchSettings) => Promise<WatchSettings>;
  onStateChange: (state: OnboardingState) => void;
  onDeleteLocalData?: () => Promise<void>;
  onLocalDataDeleted?: () => void;
};

const sectionTitle = (section: SettingsSection) =>
  formatSettingsSection(section).label;

const MissingLeaf = ({ section }: { section: SettingsSection }) => (
  <Card>
    <CardHeader>
      <CardTitle>{sectionTitle(section)}</CardTitle>
      <CardDescription>
        This section is unavailable in the current build; no settings were
        changed.
      </CardDescription>
    </CardHeader>
  </Card>
);

const SettingsSwitch = ({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <Field orientation="horizontal" className="items-start justify-between">
    <FieldContent>
      <FieldTitle>
        <label htmlFor={id}>{label}</label>
      </FieldTitle>
      <FieldDescription>{description}</FieldDescription>
    </FieldContent>
    <Switch
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(value) => onChange(value === true)}
    />
  </Field>
);

const SettingsSaveSidebar = ({ accountId }: { accountId: string }) => {
  const subscribe = useCallback(
    (listener: () => void) => subscribeSettingsSaveState(accountId, listener),
    [accountId],
  );
  const getSnapshot = useCallback(
    () => getSettingsSaveState(accountId),
    [accountId],
  );
  const saveState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const failedGroups = settingsSaveGroups.filter(
    (group) => saveState.groups[group]?.error,
  );
  const status: SettingsSaveStatus =
    saveState.pending > 0
      ? 'saving'
      : failedGroups.length > 0
        ? 'error'
        : 'saved';
  const { label, Icon } = formatSettingsSaveStatus(status);

  return (
    <aside
      aria-label="Settings save status"
      aria-busy={saveState.pending > 0}
      aria-live="polite"
      className="sticky top-0"
      role="status"
    >
      <Card className="text-base">
        <CardContent className="gap-3 p-4">
          <span className="flex items-center gap-2 text-muted-foreground">
            <Icon
              className={cn(
                'size-5 shrink-0',
                status === 'saving' && 'motion-safe:animate-spin',
              )}
            />
            {label}
          </span>
          {failedGroups.map((group) => {
            const groupState = saveState.groups[group]!;
            return (
              <div key={group} className="flex flex-col gap-2">
                <p className="flex items-center gap-2 font-medium">
                  <CircleAlert className="size-4 shrink-0 text-destructive" />
                  {formatSettingsSaveGroup(group)}
                </p>
                <p className="text-destructive">{groupState.error}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Retry ${formatSettingsSaveGroup(group).toLowerCase()}`}
                  disabled={groupState.pending > 0}
                  onClick={() =>
                    void retrySettingsSave(accountId, group).catch(
                      () => undefined,
                    )
                  }
                >
                  <LoadingSwap isLoading={groupState.pending > 0}>
                    Retry
                  </LoadingSwap>
                </Button>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </aside>
  );
};

const BackgroundSettings = ({
  accountId,
  state,
  onSettingsSave,
  onStateChange,
}: Pick<
  ProductSettingsProps,
  'accountId' | 'state' | 'onSettingsSave' | 'onStateChange'
>) => {
  const canEnable = state.settings.consent && state.workspace?.ready === true;
  useEffect(() => {
    reconcileSettingsSaveDraft(accountId, {
      launchAtLogin: state.settings.launchAtLogin,
      backgroundSync: state.settings.backgroundSync,
    });
  }, [accountId, state.settings.backgroundSync, state.settings.launchAtLogin]);
  const save = (changes: SettingsUpdateSchema) => {
    const parsed = settingsUpdateSchema.safeParse(changes);
    if (!parsed.success) return;
    void queueSettingsGroupSave(
      accountId,
      'background',
      parsed.data,
      async (draft) => {
        const updatedState = await onSettingsSave(
          settingsUpdateFromSaveDraft(draft),
        );
        if (updatedState) onStateChange(updatedState);
      },
    ).catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Background activity</CardTitle>
          <CardDescription>
            Both options are off by default and require this computer’s approved
            study browser.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingsSwitch
            id="settings-launch-at-login"
            label="Launch at login"
            description="Open ScholarOS when you sign in to this computer."
            checked={state.settings.launchAtLogin}
            disabled={!canEnable && !state.settings.launchAtLogin}
            onChange={(launchAtLogin) => save({ launchAtLogin })}
          />
          <SettingsSwitch
            id="settings-background-sync"
            label="Background sync"
            description="Refresh authorized course information while ScholarOS is closed."
            checked={state.settings.backgroundSync}
            disabled={!canEnable && !state.settings.backgroundSync}
            onChange={(backgroundSync) => save({ backgroundSync })}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export const ProductSettings = ({
  accountId,
  state,
  section = 'account',
  watchSettings,
  watchRuntime,
  watchHealth = null,
  watchError = null,
  leafSettings = {},
  replacementActions = null,
  onSettingsSave,
  onWatchSave,
  onStateChange,
  onDeleteLocalData,
  onLocalDataDeleted,
}: ProductSettingsProps) => {
  const activeSection = section === 'watch' ? 'background' : section;
  const focusWatch = section === 'watch';

  useEffect(() => {
    const target = document.getElementById(`settings-section-${activeSection}`);
    if (focusWatch) {
      const watchSection = document.getElementById('watch-course-pages');
      watchSection?.scrollIntoView({ block: 'start' });
      watchSection?.focus();
      return;
    }
    target?.focus();
  }, [activeSection, focusWatch]);

  const saveAgentSettings = async (changes: SettingsUpdateSchema) => {
    const updatedState = await onSettingsSave(changes);
    if (updatedState) onStateChange(updatedState);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)_16rem]">
      <nav aria-label="Settings sections" className="flex flex-col gap-1">
        {settingsSections.map((settingsSection) => {
          const { label, Icon } = formatSettingsSection(settingsSection);
          return (
            <Link
              key={settingsSection}
              to="/dashboard/settings"
              search={{ section: settingsSection }}
              data-settings-section={settingsSection}
              aria-current={
                activeSection === settingsSection ? 'page' : undefined
              }
              className="flex items-center gap-3 rounded-md px-3 py-2 text-base text-muted-foreground hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:text-foreground"
            >
              <Icon className="size-5 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>
      <section
        id={`settings-section-${activeSection}`}
        aria-labelledby="settings-section-title"
        tabIndex={-1}
        className="flex min-w-0 flex-col gap-5 outline-none"
      >
        <h2 id="settings-section-title" className="text-xl font-semibold">
          {sectionTitle(activeSection)}
        </h2>
        {activeSection === 'account' && (
          <Card>
            <CardHeader>
              <CardTitle>ScholarOS account</CardTitle>
              <CardDescription>
                Your account is signed in. Device browser profiles and academic
                records remain local to each computer.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        {activeSection === 'device' && (
          <DeviceSettings
            state={state}
            onStateChange={onStateChange}
            replacementActions={replacementActions}
          />
        )}
        {activeSection === 'connections' && (
          <Card>
            <CardHeader>
              <CardTitle>Connected services</CardTitle>
              <CardDescription>
                {state.connections.length
                  ? `${state.connections.length} saved connection${state.connections.length === 1 ? '' : 's'} are available on this computer.`
                  : 'No academic services are connected on this computer yet.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                to="/dashboard/connections"
                search={defaultConnectionSearch}
                className="text-base text-primary underline underline-offset-4"
              >
                Manage connections and access
              </Link>
            </CardContent>
          </Card>
        )}
        {activeSection === 'personal-context' &&
          (leafSettings['personal-context'] ?? (
            <MissingLeaf section="personal-context" />
          ))}
        {activeSection === 'ai-navigation' && (
          <AgentSettings
            accountId={accountId}
            decisionTimeSeconds={state.settings.decisionTimeSeconds}
            blockedWords={state.settings.blockedWords}
            onSave={saveAgentSettings}
            showSaveStatus={false}
          />
        )}
        {activeSection === 'background' && (
          <>
            <BackgroundSettings
              accountId={accountId}
              state={state}
              onSettingsSave={onSettingsSave}
              onStateChange={onStateChange}
            />
            {watchSettings ? (
              <WatchSettingsComponent
                accountId={accountId}
                settings={watchSettings}
                connections={state.connections}
                status={watchRuntime?.status ?? state.watch?.status ?? 'off'}
                health={watchHealth}
                focusOnMount={focusWatch}
                onSave={onWatchSave}
              />
            ) : watchError ? (
              <p role="alert" className="text-base text-destructive">
                {watchError}
              </p>
            ) : (
              <p role="status" className="text-base text-muted-foreground">
                Loading watch settings.
              </p>
            )}
          </>
        )}
        {activeSection === 'grades' &&
          (leafSettings.grades ?? <MissingLeaf section="grades" />)}
        {activeSection === 'notifications' &&
          (leafSettings.notifications ?? (
            <MissingLeaf section="notifications" />
          ))}
        {activeSection === 'appearance' && (
          <Card>
            <CardHeader>
              <CardTitle>Appearance and accessibility</CardTitle>
              <CardDescription>
                Choose a theme; motion follows your system’s reduced-motion
                preference. Text-size and contrast controls are unavailable in
                this build.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between gap-4">
              <span className="text-base">Theme</span>
              <ThemeSwitcher />
            </CardContent>
          </Card>
        )}
        {activeSection === 'local-data' && (
          <LocalDataSettings
            onDeleteLocalData={onDeleteLocalData}
            onDeleted={onLocalDataDeleted}
          />
        )}
      </section>
      <SettingsSaveSidebar accountId={accountId} />
    </div>
  );
};
