import { getCurrentUser } from '@/lib/auth/helpers';

export const runtime = 'nodejs';

export const GET = async (request: Request) => {
  const user = await getCurrentUser(request.headers);
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json({ user }, { headers: { 'Cache-Control': 'no-store' } });
};
