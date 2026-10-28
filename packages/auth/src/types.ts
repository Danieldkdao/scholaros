import type { auth } from './server';

export type Session = typeof auth.$Infer.Session;
export type User = Session['user'];

export type DesktopAuthQuery = {
  client_id: string;
  state: string;
  code_challenge: string;
};
