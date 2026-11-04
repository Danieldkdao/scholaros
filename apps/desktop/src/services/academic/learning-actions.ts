import type {
  SourcePassage,
  SourceReference,
} from '@scholaros/services/learning/context-contracts';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type {
  ActionCleanup,
  AuthorizedContext,
  LearningLifecycle,
  ProductEventV1,
} from '@scholaros/services/learning/product-contracts';
import type { NotificationOutcome } from '../../features/notifications/services/notification-actions';
import type { LearningActionRegistrar } from './contracts';
import {
  learningRequestSchema,
  learningResponseSchema,
} from '../../../../../packages/services/src/ai/learning-dispatch';
import type { TutorPracticeDependencies } from './tutor-practice-adapter';
import { LearningClientError } from '../../features/study/services/learning-client';

const requestLearning: TutorPracticeDependencies['requestLearning'] = async (
  request,
  operationSignal,
) => {
  const [{ net }, { clientEnv }, { authClient }, { isAccountSessionCurrent }] =
    await Promise.all([
      import('electron'),
      import('../../data/env/client'),
      import('../../lib/auth/client'),
      import('../../lib/auth/main'),
    ]);
  const parsedRequest = learningRequestSchema.parse(request);
  const cookie = authClient.getCookie();
  const signal = AbortSignal.any([
    operationSignal,
    AbortSignal.timeout(65_000),
  ]);
  const assertCurrent = () => {
    if (signal.aborted) throw new LearningClientError('cancelled');
    if (!isAccountSessionCurrent(cookie))
      throw new LearningClientError('session-changed');
  };
  assertCurrent();
  try {
    const response = await net.fetch(
      new URL('/api/learning', clientEnv.VITE_API_URL).href,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        body: JSON.stringify(parsedRequest),
        signal,
      },
    );
    assertCurrent();
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      throw new LearningClientError(
        response.status === 401 ? 'session-changed' : 'provider-failed',
      );
    }
    if (!response.body) throw new LearningClientError('provider-failed');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const cancelRead = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancelRead, { once: true });
    try {
      for (;;) {
        assertCurrent();
        const { value, done } = await reader.read();
        assertCurrent();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > 2 * 1024 * 1024)
          throw new LearningClientError('limit-exceeded');
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener('abort', cancelRead);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, byteLength);
    const result: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    assertCurrent();
    return result;
  } catch (error) {
    assertCurrent();
    if (error instanceof LearningClientError) throw error;
    throw new LearningClientError('provider-failed');
  }
};

export type LearningActionModule = (
  registrar: LearningActionRegistrar,
) => ActionCleanup | void;
export type LearningLifecycleRuntime = LearningLifecycle & {
  cancelOperations: (key?: string) => void;
  cancelOperationsAndWait: () => Promise<void>;
  invalidate: (excludedOperationId?: string) => Promise<void>;
  withOperationsQuiesced: <TResult>(
    excludedOperationId: string,
    stopExternal: () => Promise<void>,
    action: () => Promise<TResult>,
  ) => Promise<TResult>;
  trackOperation: <TResult>(
    operationId: string,
    operation: () => Promise<TResult>,
  ) => Promise<TResult>;
};

type RegisteredLearningOperation = {
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
};

