import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Stagehand has no CommonJS export, so locate its dist folder without require.resolve.
const findStagehandDirectory = () => {
  try {
    return path.dirname(
      fileURLToPath(import.meta.resolve('@browserbasehq/stagehand')),
    );
  } catch {
    let directory = process.cwd();
    for (;;) {
      const candidate = path.join(
        directory,
        'node_modules/@browserbasehq/stagehand/dist',
      );
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(directory);
      if (parent === directory)
        throw new Error('Could not locate @browserbasehq/stagehand.');
      directory = parent;
    }
  }
};

const stagehandDirectory = findStagehandDirectory();

export const stagehandExtensionDirectory = path.join(
  stagehandDirectory,
  'extension',
);
export const stagehandExtensionArchive = path.join(
  stagehandDirectory,
  'assets',
  'stagehand-extension.zip',
);
