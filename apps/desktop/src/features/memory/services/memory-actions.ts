import type {
  ActionCleanup,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import {
  correctMemory,
  deleteMemory,
  listMemories,
  subscribeMemoryChanges,
  upsertExplicitPreference,
} from './memory-store';
import { getLearningProgress } from './learning-model';

export const registerMemoryActions = (
  registrar: AuthorizedRegistrar,
): ActionCleanup => {
  const unsubscribe = subscribeMemoryChanges((change) => {
    registrar.publish({
      version: 1,
      accountId: change.userId,
      revision: change.revision,
      resource: 'memory',
      targetId: change.courseId,
    });
  });
  const cleanup: ActionCleanup = async () => {
    unsubscribe();
  };
  registrar.lifecycle.onTeardown(cleanup);

  registrar.handle('listMemories', async (context, input) => {
    try {
      return await listMemories(context, input);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'storage-failed'
      )
        return null;
      throw error;
    }
  });
  registrar.handle('upsertExplicitPreference', async (context, input) =>
    upsertExplicitPreference(context, input),
  );
  registrar.handle('correctMemory', async (context, input) =>
    correctMemory(context, input),
  );
  registrar.handle('deleteMemory', async (context, input) => {
    deleteMemory(context, input);
  });
  registrar.handle('getLearningProgress', async (context, input) => {
    try {
      return await getLearningProgress(context, input);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'storage-failed'
      )
        return null;
      throw error;
    }
  });

  return cleanup;
};
