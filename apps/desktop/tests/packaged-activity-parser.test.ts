import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { stageRuntimePackage } from '../stage-runtime-package.mts';

it('stages the activity parser and dependencies for dynamic import inside its validation worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scholaros-activity-parser-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{}');
    await stageRuntimePackage('parse5', root);
    const packagedRequire = createRequire(path.join(root, 'package.json'));
    const entry = packagedRequire.resolve('parse5');
    expect(entry.startsWith(await realpath(root))).toBe(true);
    const result = await new Promise<boolean>((resolve, reject) => {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads');
        const { pathToFileURL } = require('node:url');
        import(pathToFileURL(workerData).href).then(({ parseFragment }) => {
          parentPort.postMessage(parseFragment('<button>Try</button>').childNodes[0].tagName === 'button');
        }).catch(() => parentPort.postMessage(false));
      `,
        { eval: true, workerData: entry },
      );
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    expect(result).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
