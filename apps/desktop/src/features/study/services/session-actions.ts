import type {
  ActionCleanup,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import {
  createSessionStore,
  type CreateSessionStoreOptions,
} from './session-store';
import { StudySessionError } from './session-events';

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
    const page = await store.listStudySessions(context, input);
    if (!page)
      throw new StudySessionError(
        'storage-failed',
        'Study history could not be read.',
      );
    return page;
  });
  registrar.handle('getStudySession', async (context, input) => {
    const snapshot = await store.getStudySession(context, input);
    if (!snapshot)
      throw new StudySessionError(
        'storage-failed',
        'The study session could not be read.',
      );
    return snapshot;
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
