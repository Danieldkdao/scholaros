import { describe, expect, it, vi } from 'vitest';

const loginItem = vi.hoisted(() => ({
  settings: { openAtLogin: false },
  setError: null as Error | null,
}));

vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: () => loginItem.settings,
    setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => {
      if (loginItem.setError) throw loginItem.setError;
      loginItem.settings = { openAtLogin: settings.openAtLogin };
    }),
  },
}));

const { applyLaunchAtLogin, getLaunchAtLoginState } =
  await import('../services/preferences');

describe('launch at login', () => {
  it('reports an applied preference from the OS state', () => {
    loginItem.settings = { openAtLogin: false };
    expect(applyLaunchAtLogin(true)).toEqual({
      requested: true,
      applied: true,
      message: null,
    });
    expect(getLaunchAtLoginState(true)).toMatchObject({ applied: true });
  });

  it('reports the exact blocker when the OS rejects the change', () => {
    loginItem.setError = new Error('Login items are managed by MDM.');
    const status = applyLaunchAtLogin(true);
    expect(status).toMatchObject({
      requested: true,
      applied: false,
      message: 'Login items are managed by MDM.',
    });
    loginItem.setError = null;
  });

  it('reports a saved preference the OS did not apply', () => {
    loginItem.settings = { openAtLogin: false };
    expect(getLaunchAtLoginState(true)).toMatchObject({
      requested: true,
      applied: false,
      message: 'This computer did not add ScholarOS to login items.',
    });
  });

  it('reconciles a login item that remains after turning it off', () => {
    loginItem.settings = { openAtLogin: true };
    expect(getLaunchAtLoginState(false)).toMatchObject({
      requested: false,
      applied: false,
      message: 'This computer still starts ScholarOS at login.',
    });
  });
});
