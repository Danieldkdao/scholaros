import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { BookOpen, CircleAlert, Globe, Loader2, LogOut } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { ErrorScreen } from '../../components/error-screen';
import { useBridgeAction } from '../../hooks/use-bridge-action';
import { errorMessage } from '../../lib/error-message';
import { exitAndSignOut } from '../../lib/session-actions';
import { DeviceSetup } from '../onboarding/components/device-setup';
import { DiscoverySummary } from '../onboarding/components/discovery-summary';
import { PreferencesStep } from '../onboarding/components/preferences-step';
import { ResourcesStep } from '../onboarding/components/resources-step';
import { useOnboardingState } from '../onboarding/hooks/use-onboarding-state';
import { formatBrowser } from '../onboarding/lib/formatters';
import { needsDeviceSetup } from '../onboarding/lib/step-policy';
import { BackgroundSyncControls } from './background-sync-controls';
import type { CurrentUser, OnboardingSettings } from '../onboarding/types';

export const DashboardScreen = () => {
  const router = useRouter();
  const { state, setState, loading, loadError, reload, reset } =
    useOnboardingState();
  const { busy, error, run, setError } = useBridgeAction();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    let active = true;
    void window.scholar
      .getCurrentUser()
      .then((current) => {
        if (active) setUser(current);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const discover = async () => {
    await run(async () => {
      setState(await window.scholar.discoverContext());
    });
  };

  const updatePreferences = async (
    changes: Partial<
      Pick<OnboardingSettings, 'launchAtLogin' | 'backgroundSync'>
    >,
  ) => {
    await run(async () => {
      setState(await window.scholar.saveSettings(changes));
    });
  };

  const pauseSync = async () => {
    await run(async () => {
      setState(await window.scholar.pauseBackgroundSync());
    });
  };

  const resumeSync = async () => {
    await run(async () => {
      setState(await window.scholar.resumeBackgroundSync());
    });
  };

  const exit = async () => {
    if (exiting) return;
    setExiting(true);
    setError(null);
    try {
      await exitAndSignOut({
        signOut: () => window.scholar.signOut(),
        clearRendererState: () => {
          reset();
          setUser(null);
        },
        navigateToAuth: async () => {
          await router.invalidate();
          await router.navigate({ to: '/auth' });
        },
      });
    } catch (cause) {
      setError(errorMessage(cause, 'Could not sign out. Please try again.'));
    } finally {
      setExiting(false);
    }
  };

  const browser = state?.workspace
    ? formatBrowser(state.workspace.browser)
    : null;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-8 text-base sm:px-10">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-6">
        <div className="flex items-center gap-3 text-primary">
          <BookOpen className="size-6" />
          <span className="font-serif text-2xl font-semibold">ScholarOS</span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {user && (
            <p className="text-muted-foreground">
              {user.name.trim() || user.email}
            </p>
          )}
          <Button
            variant="ghost"
            className="text-base"
            disabled={exiting}
            onClick={() => void exit()}
          >
            <LoadingSwap isLoading={exiting}>
              <span className="flex items-center gap-2">
                <LogOut className="size-5" />
                Exit and sign out
              </span>
            </LoadingSwap>
          </Button>
        </div>
      </header>
      <main className="flex flex-1 flex-col gap-8">
        {loading || exiting ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p role="status" className="text-muted-foreground">
              {exiting ? 'Signing out…' : 'Loading your workspace…'}
            </p>
          </div>
        ) : loadError || !state ? (
          <ErrorScreen
            title="We couldn’t load your workspace"
            message={loadError ?? 'Please try again.'}
            onRetry={() => void reload()}
          />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <h1 className="text-3xl font-semibold">Your academic home</h1>
              <p className="max-w-2xl text-lg text-muted-foreground">
                Course radar, deadlines, and study sessions arrive next. Your
                setup lives here in the meantime.
              </p>
            </div>
            {error && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>That didn’t work</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {needsDeviceSetup(state) ? (
              <DeviceSetup
                state={state}
                busy={busy || exiting}
                run={run}
                update={setState}
              />
            ) : (
              <>
                <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
                  <Globe className="mt-0.5 size-5 shrink-0 text-primary" />
                  <div className="flex flex-col gap-1">
                    <p className="font-medium">This computer is ready</p>
                    <p className="text-muted-foreground">
                      {state.workspace?.browserName ??
                        browser?.label ??
                        'Your study browser'}{' '}
                      keeps academic sessions separate from your personal
                      browsing.
                    </p>
                  </div>
                </div>
                <section className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-2xl font-semibold">
                      Academic resources
                    </h2>
                    <p className="text-muted-foreground">
                      Connect the sites your agent may read; everything else
                      stays off limits.
                    </p>
                  </div>
                  <ResourcesStep
                    state={state}
                    busy={busy || exiting}
                    run={run}
                    update={setState}
                  />
                </section>
                <section className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-2xl font-semibold">Course map</h2>
                    <p className="text-muted-foreground">
                      Pages your agent has observed in your connected resources.
                    </p>
                  </div>
                  <DiscoverySummary
                    state={state}
                    busy={busy || exiting}
                    onDiscover={discover}
                  />
                </section>
              </>
            )}
            <section className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="text-2xl font-semibold">Preferences</h2>
                <p className="text-muted-foreground">
                  Change or revoke these choices whenever you want.
                </p>
              </div>
              <PreferencesStep
                state={state}
                busy={busy || exiting}
                onChange={(changes) => void updatePreferences(changes)}
              />
              <BackgroundSyncControls
                state={state}
                busy={busy || exiting}
                onPause={pauseSync}
                onResume={resumeSync}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
};
