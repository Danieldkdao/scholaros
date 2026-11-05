import { describe, expect, it, vi } from 'vitest';
import { createDemoSignInHandler } from '../src/lib/auth/demo-sign-in';

const configuration = {
  enabled: true,
  email: 'demo@scholaros.example',
  password: 'synthetic-test-password-only',
  trustedOrigin: 'https://scholaros.example',
};
const request = (
  origin: string | null = configuration.trustedOrigin,
  query = '',
) =>
  new Request(`https://scholaros.example/api/demo/sign-in${query}`, {
    method: 'POST',
    headers: origin ? { origin } : {},
  });

describe('explicit demo account sign-in', () => {
  it.each(['https://attacker.example', null])(
    'rejects origin %s before reading or signing in',
    async (origin) => {
      const signIn = vi.fn();
      const response = await createDemoSignInHandler({
        ...configuration,
        signIn,
      })(request(origin));
      expect(response.status).toBe(403);
      expect(signIn).not.toHaveBeenCalled();
    },
  );
  it('fails closed when the deployment has not enabled demo authentication', async () => {
    const signIn = vi.fn();
    const response = await createDemoSignInHandler({
      ...configuration,
      enabled: false,
      signIn,
    })(request());
    expect(response.status).toBe(503);
    expect(signIn).not.toHaveBeenCalled();
  });
  it('uses ordinary auth with preserved PKCE and forwards cookies without exposing secrets or tokens', async () => {
    const cookies = new Headers();
    cookies.append(
      'Set-Cookie',
      'session=synthetic-session; HttpOnly; Secure; SameSite=Lax',
    );
    const signIn = vi.fn(async () =>
      Response.json(
        { token: 'must-not-leak', password: configuration.password },
        { headers: cookies },
      ),
    );
    const query =
      '?client_id=electron&state=aaaaaaaaaaaaaaaa&code_challenge=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const response = await createDemoSignInHandler({
      ...configuration,
      signIn,
    })(request(configuration.trustedOrigin, query));
    expect(signIn).toHaveBeenCalledWith(
      expect.objectContaining({
        email: configuration.email,
        password: configuration.password,
        desktopQuery: {
          client_id: 'electron',
          state: 'aaaaaaaaaaaaaaaa',
          code_challenge: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        callbackURL: expect.stringContaining('/auth/desktop?'),
      }),
    );
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
  });
  it('does not expose upstream authentication failure bodies', async () => {
    const signIn = vi.fn(async () =>
      Response.json(
        { token: 'must-not-leak', password: configuration.password },
        { status: 401 },
      ),
    );
    const response = await createDemoSignInHandler({
      ...configuration,
      signIn,
    })(request());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(configuration.password);
    expect(response.headers.has('set-cookie')).toBe(false);
  });
});
