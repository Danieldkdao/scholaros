import { db } from '../../../db';
import type {
  ActionCleanup,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import { createArtifactStore, type ArtifactStore } from './artifact-store';

export { createArtifactStore };

export type {
  AuthorizeActivityRunInput,
  AuthorizedActivityRun,
  CheckpointArtifactStateInput,
  ArtifactStore,
  ReleaseActivityRunInput,
} from './artifact-store';

const artifactStore = createArtifactStore({ db });

export const createArtifactVersion = artifactStore.createArtifactVersion;
export const checkpointArtifactState: ArtifactStore['checkpointArtifactState'] =
  artifactStore.checkpointArtifactState;
export const authorizeActivityRun: ArtifactStore['authorizeActivityRun'] =
  artifactStore.authorizeActivityRun;
export const releaseActivityRun: ArtifactStore['releaseActivityRun'] =
  artifactStore.releaseActivityRun;

export const registerArtifactActions = (
  registrar: AuthorizedRegistrar,
  store: ArtifactStore = artifactStore,
): ActionCleanup => {
  registrar.handle('getArtifactVersion', async (context, input) => {
    try {
      return await store.getArtifactVersion(context, input);
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
  registrar.handle('getArtifactState', async (context, input) => {
    try {
      return await store.getArtifactState(context, input);
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
  registrar.handle('resetArtifactAttempt', (context, input) =>
    store.resetArtifactAttempt(context, input),
  );
  registrar.handle('saveArtifactToContext', (context, input) =>
    store.saveArtifactToContext(context, input),
  );

  return async () => store.dispose();
};
