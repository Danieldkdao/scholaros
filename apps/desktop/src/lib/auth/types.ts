import type { authClient } from './client';

type AuthBridges = typeof authClient.$Infer.Bridges;

declare global {
  interface Window extends AuthBridges {}
}
