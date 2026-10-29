import { useEffect, useRef, useState } from 'react';
import {
  createRootRoute,
  Link,
  Outlet,
  redirect,
  useRouter,
} from '@tanstack/react-router';
import { CircleAlert, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { Button } from '@scholaros/ui/components/button';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';
import { authorizeRoute, routeGroupForPath } from '../lib/auth/access';
import { errorMessage } from '../lib/error-message';
import { exitAndSignOut } from '../lib/session-actions';

type BridgeUser = { id: string; hasCompletedOnboarding?: unknown } | null;

const RootLayout = () => {
  const router = useRouter();
  const identity = useRef<string | null>(null);
  useEffect(() => {
    const reevaluate = (user: BridgeUser) => {
      const next = user
        ? `${user.id}:${user.hasCompletedOnboarding === true}`
        : 'signed-out';
      if (identity.current === next) return;
      identity.current = next;
      void router.invalidate();
    };
    const unsubscribeAuthenticated = window.onAuthenticated((user) =>
      reevaluate(user),
    );
    const unsubscribeUserUpdated = window.onUserUpdated((user) =>
      reevaluate(user),
    );
    return () => {
      unsubscribeAuthenticated();
      unsubscribeUserUpdated();
    };
  }, [router]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
    </div>
  );
};

const RootPending = () => (
  <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-base">
    <Loader2 className="size-8 animate-spin text-primary" />
    <p role="status" className="text-muted-foreground">
      Checking your ScholarOS account…
    </p>
  </main>
);

const RootErrorComponent = ({ reset }: { reset: () => void }) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exit = async () => {
    setBusy(true);
    setError(null);
    try {
      await exitAndSignOut({
        signOut: () => window.scholar.signOut(),
        clearRendererState: () => undefined,
        navigateToAuth: async () => {
          await router.invalidate();
          await router.navigate({ to: '/auth' });
        },
      });
    } catch (cause) {
      setError(errorMessage(cause, 'Could not sign out. Please try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 p-8 text-base">
      <CircleAlert className="size-8 text-destructive" />
      <h1 className="text-3xl font-semibold">This screen could not load</h1>
      <p className="max-w-md text-center text-muted-foreground">
        ScholarOS could not confirm your account. Check your connection and try
        again.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button className="text-base" onClick={reset}>
          <RefreshCw className="size-5" />
          Try again
        </Button>
        <Button
          variant="ghost"
          className="text-base"
          disabled={busy}
          onClick={() => void exit()}
        >
          <LoadingSwap isLoading={busy}>
            <span className="flex items-center gap-2">
              <LogOut className="size-5" />
              Exit and sign out
            </span>
          </LoadingSwap>
        </Button>
      </div>
    </main>
  );
};

const NotFound = () => (
  <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-base">
    <h1 className="text-3xl font-semibold">Page not found</h1>
    <p className="text-muted-foreground">
      This application route does not exist.
    </p>
    <Link
      to="/"
      className="font-medium text-primary underline underline-offset-4"
    >
      Return home
    </Link>
  </main>
);

export const Route = createRootRoute({
  component: RootLayout,
  beforeLoad: async ({ location }) => {
    const access = await authorizeRoute(routeGroupForPath(location.pathname));
    if (!access.authorized) throw redirect({ to: access.route });
  },
  pendingComponent: RootPending,
  pendingMs: 150,
  pendingMinMs: 300,
  errorComponent: RootErrorComponent,
  notFoundComponent: NotFound,
});
