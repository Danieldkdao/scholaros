import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

const loadPackagedRunner = async () =>
  import('./fixtures/packaged-product-runner').catch(() => null);

it('retains blank-page and truncation results from the packaged PDF probe', async () => {
  const runner = await loadPackagedRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  expect(
    runner.parsePackagedPdfProbe(
      'SCHOLAROS_PACKAGED_PDF_RESULT={"complete":{"status":"complete","pageCount":3,"text":"First page\\f\\fThird page"},"bounded":{"status":"partial","pageCount":3,"text":"First page"}}',
    ),
  ).toEqual({
    complete: {
      status: 'complete',
      pageCount: 3,
      text: 'First page\f\fThird page',
    },
    bounded: {
      status: 'partial',
      pageCount: 3,
      text: 'First page',
    },
  });
});

it('parses process.versions emitted by the packaged Electron main process', async () => {
  const runner = await loadPackagedRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  expect(
    runner.parseRuntimeVersions(
      'startup log\nSCHOLAROS_RUNTIME_VERSIONS={"electron":"45.0.0","node":"26.0.0","chrome":"156.0.0.0","v8":"14.0.0","modules":"137"}\n',
    ),
  ).toEqual({
    electron: '45.0.0',
    node: '26.0.0',
    chrome: '156.0.0.0',
    v8: '14.0.0',
    modules: '137',
  });
});

it('parses the test API origin compiled into the packaged runtime', async () => {
  const runner = await loadPackagedRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  expect(
    runner.parsePackagedTestApiUrl(
      'SCHOLAROS_TEST_API_URL=http://127.0.0.1:39787',
    ),
  ).toBe('http://127.0.0.1:39787');
});

it('rejects non-loopback API origins in the packaged runtime marker', async () => {
  const runner = await loadPackagedRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  expect(() =>
    runner.parsePackagedTestApiUrl(
      'SCHOLAROS_TEST_API_URL=https://api.example.invalid',
    ),
  ).toThrow('explicit 127.0.0.1 test origin');
});

