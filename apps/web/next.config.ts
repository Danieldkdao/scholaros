import { createServerEnvironment } from '@scholaros/env/server-config';
import './src/data/env/client';
import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@scholaros/assets',
    '@scholaros/ui',
    '@scholaros/env',
    '@scholaros/cloud-db',
    '@scholaros/auth',
    '@scholaros/services',
    '@scholaros/lib',
  ],
  turbopack: {
    root: fileURLToPath(new URL('../..', import.meta.url)),
  },
};

export default async (): Promise<NextConfig> => {
  // The opt-in public demo needs only its Meta key. Authenticated modules still
  // validate their complete server environment when those features are loaded.
  if (process.env.DEMO_API_ENABLED !== '1') createServerEnvironment();
  return nextConfig;
};
