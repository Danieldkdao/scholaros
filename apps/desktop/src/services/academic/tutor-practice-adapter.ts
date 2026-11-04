import { and, eq, isNull } from 'drizzle-orm';
import {
  learningRequestSchema,
  learningResponseSchema,
  practiceGenerateResponseSchema,
  practiceEvaluateResponseSchema,
  type LearningRequest,
} from '../../../../../packages/services/src/ai/learning-dispatch';
import { practiceQuestionAnswerKeySchema } from '../../../../../packages/services/src/ai/practice-generation';
import type {
  ActionCleanup,
  AuthorizedContext,
  AuthorizedRegistrar,
} from '@scholaros/services/learning/product-contracts';
import { jsonValueSchema } from '@scholaros/services/learning/product-contracts';
import type {
  SourceReference,
  SourcePassage,
} from '@scholaros/services/learning/context-contracts';
import { db } from '../../db';
import {
  ContextLinkTable,
  CourseAssignmentTable,
  CourseTable,
  StudyMessageTable,
  StudyTurnTable,
} from '../../db/schema';
import { searchStudySources } from '../../features/context/services/library-retrieval';
import { gradeStore } from '../../features/grades/services/grade-store';
import {
  assessCandidate,
  assessPracticeCandidate,
  resolveAssistancePolicy,
} from '../../features/integrity/services/policy';
import { recordAssistance } from '../../features/integrity/services/assistance-store';
import { filterSourcePreview } from '../../features/integrity/services/source-preview';
import { preparePersonalContext } from '../../features/memory/services/personal-context';
import { upsertExplicitPreference } from '../../features/memory/services/memory-store';
import {
  createPracticeAttempt,
  registerPracticeActions,
  type PracticeActionDependencies,
} from '../../features/practice/services/practice-actions';
import { createPracticeStore } from '../../features/practice/services/practice-store';
import {
  createLearningClient,
  LearningClientError,
  type LearningRequest as LocalTutorRequest,
} from '../../features/study/services/learning-client';
import {
  type LearningEffect,
  type LearningEffectHandlers,
} from '../../features/study/services/learning-tools';
import {
  createSessionStore,
  type CreateSessionStoreOptions,
  type StudyTurnAdmission,
} from '../../features/study/services/session-store';
import {
  type StudyContextDependencies,
  type StudySourceReadResult,
} from '../../features/study/services/study-context';
import { registerTutorActions } from '../../features/study/services/tutor-actions';
import {
  TutorServiceError,
  type TurnAdmission,
} from '../../features/study/services/tutor';