it('discovers a macOS bundle only inside the owned package output directory', async () => {
  const runner = await loadPackagedRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  const fixtureRoot = await mkdtemp(
    path.join(
      process.env.SCHOLAROS_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? tmpdir(),
      'scholaros-packaged-runner-',
    ),
  );
  const appBundlePath = path.join(
    fixtureRoot,
    'out',
    'scholaros-darwin-arm64',
    'scholaros.app',
  );

  try {
    await mkdir(path.join(appBundlePath, 'Contents', 'MacOS'), {
      recursive: true,
    });
    await writeFile(
      path.join(appBundlePath, 'Contents', 'MacOS', 'scholaros'),
      'test-owned placeholder, never executed',
    );

    const result = await runner.findPackagedApplication(
      path.join(fixtureRoot, 'out'),
      'scholaros',
    );

    const resolvedBundlePath = await realpath(appBundlePath);
    expect(result.appBundlePath).toBe(resolvedBundlePath);
    expect(result.executablePath).toBe(
      path.join(resolvedBundlePath, 'Contents', 'MacOS', 'scholaros'),
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

it('refuses to follow a package executable symlink outside owned output', async () => {
  const runner = await loadPackagedRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  const fixtureRoot = await mkdtemp(
    path.join(
      process.env.SCHOLAROS_TEST_TEMP_ROOT ?? process.env.TMPDIR ?? tmpdir(),
      'scholaros-packaged-link-',
    ),
  );
  const outputDirectory = path.join(fixtureRoot, 'out');
  const executablePath = path.join(
    outputDirectory,
    'scholaros-darwin-arm64',
    'scholaros.app',
    'Contents',
    'MacOS',
    'scholaros',
  );
  const outsideExecutable = path.join(fixtureRoot, 'installed', 'scholaros');

  try {
    await mkdir(path.dirname(executablePath), { recursive: true });
    await mkdir(path.dirname(outsideExecutable), { recursive: true });
    await writeFile(
      outsideExecutable,
      'test-owned placeholder, never executed',
    );
    await symlink(outsideExecutable, executablePath);

    await expect(
      runner.findPackagedApplication(outputDirectory, 'scholaros'),
    ).rejects.toThrow('found 0');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'darwin')(
  'keeps macOS HOME while isolating temporary and profile paths',
  async () => {
    const { createTestEnvironment } =
      await import('./fixtures/whole-product-runner');
    const environment = createTestEnvironment('/test-owned-profile');
    expect(environment.HOME).toBe(process.env.HOME);
    expect(environment.USERPROFILE).toBe('/test-owned-profile');
    expect(environment.TMPDIR).toBe('/test-owned-profile');
    expect(environment.TMP).toBe('/test-owned-profile');
    expect(environment.TEMP).toBe('/test-owned-profile');
    expect(environment.APPDATA).toBe('/test-owned-profile/AppData/Roaming');
    expect(environment.LOCALAPPDATA).toBe('/test-owned-profile/AppData/Local');
    expect(Object.keys(environment)).not.toContain('AWS_SECRET_ACCESS_KEY');
  },
);

const packagedIntegrationTest =
  process.env.RUN_PACKAGED_PRODUCT_INTEGRATION === '1' ? it : it.skip;

const packagedSmokeTest =
  process.env.RUN_PACKAGED_PRODUCT_SMOKE === '1' ? it : it.skip;

const packagedInspectionTest =
  process.env.RUN_PACKAGED_PRODUCT_INSPECTION === '1' ? it : it.skip;

packagedInspectionTest(
  'inspects actual packaged fuses and resources without launching Electron',
  async () => {
    const runner = await loadPackagedRunner();
    expect(runner).not.toBeNull();
    if (!runner) return;

    const result = await runner.inspectPackagedProduct();
    console.info(
      `PACKAGED_PRODUCT_INSPECTION=${JSON.stringify({
        appBundlePath: result.application.appBundlePath,
        testApiUrl: result.testApiUrl,
        fuses: result.fuses,
        resources: result.resources,
        featureAssets: result.featureAssets,
      })}`,
    );

    expect(result.testApiUrl).toBe(process.env.VITE_API_URL);
    expect(result.fuses.RunAsNode).toBe('disabled');
    expect(result.fuses.EnableCookieEncryption).toBe('enabled');
    expect(result.fuses.EnableNodeOptionsEnvironmentVariable).toBe('disabled');
    expect(result.fuses.EnableNodeCliInspectArguments).toBe('disabled');
    expect(result.fuses.EnableEmbeddedAsarIntegrityValidation).toBe('enabled');
    expect(result.fuses.OnlyLoadAppFromAsar).toBe('enabled');
    expect(result.resources).toEqual([]);
  },
);

packagedSmokeTest(
  'smokes the packaged base runtime and reports remaining product gates',
  async () => {
    const runner = await loadPackagedRunner();
    expect(runner).not.toBeNull();
    if (!runner) return;

    const result = await runner.verifyPackagedProduct();
    console.info(
      `PACKAGED_PRODUCT_REPORT=${JSON.stringify({
        testApiUrl: result.testApiUrl,
        runtimeVersions: result.runtimeVersions,
        currentUser: result.currentUser,
        fuses: result.fuses,
        nativeDatabase: result.nativeDatabase,
        resources: result.resources,
        featureAssets: result.featureAssets,
        endpointRequestCount: result.endpointRequestCount,
        unverifiedJourneys: result.unverifiedJourneys,
        pdfProbe: result.pdfProbe,
      })}`,
    );

    expect(result.runtimeVersions.electron).toBe(
      result.expectedElectronVersion,
    );
    expect(result.testApiUrl).toBe(process.env.VITE_API_URL);
    expect(result.currentUser).toBeNull();
    expect(result.endpointRequestCount).toBe(0);
    expect(result.nativeDatabase.migrationCount).toBeGreaterThan(0);
    expect(result.nativeDatabase.ftsInsertMatches).toBe(1);
    expect(result.nativeDatabase.ftsDeleteMatches).toBe(0);
    expect(result.resources).toEqual([]);
    expect(result.pdfProbe).toEqual({
      complete: {
        status: 'complete',
        pageCount: 3,
        text: 'First page\f\fThird page',
      },
      bounded: {
        status: 'partial',
        pageCount: 3,
        text: 'First page',
      },
    });
  },
  120_000,
);

packagedIntegrationTest(
  'verifies the packaged Electron fuses, runtime, native database and resources',
  async () => {
    const runner = await loadPackagedRunner();
    expect(runner).not.toBeNull();
    if (!runner) return;

    const result = await runner.verifyPackagedProduct();

    expect(result.runtimeVersions.electron).toBe(
      result.expectedElectronVersion,
    );
    expect(result.testApiUrl).toBe(process.env.VITE_API_URL);
    expect(result.fuses.RunAsNode).toBe('disabled');
    expect(result.fuses.EnableCookieEncryption).toBe('enabled');
    expect(result.fuses.EnableNodeOptionsEnvironmentVariable).toBe('disabled');
    expect(result.fuses.EnableNodeCliInspectArguments).toBe('disabled');
    expect(result.fuses.EnableEmbeddedAsarIntegrityValidation).toBe('enabled');
    expect(result.fuses.OnlyLoadAppFromAsar).toBe('enabled');
    expect(result.nativeDatabase.migrationCount).toBeGreaterThan(0);
    expect(result.nativeDatabase.ftsInsertMatches).toBe(1);
    expect(result.nativeDatabase.ftsDeleteMatches).toBe(0);
    expect(result.currentUser).toBeNull();
    expect(result.endpointRequestCount).toBe(0);
    expect(result.pdfProbe).toEqual({
      complete: {
        status: 'complete',
        pageCount: 3,
        text: 'First page\f\fThird page',
      },
      bounded: {
        status: 'partial',
        pageCount: 3,
        text: 'First page',
      },
    });
    expect(result.resources).toEqual([]);
    expect(result.featureAssets).toEqual([]);
  },
  120_000,
);
