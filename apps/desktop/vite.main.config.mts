import { defineConfig, type Plugin } from 'vite';
import {
  stagehandExtensionArchive,
  stagehandExtensionDirectory,
} from './stagehand-assets.mts';

const packagedPath = (name: string) =>
  `require('node:path').join(process.resourcesPath, ${JSON.stringify(name)})`;

// Vite runs in Node tooling, where the app's typed env module is unavailable.
const packagedRuntimeProbeEnabled =
  process.env.SCHOLAROS_PACKAGED_RUNTIME_PROBE === '1';
const validatePackagedTestApiUrl = (value: string | undefined) => {
  if (!value) throw new Error('A test-only loopback VITE_API_URL is required.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VITE_API_URL is not a valid test endpoint URL.');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('VITE_API_URL must be an explicit 127.0.0.1 test origin.');

  return value;
};
const packagedRuntimeProbeApiUrl = packagedRuntimeProbeEnabled
  ? validatePackagedTestApiUrl(process.env.VITE_API_URL)
  : null;

// Vite inlines import.meta.url as a data URL in CJS output, which Stagehand resolves as a base URL.
const stagehandImportMetaUrl: Plugin = {
  name: 'stagehand-import-meta-url',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('@browserbasehq/stagehand')) return null;
    return {
      code: code.replaceAll(
        'import.meta.url',
        'require("node:url").pathToFileURL(__filename).href',
      ),
      map: null,
    };
  },
};

const packagedRuntimeProbe: Plugin = {
  name: 'packaged-runtime-probe',
  enforce: 'pre',
  transform(code, id) {
    if (
      !packagedRuntimeProbeEnabled ||
      !id.replaceAll('\\', '/').endsWith('/src/main.ts')
    )
      return null;
    if (!packagedRuntimeProbeApiUrl)
      throw new Error('A test-only loopback VITE_API_URL is required.');

    const probe = [
      `process.stdout.write("SCHOLAROS_TEST_API_URL=" + ${JSON.stringify(packagedRuntimeProbeApiUrl)} + "\\n");`,
      'process.stdout.write("SCHOLAROS_RUNTIME_VERSIONS=" + JSON.stringify(process.versions) + "\\n");',
      "const pdfProbeArgument = process.argv.find((argument) => argument.startsWith('--scholaros-pdf-probe='));",
      'const runPackagedPdfProbe = async () => {',
      '  try {',
      '    const [{ extractPdfContent }, { readFile }] = await Promise.all([',
      "      import('./features/context/services/pdf-content'),",
      "      import('node:fs/promises'),",
      '    ]);',
      "    const pdfBytes = await readFile(pdfProbeArgument.slice('--scholaros-pdf-probe='.length));",
      '    const complete = await extractPdfContent(pdfBytes);',
      '    const bounded = await extractPdfContent(pdfBytes, { maxCharacters: 10 });',
      '    process.stdout.write("SCHOLAROS_PACKAGED_PDF_RESULT=" + JSON.stringify({ complete, bounded }) + "\\n");',
      '  } catch {',
      '    process.stdout.write("SCHOLAROS_PACKAGED_PDF_PROBE_FAILED\\n");',
      '  }',
      '};',
    ].join('\n');
    const serviceStartAnchor = 'await runAcademicService();';
    const mainWithProbe = code.replace(
      serviceStartAnchor,
      `${serviceStartAnchor}\n      if (pdfProbeArgument) await runPackagedPdfProbe();`,
    );
    if (mainWithProbe === code)
      throw new Error(
        'The packaged runtime probe could not find service startup.',
      );

    return {
      code: `${probe}\n${mainWithProbe}`,
      map: null,
    };
  },
};

export default defineConfig({
  plugins: [stagehandImportMetaUrl, packagedRuntimeProbe],
  define: {
    // Stagehand loads its extension from app resources after packaging.
    'process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH': `(require('electron').app.isPackaged ? ${packagedPath('extension')} : ${JSON.stringify(stagehandExtensionDirectory)})`,
    'process.env.STAGEHAND_EXTENSION_ARCHIVE_PATH': `(require('electron').app.isPackaged ? ${packagedPath('stagehand-extension.zip')} : ${JSON.stringify(stagehandExtensionArchive)})`,
  },
  build: {
    rolldownOptions: {
      external: ['better-sqlite3', '@napi-rs/canvas'],
    },
  },
});
