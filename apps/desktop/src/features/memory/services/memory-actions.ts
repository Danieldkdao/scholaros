import type {
  ActionCleanup,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import {
  correctMemory,
  deleteMemory,
  listMemories,
  MemoryServiceError,
  subscribeMemoryChanges,
  upsertExplicitPreference,
} from './memory-store';
import { getLearningProgress } from './learning-model';

const requireReadResult = <T>(result: T | null): T => {
  if (result === null) throw new MemoryServiceError('storage-failed');
  return result;
};

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

  registrar.handle('listMemories', async (context, input) =>
    requireReadResult(listMemories(context, input)),
  );
  registrar.handle('upsertExplicitPreference', async (context, input) =>
    upsertExplicitPreference(context, input),
  );
  registrar.handle('correctMemory', async (context, input) =>
    correctMemory(context, input),
  );
  registrar.handle('deleteMemory', async (context, input) => {
    deleteMemory(context, input);
  });
  registrar.handle('getLearningProgress', async (context, input) =>
    requireReadResult(getLearningProgress(context, input)),
  );

  return cleanup;
};
