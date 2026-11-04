import { activityRuntimeSdkSource } from '../../features/study/lib/activity-runtime-sdk';
import {
  createActivityContentDigest,
  type ActivityRunRelease,
  type ActivityStateProposal,
  type AuthorizedActivityRun as RuntimeAuthorizedActivityRun,
} from '../../features/study/services/activity-runtime';
import {
  ArtifactStoreError,
  type ArtifactStore,
  type AuthorizeActivityRunInput,
  type AuthorizedActivityRun as StoredAuthorizedActivityRun,
  type CheckpointArtifactStateInput,
  type ReleaseActivityRunInput,
} from '../../features/study/services/artifact-store';
import type { ArtifactStateDTO } from '@scholaros/services/learning/activity-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import { jsonValueSchema } from '@scholaros/services/learning/product-contracts';

type AcademicActivityStore = Pick<
  ArtifactStore,
  'authorizeActivityRun' | 'checkpointArtifactState' | 'releaseActivityRun'
>;

type BoundActivityRun = {
  runId: string | null;
  requestId: string;
  sessionId: string;
  artifactId: string;
  versionId: string;
  attemptId: string;
  userId: string;
  epoch: number;
  authorization: RuntimeAuthorizedActivityRun | null;
  authorizationPromise: Promise<RuntimeAuthorizedActivityRun> | null;
  releasePromise: Promise<void> | null;
};

export type AcademicActivityAdapter = {
  authorizeActivityRun: (
    context: AuthorizedContext,
    input: AuthorizeActivityRunInput,
  ) => Promise<RuntimeAuthorizedActivityRun>;
  checkpointArtifactState: (
    context: AuthorizedContext,
    proposal: ActivityStateProposal,
  ) => Promise<ArtifactStateDTO>;
  releaseActivityRun: (input: ActivityRunRelease) => Promise<void>;
  dispose: () => Promise<void>;
};

