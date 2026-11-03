import { desktopScheme } from '@scholaros/auth/constants';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import path from 'node:path';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import {
  stagehandExtensionArchive,
  stagehandExtensionDirectory,
} from './stagehand-assets.mts';

const packageRequire = createRequire(import.meta.url);
const sqlitePackage = path.dirname(
  packageRequire.resolve('better-sqlite3/package.json'),
);
const pdfjsPackage = path.resolve(
  path.dirname(packageRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
  '../..',
);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [
      path.resolve('src/db/migrations'),
      stagehandExtensionDirectory,
      stagehandExtensionArchive,
    ],
    protocols: [{ name: 'ScholarOS', schemes: [desktopScheme] }],
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      // Forge's Vite plugin omits runtime packages that use dynamic resolution.
      await Promise.all([
        cp(sqlitePackage, path.join(buildPath, 'node_modules/better-sqlite3'), {
          recursive: true,
        }),
        cp(pdfjsPackage, path.join(buildPath, 'node_modules/pdfjs-dist'), {
          recursive: true,
        }),
      ]);
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
