import { Link } from '@tanstack/react-router';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@scholaros/ui/components/alert';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { CircleAlert, Loader2, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';
import logoMarkDark from '@scholaros/assets/images/logo-dark.png';
import logoMarkLight from '@scholaros/assets/images/logo-light.png';
import { errorMessage } from '../../lib/error-message';
import { Image } from '../../components/image';

export const AuthScreen = () => {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () =>
      window.onAuthError(() => {
        setWaiting(false);
        setError('Sign-in could not be completed. Please try again.');
      }),
    [],
  );
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.requestAuth();
      setWaiting(true);
    } catch (cause) {
      setError(
        errorMessage(cause, 'Could not open sign-in. Please try again.'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6 text-base">
      <div className="w-full max-w-lg flex flex-col gap-4 items-center">
        <div className="w-full flex flex-col gap-3 items-center">
          <h1 className="flex items-center justify-center gap-3 text-4xl font-semibold">
            <Image
              src={{ light: logoMarkLight, dark: logoMarkDark }}
              alt=""
              className="size-16 shrink-0 object-contain"
            />
            ScholarOS
          </h1>
          <h2 className="text-3xl font-semibold text-center">
            The AI that learns your classes
          </h2>
        </div>
        <p className="text-lg text-muted-foreground text-center">
          Sign in to set up a private study workspace that learns your courses
          so it can teach you.
        </p>
        <div className="flex flex-col gap-5 w-full">
          {waiting && (
            <div
              role="status"
              className="flex items-start gap-3 rounded-xl bg-muted p-4"
            >
              <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
              <div className="flex flex-col gap-1">
                <p className="font-medium">Finish signing in in your browser</p>
                <p className="text-muted-foreground">
                  This window moves on automatically when you’re done.
                </p>
              </div>
            </div>
          )}
          {error && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>Could not start sign-in</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button
            className="w-full text-base"
            disabled={busy}
            onClick={() => void signIn()}
          >
            <LoadingSwap isLoading={busy}>
              <span className="flex items-center gap-2">
                <LogIn className="size-5" />
                {waiting ? 'Open sign-in again' : 'Continue to sign in'}
              </span>
            </LoadingSwap>
          </Button>
          <Button
            variant="outline"
            render={<Link to="/demo" />}
            nativeButton={false}
          >
            Try demo
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Explore with sample data. No account or permissions needed.
          </p>
        </div>
      </div>
    </main>
  );
};
