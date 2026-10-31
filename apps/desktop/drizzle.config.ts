import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Studio has to reach the same file the app opens, but a drizzle-kit config runs
// in plain Node, so it cannot use Electron's app.getPath('userData'). The folder
// names here mirror productName in package.json and src/db/index.ts.
const localDatabasePath = () => {
  const home = os.homedir();
  const applicationData =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  return path.join(applicationData, 'scholaros', 'data', 'scholaros.sqlite');
};

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: localDatabasePath(),
  },
});
