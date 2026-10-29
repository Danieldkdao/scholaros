import { defineConfig, type Plugin } from 'vite';
import {
  stagehandExtensionArchive,
  stagehandExtensionDirectory,
} from './stagehand-assets.mts';

const packagedPath = (name: string) =>
  `require('node:path').join(process.resourcesPath, ${JSON.stringify(name)})`;

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

export default defineConfig({
  plugins: [stagehandImportMetaUrl],
  define: {
    // Stagehand loads its extension from app resources after packaging.
    'process.env.STAGEHAND_EXTENSION_DIRECTORY_PATH': `(require('electron').app.isPackaged ? ${packagedPath('extension')} : ${JSON.stringify(stagehandExtensionDirectory)})`,
    'process.env.STAGEHAND_EXTENSION_ARCHIVE_PATH': `(require('electron').app.isPackaged ? ${packagedPath('stagehand-extension.zip')} : ${JSON.stringify(stagehandExtensionArchive)})`,
  },
  build: { rollupOptions: { external: ['better-sqlite3'] } },
});