export type TutorPracticeDependencies = {
  sessionStore: ReturnType<typeof createSessionStore>;
  requestLearning: (
    request: LearningRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  createActivity: LearningEffectHandlers['createActivity'];
};

export const createTutorPracticeSessionStore = (
  options: Omit<
    CreateSessionStoreOptions,
    'database' | 'resolvePolicyRevision'
  > = {},
) =>
  createSessionStore({
    ...options,
    database: db,
    resolvePolicyRevision: (context, { sessionId }) =>
      resolveAssistancePolicy(context, { sessionId, sourceIds: [] })
        .policyRevision,
  });

const assertCurrent = (context: AuthorizedContext) => {
  if (context.signal.aborted) throw new TutorServiceError('cancelled');
  if (!context.isCurrent()) throw new TutorServiceError('session-changed');
};

const uniqueReferences = (references: SourceReference[]) => [
  ...new Map(
    references.map((reference) => [JSON.stringify(reference), reference]),
  ).values(),
];

const sourceSelector = ({
  sourceKind,
  sourceId,
  versionId,
  locator,
}: SourceReference) => ({ sourceKind, sourceId, versionId, locator });

const toLocalEffects = (
  request: LocalTutorRequest,
  effects: ReturnType<typeof learningResponseSchema.parse>['proposedEffects'],
  citations: SourceReference[],
): LearningEffect[] =>
  effects.map((effect): LearningEffect => {
    const offered = request.input.context.sourcePassages.map(
      ({ reference }) => reference,
    );
    switch (effect.kind) {
      case 'retrieve-source': {
        const references = offered.filter(
          ({ sourceId }) => sourceId === effect.sourceId,
        );
        if (references.length === 0)
          throw new LearningClientError('scope-denied', true);
        return {
          kind: effect.kind,
          references: references.map(sourceSelector),
        };
      }
      case 'remember-preference':
        return {
          kind: effect.kind,
          preference: effect.preference,
          evidence: request.input.message.trim().slice(0, 500),
        };
      case 'create-activity':
        return {
          kind: effect.kind,
          objective: request.input.message.slice(0, 1000),
          references: offered.map(sourceSelector),
        };
      case 'offer-practice': {
        const questionReferences = effect.questions.flatMap(
          ({ sourceReferences }) => sourceReferences,
        );
        // Proposed questions are discarded; trusted citations scope a new generation.
        // The learning client validates every citation before any effect executes.
        const references =
          questionReferences.length > 0 ? questionReferences : citations;
        return {
          kind: effect.kind,
          objective: effect.objective,
          references: uniqueReferences(references).map(sourceSelector),
        };
      }
      case 'practice-feedback':
        throw new LearningClientError('scope-denied', true);
    }
  });

export const registerTutorPracticeActions = (
  registrar: AuthorizedRegistrar,
  dependencies: TutorPracticeDependencies,
): ActionCleanup => {
  const { sessionStore } = dependencies;
  const practiceStore = createPracticeStore({ db });
  const requireSession = async (
    context: AuthorizedContext,
    sessionId: string,
    courseId?: string,
  ) => {
    assertCurrent(context);
    const snapshot = await sessionStore.getStudySession(context, {
      sessionId,
      limit: 100,
    });
    assertCurrent(context);
    if (
      !snapshot ||
      (courseId !== undefined && snapshot.session.courseId !== courseId)
    )
      throw new TutorServiceError('scope-denied');
    return snapshot;
  };
  const policyForSession: StudyContextDependencies['resolveAssistancePolicy'] =
    async (context, input) => {
      await requireSession(context, input.sessionId);
      return resolveAssistancePolicy(context, {
        sessionId: input.sessionId,
        ...(input.targetAssignmentId === null
          ? {}
          : { targetAssignmentId: input.targetAssignmentId }),
        sourceIds: input.sourceIds,
      });
    };
  const readContextRevision: StudyContextDependencies['readContextRevision'] =
    async (context, input) =>
      sessionStore.readStudySessionRevisions(context, input).contextRevision;
  const getGradeSettings: StudyContextDependencies['getGradeSettings'] = async (
    context,
  ) => {
    assertCurrent(context);
    return gradeStore.getSettings(context.userId);
  };
  const safePassages = (
    context: AuthorizedContext,
    sessionId: string,
    passages: SourcePassage[],
  ) =>
    passages.flatMap((passage) => {
      const text = filterSourcePreview(context, {
        sessionId,
        reference: passage.reference,
        text: passage.text,
      });
      return text === null ? [] : [{ ...passage, text }];
    });
  const readSources = (
    context: AuthorizedContext,
    input: { sessionId: string; query: string; selectedIds: string[] },
  ): StudySourceReadResult | null => {
    const passages = searchStudySources(context, {
      ...input,
      query: input.query.slice(0, 2000),
    });
    if (passages === null) return null;
    const safe = safePassages(context, input.sessionId, passages);
    return {
      passages: safe,
      status: safe.length === passages.length ? 'current' : 'partial',
      lastSuccessfulAt:
        safe
          .map(({ reference }) => reference.observedAt)
          .filter((time): time is string => time !== null)
          .sort()
          .at(0) ?? null,
    };
  };
  const studyContext: StudyContextDependencies = {
    getStudySession: (context, input) =>
      sessionStore.getStudySession(context, input),
    getGradeSettings,
    readContextRevision,
    resolveAssistancePolicy: policyForSession,
    preparePersonalContext: async (context, input) => {
      await requireSession(context, input.sessionId, input.courseId);
      return preparePersonalContext(context, { courseId: input.courseId });
    },
    readCourseSources: async (context, input) => {
      await requireSession(context, input.sessionId, input.courseId);
      const course = db
        .select()
        .from(CourseTable)
        .where(
          and(
            eq(CourseTable.userId, context.userId),
            eq(CourseTable.id, input.courseId),
            eq(CourseTable.active, true),
            isNull(CourseTable.suppressedAt),
          ),
        )
        .get();
      if (!course) return null;
      const result = readSources(context, {
        sessionId: input.sessionId,
        query: input.query,
        selectedIds: [],
      });
      if (!result) return null;
      const passages = result.passages.filter(
        ({ reference }) => reference.courseId === input.courseId,
      );
      if (input.targetAssignmentId) {
        const assignment = db
          .select()
          .from(CourseAssignmentTable)
          .where(
            and(
              eq(CourseAssignmentTable.userId, context.userId),
              eq(CourseAssignmentTable.courseId, input.courseId),
              eq(CourseAssignmentTable.id, input.targetAssignmentId),
              eq(CourseAssignmentTable.active, true),
              isNull(CourseAssignmentTable.suppressedAt),
            ),
          )
          .get();
        if (assignment?.body) {
          const reference: SourceReference = {
            sourceKind: 'assignment',
            sourceId: assignment.id,
            versionId: null,
            courseId: input.courseId,
            locator: null,
            title: assignment.title,
            provenance: 'connected-source',
            observedAt: assignment.lastSeenAt,
            state: 'current',
          };
          passages.unshift(
            ...safePassages(context, input.sessionId, [
              { reference, text: assignment.body.slice(0, 2000), score: null },
            ]),
          );
        }
      }
      const statuses = [
        course.assignmentsStatus,
        course.announcementsStatus,
        course.materialsStatus,
      ];
      return {
        passages: passages.slice(0, 20),
        status: statuses.every((status) => status === 'complete')
          ? result.status
          : 'partial',
        lastSuccessfulAt: course.lastSeenAt,
      };
    },
    readSelectedSources: async (context, input) => {
      await requireSession(context, input.sessionId);
      const linked = db
        .select({ itemId: ContextLinkTable.itemId })
        .from(ContextLinkTable)
        .where(
          and(
            eq(ContextLinkTable.userId, context.userId),
            eq(ContextLinkTable.sessionId, input.sessionId),
          ),
        )
        .all();
      const selectedIds = [
        ...new Set([
          ...linked.map(({ itemId }) => itemId),
          ...input.selectedIds,
        ]),
      ];
      if (selectedIds.length === 0)
        return { passages: [], status: 'current', lastSuccessfulAt: null };
      return readSources(context, { ...input, selectedIds });
    },
  };
  const practiceDependencies: Omit<PracticeActionDependencies, 'publish'> = {
    store: practiceStore,
    assessCandidate: async (context, candidate) => {
      if (candidate.sessionId === null) return { allowed: false };
      await requireSession(context, candidate.sessionId, candidate.courseId);
      return assessPracticeCandidate(context, {
        courseId: candidate.courseId,
        sessionId: candidate.sessionId,
        candidate: {
          questions: candidate.questions,
          rubricVersion: candidate.rubricVersion,
        },
        sourceReferences: uniqueReferences(
          candidate.questions.flatMap(
            ({ sourceReferences }) => sourceReferences,
          ),
        ),
      });
    },
    canPublishFeedback: async (context, input) => {
      if (input.sessionId === null) return false;
      const snapshot = await requireSession(
        context,
        input.sessionId,
        input.courseId,
      );
      const policy = await policyForSession(context, {
        sessionId: input.sessionId,
        targetAssignmentId: snapshot.session.targetAssignmentId,
        sourceIds: input.sourceReferences
          .filter(({ sourceKind }) => sourceKind === 'assignment')
          .map(({ sourceId }) => sourceId),
      });
      return (
        policy !== null &&
        policy.allowedOperations.includes('distinct-practice')
      );
    },
    evaluateAnswer: async (context, input, signal) => {
      if (input.sessionId === null) throw new TutorServiceError('scope-denied');
      const snapshot = await requireSession(
        context,
        input.sessionId,
        input.courseId,
      );
      const epoch = snapshot.session.generationEpoch;
      const revisions = sessionStore.readStudySessionRevisions(context, {
        sessionId: input.sessionId,
      });
      const policy = await policyForSession(context, {
        sessionId: input.sessionId,
        targetAssignmentId: snapshot.session.targetAssignmentId,
        sourceIds: input.question.sourceReferences.map(
          ({ sourceId }) => sourceId,
        ),
      });
      if (!policy?.allowedOperations.includes('distinct-practice'))
        throw new TutorServiceError('permission-revoked');
      const request: LearningRequest = learningRequestSchema.parse({
        version: 1,
        kind: 'practice-evaluate',
        requestId: input.requestId,
        sessionId: input.sessionId,
        courseId: input.courseId,
        contextRevision: revisions.contextRevision,
        input: {
          priorAssistanceSummary: policy.priorAssistanceSummary,
          question: input.question,
          answer: input.answer,
          answerKey: practiceQuestionAnswerKeySchema.parse(input.answerKey),
          rubricVersion: input.rubricVersion,
          assisted: input.assisted,
        },
      });
      const response = practiceEvaluateResponseSchema.parse(
        await dependencies.requestLearning(request, signal),
      );
      const current = await requireSession(
        context,
        input.sessionId,
        input.courseId,
      );
      const currentRevisions = sessionStore.readStudySessionRevisions(context, {
        sessionId: input.sessionId,
      });
      if (
        signal.aborted ||
        current.session.generationEpoch !== epoch ||
        JSON.stringify(revisions) !== JSON.stringify(currentRevisions)
      )
        throw new TutorServiceError('permission-revoked');
      if (response.requestId !== request.requestId)
        throw new TutorServiceError('provider-failed');
      return response.evaluation;
    },
  };
  const effectHandlers: LearningEffectHandlers = {
    readContextRevision,
    getGradeSettings,
    resolveAssistancePolicy: policyForSession,
    isTurnCurrent: async (context, input) => {
      const snapshot = await requireSession(context, input.sessionId);
      const turn = db
        .select()
        .from(StudyTurnTable)
        .where(
          and(
            eq(StudyTurnTable.userId, context.userId),
            eq(StudyTurnTable.sessionId, input.sessionId),
            eq(StudyTurnTable.id, input.turnId),
          ),
        )
        .get();
      return (
        snapshot.session.generationEpoch === input.generationEpoch &&
        turn?.generationEpoch === input.generationEpoch &&
        (turn.status === 'checking' || turn.status === 'generating')
      );
    },
    rememberPreference: async (context, input) =>
      upsertExplicitPreference(context, {
        requestId: input.requestId,
        courseId: input.courseId,
        preference: input.preference,
      }),
    createActivity: dependencies.createActivity,
    offerPractice: async (context, input) => {
      const snapshot = await requireSession(
        context,
        input.sessionId,
        input.courseId,
      );
      const revisions = sessionStore.readStudySessionRevisions(context, {
        sessionId: input.sessionId,
      });
      const selected = readSources(context, {
        sessionId: input.sessionId,
        query: input.objective,
        selectedIds: input.references.map(({ sourceId }) => sourceId),
      });
      const offered = new Set(
        input.references.map((reference) => JSON.stringify(reference)),
      );
      const sources =
        selected?.passages
          .filter(({ reference }) => offered.has(JSON.stringify(reference)))
          .map(({ reference, text }) => ({ reference, excerpt: text })) ?? [];
      if (sources.length === 0) throw new TutorServiceError('scope-denied');
      const request: LearningRequest = learningRequestSchema.parse({
        version: 1,
        kind: 'practice-generate',
        requestId: input.requestId,
        sessionId: input.sessionId,
        courseId: input.courseId,
        contextRevision: revisions.contextRevision,
        input: {
          topic: input.objective,
          difficulty: 'developing',
          questionCount: 3,
          objectives: [{ id: input.requestId, description: input.objective }],
          sources,
          priorAssistanceSummary: input.policy.priorAssistanceSummary,
        },
      });
      const response = practiceGenerateResponseSchema.parse(
        await dependencies.requestLearning(request, context.signal),
      );
      const current = await requireSession(
        context,
        input.sessionId,
        input.courseId,
      );
      const currentRevisions = sessionStore.readStudySessionRevisions(context, {
        sessionId: input.sessionId,
      });
      if (
        response.requestId !== request.requestId ||
        current.session.generationEpoch !== snapshot.session.generationEpoch ||
        JSON.stringify(revisions) !== JSON.stringify(currentRevisions)
      )
        throw new TutorServiceError('permission-revoked');
      const attempt = await createPracticeAttempt(
        context,
        {
          requestId: input.requestId,
          courseId: input.courseId,
          sessionId: input.sessionId,
          artifactId: null,
          versionId: response.candidate.rubricVersion,
          objectiveIds: [input.requestId],
          mode: snapshot.session.activity === 'prepare-exam' ? 'exam' : 'quiz',
          feedbackMode: 'end',
          ...response.candidate,
          hostAnswerKey: jsonValueSchema.parse(
            response.candidate.hostAnswerKey,
          ),
        },
        practiceDependencies,
      );
      return { practiceAttemptId: attempt.id };
    },
  };
  const tutorCleanup = registerTutorActions(registrar, {
    studyContext,
    learningEffectHandlers: effectHandlers,
    learningClient: createLearningClient({
      requestLearning: async (localRequest, signal) => {
        const prepared = localRequest.input.context;
        const request = learningRequestSchema.parse({
          version: 1,
          kind: 'tutor-turn',
          requestId: localRequest.requestId,
          sessionId: localRequest.sessionId,
          courseId: localRequest.courseId,
          contextRevision: localRequest.contextRevision,
          input: {
            activity: prepared.activity,
            studentText:
              localRequest.input.message ||
              'Explain the selected attached material conceptually.',
            targetAssignmentId: prepared.targetAssignmentId,
            sources: prepared.sourcePassages,
            history: prepared.history,
            personalContext: prepared.personalContext,
            freshness: prepared.freshness,
            priorAssistanceSummary: prepared.policy.priorAssistanceSummary,
            ...(localRequest.input.safeRegeneration
              ? { safeRegeneration: localRequest.input.safeRegeneration }
              : {}),
          },
        });
        const parsed = learningResponseSchema.safeParse(
          await dependencies.requestLearning(request, signal),
        );
        if (!parsed.success)
          throw new LearningClientError('invalid-input', true);
        const response = parsed.data;
        return {
          ...response,
          proposedEffects: toLocalEffects(
            localRequest,
            response.proposedEffects,
            response.citations,
          ),
        };
      },
    }),
    beginStudyTurn: async (context, input): Promise<TurnAdmission> => {
      const admitted: StudyTurnAdmission =
        input.kind === 'send'
          ? await sessionStore.beginStudyTurn(context, {
              sessionId: input.sessionId,
              requestId: input.requestId,
              expectedDraftRevision: input.expectedDraftRevision,
              text: input.text,
              attachmentIds: input.attachmentIds,
            })
          : await sessionStore.retryStudyTurn(context, {
              sessionId: input.sessionId,
              turnId: input.turnId,
              requestId: input.requestId,
            });
      const student = db
        .select()
        .from(StudyMessageTable)
        .where(
          and(
            eq(StudyMessageTable.userId, context.userId),
            eq(StudyMessageTable.sessionId, input.sessionId),
            eq(StudyMessageTable.turnId, admitted.turnId),
            eq(StudyMessageTable.role, 'student'),
          ),
        )
        .get();
      if (!student) throw new TutorServiceError('storage-failed');
      return {
        sessionId: input.sessionId,
        turnId: admitted.turnId,
        requestId: input.requestId,
        revision: admitted.revision,
        generationEpoch: admitted.generationEpoch,
        attemptNumber: admitted.turn.attemptNumber,
        contextRevision: admitted.contextRevision,
        policyRevision: admitted.policyRevision,
        gradeConsentRevision: admitted.gradeConsentRevision,
        studentMessage: student.parts
          .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
          .join('\n'),
        attachmentIds: student.parts.flatMap((part) =>
          part.kind === 'attachment' ? [part.itemId] : [],
        ),
        executionRequired: !admitted.duplicate,
      };
    },
    setStudyTurnStatus: async (context, { turnId, status }) => {
      await sessionStore.updateStudyTurnStatus(context, { turnId, status });
    },
    settleStudyTurn: async (context, { turnId, status, errorCode }) => {
      await sessionStore.settleStudyTurn(context, {
        turnId,
        status,
        errorCode,
      });
    },
    commitStudyTurn: async (
      context,
      { sessionId, ...input },
      beforePublish,
    ) => {
      await requireSession(context, sessionId);
      await sessionStore.commitStudyTurn(context, input, beforePublish);
      const snapshot = await requireSession(context, sessionId);
      return { committed: true, revision: snapshot.revision };
    },
    appendStudyTurnParts: (context, input) =>
      sessionStore.appendStudyTurnParts(context, input),
    assessCandidate: async (context, input) =>
      assessCandidate(context, {
        ...input,
        candidate: jsonValueSchema.parse(input.candidate),
      }),
    reserveStudyTurnAssistance: sessionStore.reserveStudyTurnAssistance,
    recordAssistance,
  });
  const practiceCleanup = registerPracticeActions(
    registrar,
    practiceDependencies,
  );
  return async () => {
    await Promise.all([tutorCleanup(), practiceCleanup()]);
  };
};
