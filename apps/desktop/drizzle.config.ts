import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'drizzle-kit';

// Studio runs outside Electron, so derive the database path using the same
// platform locations and product name as src/db/index.ts.
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
