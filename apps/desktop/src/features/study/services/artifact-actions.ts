import { db } from '../../../db';
import type {
  ActionCleanup,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import {
  createArtifactStore,
  ArtifactStoreError,
  type ArtifactStore,
} from './artifact-store';

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
    const version = await store.getArtifactVersion(context, input);
    if (!version) throw new ArtifactStoreError('not-found');
    return version;
  });
  registrar.handle('getArtifactState', async (context, input) => {
    const state = await store.getArtifactState(context, input);
    if (!state) throw new ArtifactStoreError('not-found');
    return state;
  });
  registrar.handle('resetArtifactAttempt', (context, input) =>
    store.resetArtifactAttempt(context, input),
  );
  registrar.handle('saveArtifactToContext', (context, input) =>
    store.saveArtifactToContext(context, input),
  );

  return async () => store.dispose();
};
