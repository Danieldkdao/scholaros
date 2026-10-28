import 'server-only';
import { headers } from 'next/headers';
import { auth } from './index';

export const getCurrentUser = async (requestHeaders?: Headers) => {
  try {
    const session = await auth.api.getSession({
      headers: requestHeaders ?? (await headers()),
    });
    return session?.user ?? null;
  } catch {
    return null;
  }
};
