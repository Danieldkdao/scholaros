import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import {
  createPdfFixture,
  parsePackagedTestApiUrl,
  startPackagedAcademicService,
} from './whole-product-runner';

export {
  parsePackagedPdfProbe,
  parsePackagedTestApiUrl,
  parseRuntimeVersions,
} from './whole-product-runner';

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export type PackagedApplication = {
  appBundlePath: string;
  executablePath: string;
  resourcesPath: string;
  asarPath: string;
};

const isWithinDirectory = (root: string, candidate: string) => {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
};

export const findPackagedApplication = async (
  outputDirectory: string,
  productName: string,
): Promise<PackagedApplication> => {
  const outputRoot = await realpath(outputDirectory);
  const bundleName = `${productName}.app`;
  const candidates: PackagedApplication[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidatePath = path.join(directory, entry.name);
      if (entry.name === bundleName) {
        const executablePath = path.join(
          candidatePath,
          'Contents',
          'MacOS',
          productName,
        );
        if (!isWithinDirectory(outputRoot, candidatePath))
          throw new Error(
            'Packaged app is outside the owned output directory.',
          );
        const executableStats = await lstat(executablePath).catch(() => null);
        if (!executableStats?.isFile()) continue;
        const resourcesPath = path.join(candidatePath, 'Contents', 'Resources');
        candidates.push({
          appBundlePath: candidatePath,
          executablePath,
          resourcesPath,
          asarPath: path.join(resourcesPath, 'app.asar'),
        });
        continue;
      }
      await visit(candidatePath, depth + 1);
    }
  };

  await visit(outputRoot, 0);
  if (candidates.length !== 1)
    throw new Error(
      `Expected one test-owned ${bundleName} under the package output directory; found ${candidates.length}.`,
    );
  return candidates[0]!;
};

const fuseStateName = (state: FuseState | undefined) => {
  switch (state) {
    case FuseState.ENABLE:
      return 'enabled';
    case FuseState.DISABLE:
      return 'disabled';
    case FuseState.REMOVED:
      return 'removed';
    case FuseState.INHERIT:
      return 'inherited';
    default:
      return 'unknown';
  }
};

const readFuseStates = async (executablePath: string) => {
  const wire = await getCurrentFuseWire(executablePath);
  return {
    RunAsNode: fuseStateName(wire[FuseV1Options.RunAsNode]),
    EnableCookieEncryption: fuseStateName(
      wire[FuseV1Options.EnableCookieEncryption],
    ),
    EnableNodeOptionsEnvironmentVariable: fuseStateName(
      wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable],
    ),
    EnableNodeCliInspectArguments: fuseStateName(
      wire[FuseV1Options.EnableNodeCliInspectArguments],
    ),
    EnableEmbeddedAsarIntegrityValidation: fuseStateName(
      wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],
    ),
    OnlyLoadAppFromAsar: fuseStateName(wire[FuseV1Options.OnlyLoadAppFromAsar]),
  };
};

const asarContains = (asarPath: string, entryPath: string) => {
  try {
    statFile(asarPath, entryPath);
    return true;
  } catch {
    return false;
  }
};

