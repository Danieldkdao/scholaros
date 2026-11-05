import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const packageRequire = createRequire(import.meta.url);

const resolveRuntimeManifest = async (
  name: string,
  parentRequire: NodeRequire,
) => {
  try {
    return await realpath(parentRequire.resolve(`${name}/package.json`));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    )
      throw error;
  }
  let directory = path.dirname(await realpath(parentRequire.resolve(name)));
  while (directory !== path.dirname(directory)) {
    const manifestPath = path.join(directory, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        name?: string;
      };
      if (manifest.name === name) return manifestPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Runtime package manifest not found: ${name}`);
};

export const stageRuntimePackage = async (name: string, buildPath: string) => {
  const staged = new Map<string, string>();
  const stage = async (packageName: string, parentRequire: NodeRequire) => {
    const manifestPath = await resolveRuntimeManifest(
      packageName,
      parentRequire,
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
