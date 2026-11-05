import { desktopScheme } from '@scholaros/auth/constants';
import type {
  ForgeArch,
  ForgeConfig,
  ForgePlatform,
} from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import path from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { stageRuntimePackage } from './stage-runtime-package.mts';
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
const canvasPackage = path.dirname(
  packageRequire.resolve('@napi-rs/canvas/package.json'),
);

export const canvasNativePackageNamesForTarget = (
  platform: ForgePlatform,
  arch: ForgeArch,
  usesGlibc = true,
): string[] => {
  switch (`${platform}-${arch}`) {
    case 'darwin-arm64':
    case 'mas-arm64':
      return ['@napi-rs/canvas-darwin-arm64'];
    case 'darwin-x64':
    case 'mas-x64':
      return ['@napi-rs/canvas-darwin-x64'];
    case 'win32-arm64':
      return ['@napi-rs/canvas-win32-arm64-msvc'];
    case 'win32-x64':
      return ['@napi-rs/canvas-win32-x64-msvc'];
    case 'linux-armv7l':
      return ['@napi-rs/canvas-linux-arm-gnueabihf'];
    case 'linux-arm64':
      return [
        usesGlibc
          ? '@napi-rs/canvas-linux-arm64-gnu'
          : '@napi-rs/canvas-linux-arm64-musl',
      ];
    case 'linux-x64':
      return [
        usesGlibc
          ? '@napi-rs/canvas-linux-x64-gnu'
          : '@napi-rs/canvas-linux-x64-musl',
      ];
    default:
      throw new Error(
        `Unsupported @napi-rs/canvas target: ${platform}-${arch}`,
      );
  }
};

const canvasUsesGlibc = (platform: ForgePlatform) => {
  if (platform !== 'linux' || process.platform !== 'linux') return true;
  const report = process.report.getReport() as {
    header?: { glibcVersionRuntime?: string };
  };
  return typeof report.header?.glibcVersionRuntime === 'string';
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [
      path.resolve('src/db/migrations'),
      stagehandExtensionDirectory,
      stagehandExtensionArchive,
    ],
    protocols: [{ name: 'ScholarOS', schemes: [desktopScheme] }],
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({ timestamp: 'none' }),
    },
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (
      _forgeConfig,
      buildPath,
      _electronVersion,
      platform,
      arch,
    ) => {
      // Forge's Vite plugin omits runtime packages that use dynamic resolution.
      const canvasNativePackageNames = canvasNativePackageNamesForTarget(
        platform,
        arch,
        canvasUsesGlibc(platform),
      );
      const canvasNativePackages = canvasNativePackageNames.map((name) => ({
        name,
        path: path.dirname(packageRequire.resolve(`${name}/package.json`)),
      }));
      const napiPackagesDirectory = path.join(
        buildPath,
        'node_modules/@napi-rs',
      );
      await mkdir(napiPackagesDirectory, { recursive: true });
      await Promise.all([
        stageRuntimePackage('mammoth', buildPath),
        cp(sqlitePackage, path.join(buildPath, 'node_modules/better-sqlite3'), {
          recursive: true,
        }),
        cp(pdfjsPackage, path.join(buildPath, 'node_modules/pdfjs-dist'), {
          recursive: true,
        }),
        cp(canvasPackage, path.join(napiPackagesDirectory, 'canvas'), {
          recursive: true,
        }),
        ...canvasNativePackages.map(({ name, path: nativePackage }) =>
          cp(nativePackage, path.join(buildPath, 'node_modules', name), {
            recursive: true,
          }),
        ),
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
        {
          entry: {
            'image-decoder': 'src/features/context/workers/image-decoder.ts',
          },
          config: 'vite.main.config.mts',
          target: 'main',
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