export const createLearningLifecycle = (): LearningLifecycleRuntime => {
  let epoch = 0;
  let controller = new AbortController();
  let invalidating: Promise<void> | null = null;
  let cancellationCount = 0;
  let quiescing = false;
  const operations = new Map<
    string,
    Map<string, RegisteredLearningOperation>
  >();
  const pendingOperations = new Map<string, Promise<unknown>>();
  const teardownCallbacks = new Set<() => void | Promise<void>>();

  const removeOperation = (key: string, operationId: string) => {
    const scopedOperations = operations.get(key);
    const operation = scopedOperations?.get(operationId);
    if (operation) {
      scopedOperations?.delete(operationId);
      operation.settle();
    }
    if (scopedOperations?.size === 0) operations.delete(key);
  };

  const cancelOperations = (key?: string) => {
    for (const [operationKey, scopedOperations] of operations) {
      if (key !== undefined && operationKey !== key) continue;
      for (const operation of scopedOperations.values())
        operation.controller.abort();
    }
  };

  const waitForOperations = async (excludedOperationId?: string) => {
    while (true) {
      const requests = [...pendingOperations]
        .filter(([operationId]) => operationId !== excludedOperationId)
        .map(([, operation]) => operation);
      const registered = [...operations.values()].flatMap((scopedOperations) =>
        [...scopedOperations.values()].map((operation) => operation.settled),
      );
      const pending = [...requests, ...registered];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  };

  const waitForRegisteredOperations = async () => {
    let emptyPass = false;
    while (true) {
      const pending = [...operations.values()].flatMap((scopedOperations) =>
        [...scopedOperations.values()].map((operation) => operation.settled),
      );
      if (pending.length === 0) {
        if (emptyPass) return;
        emptyPass = true;
        await Promise.resolve();
        continue;
      }
      emptyPass = false;
      await Promise.allSettled(pending);
    }
  };

  const cancelOperationsAndWait = async () => {
    cancellationCount += 1;
    try {
      cancelOperations();
      await waitForRegisteredOperations();
    } finally {
      cancellationCount -= 1;
    }
  };

  const invalidate = (excludedOperationId?: string) => {
    if (invalidating) return invalidating;

    epoch += 1;
    controller.abort();
    cancelOperations();

    let resolveInvalidation!: () => void;
    let rejectInvalidation!: (reason: unknown) => void;
    const currentInvalidation = new Promise<void>((resolve, reject) => {
      resolveInvalidation = resolve;
      rejectInvalidation = reject;
    });
    invalidating = currentInvalidation;
    const teardowns = [...teardownCallbacks].map((cleanup) => {
      try {
        return Promise.resolve(cleanup());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    teardownCallbacks.clear();
    void Promise.all([
      waitForOperations(excludedOperationId),
      Promise.allSettled(teardowns),
    ]).then(([, results]) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (invalidating === currentInvalidation) invalidating = null;
      if (failures.length > 0)
        rejectInvalidation(
          new AggregateError(failures, 'Learning teardown failed.'),
        );
      else {
        controller = new AbortController();
        resolveInvalidation();
      }
    });
    return currentInvalidation;
  };

  return {
    get epoch() {
      return epoch;
    },
    get signal() {
      return controller.signal;
    },
    isCurrent: (capturedEpoch) =>
      capturedEpoch === epoch && !controller.signal.aborted,
    now: () => Date.now(),
    registerOperation: (key, operationId, operation) => {
      if (!key.trim() || !operationId.trim())
        throw new Error('Learning operations need a scope and identifier.');
      if (invalidating || quiescing || controller.signal.aborted)
        throw new Error('Learning work is being cancelled.');
      const scopedOperations = operations.get(key) ?? new Map();
      if (scopedOperations.has(operationId))
        throw new Error('This learning operation is already registered.');
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      scopedOperations.set(operationId, {
        controller: operation,
        settled,
        settle,
      });
      operations.set(key, scopedOperations);
      if (cancellationCount > 0) operation.abort();
      return () => removeOperation(key, operationId);
    },
    onTeardown: (cleanup) => {
      teardownCallbacks.add(cleanup);
    },
    cancelOperations,
    cancelOperationsAndWait,
    invalidate,
    withOperationsQuiesced: async (
      excludedOperationId,
      stopExternal,
      action,
    ) => {
      if (quiescing || invalidating || controller.signal.aborted)
        throw new Error('Learning work is being cancelled.');
      quiescing = true;
      cancellationCount += 1;
      try {
        cancelOperations();
        const results = await Promise.allSettled([
          stopExternal(),
          waitForOperations(excludedOperationId),
        ]);
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(failures, 'Learning quiescence failed.');
        return await action();
      } finally {
        cancellationCount -= 1;
        quiescing = false;
      }
    },
    trackOperation: (operationId, operation) => {
      if (!operationId.trim())
        throw new Error('Learning operations need an identifier.');
      if (invalidating || quiescing || controller.signal.aborted)
        throw new Error('Learning work is being cancelled.');
      if (pendingOperations.has(operationId))
        throw new Error('This learning request is already active.');
      const pendingOperation = Promise.resolve().then(operation);
      pendingOperations.set(operationId, pendingOperation);
      const removePendingOperation = () => {
        if (pendingOperations.get(operationId) === pendingOperation)
          pendingOperations.delete(operationId);
      };
      void pendingOperation.then(
        removePendingOperation,
        removePendingOperation,
      );
      return pendingOperation;
    },
  };
};

const once = (cleanup: ActionCleanup): ActionCleanup => {
  let completion: Promise<void> | null = null;
  return () => (completion ??= Promise.resolve().then(cleanup));
};

const runCleanups = async (cleanups: ActionCleanup[]) => {
  for (const cleanup of [...cleanups].reverse()) await cleanup();
};

export const registerLearningActions = async (
  registrar: LearningActionRegistrar,
  modules: readonly LearningActionModule[],
): Promise<ActionCleanup> => {
  const cleanups: ActionCleanup[] = [];
  try {
    for (const module of modules) {
      const cleanup = module(registrar);
      if (cleanup) cleanups.push(once(cleanup));
    }
  } catch (error) {
    await runCleanups(cleanups).catch(() => undefined);
    throw error;
  }

  const cleanup = once(() => runCleanups(cleanups));
  registrar.lifecycle.onTeardown(cleanup);
  return cleanup;
};

export const notificationOutcomeId = (...identity: (string | number)[]) =>
  createHash('sha256').update(JSON.stringify(identity)).digest('hex');

export const createProductNotificationProducer = (
  registrar: Pick<LearningActionRegistrar, 'lifecycle' | 'publish'>,
) => {
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let closed = false;
  const enqueue = (
    context: AuthorizedContext,
    outcome: NotificationOutcome,
    revision: number,
  ): Promise<void> => {
    const controller = new AbortController();
    let targetIsCurrent = () => true;
    const isCurrent = () =>
      !closed &&
      !controller.signal.aborted &&
      !context.signal.aborted &&
      registrar.lifecycle.isCurrent(context.epoch) &&
      context.isCurrent() &&
      targetIsCurrent();
    if (!isCurrent()) return Promise.resolve();
    let unregister: () => void;
    try {
      unregister = registrar.lifecycle.registerOperation(
        `notifications:${context.userId}`,
        randomUUID(),
        controller,
      );
    } catch {
      return Promise.resolve();
    }
    controllers.add(controller);
    const operation = (async () => {
      try {
        const [actions, store] = await Promise.all([
          import('../../features/notifications/services/notification-actions'),
          import('../../features/notifications/services/notification-store'),
        ]);
        targetIsCurrent = () =>
          store.isNotificationTargetAvailable(context.userId, {
            targetKind: outcome.targetKind,
            targetId: outcome.targetId,
            safeRoute: outcome.route,
          });
        if (!isCurrent()) return;
        const result = await actions.enqueueProductNotification(
          {
            ...context,
            isCurrent,
            signal: AbortSignal.any([context.signal, controller.signal]),
          },
          outcome,
        );
        if (result.created && isCurrent())
          registrar.publish({
            version: 1,
            accountId: context.userId,
            resource: 'notifications',
            revision,
            targetId: result.eventId,
          });
      } catch {
        // Optional alerts cannot undo an already committed product outcome.
      } finally {
        controllers.delete(controller);
        unregister();
      }
    })();
    pending.add(operation);
    void operation.then(() => pending.delete(operation));
    return operation;
  };
  return {
    enqueue,
    dispose: async () => {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(pending);
    },
  };
};

export const loadLearningActionModules = async (): Promise<
  LearningActionModule[]
> => {
  const [
    contextActions,
    contextIngestion,
    gradeActions,
    sessionActions,
    artifactActions,
    artifactStoreModule,
    activityAdapterModule,
    memoryActions,
    todayActions,
    notificationActions,
    tutorPractice,
    libraryRetrieval,
    sourcePreview,
    policy,
    originalStore,
    database,
    libraryStore,
    tables,
  ] = await Promise.all([
    import('../../features/context/services/library-actions'),
    import('./context-ingestion-adapter'),
    import('../../features/grades/services/grade-actions'),
    import('../../features/study/services/session-actions'),
    import('../../features/study/services/artifact-actions'),
    import('../../features/study/services/artifact-store'),
    import('./activity-adapter'),
    import('../../features/memory/services/memory-actions'),
    import('../../features/today/services/today-actions'),
    import('../../features/notifications/services/notification-actions'),
    import('./tutor-practice-adapter'),
    import('../../features/context/services/library-retrieval'),
    import('../../features/integrity/services/source-preview'),
    import('../../features/integrity/services/policy'),
    import('../../features/context/services/original-store'),
    import('../../db'),
    import('../../features/context/services/library-store'),
    import('../../db/schema'),
  ]);

  const contexts = new Map<string, AuthorizedContext>();
  let producer: ReturnType<typeof createProductNotificationProducer>;
  const notifyCommittedEvent = (event: ProductEventV1) => {
    const context = contexts.get(event.accountId);
    if (
      !context ||
      context.signal.aborted ||
      !context.isCurrent() ||
      !event.targetId ||
      !event.operationId
    )
      return;
    if (event.resource === 'study') {
      const session = database.db
        .select({
          id: tables.StudySessionTable.id,
          revision: tables.StudySessionTable.revision,
          generationEpoch: tables.StudySessionTable.generationEpoch,
          timerRevision: tables.StudySessionTable.timerRevision,
          expiredRevision: tables.StudySessionTable.expiredRevision,
          resolvedExpiredRevision:
            tables.StudySessionTable.resolvedExpiredRevision,
        })
        .from(tables.StudySessionTable)
        .where(
          and(
            eq(tables.StudySessionTable.userId, context.userId),
            eq(tables.StudySessionTable.id, event.targetId),
            isNull(tables.StudySessionTable.deletedAt),
          ),
        )
        .get();
      if (!session || session.revision < event.revision) return;
      if (
        event.outcome === 'completed' &&
        event.operationId ===
          `study-timer-${session.id}-${session.timerRevision}` &&
        session.expiredRevision === session.timerRevision &&
        session.resolvedExpiredRevision !== session.timerRevision
      ) {
        void producer.enqueue(
          context,
          {
            category: 'timer-expired',
            outcome: 'completed',
            outcomeId: notificationOutcomeId(
              'timer',
              session.id,
              session.timerRevision,
            ),
            targetKind: 'study',
            targetId: session.id,
            route: { kind: 'study', sessionId: session.id },
            expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          },
          event.revision,
        );
        return;
      }
      const message = database.db
        .select({ turnId: tables.StudyMessageTable.turnId })
        .from(tables.StudyMessageTable)
        .where(
          and(
            eq(tables.StudyMessageTable.userId, context.userId),
            eq(tables.StudyMessageTable.sessionId, session.id),
            eq(tables.StudyMessageTable.id, event.operationId),
            eq(tables.StudyMessageTable.role, 'tutor'),
            eq(tables.StudyMessageTable.status, 'accepted'),
          ),
        )
        .get();
      const turn = database.db
        .select()
        .from(tables.StudyTurnTable)
        .where(
          and(
            eq(tables.StudyTurnTable.userId, context.userId),
            eq(tables.StudyTurnTable.sessionId, session.id),
            eq(tables.StudyTurnTable.id, message?.turnId ?? event.operationId),
            eq(tables.StudyTurnTable.generationEpoch, session.generationEpoch),
            eq(tables.StudyTurnTable.status, 'complete'),
          ),
        )
        .get();
      if (!turn?.settledAt) return;
      const messages = database.db
        .select({ parts: tables.StudyMessageTable.parts })
        .from(tables.StudyMessageTable)
        .where(
          and(
            eq(tables.StudyMessageTable.userId, context.userId),
            eq(tables.StudyMessageTable.sessionId, session.id),
            eq(tables.StudyMessageTable.turnId, turn.id),
            eq(tables.StudyMessageTable.role, 'tutor'),
            eq(tables.StudyMessageTable.status, 'accepted'),
          ),
        )
        .all();
      const parts = messages.flatMap(({ parts }) => parts);
      const notify = (
        category: 'tutor-ready' | 'activity-ready',
        identity: string[],
      ) =>
        void producer.enqueue(
          context,
          {
            category,
            outcome: 'completed',
            outcomeId: notificationOutcomeId(category, session.id, ...identity),
            targetKind: 'study',
            targetId: session.id,
            route: { kind: 'study', sessionId: session.id },
            expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          },
          event.revision,
        );
      if (parts.some((part) => part.kind === 'text'))
        notify('tutor-ready', [turn.id, String(turn.attemptNumber)]);
      for (const part of parts) {
        if (part.kind !== 'activity') continue;
        const version = database.db
          .select({ id: tables.ArtifactVersionTable.id })
          .from(tables.ArtifactVersionTable)
          .innerJoin(
            tables.ArtifactTable,
            eq(tables.ArtifactTable.id, tables.ArtifactVersionTable.artifactId),
          )
          .where(
            and(
              eq(tables.ArtifactVersionTable.userId, context.userId),
              eq(tables.ArtifactVersionTable.artifactId, part.artifactId),
              eq(tables.ArtifactVersionTable.id, part.versionId),
              eq(tables.ArtifactTable.userId, context.userId),
              isNull(tables.ArtifactTable.removedAt),
            ),
          )
          .get();
        if (version)
          notify('activity-ready', [
            part.artifactId,
            part.versionId,
            part.attemptId,
          ]);
      }
      return;
    }
    if (
      event.resource !== 'context' ||
      !event.outcome ||
      event.outcome === 'cancelled'
    )
      return;
    const item = libraryStore.readContextIngestionItem(context, {
      itemId: event.targetId,
    });
    if (!item || item.revision !== event.revision) return;
    const completed =
      event.outcome === 'completed' && item.status === 'complete';
    const failed = ['failed', 'partial', 'unreadable', 'unsupported'].includes(
      item.status,
    );
    if (!completed && !failed) return;
    if (completed) {
      const version = libraryStore.readContextIngestionVersion(context, {
        itemId: item.id,
        attemptId: event.operationId,
      });
      if (!version || version.extractionStatus !== 'complete') return;
    }
    void producer.enqueue(
      context,
      {
        category: completed ? 'context-completed' : 'context-failed',
        outcome: completed ? 'completed' : 'failed',
        outcomeId: notificationOutcomeId(
          'context',
          item.id,
          event.operationId,
          item.revision,
        ),
        targetKind: 'context',
        targetId: item.id,
        route: { kind: 'context', itemId: item.id },
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      },
      event.revision,
    );
  };
  const withOutcomeNotifications =
    (module: LearningActionModule): LearningActionModule =>
    (registrar) => {
      let active = true;
      const epoch = registrar.lifecycle.epoch;
      const cleanup = module({
        ...registrar,
        handle: (method, action) =>
          registrar.handle(method, (context, input) => {
            contexts.set(context.userId, context);
            return action(context, input);
          }),
        handleInternal: (method, action) =>
          registrar.handleInternal(method, (context, input) => {
            contexts.set(context.userId, context);
            return action(context, input);
          }),
        publish: (event) => {
          if (!active || !registrar.lifecycle.isCurrent(epoch)) return;
          try {
            registrar.publish(event);
          } catch {
            /* Committed outcomes survive subscriber failure. */
          }
          try {
            notifyCommittedEvent(event);
          } catch {
            /* Notifications are optional. */
          }
        },
      });
      return async () => {
        active = false;
        await cleanup?.();
      };
    };

  let sessionStore: ReturnType<
    typeof tutorPractice.createTutorPracticeSessionStore
  > | null = null;
  let artifactStore: ReturnType<
    typeof artifactStoreModule.createArtifactStore
  > | null = null;

  const modules: LearningActionModule[] = [
    contextActions.registerContextActions,
    (registrar) => {
      const host = contextIngestion.createContextIngestionHost();
      const cleanupActions = host.registerContextIngestionActions(registrar);
      registrar.handleInternal(
        'registerSelectedContextFiles',
        (context, input) => host.registerSelectedContextFiles(context, input),
      );
      return async () => {
        try {
          await cleanupActions();
        } finally {
          await host.dispose();
        }
      };
    },
    (registrar) => {
      sessionStore = tutorPractice.createTutorPracticeSessionStore({
        now: () => registrar.lifecycle.now(),
        publish: (event) => registrar.publish(event),
        cleanupOriginals: async (context, userId, storageKeys) => {
          if (context.userId !== userId)
            throw new Error('The study session owner changed.');
          await Promise.all(
            storageKeys.map((storageKey) =>
              originalStore.removeContextOriginal(userId, storageKey),
            ),
          );
        },
      });
      const activeSessionStore = sessionStore;
      const cleanupActions = sessionActions.registerSessionActions(registrar, {
        store: activeSessionStore,
      });
      let ticking: Promise<void> | null = null;
      const interval = setInterval(() => {
        if (ticking) return;
        const context = [...contexts.values()].find(
          (context) =>
            !context.signal.aborted &&
            context.isCurrent() &&
            registrar.lifecycle.isCurrent(context.epoch),
        );
        if (!context) return;
        const controller = new AbortController();
        let unregister: () => void;
        try {
          unregister = registrar.lifecycle.registerOperation(
            `study-timers:${context.userId}`,
            randomUUID(),
            controller,
          );
        } catch {
          return;
        }
        ticking = activeSessionStore.timer
          .reconcileDueStudyDeadlines({
            ...context,
            signal: AbortSignal.any([context.signal, controller.signal]),
            isCurrent: () => !controller.signal.aborted && context.isCurrent(),
          })
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            unregister();
            ticking = null;
          });
      }, 1_000);
      interval.unref();
      return async () => {
        clearInterval(interval);
        await ticking;
        await cleanupActions();
      };
    },
    (registrar) => {
      if (!sessionStore)
        throw new Error('The study session store is unavailable.');
      const activeSessionStore = sessionStore;
      return gradeActions.registerGradeActions(registrar, {
        onSettingsChanged: async (context, settings, deletedCollected) => {
          if (!settings.enabled || deletedCollected)
            await activeSessionStore.purgeGradeDerivedStudyContent(context, {
              consentRevision: settings.revision,
            });
        },
      });
    },
    (registrar) => {
      const store = artifactStoreModule.createArtifactStore({
        db: database.db,
      });
      artifactStore = store;
      const adapter = activityAdapterModule.createAcademicActivityAdapter({
        store,
      });
      const cleanupArtifacts = artifactActions.registerArtifactActions(
        registrar,
        store,
      );
      registrar.handleInternal('authorizeActivityRun', (context, request) =>
        adapter.authorizeActivityRun(context, request),
      );
      registrar.handleInternal('checkpointArtifactState', (context, proposal) =>
        adapter.checkpointArtifactState(context, proposal),
      );
      registrar.handleInternal('releaseActivityRun', (_context, request) =>
        adapter.releaseActivityRun(request),
      );
      return async () => {
        await adapter.dispose();
        await cleanupArtifacts();
      };
    },
    (registrar) => {
      if (!sessionStore || !artifactStore)
        throw new Error('The learning stores are unavailable.');
      const activeSessionStore = sessionStore;
      const activeArtifactStore = artifactStore;
      return tutorPractice.registerTutorPracticeActions(registrar, {
        sessionStore: activeSessionStore,
        requestLearning,
        createActivity: async (context, input) => {
          const assertCurrent = () => {
            if (context.signal.aborted)
              throw new LearningClientError('cancelled');
            if (!context.isCurrent())
              throw new LearningClientError('session-changed');
            const revisions = activeSessionStore.readStudySessionRevisions(
              context,
              { sessionId: input.sessionId },
            );
            if (
              revisions.contextRevision !== input.contextRevision ||
              revisions.policyRevision !== input.policyRevision ||
              revisions.gradeConsentRevision !== input.gradeConsentRevision
            )
              throw new LearningClientError('permission-revoked');
          };
          assertCurrent();
          const snapshot = await activeSessionStore.getStudySession(context, {
            sessionId: input.sessionId,
          });
          assertCurrent();
          if (!snapshot || snapshot.session.courseId !== input.courseId)
            throw new LearningClientError('scope-denied');
          const existingCourse = database.db
            .select()
            .from(tables.CourseTable)
            .where(
              and(
                eq(tables.CourseTable.userId, context.userId),
                eq(tables.CourseTable.id, snapshot.session.courseId),
                eq(tables.CourseTable.active, true),
                isNull(tables.CourseTable.suppressedAt),
              ),
            )
            .get();
          if (!existingCourse) throw new LearningClientError('scope-denied');
          const offered = new Set(
            input.references.map((reference) => JSON.stringify(reference)),
          );
          const libraryReferences = input.references.filter(
            ({ sourceKind }) => sourceKind !== 'assignment',
          );
          const passages: SourcePassage[] =
            libraryReferences.length === 0
              ? []
              : (libraryRetrieval.searchStudySources(context, {
                  sessionId: input.sessionId,
                  query: input.objective,
                  selectedIds: libraryReferences.map(
                    ({ sourceId }) => sourceId,
                  ),
                }) ?? []);
          if (
            input.references.some(
              ({ sourceKind }) => sourceKind === 'assignment',
            )
          ) {
            const targetAssignmentId = snapshot.session.targetAssignmentId;
            const existingAssignment =
              targetAssignmentId === null
                ? undefined
                : database.db
                    .select()
                    .from(tables.CourseAssignmentTable)
                    .where(
                      and(
                        eq(tables.CourseAssignmentTable.userId, context.userId),
                        eq(
                          tables.CourseAssignmentTable.courseId,
                          snapshot.session.courseId,
                        ),
                        eq(tables.CourseAssignmentTable.id, targetAssignmentId),
                        eq(tables.CourseAssignmentTable.active, true),
                        isNull(tables.CourseAssignmentTable.suppressedAt),
                      ),
                    )
                    .get();
            if (!existingAssignment?.body)
              throw new LearningClientError('scope-denied');
            const reference: SourceReference = {
              sourceKind: 'assignment',
              sourceId: existingAssignment.id,
              versionId: null,
              courseId: snapshot.session.courseId,
              locator: null,
              title: existingAssignment.title,
              provenance: 'connected-source',
              observedAt: existingAssignment.lastSeenAt,
              state: 'current',
            };
            if (!offered.has(JSON.stringify(reference)))
              throw new LearningClientError('scope-denied');
            passages.unshift({
              reference,
              text: existingAssignment.body.slice(0, 2000),
              score: null,
            });
          }
          const sources = [
            ...new Map(
              passages
                .filter(({ reference }) =>
                  offered.has(JSON.stringify(reference)),
                )
                .flatMap((passage) => {
                  const text = sourcePreview.filterSourcePreview(context, {
                    sessionId: input.sessionId,
                    reference: passage.reference,
                    text: passage.text,
                  });
                  return text === null ? [] : [{ ...passage, text }];
                })
                .map(
                  (passage) =>
                    [JSON.stringify(passage.reference), passage] as const,
                ),
            ).values(),
          ];
          if (sources.length !== offered.size)
            throw new LearningClientError('scope-denied');
          assertCurrent();
          const response = learningResponseSchema.parse(
            await requestLearning(
              learningRequestSchema.parse({
                version: 1,
                requestId: input.requestId,
                kind: 'activity-generate',
                sessionId: input.sessionId,
                courseId: input.courseId,
                contextRevision: input.contextRevision,
                input: { objective: input.objective, sources },
              }),
              context.signal,
            ),
          );
          assertCurrent();
          const [effect] = response.proposedEffects;
          if (
            response.requestId !== input.requestId ||
            response.proposedEffects.length !== 1 ||
            effect?.kind !== 'create-activity' ||
            effect.candidate.sourceReferences.some(
              (reference) => !offered.has(JSON.stringify(reference)),
            )
          )
            throw new LearningClientError('provider-failed');
          const decision = policy.assessCandidate(context, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            candidate: effect.candidate,
            policy: input.policy,
            sourceReferences: input.references,
          });
          const created = await activeArtifactStore.createArtifactVersion(
            context,
            {
              sessionId: input.sessionId,
              turnId: input.turnId,
              requestId: input.requestId,
              candidate: effect.candidate,
              policyDecision: {
                allowed: decision.allowed,
                reasonCode: decision.reasonCode,
                revision: decision.revision,
              },
            },
          );
          return {
            artifactId: created.version.artifactId,
            versionId: created.version.versionId,
            attemptId: created.attemptId,
          };
        },
      });
    },
    memoryActions.registerMemoryActions,
    todayActions.registerTodayActions,
    notificationActions.registerNotificationActions,
  ];
  return [
    (registrar) => {
      contexts.clear();
      producer = createProductNotificationProducer(registrar);
      return async () => {
        await producer.dispose();
        contexts.clear();
      };
    },
    ...modules.map(withOutcomeNotifications),
  ];
};
