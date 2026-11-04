import type {
  ActionCleanup,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import {
  createSessionStore,
  type CreateSessionStoreOptions,
} from './session-store';

type SessionStore = ReturnType<typeof createSessionStore>;

export type RegisterSessionActionsOptions = {
  store?: SessionStore;
  cleanupOriginals?: CreateSessionStoreOptions['cleanupOriginals'];
};

export const registerSessionActions = (
  registrar: AuthorizedRegistrar,
  options: RegisterSessionActionsOptions = {},
): ActionCleanup => {
  const store =
    options.store ??
    createSessionStore({
      now: () => registrar.lifecycle.now(),
      publish: (event) => registrar.publish(event),
      ...(options.cleanupOriginals
        ? { cleanupOriginals: options.cleanupOriginals }
        : {}),
    });

  registrar.handle('createStudySession', (context, input) =>
    store.createStudySession(context, input),
  );
  registrar.handle('listStudySessions', async (context, input) => {
    try {
      return await store.listStudySessions(context, input);
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
  registrar.handle('getStudySession', async (context, input) => {
    try {
      return await store.getStudySession(context, input);
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
  registrar.handle('renameStudySession', (context, input) =>
    store.renameStudySession(context, input),
  );
  registrar.handle('saveStudyDraft', (context, input) =>
    store.saveStudyDraft(context, input),
  );
  registrar.handle('deleteStudySession', (context, input) =>
    store.deleteStudySession(context, input),
  );
  registrar.handle('reconcileStudyDeadline', (context, input) =>
    store.timer.reconcileStudyDeadline(context, input),
  );
  registrar.handle('finishStudySession', (context, input) =>
    store.timer.finishStudySession(context, input),
  );
  registrar.handle('extendStudySession', (context, input) =>
    store.timer.extendStudySession(context, input),
  );
  registrar.handle('continueStudyUntimed', (context, input) =>
    store.timer.continueStudyUntimed(context, input),
  );

  return async () => undefined;
};
