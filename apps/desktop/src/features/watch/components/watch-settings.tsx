import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { CircleAlert, Link2, Plus, Trash2 } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from '@scholaros/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@scholaros/ui/components/card';
import { Input } from '@scholaros/ui/components/input';
import { Switch } from '@scholaros/ui/components/switch';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { defaultConnectionSearch } from '../../dashboard/lib/connection-filters';
import { parseWatchUrl, getEffectiveWatchTargetInputs } from '../lib/watch-url';
import {
  formatWatchFailureCategory,
  formatWatchRuntimeStatus,
  formatWatchUrlLabel,
  summarizeWatchHealth,
} from '../lib/formatters';
import { maxWatchUrls } from '../constants';
import { watchSettingsSchema, watchUrlInputSchema } from '../schemas';
import type {
  WatchRuntimeStatus,
  WatchSettings as WatchSettingsValue,
  WatchHealthSummary,
} from '../types';
import {
  getSettingsSaveState,
  queueWatchSettingsSave,
  reconcileSettingsSaveDraft,
  subscribeSettingsSaveState,
} from '../../dashboard/settings-save-queue';

type WatchSettingsConnection = {
  id: string;
  name: string;
  host: string;
  url: string;
  status: 'verified' | 'confirmed' | 'needs-sign-in';
  isCourseResource: boolean;
};

type WatchSettingsProps = {
  accountId: string;
  settings: WatchSettingsValue;
  connections: WatchSettingsConnection[];
  status: WatchRuntimeStatus;
  health?: WatchHealthSummary | null;
  setupMessage?: string | null;
  onSave: (settings: WatchSettingsValue) => Promise<WatchSettingsValue>;
  focusOnMount?: boolean;
};

