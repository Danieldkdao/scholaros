import { getCurrentUser } from '@/lib/auth/helpers';

export const runtime = 'nodejs';

export const GET = async (request: Request) => {
  const currentUser = await getCurrentUser(request.headers);
  if (!currentUser?.userId || !currentUser.user || !currentUser.session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json(
    { user: currentUser.user },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};
