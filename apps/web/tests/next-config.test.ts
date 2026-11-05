import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const validation = vi.hoisted(() => vi.fn());
vi.mock('../src/data/env/server', () => {
  validation();
  return {};
});
beforeEach(() => {
  vi.resetModules();
  validation.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it('loads the opt-in demo configuration without requiring database or OAuth configuration', async () => {
  vi.stubEnv('DEMO_API_ENABLED', '1');
  validation.mockImplementation(() => {
    throw new Error('Database and OAuth variables are absent');
  });
  const configuration = (await import('../next.config')).default;
  expect((await configuration()).transpilePackages).toContain('@scholaros/ui');
  expect(validation).not.toHaveBeenCalled();
});

it.each(['0', '', 'true'])(
  'keeps normal server environment validation for flag %s',
  async (flag) => {
    vi.stubEnv('DEMO_API_ENABLED', flag);
    validation.mockImplementation(() => {
      throw new Error('Normal configuration is invalid');
    });
    const configuration = (await import('../next.config')).default;
    await expect(configuration()).rejects.toThrow();
    expect(validation).toHaveBeenCalledOnce();
  },
);
