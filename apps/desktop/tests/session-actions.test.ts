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

const readMocks = vi.hoisted(() => {
  const names = [
    'listMemories',
    'getLearningProgress',
    'listContextItems',
    'getContextItem',
    'listStudySessions',
    'getStudySession',
    'getArtifactVersion',
    'getArtifactState',
    'createContextNote',
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn()]));
});
vi.mock('../src/db', () => ({ db: {} }));
vi.mock('../src/features/memory/services/memory-store', () => ({
  listMemories: readMocks.listMemories,
  subscribeMemoryChanges: () => () => undefined,
  correctMemory: vi.fn(),
  deleteMemory: vi.fn(),
  upsertExplicitPreference: vi.fn(),
  MemoryServiceError: class extends Error {},
}));
vi.mock('../src/features/memory/services/learning-model', () => ({
  getLearningProgress: readMocks.getLearningProgress,
}));
vi.mock('../src/features/context/services/library-store', () => ({
  listContextItems: readMocks.listContextItems,
  getContextItem: readMocks.getContextItem,
  createContextNote: readMocks.createContextNote,
  updateContextItem: vi.fn(),
  linkContextItem: vi.fn(),
  removeContextItem: vi.fn(),
  getContextRevision: () => 1,
  ContextStoreError: class extends Error {},
}));
vi.mock('../src/features/study/services/session-store', () => ({
  createSessionStore: () => ({ ...readMocks, timer: {} }),
}));
vi.mock('../src/features/study/services/artifact-store', () => ({
  createArtifactStore: () => ({ ...readMocks }),
  ArtifactStoreError: class extends Error {},
}));

describe('registered public nullable read actions', () => {
  const readNames = [
    'listMemories',
    'getLearningProgress',
    'listContextItems',
    'getContextItem',
    'listStudySessions',
    'getStudySession',
    'getArtifactVersion',
    'getArtifactState',
  ];
  const callbacks = new Map<
    string,
    (context: unknown, input: unknown) => Promise<unknown>
  >();
  const register = async () => {
    const registrar = {
      handle: (
        name: string,
        callback: (context: unknown, input: unknown) => Promise<unknown>,
      ) => callbacks.set(name, callback),
      publish: vi.fn(),
      lifecycle: { onTeardown: vi.fn() },
    } as unknown as import('@scholaros/services/learning/product-contracts').AuthorizedRegistrar;
    const { registerMemoryActions } =
      await import('../src/features/memory/services/memory-actions');
    const { registerContextActions } =
      await import('../src/features/context/services/library-actions');
    const { registerSessionActions } =
      await import('../src/features/study/services/session-actions');
    const { registerArtifactActions } =
      await import('../src/features/study/services/artifact-actions');
    registerMemoryActions(registrar);
    registerContextActions(registrar);
    registerSessionActions(registrar);
    registerArtifactActions(registrar);
  };
  it.each(readNames)(
    '%s preserves null failures and valid empty results',
    async (name) => {
      await register();
      const action = callbacks.get(name)!;
      readMocks[name]!.mockReturnValue(null);
      await expect(action({}, {})).resolves.toBeNull();
      readMocks[name]!.mockImplementation(() => {
        throw Object.assign(new Error('read unavailable'), {
          code: 'storage-failed',
        });
      });
      await expect(action({}, {})).resolves.toBeNull();
      const denied = Object.assign(new Error('read denied'), {
        code: 'scope-denied',
      });
      readMocks[name]!.mockImplementation(() => {
        throw denied;
      });
      await expect(action({}, {})).rejects.toBe(denied);
      const empty = { items: [], nextCursor: null, revision: 0 };
      readMocks[name]!.mockReturnValue(empty);
      await expect(action({}, {})).resolves.toBe(empty);
    },
  );
  it('keeps mutation failures rejected', async () => {
    await register();
    const failure = new Error('mutation denied');
    readMocks.createContextNote!.mockRejectedValue(failure);
    await expect(callbacks.get('createContextNote')!({}, {})).rejects.toBe(
      failure,
    );
  });
});
