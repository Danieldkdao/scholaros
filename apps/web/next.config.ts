import './src/data/env/server';
import './src/data/env/client';
import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@scholaros/ui',
    '@scholaros/env',
    '@scholaros/cloud-db',
    '@scholaros/auth',
    '@scholaros/services',
  ],
  turbopack: {
    root: fileURLToPath(new URL('../..', import.meta.url)),
  },
};

export default nextConfig;
