import { getCurrentUser } from '@/lib/auth/helpers';
import { db } from '@scholaros/cloud-db';
import { user } from '@scholaros/cloud-db/schema';
import { eq } from 'drizzle-orm';
import { serverEnv } from '@/data/env/server';

export const runtime = 'nodejs';
export const POST = async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(serverEnv.BETTER_AUTH_URL).origin)
    return Response.json({ error: 'Invalid origin' }, { status: 403 });
  const currentUser = await getCurrentUser(request.headers);
  if (!currentUser?.userId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    await db
      .update(user)
      .set({ hasCompletedOnboarding: true })
      .where(eq(user.id, currentUser.userId));
    return Response.json(
      { completed: true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: 'Unable to finish onboarding' },
      { status: 503 },
    );
  }
};
