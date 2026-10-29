import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { Progress } from '@scholaros/ui/components/progress';
import { useRouter } from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Loader2,
  LogOut,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ErrorScreen } from '../../../components/error-screen';
import { useBridgeAction } from '../../../hooks/use-bridge-action';
import { errorMessage } from '../../../lib/error-message';
import { exitAndSignOut } from '../../../lib/session-actions';
import { useOnboardingState } from '../hooks/use-onboarding-state';
import { formatOnboardingStep } from '../lib/formatters';
import {
  adjacentOnboardingStep,
  canCompleteOnboarding,
  resumeOnboardingStep,
} from '../lib/step-policy';
import { onboardingSteps } from '../schemas';
import type { OnboardingSettings, OnboardingStep } from '../types';
import { BrowserStep } from './browser-step';
import { ContextStep } from './context-step';
import { PreferencesStep } from './preferences-step';
import { PreviewStep } from './preview-step';
import { ResourcesStep } from './resources-step';
import { ReviewStep } from './review-step';
import { WelcomeStep } from './welcome-step';
import { Separator } from '@scholaros/ui/components/separator';

export const OnboardingScreen = () => {
  const router = useRouter();
  const { state, setState, loading, loadError, reload, reset } =
    useOnboardingState();
  const { busy, error, run, setError } = useBridgeAction();
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [notes, setNotes] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [exiting, setExiting] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (!state || initialized.current) return;
    initialized.current = true;
    setStep(resumeOnboardingStep(state));
    setNotes(state.settings.notes);
  }, [state]);

  const persistNotes = async () => {
    if (!state || notes === state.settings.notes) return;
    setState(await window.scholar.saveSettings({ notes }));
  };

  const goTo = async (next: OnboardingStep) => {
    if (!state) return;
    await run(async () => {
      if (step === 'preview')
        await window.scholar.cancelPreview(state.accountId);
      const saved = await window.scholar.saveSettings({
        step: next,
        ...(notes !== state.settings.notes ? { notes } : {}),
      });
      setState(saved);
      setNotes(saved.settings.notes);
      setStep(next);
    });
  };

  const changeConsent = (consent: boolean) => {
    void run(async () => {
      setState(await window.scholar.saveSettings({ consent }));
    });
  };

  const changePreference = (
    changes: Partial<
      Pick<OnboardingSettings, 'launchAtLogin' | 'backgroundSync'>
    >,
  ) => {
    void run(async () => {
      setState(await window.scholar.saveSettings(changes));
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
          setNotes('');
          initialized.current = false;
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

  const complete = async () => {
    if (!state || !canCompleteOnboarding(state)) return;
    setFinishing(true);
    await run(async () => {
      await window.scholar.completeOnboarding();
      await router.invalidate();
      await router.navigate({ to: '/dashboard' });
    });
    setFinishing(false);
  };

  const stepIndex = onboardingSteps.indexOf(step);
  const formatted = formatOnboardingStep(step);
  const previous = adjacentOnboardingStep(step, -1);
  const next = adjacentOnboardingStep(step, 1);
  const canContinue = (() => {
    if (!state) return false;
    switch (step) {
      case 'welcome':
        return state.settings.consent;
      case 'browser':
        return state.workspace?.ready === true;
      case 'review':
        return canCompleteOnboarding(state);
      case 'resources':
      case 'context':
      case 'preferences':
      case 'preview':
        return true;
    }
  })();
  const footerHint = (() => {
    if (!state) return null;
    if (step === 'welcome' && !state.settings.consent)
      return 'Approve access to continue.';
    if (step === 'browser' && !state.workspace?.ready)
      return 'Choose a browser to continue.';
    if (step === 'resources' && state.connections.length === 0)
      return 'You can continue without connecting a resource.';
    return null;
  })();

  const content = (() => {
    if (!state) return null;
    switch (step) {
      case 'welcome':
        return (
          <WelcomeStep
            consent={state.settings.consent}
            busy={busy || exiting}
            onConsentChange={changeConsent}
          />
        );
      case 'browser':
        return (
          <BrowserStep
            state={state}
            busy={busy || exiting}
            run={run}
            update={setState}
          />
        );
      case 'resources':
        return (
          <ResourcesStep
            state={state}
            busy={busy || exiting}
            run={run}
            update={setState}
          />
        );
      case 'context':
        return (
          <ContextStep
            notes={notes}
            busy={busy || exiting}
            onNotesChange={setNotes}
            onNotesBlur={() => void persistNotes().catch(() => undefined)}
          />
        );
      case 'preferences':
        return (
          <PreferencesStep
            state={state}
            busy={busy || exiting}
            onChange={changePreference}
          />
        );
      case 'preview':
        return (
          <PreviewStep
            accountId={state.accountId}
            enabled={state.connections.some(
              (connection) => connection.status !== 'needs-sign-in',
            )}
            busy={busy || exiting}
            run={run}
          />
        );
      case 'review':
        return <ReviewStep state={state} />;
    }
  })();

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-24 text-base sm:px-10">
      <main className="flex flex-1 flex-col gap-6">
        {loading || exiting ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4">
            <Loader2 className="size-8 animate-spin text-primary" />
            <p role="status" className="text-muted-foreground">
              {exiting ? 'Signing out…' : 'Loading your setup…'}
            </p>
          </div>
        ) : loadError || !state ? (
          <ErrorScreen
            title="We couldn’t load your setup"
            message={loadError ?? 'Please try again.'}
            onRetry={() => void reload()}
          />
        ) : (
          <>
            <div className="flex flex-col items-center gap-1">
              <h1 className="text-3xl font-semibold">{formatted.title}</h1>
              <p className="max-w-2xl text-lg text-muted-foreground">
                {formatted.description}
              </p>
            </div>
            {content}
            {error && (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>That didn’t work</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <footer className="mt-auto pt-6 flex flex-col gap-6 w-full">
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-4 text-muted-foreground">
                  <span>
                    Step {stepIndex + 1} of {onboardingSteps.length}
                  </span>
                </div>
                <Progress
                  value={((stepIndex + 1) / onboardingSteps.length) * 100}
                  aria-label="Onboarding progress"
                />
              </div>
              <Separator />
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2">
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
                  {previous && (
                    <Button
                      variant="ghost"
                      className="text-base"
                      disabled={busy || finishing || exiting}
                      onClick={() => void goTo(previous)}
                    >
                      <ArrowLeft className="size-5" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {footerHint && (
                    <p className="text-muted-foreground">{footerHint}</p>
                  )}
                  {step === 'preview' && (
                    <Button
                      variant="ghost"
                      className="text-base"
                      disabled={busy || finishing || exiting}
                      onClick={() => void goTo('review')}
                    >
                      Skip for now
                    </Button>
                  )}
                  <Button
                    className="text-base"
                    disabled={!canContinue || busy || finishing || exiting}
                    onClick={() => {
                      if (step === 'review') void complete();
                      else if (next) void goTo(next);
                    }}
                  >
                    <LoadingSwap isLoading={busy || finishing}>
                      <span className="flex items-center gap-2">
                        {step === 'review' ? 'Finish setup' : 'Continue'}
                        {step !== 'review' && <ArrowRight className="size-5" />}
                      </span>
                    </LoadingSwap>
                  </Button>
                </div>
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
};
