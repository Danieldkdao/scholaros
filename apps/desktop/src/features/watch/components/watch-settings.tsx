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
import { Input } from '@scholaros/ui/components/input';
import { Switch } from '@scholaros/ui/components/switch';
import { TooltipWrapper } from '@scholaros/ui/components/tooltip-wrapper';
import { defaultConnectionSearch } from '../../dashboard/lib/connection-filters';
import { parseWatchUrl, getEffectiveWatchTargetInputs } from '../lib/watch-url';
import {
  formatWatchRuntimeStatus,
  formatWatchUrlLabel,
} from '../lib/formatters';
import { maxWatchUrls } from '../constants';
import { watchUrlInputSchema } from '../schemas';
import type {
  WatchRuntimeStatus,
  WatchSettings as WatchSettingsValue,
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
  onSave: (settings: WatchSettingsValue) => Promise<WatchSettingsValue>;
  focusOnMount?: boolean;
};

export const WatchSettings = ({
  accountId,
  settings: persistedSettings,
  connections,
  status,
  onSave,
  focusOnMount = false,
}: WatchSettingsProps) => {
  const initialDraft = getSettingsSaveState(accountId).draft.watchSettings;
  const [settings, setSettings] = useState(
    () => initialDraft ?? persistedSettings,
  );
  const [urlError, setUrlError] = useState<string | null>(null);
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
  const defaultTargets = getEffectiveWatchTargetInputs(
    { watchEnabled: true, watchUrls: [] },
    activeResourceConnections,
  );
  const statusView = formatWatchRuntimeStatus(status);

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
    void queueWatchSettingsSave(accountId, nextSettings, async () => {
      await onSave(nextSettings);
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

  const removeUrl = (url: string) =>
    save({
      ...settings,
      watchUrls: settings.watchUrls.filter((savedUrl) => savedUrl !== url),
    });

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      id="watch-course-pages"
      aria-labelledby="watch-course-pages-title"
      className="flex flex-col gap-4 scroll-mt-6"
    >
      <div className="flex items-start justify-between gap-5 rounded-xl border bg-card p-5 cursor-pointer">
        <div className="flex min-w-0 flex-col gap-2">
          <label
            id="watch-course-pages-title"
            htmlFor="watch-course-pages-switch"
            className="font-medium"
          >
            Watch course pages
          </label>
          <p className="text-base text-muted-foreground">
            Add specific course page URLs for the best results. If none are
            added, ScholarOS watches your course resource home pages.
          </p>
          <p
            className="flex items-center gap-2 text-base text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <statusView.Icon className="size-4 shrink-0" />
            {statusView.label}
          </p>
          {!configuredResourceConnections.length ? (
            <p className="flex flex-wrap items-center gap-2 text-base text-muted-foreground">
              <CircleAlert className="size-4 shrink-0" />
              Add a course resource connection to enable watching.
              <Link
                to="/dashboard/connections"
                search={defaultConnectionSearch}
                className="text-primary underline underline-offset-4"
              >
                Connections
              </Link>
            </p>
          ) : !activeResourceConnections.length ? (
            <p className="flex flex-wrap items-center gap-2 text-base text-muted-foreground">
              <CircleAlert className="size-4 shrink-0" />
              Sign in to a course resource connection to enable watching.
              <Link
                to="/dashboard/connections"
                search={defaultConnectionSearch}
                className="text-primary underline underline-offset-4"
              >
                Connections
              </Link>
            </p>
          ) : null}
        </div>
        <Switch
          id="watch-course-pages-switch"
          checked={settings.watchEnabled}
          disabled={!activeResourceConnections.length}
          onCheckedChange={(checked) => toggleWatching(checked === true)}
        />
      </div>

      {settings.watchEnabled && (
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
          {settings.watchUrls.length ? (
            <ul
              className="flex flex-col gap-3"
              aria-label="Custom course pages"
            >
              {settings.watchUrls.map((url) => (
                <li
                  key={url}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Link2 className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={url} aria-label={url}>
                      {formatWatchUrlLabel(url)}
                    </span>
                  </span>
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
        </div>
      )}
    </section>
  );
};
