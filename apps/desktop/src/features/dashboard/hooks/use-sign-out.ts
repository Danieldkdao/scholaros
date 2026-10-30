import { useRef, useState } from 'react';
import { errorMessage } from '../../../lib/error-message';
import {
  exitAndSignOut,
  type SignOutDependencies,
} from '../../../lib/session-actions';

const fallback = 'Could not sign out. Please try again.';

export const useSignOut = (dependencies: SignOutDependencies) => {
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const signOutNow = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSigningOut(true);
    setError(null);
    try {
      await exitAndSignOut(dependencies);
    } catch (cause) {
      setError(errorMessage(cause, fallback));
    } finally {
      inFlight.current = false;
      setSigningOut(false);
    }
  };

  return { signingOut, error, signOutNow };
};
