import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const packageRequire = createRequire(import.meta.url);

export const stageRuntimePackage = async (name: string, buildPath: string) => {
  const staged = new Map<string, string>();
  const stage = async (packageName: string, parentRequire: NodeRequire) => {
    const manifestPath = await realpath(
      parentRequire.resolve(`${packageName}/package.json`),
    );
    const existing = staged.get(packageName);
    if (existing) {
      if (existing !== manifestPath)
        throw new Error(`Conflicting runtime package versions: ${packageName}`);
      return;
    }
    staged.set(packageName, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const destination = path.join(buildPath, 'node_modules', packageName);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.dirname(manifestPath), destination, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
    const childRequire = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await stage(dependency, childRequire);
  };
  await stage(name, packageRequire);
};
