import { useEffect, useState } from 'react';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';

type DesktopUser = Awaited<ReturnType<Window['getUser']>>;

const App = () => {
  const [user, setUser] = useState<DesktopUser>(null);
  const [busy, setBusy] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let updated = false;
    const updateUser = (next: DesktopUser) => {
      if (!active) return;
      updated = true;
      setUser(next);
      setBusy(false);
      setWaiting(false);
      setError(null);
    };
    const unsubscribeAuthenticated = window.onAuthenticated(updateUser);
    const unsubscribeUser = window.onUserUpdated(updateUser);
    const unsubscribeError = window.onAuthError(() => {
      if (!active) return;
      setBusy(false);
      setWaiting(false);
      setError('Could not connect to account services. Please try again.');
    });
    const restoreTimeout = setTimeout(() => {
      if (!active) return;
      setBusy(false);
      setError(
        'Session restoration took too long. Please try signing in again.',
      );
    }, 12_000);
    void window
      .getUser()
      .then((current) => {
        if (active && !updated) setUser(current);
      })
      .catch(() => {
        if (active)
          setError('Could not restore your session. Please sign in again.');
      })
      .finally(() => {
        clearTimeout(restoreTimeout);
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      clearTimeout(restoreTimeout);
      unsubscribeAuthenticated();
      unsubscribeUser();
      unsubscribeError();
    };
  }, []);

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.requestAuth();
      setWaiting(true);
    } catch {
      setError('Could not open sign-in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.signOut();
      setUser(null);
      setWaiting(false);
    } catch {
      setError('Could not sign out. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-base">
      <h1 className="text-3xl font-semibold">ScholarOS</h1>
      {user && (
        <div className="flex flex-col items-center gap-2">
          <p className="text-xl font-medium">
            Welcome back, {user.name.trim() || 'there'}!
          </p>
          <p className="text-muted-foreground">{user.email}</p>
        </div>
      )}
      {waiting && <p role="status">Finish signing in in your browser.</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy} onClick={user ? signOut : signIn}>
        <LoadingSwap isLoading={busy}>
          {user ? 'Log out' : 'Sign in'}
        </LoadingSwap>
      </Button>
    </main>
  );
};

export default App;
