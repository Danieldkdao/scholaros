import { betterAuth } from 'better-auth';
import { authOptions } from './options';

// The CLI supplies the Drizzle dialect without loading the server-only database.
export const auth = betterAuth(authOptions);
