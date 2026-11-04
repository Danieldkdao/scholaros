import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { CircleAlert } from 'lucide-react';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@scholaros/ui/components/field';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { Input } from '@scholaros/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectGroup,
  SelectTrigger,
  SelectValue,
} from '@scholaros/ui/components/select';
import { Switch } from '@scholaros/ui/components/switch';
import {
  notificationCategories,
  notificationSettingsSchema,
} from '@scholaros/services/learning/notification-contracts';
import type { NotificationSettings as NotificationSettingsValue } from '@scholaros/services/learning/notification-contracts';
import { formatNotificationCategory, formatQuietHour } from '../lib/formatters';
import type { NotificationPermission } from '../services/notification-policy';
import {
  getSettingsSaveState,
  queueNotificationSettingsSave,
  reconcileSettingsSaveDraft,
  subscribeSettingsSaveState,
} from '../../dashboard/settings-save-queue';

type NotificationSettingsProps = {
  accountId: string;
  settings: NotificationSettingsValue;
  onSave: (
    settings: NotificationSettingsValue,
  ) => Promise<NotificationSettingsValue>;
  requestPermission: () => Promise<NotificationPermission>;
  permissionState?: NotificationPermission;
};

const getLocalTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const getTimeZoneOptions = () => {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  };
  const localTimeZone = getLocalTimeZone();
  return [
    ...new Set([
      ...(intl.supportedValuesOf?.('timeZone') ?? []),
      'UTC',
      localTimeZone,
    ]),
  ].sort((left, right) => left.localeCompare(right));
};

const timeZoneOptions = getTimeZoneOptions();

const parseQuietHour = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
};

const getPermissionMessage = (permission: NotificationPermission) => {
  switch (permission) {
    case 'granted':
      return 'Enabled in ScholarOS. On macOS, also allow ScholarOS in System Settings → Notifications.';
    case 'denied':
      return 'Allow notifications in system settings, then try enabling them again.';
    case 'unsupported':
      return 'System notifications are unavailable on this device.';
    case 'unknown':
      return 'ScholarOS could not confirm system notification permission.';
  }
};

