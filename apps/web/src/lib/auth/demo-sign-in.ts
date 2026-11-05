import {
  getAuthRedirect,
  getDesktopAuthQuery,
} from '@scholaros/auth/redirects';

type DemoSignInDependencies = {
  enabled: boolean;
  email?: string;
  password?: string;
  trustedOrigin: string;
  signIn: (input: {
    email: string;
    password: string;
    callbackURL: string;
    desktopQuery: ReturnType<typeof getDesktopAuthQuery>;
    headers: Headers;
  }) => Promise<Response>;
};

export const createDemoSignInHandler =
  (dependencies: DemoSignInDependencies) => async (request: Request) => {
    const fail = (status: number, error: string) =>
      Response.json(
        { error },
        { status, headers: { 'Cache-Control': 'no-store' } },
      );
    if (request.headers.get('origin') !== dependencies.trustedOrigin)
      return fail(403, 'This request origin is not allowed.');
    if (!dependencies.enabled || !dependencies.email || !dependencies.password)
      return fail(
        503,
        'Demo account sign-in is not configured. You can still explore the public demo.',
      );
    try {
      const params = new URL(request.url).searchParams;
      const response = await dependencies.signIn({
        email: dependencies.email,
        password: dependencies.password,
        callbackURL: getAuthRedirect(params),
        desktopQuery: getDesktopAuthQuery(params),
        headers: request.headers,
      });
      if (!response.ok)
        return fail(
          response.status,
          'Demo account sign-in could not be completed. Please try again.',
        );
      const headers = new Headers({ 'Cache-Control': 'no-store' });
      for (const cookie of response.headers.getSetCookie())
        headers.append('Set-Cookie', cookie);
      // The normal auth session cookies are sufficient for the ordinary browser
      // or Electron callback. Never expose the configured password or API token.
      return Response.json({ ok: true }, { headers });
    } catch {
      return fail(
        503,
        'Demo account sign-in is unavailable. Please try again.',
      );
    }
  };
