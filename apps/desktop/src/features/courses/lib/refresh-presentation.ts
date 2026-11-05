import { errorMessage } from '../../../lib/error-message';

const authenticationCodes = new Set([
  'unauthorized',
  'unauthenticated',
  'auth-required',
  'needs-sign-in',
  'sign-in-required',
  'session-expired',
  'session-changed',
  'permission-revoked',
]);

/** Presentation only; source receipts, stored coverage and thrown errors are unchanged. */
export const authenticationRefreshMessage = (
  cause: unknown,
  fallback: string,
): string | null => {
  const message = errorMessage(cause, fallback);
  const code =
    cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
  return (typeof code === 'string' && authenticationCodes.has(code)) ||
    /\b(?:sign[ -]?in|log[ -]?in|reconnect|authentication|unauthenticated|unauthorized|401|session(?: has)? (?:expired|changed))\b/iu.test(
      message,
    )
    ? message
    : null;
};
