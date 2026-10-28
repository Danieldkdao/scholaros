'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { authClient } from '@scholaros/auth/client';
import {
  getAuthPageHref,
  getDesktopAuthQuery,
} from '@scholaros/auth/redirects';
import { Button } from '@scholaros/ui/components/button';
import { Card, CardContent } from '@scholaros/ui/components/card';
import { LoadingSwap } from '@scholaros/ui/components/loading-swap';

export const DesktopCallback = () => {
  const params = useSearchParams();
  const router = useRouter();
  const queryString = params.toString();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const completed = params.get('completed') === '1';
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{
    key: string;
    result: Promise<'ready' | 'sign-in'>;
  } | null>(null);

  useEffect(() => {
    let active = true;
    let redirectTimer:
      | ReturnType<typeof authClient.ensureElectronRedirect>
      | undefined;
    const search = new URLSearchParams(queryString);
    if (search.get('completed') === '1') {
      setBusy(false);
      setError(null);
      if (authClient.electron.getAuthorizationCode()) {
        redirectTimer = authClient.ensureElectronRedirect();
      }
      return () => {
        if (redirectTimer !== undefined) clearInterval(redirectTimer);
      };
    }
    const query = getDesktopAuthQuery(search);
    if (!query) {
      setError('This sign-in request is invalid. Start again from ScholarOS.');
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    const key = `${queryString}:${attempt}`;
    // Reuse the in-flight operation across Strict Mode's setup/cleanup cycle.
    if (pending.current?.key !== key) {
      pending.current = {
        key,
        result: (async () => {
          const session = await authClient.getSession({
            fetchOptions: { timeout: 10_000 },
          });
          if (session.error) throw new Error('Session unavailable');
          if (!session.data?.user.emailVerified) return 'sign-in' as const;
          const transfer = await authClient.electron.transferUser({
            fetchOptions: { query, timeout: 10_000 },
          });
          if (transfer.error) throw new Error('Transfer failed');
          return 'ready' as const;
        })(),
      };
    }
    void pending.current.result
      .then((result) => {
        if (!active) return;
        if (result === 'sign-in') {
          routerRef.current.replace(getAuthPageHref('/sign-in', search));
          return;
        }
        // Remove the one-time request before opening the external app.
        routerRef.current.replace('/auth/desktop?completed=1');
      })
      .catch(() => {
        if (active) {
          setError(
            'Could not return to ScholarOS. Try again or restart sign-in from the app.',
          );
          setBusy(false);
        }
      });
    return () => {
      active = false;
      if (redirectTimer !== undefined) clearInterval(redirectTimer);
    };
  }, [queryString, attempt]);

  return (
    <Card className="w-full max-w-[30rem] rounded-2xl text-base shadow-none">
      <CardContent className="flex flex-col gap-4 text-center">
        <h1 className="text-3xl font-semibold">Continue in ScholarOS</h1>
        <p
          className="text-base text-muted-foreground"
          role={error ? 'alert' : 'status'}
        >
          {error ??
            (completed
              ? 'Once ScholarOS opens, you can close this tab.'
              : 'Preparing to return to ScholarOS.')}
        </p>
        {!completed && (
          <Button
            disabled={busy || !getDesktopAuthQuery(params)}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <LoadingSwap isLoading={busy}>Try again</LoadingSwap>
          </Button>
        )}
      </CardContent>
    </Card>
  );
};
