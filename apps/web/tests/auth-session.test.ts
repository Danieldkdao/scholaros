import { beforeEach, expect, test, vi } from 'vitest';
import { getCurrentUser } from '../src/lib/auth/helpers';
import { GET } from '../src/app/api/me/route';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requestHeaders: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: mocks.requestHeaders }));
vi.mock('../src/lib/auth/index', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock('@scholaros/cloud-db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: mocks.lookup }) }),
    }),
  },
}));

beforeEach(() => vi.resetAllMocks());

test('an anonymous result object is rejected by the protected route', async () => {
  mocks.getSession.mockResolvedValue(null);
  const response = await GET(new Request('https://scholaros.example/api/me'));
  expect(response.status).toBe(401);
  expect(mocks.lookup).not.toHaveBeenCalled();
});

test('the helper returns one user and the route never exposes the session token', async () => {
  const user = {
    id: 'student-id',
    name: 'Student',
    email: 'student@example.com',
  };
  const session = { id: 'session-id', token: 'private-session-token' };
  mocks.getSession.mockResolvedValue({ user, session });
  mocks.lookup.mockResolvedValue([user]);
  const headers = new Headers({ cookie: 'session=test' });
  expect(await getCurrentUser(headers)).toEqual({
    userId: user.id,
    user,
    session,
  });
  expect(mocks.getSession).toHaveBeenCalledWith({ headers });
  const response = await GET(
    new Request('https://scholaros.example/api/me', { headers }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ user });
});

test('a deleted user and lookup errors fail closed', async () => {
  mocks.getSession.mockResolvedValue({
    user: { id: 'missing' },
    session: { id: 's' },
  });
  mocks.lookup.mockResolvedValue([]);
  expect(
    (await GET(new Request('https://scholaros.example/api/me'))).status,
  ).toBe(401);
  mocks.getSession.mockRejectedValue(new Error('Service unavailable'));
  expect(
    (await GET(new Request('https://scholaros.example/api/me'))).status,
  ).toBe(401);
});
