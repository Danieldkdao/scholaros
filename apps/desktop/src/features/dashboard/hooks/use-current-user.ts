import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentUser } from '../../../lib/auth/helpers';
import { errorMessage } from '../../../lib/error-message';
import type { CurrentUser } from '../../onboarding/types';

type CurrentUserState = {
  user: CurrentUser | null;
  loading: boolean;
  error: string | null;
};

const fallback = 'Your account could not be loaded.';

export const useCurrentUser = () => {
  const [state, setState] = useState<CurrentUserState>({
    user: null,
    loading: true,
    error: null,
  });
  const request = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const current = request.current + 1;
    request.current = current;
    const settle = (next: CurrentUserState) => {
      // A response that lands after sign-out or unmount belongs to no session.
      if (!alive.current || current !== request.current) return;
      setState(next);
    };
    try {
      settle({ user: await getCurrentUser(), loading: false, error: null });
    } catch (cause) {
      settle({
        user: null,
        loading: false,
        error: errorMessage(cause, fallback),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clear = useCallback(() => {
    request.current += 1;
    setState({ user: null, loading: false, error: null });
  }, []);

  return { ...state, reload: load, clear };
};