export const WatchSettings = ({
  accountId,
  settings: persistedSettings,
  connections,
  status,
  health = null,
  setupMessage = null,
  onSave,
  focusOnMount = false,
}: WatchSettingsProps) => {
  const initialDraft = getSettingsSaveState(accountId).draft.watchSettings;
  const [settings, setSettings] = useState(
    () => initialDraft ?? persistedSettings,
  );
  const [urlError, setUrlError] = useState<string | null>(null);
  const [savedUrlDrafts, setSavedUrlDrafts] = useState<Record<string, string>>(
    {},
  );
  const [savedUrlErrors, setSavedUrlErrors] = useState<Record<string, string>>(
    {},
  );
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const subscribe = useCallback(
    (listener: () => void) => subscribeSettingsSaveState(accountId, listener),
    [accountId],
  );
  const getSnapshot = useCallback(
    () => getSettingsSaveState(accountId),
    [accountId],
  );
  const saveState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const form = useForm({
    resolver: zodResolver(watchUrlInputSchema),
    defaultValues: { url: '' },
  });
  const urlField = form.register('url');
  const activeResourceConnections = connections.filter(
    (connection) =>
      connection.isCourseResource && connection.status !== 'needs-sign-in',
  );
  const configuredResourceConnections = connections.filter(
    (connection) => connection.isCourseResource,
  );
  const connectionEligibilityMessage = !configuredResourceConnections.length
    ? 'Add a course resource connection to enable watching.'
    : !activeResourceConnections.length
      ? 'Sign in to a course resource connection to enable watching.'
      : null;
  const eligibilityMessage = setupMessage ?? connectionEligibilityMessage;
  const defaultTargets = getEffectiveWatchTargetInputs(
    { watchEnabled: true, watchUrls: [] },
    activeResourceConnections,
  );
  const statusView = formatWatchRuntimeStatus(health?.status ?? status);
  const healthView = health ? summarizeWatchHealth(health) : null;

  useEffect(() => {
    reconcileSettingsSaveDraft(accountId, {
      watchSettings: persistedSettings,
    });
  }, [
    accountId,
    persistedSettings,
    saveState.draft,
    saveState.error,
    saveState.pending,
  ]);

  useEffect(() => {
    if (saveState.draft.watchSettings) {
      setSettings(saveState.draft.watchSettings);
    } else if (saveState.pending === 0 && !saveState.error) {
      setSettings(persistedSettings);
    }
  }, [
    accountId,
    persistedSettings,
    saveState.draft.watchSettings,
    saveState.error,
    saveState.pending,
  ]);

  useEffect(() => {
    if (focusOnMount) {
      if (typeof sectionRef.current?.scrollIntoView === 'function')
        sectionRef.current.scrollIntoView({ block: 'start' });
      sectionRef.current?.focus();
    }
  }, [focusOnMount]);

  const save = (nextSettings: WatchSettingsValue) => {
    setSettings(nextSettings);
    void queueWatchSettingsSave(accountId, nextSettings, async (draft) => {
      const parsed = watchSettingsSchema.safeParse(draft.watchSettings);
      if (!parsed.success) throw new Error('Watch settings are invalid.');
      await onSave(parsed.data);
    }).catch(() => undefined);
  };

  const addUrl = form.handleSubmit(({ url }) => {
    setUrlError(null);
    if (!url.trim()) return;
    let parsedUrl: ReturnType<typeof parseWatchUrl>;
    try {
      parsedUrl = parseWatchUrl(url, connections);
    } catch (error) {
      setUrlError(
        error instanceof Error
          ? error.message
          : 'Enter a valid course page URL.',
      );
      return;
    }
    const duplicate = settings.watchUrls.some((existingUrl) => {
      try {
        return (
          parseWatchUrl(existingUrl, connections).identity ===
          parsedUrl.identity
        );
      } catch {
        return existingUrl === parsedUrl.url;
      }
    });
    if (duplicate) {
      setUrlError('That course page URL is already being watched.');
      return;
    }
    if (settings.watchUrls.length >= maxWatchUrls) {
      setUrlError(`Add up to ${maxWatchUrls} course page URLs.`);
      return;
    }
    save({ ...settings, watchUrls: [...settings.watchUrls, parsedUrl.url] });
    form.reset({ url: '' });
    queueMicrotask(() => inputRef.current?.focus());
  });

  const toggleWatching = (watchEnabled: boolean) =>
    save({ ...settings, watchEnabled });

  const removeUrl = (url: string) => {
    setSavedUrlDrafts((drafts) => {
      const nextDrafts = { ...drafts };
      delete nextDrafts[url];
      return nextDrafts;
    });
    setSavedUrlErrors((errors) => {
      const nextErrors = { ...errors };
      delete nextErrors[url];
      return nextErrors;
    });
    save({
      ...settings,
      watchUrls: settings.watchUrls.filter((savedUrl) => savedUrl !== url),
    });
  };

  const saveEditedUrl = (url: string) => {
    const value = savedUrlDrafts[url];
    if (value === undefined || value === url) return;
    try {
      const parsedUrl = parseWatchUrl(value, connections);
      const duplicate = settings.watchUrls.some((existingUrl) => {
        if (existingUrl === url) return false;
        try {
          return (
            parseWatchUrl(existingUrl, connections).identity ===
            parsedUrl.identity
          );
        } catch {
          return existingUrl === parsedUrl.url;
        }
      });
      if (duplicate)
        throw new Error('That course page URL is already being watched.');
      setSavedUrlErrors((errors) => {
        const nextErrors = { ...errors };
        delete nextErrors[url];
        return nextErrors;
      });
      setSavedUrlDrafts((drafts) => {
        const nextDrafts = { ...drafts };
        delete nextDrafts[url];
        return nextDrafts;
      });
      save({
        ...settings,
        watchUrls: settings.watchUrls.map((savedUrl) =>
          savedUrl === url ? parsedUrl.url : savedUrl,
        ),
      });
    } catch (error) {
      setSavedUrlErrors((errors) => ({
        ...errors,
        [url]:
          error instanceof Error
            ? error.message
            : 'Enter a valid course page URL.',
      }));
    }
  };

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      id="watch-course-pages"
      aria-labelledby="watch-course-pages-title"
      className="flex flex-col gap-4 scroll-mt-6"
    >
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-5">
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle>
              <label
                id="watch-course-pages-title"
                htmlFor="watch-course-pages-switch"
              >
                Watch course pages
              </label>
            </CardTitle>
            <CardDescription>
              Add specific course page URLs for the best results; otherwise,
              ScholarOS watches connected course resource pages.
            </CardDescription>
          </div>
          <Switch
            id="watch-course-pages-switch"
            checked={settings.watchEnabled}
            aria-describedby={
              eligibilityMessage ? 'watch-eligibility-message' : undefined
            }
            disabled={!settings.watchEnabled && Boolean(eligibilityMessage)}
            onCheckedChange={(checked) => toggleWatching(checked === true)}
          />
        </CardHeader>
        <CardContent>
          <p
            className="flex items-center gap-2 text-base text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <statusView.Icon className="size-4 shrink-0" aria-hidden="true" />
            {statusView.label}
          </p>
          {health && healthView && (
            <div
              className="flex flex-col gap-2 text-base text-muted-foreground"
              aria-label="Watch health details"
              role="group"
            >
              <p>Last successful check: {healthView.lastSuccessfulCheckAt}</p>
              {health.pendingRevisionCount > 0 && (
                <p>
                  {healthView.pending}
                  {healthView.pendingAge && (
                    <span>
                      {' '}
                      for {healthView.pendingAge}
                      {healthView.estimatedAge ? ' (estimated)' : ''}
                    </span>
                  )}
                </p>
              )}
              {healthView.nextRetryAt && (
                <p>Next retry: {healthView.nextRetryAt}</p>
              )}
              {health.failures.map((failure) => {
                const formattedFailure = formatWatchFailureCategory(
                  failure.category,
                );
                return (
                  <p key={failure.category} className="flex items-center gap-2">
                    <formattedFailure.Icon
                      className="size-4 shrink-0"
                      aria-hidden="true"
                    />
                    {formattedFailure.label}: {failure.targetCount}
                  </p>
                );
              })}
            </div>
          )}
          {eligibilityMessage && (
            <p
              id="watch-eligibility-message"
              className="flex flex-wrap items-center gap-2 text-base text-muted-foreground"
              role="status"
            >
              <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
              {eligibilityMessage}
              {setupMessage ? (
                <Link
                  to="/dashboard/settings"
                  search={{ section: 'device' }}
                  className="text-primary underline underline-offset-4"
                >
                  Device setup
                </Link>
              ) : (
                <Link
                  to="/dashboard/connections"
                  search={defaultConnectionSearch}
                  className="text-primary underline underline-offset-4"
                >
                  Connections
                </Link>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      {(settings.watchEnabled || settings.watchUrls.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Course page targets</CardTitle>
            <CardDescription>
              Custom pages replace default course pages; an empty list restores
              the defaults.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-4">
            {settings.watchUrls.length ? (
              <ul
                className="flex flex-col gap-3"
                aria-label="Custom course pages"
              >
                {settings.watchUrls.map((url, index) => (
                  <li key={url} className="flex items-start gap-3">
                    <Link2 className="mt-2 size-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <Input
                        value={savedUrlDrafts[url] ?? url}
                        aria-label={`Course page URL ${url}`}
                        aria-describedby={`saved-watch-url-error-${index}`}
                        aria-invalid={Boolean(savedUrlErrors[url])}
                        className="w-full"
                        onChange={(event) =>
                          setSavedUrlDrafts((drafts) => ({
                            ...drafts,
                            [url]: event.target.value,
                          }))
                        }
                        onBlur={() => saveEditedUrl(url)}
                      />
                      {savedUrlErrors[url] && (
                        <p
                          id={`saved-watch-url-error-${index}`}
                          role="alert"
                          className="text-base text-destructive"
                        >
                          {savedUrlErrors[url]}
                        </p>
                      )}
                    </div>
                    <TooltipWrapper content="Remove URL">
                      <Button
                        type="button"
                        variant="destructive"
                        size="icon"
                        aria-label={`Remove ${url}`}
                        onClick={() => removeUrl(url)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TooltipWrapper>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-base font-medium">
                  Default course resource pages
                </p>
                <ul
                  className="flex flex-col gap-3"
                  aria-label="Default course pages"
                >
                  {defaultTargets.map((target) => {
                    const connection = connections.find(
                      (item) => item.id === target.connectionId,
                    );
                    if (!connection) return null;
                    return (
                      <li
                        key={`${target.connectionId}:${target.requestedUrl}`}
                        className="flex items-center justify-between gap-4"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Link2 className="size-4 shrink-0 text-muted-foreground" />
                          <span
                            className="truncate"
                            title={target.requestedUrl}
                            aria-label={target.requestedUrl}
                          >
                            {formatWatchUrlLabel(target.requestedUrl)}
                          </span>
                        </span>
                        <span className="shrink-0 text-base text-muted-foreground">
                          Default
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <form
              className="flex w-full items-start gap-2"
              noValidate
              onSubmit={addUrl}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Input
                  aria-label="Course page URL"
                  aria-describedby="watch-url-error"
                  aria-invalid={!!urlError || !!form.formState.errors.url}
                  placeholder="https://school.edu/course/assignments"
                  className="w-full"
                  {...urlField}
                  ref={(node) => {
                    urlField.ref(node);
                    inputRef.current = node;
                  }}
                />
                {(urlError || form.formState.errors.url?.message) && (
                  <p
                    id="watch-url-error"
                    role="alert"
                    className="text-base text-destructive"
                  >
                    {urlError ?? form.formState.errors.url?.message}
                  </p>
                )}
              </div>
              <TooltipWrapper content="Add URL">
                <Button
                  type="submit"
                  variant="outline"
                  size="icon"
                  aria-label="Add URL"
                >
                  <Plus className="size-4" />
                </Button>
              </TooltipWrapper>
            </form>
          </CardContent>
        </Card>
      )}
    </section>
  );
};
