import { describe, expect, it, vi } from 'vitest';
import { exitAndSignOut } from '../src/lib/session-actions';

const setup = () => {
  const signOut = vi.fn(async () => undefined);
  const clearRendererState = vi.fn();
  const navigateToAuth = vi.fn(async () => undefined);
  return { signOut, clearRendererState, navigateToAuth };
};

describe('exit and sign out', () => {
  it('signs out before clearing renderer state and navigating', async () => {
    const dependencies = setup();
    await exitAndSignOut(dependencies);
    expect(dependencies.signOut).toHaveBeenCalledOnce();
    expect(dependencies.clearRendererState).toHaveBeenCalledOnce();
    expect(dependencies.navigateToAuth).toHaveBeenCalledOnce();
    expect(dependencies.signOut.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.clearRendererState.mock.invocationCallOrder[0]!,
    );
    expect(
      dependencies.clearRendererState.mock.invocationCallOrder[0],
    ).toBeLessThan(dependencies.navigateToAuth.mock.invocationCallOrder[0]!);
  });

  it('does not clear or navigate when sign-out fails', async () => {
    const dependencies = setup();
    dependencies.signOut.mockRejectedValueOnce(new Error('Sign out failed'));
    await expect(exitAndSignOut(dependencies)).rejects.toThrow(
      'Sign out failed',
    );
    expect(dependencies.clearRendererState).not.toHaveBeenCalled();
    expect(dependencies.navigateToAuth).not.toHaveBeenCalled();
  });
});
