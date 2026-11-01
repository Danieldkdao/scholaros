import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Honor the standard data-directory switch before auth storage initializes, including runtime checks.
const directory = app.commandLine.getSwitchValue('user-data-dir');
if (directory) {
  const resolved = path.resolve(directory);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  app.setPath('userData', resolved);
  app.setPath('sessionData', resolved);
}
