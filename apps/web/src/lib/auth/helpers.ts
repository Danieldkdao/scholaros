import 'server-only';
import { headers } from 'next/headers';
import { auth } from './index';
import { db } from '@scholaros/cloud-db';
import { user } from '@scholaros/cloud-db/schema';
import { eq } from 'drizzle-orm';

export const getCurrentUser = async (requestHeaders?: Headers) => {
  try {
    const session = await auth.api.getSession({
      headers: requestHeaders ?? (await headers()),
    });
    if (!session?.user.id)
      return { userId: null, user: null, session: undefined };
    const [existingUser] = await db
      .select()
      .from(user)
      .where(eq(user.id, session.user.id))
      .limit(1);
    if (!existingUser) return { userId: null, user: null, session: undefined };
    return {
      userId: existingUser.id,
      user: existingUser,
      session: session.session,
    };
  } catch {
    return null;
  }
};
