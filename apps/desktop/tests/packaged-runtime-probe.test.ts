import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('packaged runtime probe transform', () => {
  let transform: (code: string, id: string) => { code: string } | null;

  beforeAll(async () => {
    vi.stubEnv('SCHOLAROS_PACKAGED_RUNTIME_PROBE', '1');
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:39787');
    const { default: config } = await import('../vite.main.config.mts');
    const plugins = config.plugins as Array<{
      name: string;
      transform?: typeof transform;
    }>;
    const plugin = plugins.find(
      (item) => item.name === 'packaged-runtime-probe',
    );
    if (!plugin?.transform) throw new Error('Probe transform missing');
    transform = plugin.transform;
  });

  it('injects the PDF probe immediately after actual service startup', async () => {
    const source = await readFile(
      new URL('../src/main.ts', import.meta.url),
      'utf8',
    );
    const result = transform(source, '/src/main.ts');
    expect(result?.code).toContain(
      'await runAcademicService({ learningModules });\n      if (pdfProbeArgument) await runPackagedPdfProbe();',
    );
  });

  it('fails closed when service startup is absent', () => {
    expect(() => transform('no service startup', '/src/main.ts')).toThrow(
      'The packaged runtime probe could not find service startup.',
    );
  });
});