const packagedResourceGaps = async (
  application: PackagedApplication,
  packageFiles: string[],
) => {
  const gaps: string[] = [];
  const hasEntry = (file: string) => asarContains(application.asarPath, file);
  const hasNonemptyDirectory = async (directory: string) => {
    try {
      return (await readdir(directory)).length > 0;
    } catch {
      return false;
    }
  };

  if (!(await stat(application.asarPath).catch(() => null)))
    gaps.push('app.asar');
  if (!hasEntry('.vite/build/main.cjs')) gaps.push('main bundle');
  if (!hasEntry('.vite/build/preload.cjs')) gaps.push('preload bundle');
  if (!hasEntry('.vite/renderer/main_window/index.html'))
    gaps.push('renderer entry');
  if (!hasEntry('node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
    gaps.push('PDF.js module');
  if (!hasEntry('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'))
    gaps.push('PDF.js worker');
  if (
    !(await hasNonemptyDirectory(
      path.join(application.resourcesPath, 'migrations'),
    ))
  )
    gaps.push('migration resources');
  if (
    !existsSync(
      path.join(
        application.resourcesPath,
        'migrations',
        '0015_whole-product.sql',
      ),
    )
  )
    gaps.push('latest migration');
  if (
    !(await hasNonemptyDirectory(
      path.join(application.resourcesPath, 'extension'),
    ))
  )
    gaps.push('Stagehand extension directory');

  const extensionArchive = path.join(
    application.resourcesPath,
    'stagehand-extension.zip',
  );
  if (!(await stat(extensionArchive).catch(() => null)))
    gaps.push('Stagehand extension archive');

  const nativeModulePaths = [
    path.join(
      application.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    ),
    path.join(
      application.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      `${process.platform}-${process.arch}.node`,
    ),
  ];
  const hasNativeModule = (
    await Promise.all(
      nativeModulePaths.map(
        async (nativeModulePath) =>
          (await stat(nativeModulePath).catch(() => null))?.isFile() ?? false,
      ),
    )
  ).some(Boolean);
  if (!hasNativeModule) gaps.push('unpacked better-sqlite3 native module');

  if (
    !packageFiles.some((file) => file.includes('.vite/renderer/main_window/'))
  )
    gaps.push('packaged renderer resources');
  return gaps;
};

const featureAssetGaps = (
  application: PackagedApplication,
  packageFiles: string[],
) => {
  const gaps: string[] = [];
  const activitySdkSource = path.join(
    desktopRoot,
    'src/features/study/lib/activity-runtime-sdk.ts',
  );
  const workletSource = path.join(
    desktopRoot,
    'src/features/speech/lib/pcm-worklet.ts',
  );
  if (!existsSync(activitySdkSource))
    gaps.push('activity runtime SDK source is not integrated');
  if (!existsSync(workletSource))
    gaps.push('AudioWorklet source is not integrated');

  const rendererBundles = packageFiles.filter(
    (file) =>
      file.includes('.vite/renderer/main_window/') && /\.(?:m?js)$/.test(file),
  );
  const sdkProtocolIncluded = rendererBundles.some((file) =>
    extractFile(application.asarPath, file)
      .toString('utf8')
      .includes('state-proposed'),
  );
  if (existsSync(activitySdkSource) && !sdkProtocolIncluded)
    gaps.push('activity SDK protocol is missing from renderer bundles');

  const workletBundle = packageFiles.find(
    (file) => file.includes('pcm-worklet') && /\.(?:m?js)$/.test(file),
  );
  if (existsSync(workletSource) && !workletBundle)
    gaps.push('PCM worklet was not emitted as a packaged JavaScript asset');
  if (workletBundle) {
    const worklet = extractFile(application.asarPath, workletBundle).toString(
      'utf8',
    );
    if (!worklet.includes('registerProcessor'))
      gaps.push('packaged worklet does not register an AudioWorklet processor');
  }

  return gaps;
};

const nativeDatabaseProbe = (databasePath: string) => {
  const script = `import json, sqlite3, sys, uuid
path = sys.argv[1]
connection = sqlite3.connect(path)
tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
required = {'__drizzle_migrations', 'context_chunks', 'context_chunks_fts', 'course_material_chunks_fts'}
missing = sorted(required - tables)
if missing:
    raise RuntimeError('Missing required migrated SQLite tables.')
migration_count = connection.execute('SELECT count(*) FROM __drizzle_migrations').fetchone()[0]
token = 'packagedfixturetoken' + uuid.uuid4().hex
connection.execute('INSERT INTO context_chunks (id, user_id, item_id, version_id, ordinal, locator, text) VALUES (?, ?, ?, ?, ?, ?, ?)', (token, 'p32-test-user', token, token, 0, None, token))
connection.commit()
insert_matches = connection.execute('SELECT count(*) FROM context_chunks_fts WHERE context_chunks_fts MATCH ?', (token,)).fetchone()[0]
connection.execute('DELETE FROM context_chunks WHERE id = ?', (token,))
connection.commit()
delete_matches = connection.execute('SELECT count(*) FROM context_chunks_fts WHERE context_chunks_fts MATCH ?', (token,)).fetchone()[0]
connection.close()
if migration_count < 1 or insert_matches != 1 or delete_matches != 0:
    raise RuntimeError('Packaged SQLite migration or FTS trigger probe failed.')
print(json.dumps({'migrationCount': migration_count, 'ftsInsertMatches': insert_matches, 'ftsDeleteMatches': delete_matches}))`;
  const profileDirectory = path.dirname(path.dirname(databasePath));
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: profileDirectory,
    TMPDIR: profileDirectory,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
  };
  const output = execFileSync('python3', ['-c', script, databasePath], {
    cwd: desktopRoot,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(output) as {
    migrationCount: number;
    ftsInsertMatches: number;
    ftsDeleteMatches: number;
  };
};

export const inspectPackagedProduct = async () => {
  if (process.platform !== 'darwin')
    throw new Error('The packaged .app verification is macOS-only.');

  const packageManifest = JSON.parse(
    await readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
  ) as {
    productName: string;
    devDependencies: { electron: string };
  };
  const application = await findPackagedApplication(
    path.join(desktopRoot, 'out'),
    packageManifest.productName,
  );
  const testApiUrl = parsePackagedTestApiUrl(
    `SCHOLAROS_TEST_API_URL=${process.env.VITE_API_URL ?? ''}`,
  );
  const mainBundle = extractFile(
    application.asarPath,
    '.vite/build/main.cjs',
  ).toString('utf8');
  if (
    !mainBundle.includes('SCHOLAROS_TEST_API_URL=') ||
    !mainBundle.includes(testApiUrl)
  )
    throw new Error(
      'Packaged main bundle does not report the test-owned API origin.',
    );
  const packageFiles = listPackage(application.asarPath, { isPack: false }).map(
    (file) => file.replace(/^\/+/, ''),
  );
  const fuses = await readFuseStates(application.executablePath);
  const resources = await packagedResourceGaps(application, packageFiles);
  const featureAssets = featureAssetGaps(application, packageFiles);
  return {
    application,
    expectedElectronVersion: packageManifest.devDependencies.electron.replace(
      /^[^0-9]*/,
      '',
    ),
    testApiUrl,
    fuses,
    resources,
    featureAssets,
  };
};

export const verifyPackagedProduct = async () => {
  const inspection = await inspectPackagedProduct();
  const { application } = inspection;
  const runtime = await startPackagedAcademicService(
    application.executablePath,
    { pdfFixture: createPdfFixture(['First page', '', 'Third page']) },
  );

  let currentUser: unknown;
  let nativeDatabase: ReturnType<typeof nativeDatabaseProbe> | null = null;
  try {
    currentUser = await runtime.request('getCurrentUser');
    await runtime.shutdown();
    nativeDatabase = nativeDatabaseProbe(
      path.join(runtime.userDataDirectory, 'data', 'scholaros.sqlite'),
    );
  } finally {
    await runtime.dispose();
  }

  return {
    appBundlePath: application.appBundlePath,
    expectedElectronVersion: inspection.expectedElectronVersion,
    testApiUrl: runtime.testApiUrl,
    runtimeVersions: runtime.runtimeVersions,
    pdfProbe: runtime.pdfProbe,
    currentUser,
    endpointRequestCount: runtime.endpointRequestCount(),
    fuses: inspection.fuses,
    nativeDatabase,
    resources: inspection.resources,
    featureAssets: inspection.featureAssets,
    unverifiedJourneys: [
      'scanned/handwritten PDF import and full Context source lifecycle',
      'activity state restore across packaged app restart/offline',
      'actual Stagehand browser launch and navigation',
      'WebRTC/OS-level activity isolation attacks',
      'signed/notarized distribution behavior',
    ],
  };
};