export const NotificationSettings = ({
  accountId,
  settings: persistedSettings,
  onSave,
  requestPermission,
  permissionState,
}: NotificationSettingsProps) => {
  const initialDraft =
    getSettingsSaveState(accountId).draft.notificationSettings;
  const [settings, setSettings] = useState(
    () => initialDraft ?? persistedSettings,
  );
  const [permission, setPermission] = useState<NotificationPermission | null>(
    permissionState ?? null,
  );
  const [checkingPermission, setCheckingPermission] = useState(false);
  const settingsRef = useRef(settings);
  const accountIdRef = useRef(accountId);
  const previousAccountIdRef = useRef(accountId);
  const revisionRef = useRef(persistedSettings.revision);
  const changeRevisionRef = useRef(0);
  const mountedRef = useRef(false);
  const subscribe = useCallback(
    (listener: () => void) => subscribeSettingsSaveState(accountId, listener),
    [accountId],
  );
  const getSnapshot = useCallback(
    () => getSettingsSaveState(accountId),
    [accountId],
  );
  const saveState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const notificationSaveState = saveState.groups.notifications;

  accountIdRef.current = accountId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (previousAccountIdRef.current === accountId) return;
    previousAccountIdRef.current = accountId;
    settingsRef.current = persistedSettings;
    revisionRef.current = persistedSettings.revision;
    setSettings(persistedSettings);
    setPermission(permissionState ?? null);
    setCheckingPermission(false);
    changeRevisionRef.current += 1;
  }, [accountId, permissionState, persistedSettings]);

  useEffect(() => {
    reconcileSettingsSaveDraft(accountId, {
      notificationSettings: persistedSettings,
    });
  }, [accountId, persistedSettings, saveState.groups.notifications]);

  useEffect(() => {
    const draft = notificationSaveState?.draft.notificationSettings;
    if (draft) {
      settingsRef.current = draft;
      setSettings(draft);
    } else if (
      (notificationSaveState?.pending ?? 0) === 0 &&
      !notificationSaveState?.error
    ) {
      settingsRef.current = persistedSettings;
      revisionRef.current = persistedSettings.revision;
      setSettings(persistedSettings);
    }
  }, [accountId, notificationSaveState, persistedSettings]);

  useEffect(() => {
    if (permissionState !== undefined) setPermission(permissionState);
  }, [permissionState]);

  const save = (nextSettings: NotificationSettingsValue) => {
    const requestAccountId = accountId;
    const changeRevision = ++changeRevisionRef.current;
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    void queueNotificationSettingsSave(
      requestAccountId,
      nextSettings,
      async (draft) => {
        if (accountIdRef.current !== requestAccountId)
          throw new Error('Your session changed; sign in again.');
        const parsedSettings = notificationSettingsSchema.safeParse(
          draft.notificationSettings,
        );
        if (!parsedSettings.success)
          throw new Error('Notification settings are invalid.');
        const savedSettings = await onSave({
          ...parsedSettings.data,
          revision: revisionRef.current,
        });
        if (accountIdRef.current !== requestAccountId)
          throw new Error('Your session changed; sign in again.');
        revisionRef.current = savedSettings.revision;
        if (changeRevisionRef.current === changeRevision) {
          settingsRef.current = savedSettings;
          if (mountedRef.current) setSettings(savedSettings);
        } else {
          settingsRef.current = {
            ...settingsRef.current,
            revision: savedSettings.revision,
          };
          if (mountedRef.current) setSettings(settingsRef.current);
        }
      },
    ).catch(() => undefined);
  };

  const updateSettings = (
    update: (current: NotificationSettingsValue) => NotificationSettingsValue,
  ) => save(update(settingsRef.current));

  const toggleNotifications = async (enabled: boolean) => {
    if (!enabled) {
      updateSettings((current) => ({ ...current, enabled: false }));
      return;
    }
    if (checkingPermission) return;
    const requestAccountId = accountId;
    setCheckingPermission(true);
    try {
      const permissionResult = await requestPermission();
      if (accountIdRef.current !== requestAccountId) return;
      setPermission(permissionResult);
      if (permissionResult === 'granted')
        updateSettings((current) => ({ ...current, enabled: true }));
    } catch {
      if (accountIdRef.current === requestAccountId) setPermission('unknown');
    } finally {
      if (accountIdRef.current === requestAccountId)
        setCheckingPermission(false);
    }
  };

  const permissionMessage = permission
    ? getPermissionMessage(permission)
    : null;

  return (
    <section
      aria-labelledby="notification-settings-title"
      className="flex flex-col gap-4"
    >
      <Card>
        <CardHeader>
          <CardTitle id="notification-settings-title">Notifications</CardTitle>
          <CardDescription>
            Choose which private, app-authored status alerts ScholarOS may show.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field
            orientation="horizontal"
            className="items-center justify-between"
          >
            <FieldContent>
              <FieldLabel htmlFor="notification-master-switch">
                Enable notifications
              </FieldLabel>
              <FieldDescription id="notification-master-description">
                Notifications are off until you turn them on here.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="notification-master-switch"
              aria-label="Enable notifications"
              aria-describedby="notification-master-description"
              checked={settings.enabled}
              disabled={checkingPermission}
              onCheckedChange={(checked) => {
                void toggleNotifications(checked === true);
              }}
            />
          </Field>
          {permissionMessage && (
            <p
              className="flex items-start gap-2 text-base text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <CircleAlert
                className="mt-1 size-4 shrink-0"
                aria-hidden="true"
              />
              {permissionMessage}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Event types</CardTitle>
          <CardDescription>
            Select the outcomes that may create a desktop alert.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSet>
            <FieldLegend className="sr-only">Event notifications</FieldLegend>
            <FieldGroup className="gap-4">
              {notificationCategories.map((category) => {
                const formattedCategory = formatNotificationCategory(category);
                const inputId = `notification-category-${category}`;
                const descriptionId = `${inputId}-description`;
                return (
                  <Field
                    key={category}
                    orientation="horizontal"
                    className="items-center justify-between"
                  >
                    <FieldContent>
                      <FieldLabel htmlFor={inputId}>
                        {formattedCategory.label}
                      </FieldLabel>
                      <FieldDescription id={descriptionId}>
                        {formattedCategory.description}
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id={inputId}
                      aria-label={formattedCategory.label}
                      aria-describedby={descriptionId}
                      checked={settings.categories[category]}
                      onCheckedChange={(checked) =>
                        updateSettings((current) => ({
                          ...current,
                          categories: {
                            ...current.categories,
                            [category]: checked === true,
                          },
                        }))
                      }
                    />
                  </Field>
                );
              })}
            </FieldGroup>
          </FieldSet>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quiet hours</CardTitle>
          <CardDescription>
            Delay alerts during this local-time window; matching start and end
            times keep them quiet all day.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field
            orientation="horizontal"
            className="items-center justify-between"
          >
            <FieldContent>
              <FieldLabel htmlFor="notification-quiet-hours-switch">
                Enable quiet hours
              </FieldLabel>
              <FieldDescription id="notification-quiet-hours-description">
                Use an IANA time zone so daylight-saving changes are respected.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="notification-quiet-hours-switch"
              aria-label="Enable quiet hours"
              aria-describedby="notification-quiet-hours-description"
              checked={settings.quietHours.enabled}
              onCheckedChange={(checked) =>
                updateSettings((current) => ({
                  ...current,
                  quietHours: {
                    ...current.quietHours,
                    enabled: checked === true,
                    ...(checked === true && !current.quietHours.enabled
                      ? { timeZone: getLocalTimeZone() }
                      : {}),
                  },
                }))
              }
            />
          </Field>
          <FieldGroup className="gap-4">
            <div className="flex flex-col gap-4 sm:flex-row">
              <Field>
                <FieldLabel htmlFor="notification-quiet-start">
                  Start time
                </FieldLabel>
                <Input
                  id="notification-quiet-start"
                  aria-label="Start quiet hours"
                  className="w-full"
                  type="time"
                  step={60}
                  value={formatQuietHour(settings.quietHours.startMinute)}
                  onChange={(event) => {
                    const startMinute = parseQuietHour(
                      event.currentTarget.value,
                    );
                    if (startMinute === null) return;
                    updateSettings((current) => ({
                      ...current,
                      quietHours: { ...current.quietHours, startMinute },
                    }));
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="notification-quiet-end">
                  End time
                </FieldLabel>
                <Input
                  id="notification-quiet-end"
                  aria-label="End quiet hours"
                  className="w-full"
                  type="time"
                  step={60}
                  value={formatQuietHour(settings.quietHours.endMinute)}
                  onChange={(event) => {
                    const endMinute = parseQuietHour(event.currentTarget.value);
                    if (endMinute === null) return;
                    updateSettings((current) => ({
                      ...current,
                      quietHours: { ...current.quietHours, endMinute },
                    }));
                  }}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="notification-time-zone">
                Time zone
              </FieldLabel>
              <Select
                value={settings.quietHours.timeZone}
                onValueChange={(value) => {
                  if (typeof value !== 'string') return;
                  updateSettings((current) => ({
                    ...current,
                    quietHours: { ...current.quietHours, timeZone: value },
                  }));
                }}
              >
                <SelectTrigger
                  id="notification-time-zone"
                  className="w-full"
                  aria-label="Quiet hours time zone"
                >
                  <SelectValue>{settings.quietHours.timeZone}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Time zones</SelectLabel>
                    {timeZoneOptions.map((timeZone) => (
                      <SelectItem key={timeZone} value={timeZone}>
                        {timeZone}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </section>
  );
};