export const createAcademicActivityAdapter = (input: {
  store: AcademicActivityStore;
}): AcademicActivityAdapter => {
  const activeRuns = new Map<string, BoundActivityRun>();
  const pendingRequests = new Map<string, BoundActivityRun>();
  let disposed = false;

  const assertCurrentContext = (context: AuthorizedContext) => {
    if (context.signal.aborted) throw new ArtifactStoreError('cancelled');
    if (!context.isCurrent()) throw new ArtifactStoreError('session-changed');
  };

  const isSameScope = (
    boundRun: BoundActivityRun,
    context: AuthorizedContext,
    request: AuthorizeActivityRunInput,
  ) =>
    boundRun.userId === context.userId &&
    boundRun.epoch === context.epoch &&
    boundRun.sessionId === request.sessionId &&
    boundRun.artifactId === request.artifactId &&
    boundRun.versionId === request.versionId &&
    boundRun.attemptId === request.attemptId;

  const getBoundRun = (
    context: AuthorizedContext,
    proposal: ActivityStateProposal,
  ) => {
    const boundRun = activeRuns.get(proposal.runId);
    const runId = boundRun?.runId;
    if (
      !boundRun ||
      !runId ||
      boundRun.userId !== context.userId ||
      boundRun.epoch !== context.epoch ||
      boundRun.sessionId !== proposal.sessionId ||
      boundRun.artifactId !== proposal.artifactId ||
      boundRun.versionId !== proposal.versionId ||
      boundRun.attemptId !== proposal.attemptId
    )
      throw new ArtifactStoreError('scope-denied');
    return { ...boundRun, runId };
  };

  const toRuntimeAuthorization = (
    storedRun: StoredAuthorizedActivityRun,
  ): RuntimeAuthorizedActivityRun => {
    if (storedRun.bundle.runtimeVersion !== 1)
      throw new ArtifactStoreError('unsupported');
    const bundle = {
      html: storedRun.bundle.html,
      css: storedRun.bundle.css,
      sdk: activityRuntimeSdkSource,
      javascript: storedRun.bundle.javascript,
    };
    return {
      runtimeVersion: 'activity-runtime-v1',
      sessionId: storedRun.sessionId,
      artifactId: storedRun.artifactId,
      versionId: storedRun.versionId,
      attemptId: storedRun.attemptId,
      runId: storedRun.runId,
      contentDigest: storedRun.contentDigest,
      runtimeDigest: createActivityContentDigest(bundle),
      initialState: storedRun.state.state,
      stateRevision: storedRun.state.stateRevision,
      ...bundle,
    };
  };

  const authorizeActivityRun = async (
    context: AuthorizedContext,
    request: AuthorizeActivityRunInput,
  ) => {
    if (disposed) throw new ArtifactStoreError('cancelled');
    assertCurrentContext(context);
    let boundRun = pendingRequests.get(request.requestId);
    if (boundRun && !isSameScope(boundRun, context, request))
      throw new ArtifactStoreError('scope-denied');
    if (boundRun?.authorizationPromise)
      return structuredClone(await boundRun.authorizationPromise);
    if (boundRun?.authorization) return structuredClone(boundRun.authorization);
    if (!boundRun) {
      boundRun = {
        runId: null,
        requestId: request.requestId,
        sessionId: request.sessionId,
        artifactId: request.artifactId,
        versionId: request.versionId,
        attemptId: request.attemptId,
        userId: context.userId,
        epoch: context.epoch,
        authorization: null,
        authorizationPromise: null,
        releasePromise: null,
      };
      pendingRequests.set(request.requestId, boundRun);
    }

    const authorizationPromise = (async () => {
      const storedRun = await input.store.authorizeActivityRun(
        context,
        request,
      );
      boundRun.runId = storedRun.runId;
      const runtimeRun = toRuntimeAuthorization(storedRun);
      assertCurrentContext(context);
      if (disposed) throw new ArtifactStoreError('cancelled');
      boundRun.authorization = runtimeRun;
      activeRuns.set(storedRun.runId, boundRun);
      return runtimeRun;
    })();
    boundRun.authorizationPromise = authorizationPromise;
    try {
      return structuredClone(await authorizationPromise);
    } finally {
      if (boundRun.authorizationPromise === authorizationPromise)
        boundRun.authorizationPromise = null;
    }
  };

  const checkpointArtifactState = async (
    context: AuthorizedContext,
    proposal: ActivityStateProposal,
  ) => {
    assertCurrentContext(context);
    const boundRun = getBoundRun(context, proposal);
    const state = jsonValueSchema.safeParse(proposal.state);
    if (!state.success) throw new ArtifactStoreError('invalid-input');
    const checkpointInput: CheckpointArtifactStateInput = {
      runId: boundRun.runId,
      sequence: proposal.sequence,
      expectedRevision: proposal.baseStateRevision,
      state: state.data,
    };
    const checkpoint = await input.store.checkpointArtifactState(
      context,
      checkpointInput,
    );
    assertCurrentContext(context);
    return checkpoint;
  };

  const releaseBoundRun = (boundRun: BoundActivityRun) => {
    if (boundRun.releasePromise) return boundRun.releasePromise;
    const releasePromise = Promise.resolve()
      .then(async () => {
        await boundRun.authorizationPromise?.catch(() => undefined);
        const releaseInput: ReleaseActivityRunInput = boundRun.runId
          ? { runId: boundRun.runId, requestId: boundRun.requestId }
          : { requestId: boundRun.requestId };
        input.store.releaseActivityRun(releaseInput);
      })
      .then(
        () => {
          if (boundRun.runId) activeRuns.delete(boundRun.runId);
          if (pendingRequests.get(boundRun.requestId) === boundRun)
            pendingRequests.delete(boundRun.requestId);
        },
        (error: unknown) => {
          boundRun.releasePromise = null;
          throw error;
        },
      );
    boundRun.releasePromise = releasePromise;
    return releasePromise;
  };

  const releaseActivityRun = async (request: ActivityRunRelease) => {
    const byRunId = request.runId ? activeRuns.get(request.runId) : undefined;
    const byRequestId = pendingRequests.get(request.requestId);
    if (byRunId && byRequestId && byRunId !== byRequestId)
      throw new ArtifactStoreError('scope-denied');
    const boundRun = byRunId ?? byRequestId;
    if (!boundRun) {
      const releaseInput: ReleaseActivityRunInput = request.runId
        ? { runId: request.runId, requestId: request.requestId }
        : { requestId: request.requestId };
      input.store.releaseActivityRun(releaseInput);
      return Promise.resolve();
    }
    if (
      (request.runId && request.runId !== boundRun.runId) ||
      request.requestId !== boundRun.requestId
    )
      throw new ArtifactStoreError('scope-denied');
    return releaseBoundRun(boundRun);
  };

  const dispose = async () => {
    disposed = true;
    const boundRuns = new Set([
      ...activeRuns.values(),
      ...pendingRequests.values(),
    ]);
    await Promise.all(
      [...boundRuns].map((boundRun) => releaseBoundRun(boundRun)),
    );
  };

  return {
    authorizeActivityRun,
    checkpointArtifactState,
    releaseActivityRun,
    dispose,
  };
};
