import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/route-tree.gen.ts',
      autoCodeSplitting: true,
      routeTreeFileHeader: [
        '/* eslint-disable */',
        '/* oxlint-disable */',
        '// @ts-nocheck',
      ],
    }),
    react(),
    tailwindcss(),
  ],
  build: {
    // Keep AudioWorklet modules file-backed in the packaged renderer.
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    entries: ['src/renderer.tsx'],
  },
  resolve: {
    // Resolve linked workspace packages as source so they retain hot reloading.
    preserveSymlinks: false,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
