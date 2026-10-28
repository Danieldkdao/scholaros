import type { auth } from './server';

export type Session = typeof auth.$Infer.Session;
export type User = Session['user'];
