import { expect, test, vi } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { authOptions } from '../src/options';
import { getAuthRedirect, getDesktopAuthQuery } from '../src/redirects';

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@scholaros/services/mailjet/emails/verification-emails', () => ({
  sendVerificationOtp: mail.send,
}));
vi.mock('@scholaros/env/server', () => ({
  serverEnv: {
    BETTER_AUTH_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'verification-only-secret-abcdefghijklmnopqrstuvwxyz',
    GOOGLE_CLIENT_ID: 'google',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GITHUB_CLIENT_ID: 'github',
    GITHUB_CLIENT_SECRET: 'github-secret',
  },
}));

test('OTP verification transfers an authenticated browser session with PKCE and rejects replay', async () => {
  const auth = betterAuth({
    ...authOptions,
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    rateLimit: { enabled: false },
    logger: { level: 'error' },
  });
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: 'electron',
    state: randomBytes(16).toString('hex'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  const desktop = getDesktopAuthQuery(query)!;
  const cookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  const call = (
    path: string,
    body: unknown,
    sessionCookie?: string,
    params?: URLSearchParams,
  ) =>
    auth.handler(
      new Request(
        `http://localhost:3000/api/auth${path}${params ? `?${params}` : ''}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:3000',
            ...(sessionCookie ? { cookie: sessionCookie } : {}),
          },
          body: JSON.stringify(body),
        },
      ),
    );
  const email = 'desktop-check@example.com';
  const signup = await call(
    '/sign-up/email',
    {
      email,
      password: 'test-password-12345',
      name: 'Student',
      callbackURL: getAuthRedirect(query),
    },
    undefined,
    query,
  );
  expect(signup.status).toBe(200);
  expect((await signup.json()).token).toBeNull();
  const { otp } = mail.send.mock.calls.at(-1)![0] as { otp: string };
  const verified = await call(
    '/email-otp/verify-email',
    { email, otp },
    undefined,
    query,
  );
  expect(verified.status).toBe(200);
  expect((await verified.json()).user.emailVerified).toBe(true);
  const browserCookie = cookie(verified);
  const transfer = async () => {
    const result = await call(
      '/electron/transfer-user',
      {},
      browserCookie,
      new URLSearchParams(desktop),
    );
    expect(result.status).toBe(200);
    return (await result.json()).electron_authorization_code as string;
  };
  const token = await transfer();
  const wrongVerifier = await call('/electron/token', {
    token,
    state: desktop.state,
    code_verifier: 'wrong-verifier',
  });
  expect(wrongVerifier.status).toBe(400);
  const wrongStateToken = await transfer();
  expect(
    (
      await call('/electron/token', {
        token: wrongStateToken,
        state: 'wrong-state',
        code_verifier: verifier,
      })
    ).status,
  ).toBe(400);
  const validToken = await transfer();
  const redeemed = await call('/electron/token', {
    token: validToken,
    state: desktop.state,
    code_verifier: verifier,
  });
  expect(redeemed.status).toBe(200);
  expect((await redeemed.json()).user.email).toBe(email);
  expect(
    (
      await call('/electron/token', {
        token: validToken,
        state: desktop.state,
        code_verifier: verifier,
      })
    ).status,
  ).toBe(404);
  const restored = await auth.api.getSession({
    headers: new Headers({ cookie: cookie(redeemed) }),
  });
  expect(restored?.user.email).toBe(email);
});
