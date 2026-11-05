import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionCleanup,
  AuthorizedContext,
  AuthorizedRegistrar,
  InputOf,
  LearningPublicMethod,
  ProductEventV1,
  ResultOf,
} from '@scholaros/services/learning/product-contracts';
import type { TutorPracticeDependencies } from '../tutor-practice-adapter';

vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userData = mkdtempSync(join(tmpdir(), 'scholaros-tutor-adapter-'));
  const app = {
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    isPackaged: false,
    once: vi.fn(),
    on: vi.fn(),
  };
  return { app, default: { app } };
});

const { db } = await import('../../../db');
const {
  CourseTable,
  CourseAssignmentTable,
  StudySessionTable,
  StudyTurnTable,
  StudyMessageTable,
  CourseworkProtectionTable,
  AssistanceLedgerTable,
  ContextItemTable,
  ContextVersionTable,
  ContextLinkTable,
  ContextChunkTable,
  PracticeAttemptTable,
  PracticeAnswerTable,
  ArtifactTable,
  ArtifactVersionTable,
  ArtifactStateTable,
} = await import('../../../db/schema');
const { createContextNote } =
  await import('../../../features/context/services/library-store');
const { createArtifactStore } =
  await import('../../../features/study/services/artifact-store');
const { createPracticeStore } =
  await import('../../../features/practice/services/practice-store');
const { assessCandidate } =
  await import('../../../features/integrity/services/policy');
const { createLearningLifecycle } = await import('../learning-actions');
const { createTutorPracticeSessionStore, registerTutorPracticeActions } =
  await import('../tutor-practice-adapter');

const owner = 'tutor-adapter-fixture-owner';
const courseId = 'tutor-adapter-fixture-course';
const context: AuthorizedContext = {
  userId: owner,
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
};
const handlers = new Map<
  LearningPublicMethod,
  (context: AuthorizedContext, input: unknown) => Promise<unknown>
>();
const events: ProductEventV1[] = [];
let lifecycle = createLearningLifecycle();
const registrar: AuthorizedRegistrar = {
  handle: <Method extends LearningPublicMethod>(
    name: Method,
    handler: (
      context: AuthorizedContext,
      input: InputOf<Method>,
    ) => Promise<ResultOf<Method>>,
  ) => {
    handlers.set(name, (context, input) =>
      handler(context, input as InputOf<Method>),
    );
  },
  publish: (event) => events.push(event),
  get lifecycle() {
    return lifecycle;
  },
};
const call = async <Method extends LearningPublicMethod>(
  name: Method,
  input: InputOf<Method>,
  authorized = context,
): Promise<ResultOf<Method>> => {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Missing registered handler ${name}`);
  return (await handler(authorized, input)) as ResultOf<Method>;
};
let sessionStore = createTutorPracticeSessionStore();
let cleanup: ActionCleanup | undefined;
const createActivity: TutorPracticeDependencies['createActivity'] =
  async () => {
    throw new Error('Activity generation is not used in this scenario.');
  };
const tutorResponse = async (
  request: Parameters<TutorPracticeDependencies['requestLearning']>[0],
  _signal: AbortSignal,
) => {
  if (request.kind !== 'tutor-turn')
    throw new Error('Unexpected learning operation.');
  return {
    version: 1,
    requestId: request.requestId,
    generationId: randomUUID(),
    parts: [
      {
        kind: 'text',
        text: 'A cell membrane separates the cell from its surroundings.',
      },
    ],
    citations: [],
    proposedEffects: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    configurationRevision: 'fixture-meta-configuration',
  };
};
const createSession = () =>
  sessionStore.createStudySession(context, {
    requestId: randomUUID(),
    courseId,
    activity: 'understand-topic',
    targetAssignmentId: null,
    topic: 'Cell membranes',
    contextItemIds: [],
    durationMinutes: null,
    title: 'Membranes',
  });
const snapshot = (sessionId: string) =>
  sessionStore.getStudySession(context, { sessionId, limit: 100 });
const send = (sessionId: string, authorized = context) =>
  call(
    'sendStudyTurn',
    {
      sessionId,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Explain cell membranes conceptually.',
      attachmentIds: [],
    },
    authorized,
  );

beforeEach(() => {
  db.delete(ArtifactStateTable).run();
  db.delete(ArtifactVersionTable).run();
  db.delete(ArtifactTable).run();
  db.delete(PracticeAnswerTable).run();
  db.delete(PracticeAttemptTable).run();
  db.delete(ContextChunkTable).run();
  db.delete(ContextLinkTable).run();
  db.delete(ContextVersionTable).run();
  db.delete(ContextItemTable).run();
  db.delete(AssistanceLedgerTable).run();
  db.delete(StudyMessageTable).run();
  db.delete(StudyTurnTable).run();
  db.delete(StudySessionTable).run();
  db.delete(CourseworkProtectionTable).run();
  db.delete(CourseAssignmentTable).run();
  db.delete(CourseTable).run();
  const now = new Date().toISOString();
  db.insert(CourseTable)
    .values({
      id: courseId,
      userId: owner,
      connectionId: null,
      sourceKey: `manual:${courseId}`,
      sourceName: 'Manual',
      sourceHost: '',
      externalId: null,
      name: 'Biology',
      code: null,
      term: null,
      instructor: null,
      description: null,
      url: '',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();
  lifecycle = createLearningLifecycle();
  sessionStore = createTutorPracticeSessionStore();
  handlers.clear();
  events.length = 0;
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  await lifecycle.invalidate();
});

describe('real tutor and practice academic registration', () => {
  it('regenerates a rejected wire effect once without publishing either private candidate', async () => {
    const requestLearning = vi.fn<TutorPracticeDependencies['requestLearning']>(
      async (request, signal) => ({
        ...(await tutorResponse(request, signal)),
        parts: [{ kind: 'text', text: 'MUST_NEVER_BE_VISIBLE' }],
        proposedEffects: [
          {
            kind: 'practice-feedback',
            attemptId: 'unowned-attempt',
            evaluation: {
              questionId: 'question',
              outcome: 'correct',
              explanation: 'Private feedback',
              acceptedAlternatives: [],
              sourceReferences: [],
              rubricVersion: 'rubric',
              assisted: false,
            },
          },
        ],
      }),
    );
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    const session = await createSession();
    const admitted = await send(session.id);
    await vi.waitFor(() =>
      expect(
        db
          .select()
          .from(StudyTurnTable)
          .where(eq(StudyTurnTable.id, admitted.turnId))
          .get()?.status,
      ).toBe('complete'),
    );
    expect(requestLearning).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify((await snapshot(session.id))?.messages),
    ).not.toContain('MUST_NEVER_BE_VISIBLE');
    expect(requestLearning.mock.calls[1]![0].input).toMatchObject({
      safeRegeneration: { attemptNumber: 2 },
    });
  });

  it('keeps the protected assignment hint budget across actual durable turns', async () => {
    db.insert(CourseAssignmentTable)
      .values({
        id: 'protected-fixture-assignment',
        userId: owner,
        courseId,
        sourceKey: 'manual:protected-fixture-assignment',
        title: 'Membrane assignment',
        body: null,
        dateValue: null,
        dateText: null,
        url: '',
        lastSeenAt: new Date().toISOString(),
      })
      .run();
    let index = 0;
    const requestLearning: TutorPracticeDependencies['requestLearning'] =
      async (request, signal) => ({
        ...(await tutorResponse(request, signal)),
        parts: [
          {
            kind: 'text',
            text: `Bounded conceptual nudge ${++index}: consider the cell membrane boundary.`,
          },
        ],
      });
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    const session = await sessionStore.createStudySession(context, {
      requestId: randomUUID(),
      courseId,
      activity: 'assignment-start',
      targetAssignmentId: 'protected-fixture-assignment',
      contextItemIds: [],
      durationMinutes: null,
      title: 'Assignment start',
    });
    for (const status of ['complete', 'complete', 'failed']) {
      const admitted = await send(session.id);
      await vi.waitFor(() =>
        expect(
          db
            .select()
            .from(StudyTurnTable)
            .where(eq(StudyTurnTable.id, admitted.turnId))
            .get()?.status,
        ).toBe(status),
      );
    }
    const ledger = db.select().from(AssistanceLedgerTable).all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.assistanceUnits).toBe(2);
    expect(
      (await snapshot(session.id))?.messages.filter(
        ({ role }) => role === 'tutor',
      ),
    ).toHaveLength(2);
  });

  it('cancels and awaits an in-flight real practice submission before returning cleanup', async () => {
    const session = await createSession();
    const practiceStore = createPracticeStore({ db });
    let attempt = practiceStore.createPracticeAttempt(owner, {
      requestId: randomUUID(),
      courseId,
      sessionId: session.id,
      artifactId: null,
      versionId: 'fixture-rubric',
      rubricVersion: 'fixture-rubric',
      objectiveIds: ['objective'],
      mode: 'exam',
      feedbackMode: 'end',
      questions: [
        {
          id: 'question',
          kind: 'numeric',
          prompt: 'Count three synthetic cells.',
          options: null,
          unit: null,
          objectiveIds: ['objective'],
          sourceReferences: [],
        },
      ],
      hostAnswerKey: [
        {
          questionId: 'question',
          kind: 'numeric',
          acceptedValues: [{ value: 3, tolerance: 0, unit: null }],
          explanation: 'Three synthetic cells.',
          acceptedAlternatives: [],
        },
      ],
    });
    let release!: () => void;
    let providerSignal: AbortSignal | undefined;
    const requestLearning = vi.fn<TutorPracticeDependencies['requestLearning']>(
      async (request, signal) => {
        if (request.kind !== 'practice-evaluate')
          throw new Error('Unexpected synthetic operation.');
        providerSignal = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          version: 1,
          requestId: request.requestId,
          kind: 'practice-evaluate',
          configurationRevision: 'meta-fixture',
          usage: { inputTokens: 0, outputTokens: 0 },
          evaluation: {
            questionId: 'question',
            outcome: 'correct',
            explanation: 'Three synthetic cells.',
            acceptedAlternatives: [],
            sourceReferences: [],
            rubricVersion: 'fixture-rubric',
            assisted: false,
          },
        };
      },
    );
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    attempt = await call('savePracticeAnswer', {
      attemptId: attempt.id,
      questionId: 'question',
      expectedRevision: 0,
      value: 3,
      requestId: randomUUID(),
    });
    const submitting = call('submitPracticeAttempt', {
      attemptId: attempt.id,
      expectedRevision: attempt.revision,
      requestId: randomUUID(),
    });
    const rejected = expect(submitting).rejects.toMatchObject({
      code: 'cancelled',
    });
    await vi.waitFor(() => expect(requestLearning).toHaveBeenCalledOnce());
    let settled = false;
    const cleaning = Promise.resolve(cleanup()).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
    expect(settled).toBe(false);
    release();
    await cleaning;
    await rejected;
    expect(
      practiceStore.getPracticeAttempt(owner, { attemptId: attempt.id })
        ?.feedback,
    ).toEqual([]);
  });

  it('creates a real sandboxed concept activity without course materials and streams only its committed explanation', async () => {
    const artifactStore = createArtifactStore({ db });
    const candidate = {
      title: 'Number explorer',
      objective: 'Explore numbers.',
      html: '<label for="number">Number</label><input id="number" type="number" value="1"><output id="result" aria-live="polite">1</output>',
      css: '',
      javascript:
        'const input = document.querySelector("#number"); const output = document.querySelector("#result"); input.addEventListener("input", () => { output.textContent = input.value; });',
      accessibleExplanation: 'Change the number to inspect its value.',
      runtimeVersion: 1 as const,
      sourceReferences: [],
    };
    const createConcept: TutorPracticeDependencies['createActivity'] = async (
      authorized,
      input,
    ) => {
      expect(input.references).toEqual([]);
      expect(events.some((event) => event.approvedTutorOutput)).toBe(false);
      const decision = assessCandidate(authorized, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        candidate,
        policy: input.policy,
        sourceReferences: [],
      });
      const created = await artifactStore.createArtifactVersion(authorized, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        requestId: input.requestId,
        candidate,
        policyDecision: {
          allowed: decision.allowed,
          reasonCode: decision.reasonCode,
          revision: decision.revision,
        },
      });
      return {
        artifactId: created.version.artifactId,
        versionId: created.version.versionId,
        attemptId: created.attemptId,
      };
    };
    cleanup = registerTutorPracticeActions(
      {
        ...registrar,
        publish: (event) => {
          if (event.approvedTutorOutput) {
            const persisted = db
              .select()
              .from(StudyMessageTable)
              .where(
                eq(StudyMessageTable.id, event.approvedTutorOutput.messageId),
              )
              .get();
            expect(persisted?.role).toBe('tutor');
            expect(
              persisted?.parts.some(({ kind }) => kind === 'activity'),
            ).toBe(true);
            expect(
              db
                .select()
                .from(StudyTurnTable)
                .where(eq(StudyTurnTable.id, event.approvedTutorOutput.turnId))
                .get()?.status,
            ).toBe('complete');
          }
          events.push(event);
        },
      },
      {
        sessionStore,
        createActivity: createConcept,
        requestLearning: async (request, signal) => ({
          ...(await tutorResponse(request, signal)),
          proposedEffects: [{ kind: 'create-activity', candidate }],
        }),
      },
    );
    try {
      const session = await createSession();
      await send(session.id);
      await vi.waitFor(() =>
        expect(
          events.some(({ approvedTutorOutput }) => approvedTutorOutput?.done),
        ).toBe(true),
      );
      expect(
        (await snapshot(session.id))?.messages
          .flatMap(({ parts }) => parts)
          .some(({ kind }) => kind === 'activity'),
      ).toBe(true);
      expect(db.select().from(ArtifactTable).all()).toHaveLength(1);
    } finally {
      artifactStore.dispose();
    }
  });

  it('persists approved activity effects while the real P20 turn is active and appends only after publication', async () => {
    db.insert(CourseAssignmentTable)
      .values({
        id: 'protected-fixture-assignment',
        userId: owner,
        courseId,
        sourceKey: 'manual:protected-fixture-assignment',
        title: 'Membrane assignment',
        body: null,
        dateValue: null,
        dateText: null,
        url: '',
        lastSeenAt: new Date().toISOString(),
      })
      .run();
    await createContextNote(context, {
      requestId: randomUUID(),
      title: 'Membrane notes',
      text: 'Explain cell membranes conceptually. A cell membrane separates a cell from its surroundings.',
      kind: 'note',
      courseId,
    });
    const artifactStore = createArtifactStore({ db });
    const candidate = {
      title: 'Cell counter',
      objective: 'Explore cell counts.',
      html: '<label for="count">Cells</label><input id="count" type="number" value="1"><output id="result" aria-live="polite">1</output>',
      css: '',
      javascript:
        'const input = document.querySelector("#count"); const output = document.querySelector("#result"); input.addEventListener("input", () => { output.textContent = input.value; });',
      accessibleExplanation:
        'Enter a cell count and observe the current value.',
      runtimeVersion: 1 as const,
      sourceReferences: [],
    };
    const createActivity: TutorPracticeDependencies['createActivity'] = async (
      authorized,
      input,
    ) => {
      expect(
        db.select().from(AssistanceLedgerTable).all()[0]?.assistanceUnits,
      ).toBe(1);
      expect(
        db
          .select()
          .from(StudyTurnTable)
          .where(eq(StudyTurnTable.id, input.turnId))
          .get()?.status,
      ).toBe('checking');
      const policyDecision = assessCandidate(authorized, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        candidate,
        policy: input.policy,
        sourceReferences: input.references,
      });
      const created = await artifactStore.createArtifactVersion(authorized, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        requestId: input.requestId,
        candidate,
        policyDecision: {
          allowed: policyDecision.allowed,
          reasonCode: policyDecision.reasonCode,
          revision: policyDecision.revision,
        },
      });
      return {
        artifactId: created.version.artifactId,
        versionId: created.version.versionId,
        attemptId: created.attemptId,
      };
    };
    const requestLearning: TutorPracticeDependencies['requestLearning'] =
      async (request, signal) => ({
        ...(await tutorResponse(request, signal)),
        proposedEffects: [{ kind: 'create-activity', candidate }],
      });
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    const session = await sessionStore.createStudySession(context, {
      requestId: randomUUID(),
      courseId,
      activity: 'assignment-start',
      targetAssignmentId: 'protected-fixture-assignment',
      contextItemIds: [],
      durationMinutes: null,
      title: 'Assignment start',
    });
    await send(session.id);
    await vi.waitFor(async () =>
      expect(
        (await snapshot(session.id))?.messages
          .flatMap(({ parts }) => parts)
          .some(({ kind }) => kind === 'activity'),
      ).toBe(true),
    );
    expect(db.select().from(ArtifactTable).all()).toHaveLength(1);
    artifactStore.dispose();
  });

  it.each([
    'question-references',
    'cited-source',
    'missing-citations',
    'foreign-citation',
    'stale-citation',
    'cross-course-citation',
    'invalid-question-reference',
    'assignment-target',
    'assignment-wrong',
    'assignment-stale',
    'assignment-cross-course',
  ] as const)(
    'validates practice source selection with %s',
    async (sourceMode) => {
      const assignmentMode = sourceMode.startsWith('assignment-');
      if (assignmentMode)
        db.insert(CourseAssignmentTable)
          .values({
            id: 'practice-target-assignment',
            userId: owner,
            courseId,
            sourceKey: 'manual:practice-target-assignment',
            title: 'Membrane assignment',
            body: 'Explain cell membranes conceptually. Describe transport through membranes.',
            dateValue: null,
            dateText: null,
            url: '',
            lastSeenAt: new Date().toISOString(),
          })
          .run();
      await createContextNote(context, {
        requestId: randomUUID(),
        title: 'Membrane notes',
        text: 'Explain cell membranes conceptually. A cell membrane separates the cell from its surroundings.',
        kind: 'note',
        courseId,
      });
      await createContextNote(context, {
        requestId: randomUUID(),
        title: 'Additional membrane notes',
        text: 'Explain cell membranes conceptually. Membrane proteins help transport substances.',
        kind: 'note',
        courseId,
      });
      let selectedSourceId = '';
      const succeeds = [
        'question-references',
        'cited-source',
        'assignment-target',
      ].includes(sourceMode);
      const requestLearning = vi.fn<
        TutorPracticeDependencies['requestLearning']
      >(async (request, signal) => {
        if (request.kind === 'tutor-turn') {
          expect(request.input.sources).toHaveLength(assignmentMode ? 3 : 2);
          const reference = request.input.sources[0]!.reference;
          selectedSourceId = reference.sourceId;
          const citation = {
            ...reference,
            ...(['foreign-citation', 'assignment-wrong'].includes(sourceMode)
              ? { sourceId: 'foreign-source' }
              : {}),
            ...(['stale-citation', 'assignment-stale'].includes(sourceMode)
              ? { versionId: 'stale-version' }
              : {}),
            ...(['cross-course-citation', 'assignment-cross-course'].includes(
              sourceMode,
            )
              ? { courseId: 'foreign-course' }
              : {}),
          };
          return {
            ...(await tutorResponse(request, signal)),
            citations:
              sourceMode === 'missing-citations'
                ? []
                : sourceMode === 'question-references'
                  ? [request.input.sources[1]!.reference]
                  : [citation],
            proposedEffects: [
              {
                kind: 'offer-practice',
                objective: 'Explain cell membranes conceptually.',
                questions: [
                  {
                    id: 'proposal-question',
                    kind: 'numeric',
                    prompt: 'A distinct example.',
                    unit: null,
                    options: null,
                    objectiveIds: ['objective'],
                    sourceReferences:
                      sourceMode === 'question-references'
                        ? [reference]
                        : sourceMode === 'invalid-question-reference'
                          ? [
                              {
                                ...reference,
                                sourceId: 'invalid-question-source',
                              },
                            ]
                          : [],
                  },
                ],
              },
            ],
          };
        }
        if (request.kind === 'practice-generate') {
          expect(request.input.sources).toHaveLength(1);
          expect(request.input.sources[0]!.reference.sourceId).toBe(
            selectedSourceId,
          );
          const reference = request.input.sources[0]!.reference;
          return {
            version: 1,
            requestId: request.requestId,
            kind: 'practice-generate',
            configurationRevision: 'meta-fixture',
            usage: { inputTokens: 1, outputTokens: 1 },
            candidate: {
              rubricVersion: `fixture-rubric-${request.requestId}`,
              questions: Array.from({ length: 3 }, (_, index) => ({
                id: `question-${index}`,
                kind: 'numeric',
                prompt: `A distinct cell count increases from ${index + 2} to ${index + 5}; give the increase.`,
                options: null,
                unit: null,
                objectiveIds: [request.input.objectives[0]!.id],
                sourceReferences: [reference],
              })),
              hostAnswerKey: Array.from({ length: 3 }, (_, index) => ({
                questionId: `question-${index}`,
                kind: 'numeric',
                generationProof: `server-approved-${request.requestId}`,
                acceptedValues: [{ value: 3, tolerance: 0, unit: null }],
                explanation: 'The increase is three cells.',
                acceptedAlternatives: [],
              })),
            },
          };
        }
        if (request.kind === 'practice-evaluate')
          return {
            version: 1,
            requestId: request.requestId,
            kind: 'practice-evaluate',
            configurationRevision: 'meta-fixture',
            usage: { inputTokens: 0, outputTokens: 0 },
            evaluation: {
              questionId: request.input.question.id,
              outcome: 'correct',
              explanation: 'The increase is three cells.',
              acceptedAlternatives: [],
              sourceReferences: request.input.question.sourceReferences,
              rubricVersion: request.input.rubricVersion,
              assisted: request.input.assisted,
            },
          };
        throw new Error('Unexpected synthetic operation.');
      });
      cleanup = registerTutorPracticeActions(registrar, {
        sessionStore,
        requestLearning,
        createActivity,
      });
      const session = await sessionStore.createStudySession(context, {
        requestId: randomUUID(),
        courseId,
        activity: 'prepare-exam',
        targetAssignmentId: assignmentMode
          ? 'practice-target-assignment'
          : null,
        topic: 'Cell membranes',
        contextItemIds: [],
        durationMinutes: null,
        title: 'Exam practice',
      });
      const admitted = await send(session.id);
      if (!succeeds) {
        await vi.waitFor(() =>
          expect(
            db
              .select()
              .from(StudyTurnTable)
              .where(eq(StudyTurnTable.id, admitted.turnId))
              .get()?.status,
          ).toBe('complete'),
        );
        expect(
          requestLearning.mock.calls.filter(
            ([request]) => request.kind === 'practice-generate',
          ),
        ).toHaveLength(0);
        expect(db.select().from(PracticeAttemptTable).all()).toHaveLength(0);
        const messages = (await snapshot(session.id))!.messages;
        expect(
          messages
            .filter(({ role }) => role === 'tutor')
            .flatMap(({ parts }) => parts)
            .some(({ kind }) => kind === 'text' || kind === 'practice'),
        ).toBe(false);
        return;
      }
      let attemptId = '';
      await vi.waitFor(async () => {
        const part = (await snapshot(session.id))?.messages
          .flatMap(({ parts }) => parts)
          .find((part) => part.kind === 'practice');
        expect(part?.kind).toBe('practice');
        if (part?.kind === 'practice') attemptId = part.practiceAttemptId;
      });
      let attempt = await call('getPracticeAttempt', { attemptId });
      expect(attempt.mode).toBe('exam');
      expect(attempt.feedback).toEqual([]);
      expect(JSON.stringify(attempt)).not.toContain('hostAnswerKey');
      expect(JSON.stringify(attempt)).not.toContain('acceptedValues');
      for (const question of attempt.questions) {
        attempt = await call('savePracticeAnswer', {
          attemptId,
          questionId: question.id,
          expectedRevision: attempt.revision,
          value: 3,
          requestId: randomUUID(),
        });
        expect(attempt.feedback).toEqual([]);
      }
      expect(
        requestLearning.mock.calls.filter(
          ([request]) => request.kind === 'practice-evaluate',
        ),
      ).toHaveLength(0);
      attempt = await call('submitPracticeAttempt', {
        attemptId,
        expectedRevision: attempt.revision,
        requestId: randomUUID(),
      });
      expect(attempt.status).toBe('evaluated');
      expect(attempt.feedback).toHaveLength(3);
      expect(attempt.feedback.every(({ assisted }) => !assisted)).toBe(true);
      const priorPrivate = db
        .select()
        .from(PracticeAttemptTable)
        .where(eq(PracticeAttemptTable.id, attemptId))
        .get()!;
      const retryId = randomUUID();
      const fresh = await call('retryPracticeAttempt', {
        attemptId,
        requestId: retryId,
      });
      expect(fresh.priorAttemptId).toBe(attemptId);
      expect(fresh.feedback).toEqual([]);
      expect(JSON.stringify(fresh)).not.toContain('generationProof');
      const afterPrivate = db
        .select()
        .from(PracticeAttemptTable)
        .where(eq(PracticeAttemptTable.id, fresh.id))
        .get()!;
      expect(afterPrivate.artifactId).toBeNull();
      expect(afterPrivate.rubricVersion).not.toBe(priorPrivate.rubricVersion);
      expect(JSON.stringify(afterPrivate.hostAnswerKey)).toContain(
        `server-approved-${retryId}`,
      );
      expect(
        db
          .select()
          .from(PracticeAttemptTable)
          .where(eq(PracticeAttemptTable.id, attemptId))
          .get(),
      ).toEqual(priorPrivate);
      const generationCalls = requestLearning.mock.calls.filter(
        ([req]) => req.kind === 'practice-generate',
      ).length;
      expect(
        await call('retryPracticeAttempt', { attemptId, requestId: retryId }),
      ).toEqual(fresh);
      expect(
        requestLearning.mock.calls.filter(
          ([req]) => req.kind === 'practice-generate',
        ),
      ).toHaveLength(generationCalls);
      db.update(AssistanceLedgerTable)
        .set({ answerRiskTags: ['cumulative-fragment'] })
        .run();
      expect(
        (await call('getPracticeAttempt', { attemptId })).feedback,
      ).toEqual([]);
      await expect(
        call(
          'getPracticeAttempt',
          { attemptId },
          { ...context, userId: 'other-fixture-account' },
        ),
      ).rejects.toMatchObject({ code: 'not-found' });
    },
  );

  it('keeps a failed provider response private and retries the saved message instead of the new draft', async () => {
    const requestLearning = vi.fn<TutorPracticeDependencies['requestLearning']>(
      async () => {
        throw new Error('Synthetic provider failure');
      },
    );
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    const session = await createSession();
    const admitted = await send(session.id);
    await vi.waitFor(() =>
      expect(
        db
          .select()
          .from(StudyTurnTable)
          .where(eq(StudyTurnTable.id, admitted.turnId))
          .get()?.status,
      ).toBe('failed'),
    );
    expect(
      (await snapshot(session.id))?.messages.some(
        ({ role }) => role === 'tutor',
      ),
    ).toBe(false);
    await sessionStore.saveStudyDraft(context, {
      sessionId: session.id,
      expectedDraftRevision: 0,
      text: 'A different unsent draft.',
    });
    requestLearning.mockImplementation(tutorResponse);
    await call('retryStudyTurn', {
      sessionId: session.id,
      turnId: admitted.turnId,
      requestId: randomUUID(),
    });
    await vi.waitFor(() =>
      expect(
        db
          .select()
          .from(StudyTurnTable)
          .where(eq(StudyTurnTable.id, admitted.turnId))
          .get()?.status,
      ).toBe('complete'),
    );
    const retried = requestLearning.mock.calls[1]![0];
    expect(retried.input).toMatchObject({
      studentText: 'Explain cell membranes conceptually.',
    });
    const completed = await snapshot(session.id);
    expect(
      completed?.messages.filter(({ role }) => role === 'student'),
    ).toHaveLength(1);
    expect(completed?.session.draft.text).toBe('A different unsent draft.');
  });

  it('awaits actual provider settlement on cancellation without accepting a late candidate', async () => {
    let release!: () => void;
    let providerSignal: AbortSignal | undefined;
    const requestLearning = vi.fn<TutorPracticeDependencies['requestLearning']>(
      async (request, signal) => {
        providerSignal = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return tutorResponse(request, signal);
      },
    );
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    const session = await createSession();
    const admitted = await send(session.id);
    await vi.waitFor(() => expect(requestLearning).toHaveBeenCalledOnce());
    let settled = false;
    const cancelling = call('cancelStudyTurn', {
      sessionId: session.id,
      turnId: admitted.turnId,
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(providerSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    release();
    await cancelling;
    expect(
      db
        .select()
        .from(StudyTurnTable)
        .where(eq(StudyTurnTable.id, admitted.turnId))
        .get()?.status,
    ).toBe('cancelled');
    expect(
      (await snapshot(session.id))?.messages.some(
        ({ role }) => role === 'tutor',
      ),
    ).toBe(false);
    expect(db.select().from(AssistanceLedgerTable).all()).toHaveLength(0);
  });

  it('does not publish after the account epoch becomes stale', async () => {
    let current = true;
    let release!: () => void;
    const requestLearning = vi.fn<TutorPracticeDependencies['requestLearning']>(
      async (request, signal) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return tutorResponse(request, signal);
      },
    );
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    const session = await createSession();
    await send(session.id, { ...context, isCurrent: () => current });
    await vi.waitFor(() => expect(requestLearning).toHaveBeenCalledOnce());
    current = false;
    release();
    await cleanup();
    expect(
      db
        .select()
        .from(StudyMessageTable)
        .all()
        .filter(({ role }) => role === 'tutor'),
    ).toHaveLength(0);
    expect(db.select().from(AssistanceLedgerTable).all()).toHaveLength(0);
    await expect(
      send(session.id, { ...context, userId: 'other-fixture-account' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rolls back the ledger and tutor publication together if durable message storage fails', async () => {
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning: tutorResponse,
      createActivity,
    });
    const session = await createSession();
    db.$client.exec(
      "CREATE TRIGGER fail_fixture_tutor_insert BEFORE INSERT ON study_messages WHEN NEW.role = 'tutor' BEGIN SELECT RAISE(ABORT, 'fixture-storage-failure'); END",
    );
    try {
      const admitted = await send(session.id);
      await vi.waitFor(() =>
        expect(
          db
            .select()
            .from(StudyTurnTable)
            .where(eq(StudyTurnTable.id, admitted.turnId))
            .get()?.status,
        ).toBe('failed'),
      );
      expect(db.select().from(AssistanceLedgerTable).all()).toHaveLength(0);
      expect(
        db
          .select()
          .from(CourseworkProtectionTable)
          .all()
          .every(({ policyRevision }) => policyRevision === 0),
      ).toBe(true);
      expect(
        db
          .select()
          .from(StudyMessageTable)
          .all()
          .some(({ role }) => role === 'tutor'),
      ).toBe(false);
    } finally {
      db.$client.exec('DROP TRIGGER fail_fixture_tutor_insert');
    }
  });

  it('rejects a changed policy before publication', async () => {
    const requestLearning: TutorPracticeDependencies['requestLearning'] =
      async (request, signal) => {
        db.update(CourseworkProtectionTable).set({ policyRevision: 9 }).run();
        return tutorResponse(request, signal);
      };
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    const session = await createSession();
    const admitted = await send(session.id);
    await vi.waitFor(() =>
      expect(
        db
          .select()
          .from(StudyTurnTable)
          .where(eq(StudyTurnTable.id, admitted.turnId))
          .get()?.status,
      ).toBe('failed'),
    );
    expect(
      db
        .select()
        .from(StudyMessageTable)
        .all()
        .some(({ role }) => role === 'tutor'),
    ).toBe(false);
  });

  it('registers all actions and commits a tutor turn with real session and integrity stores', async () => {
    const requestLearning = vi.fn(tutorResponse);
    cleanup = registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
    expect([...handlers.keys()]).toEqual([
      'sendStudyTurn',
      'retryStudyTurn',
      'cancelStudyTurn',
      'getPracticeAttempt',
      'savePracticeAnswer',
      'submitPracticeAttempt',
      'switchPracticeToGuided',
      'retryPracticeAttempt',
    ]);
    const session = await createSession();
    const admitted = await send(session.id);
    await vi.waitFor(async () => {
      expect(
        db
          .select({
            status: StudyTurnTable.status,
            errorCode: StudyTurnTable.errorCode,
          })
          .from(StudyTurnTable)
          .where(eq(StudyTurnTable.id, admitted.turnId))
          .get(),
      ).toEqual({ status: 'complete', errorCode: null });
    });
    expect(requestLearning).toHaveBeenCalledOnce();
    const request = requestLearning.mock.calls[0]![0];
    expect(request.kind).toBe('tutor-turn');
    expect(request.input).toMatchObject({
      studentText: 'Explain cell membranes conceptually.',
      priorAssistanceSummary: expect.any(String),
    });
    const completed = await snapshot(session.id);
    expect(
      completed?.messages.filter(({ role }) => role === 'tutor'),
    ).toHaveLength(1);
    expect(db.select().from(AssistanceLedgerTable).all()).toHaveLength(1);
  });
});

it('carries selected Biology learning notes and remembered preferences into tutoring and a resumed session', async () => {
  const { upsertExplicitPreference, deleteMemory } =
    await import('../../../features/memory/services/memory-store');
  const vocabulary = upsertExplicitPreference(context, {
    requestId: randomUUID(),
    preference: {
      field: 'vocabulary',
      value: 'Explain technical terms in plain English.',
    },
  });
  const examples = upsertExplicitPreference(context, {
    requestId: randomUUID(),
    courseId,
    preference: {
      field: 'example-style',
      value: 'Use visual examples and ask me to predict before explaining.',
    },
  });
  const learningNote = await createContextNote(context, {
    requestId: randomUUID(),
    kind: 'note',
    courseId,
    title: 'My Biology learning context',
    text: 'I learn visually, explain technical terms in plain English, ask me to predict before answering. I mix up diffusion and osmosis.',
  });
  const handout = await createContextNote(context, {
    requestId: randomUUID(),
    kind: 'note',
    courseId,
    title: 'Synthetic Biology handout',
    text: 'Osmosis is the movement of water across a selectively permeable membrane. Diffusion is the net movement of particles from higher to lower concentration.',
  });
  let generatedResponses = 0;
  const requestLearning = vi.fn<TutorPracticeDependencies['requestLearning']>(
    async (request, signal) => {
      generatedResponses += 1;
      return {
        ...(await tutorResponse(request, signal)),
        parts: [
          {
            kind: 'text',
            text:
              generatedResponses > 1
                ? 'Imagine a membrane as a doorway that lets water through; predict what changes when one side has more dissolved particles.'
                : 'A cell membrane separates the cell from its surroundings.',
          },
        ],
      };
    },
  );
  const register = () =>
    registerTutorPracticeActions(registrar, {
      sessionStore,
      requestLearning,
      createActivity,
    });
  try {
    cleanup = register();
    const session = await sessionStore.createStudySession(context, {
      requestId: randomUUID(),
      courseId,
      activity: 'understand-topic',
      targetAssignmentId: null,
      topic: 'Membrane transport',
      contextItemIds: [learningNote.id, handout.id],
      durationMinutes: null,
      title: 'Biology context demo',
    });
    const admitted = await call('sendStudyTurn', {
      sessionId: session.id,
      requestId: randomUUID(),
      expectedDraftRevision: 0,
      text: 'Help me understand how water moves.',
      attachmentIds: [],
    });
    await vi.waitFor(() =>
      expect(
        db
          .select()
          .from(StudyTurnTable)
          .where(eq(StudyTurnTable.id, admitted.turnId))
          .get()?.status,
      ).toBe('complete'),
    );
    const firstRequest = requestLearning.mock.calls[0]![0];
    if (firstRequest.kind !== 'tutor-turn')
      throw new Error('Expected tutor turn');
    expect(
      firstRequest.input.personalContext.preferences.map(
        ({ content }) => content,
      ),
    ).toEqual(expect.arrayContaining([vocabulary.content, examples.content]));
    expect(
      firstRequest.input.sources.map(({ reference }) => reference.sourceId),
    ).toEqual(expect.arrayContaining([learningNote.id, handout.id]));
    expect(
      firstRequest.input.sources.some(({ text }) =>
        text.includes('I mix up diffusion and osmosis'),
      ),
    ).toBe(true);
    const savedMessageIds = (await snapshot(session.id))!.messages.map(
      ({ id }) => id,
    );
    await cleanup();
    sessionStore = createTutorPracticeSessionStore();
    cleanup = register();
    expect((await snapshot(session.id))!.messages.map(({ id }) => id)).toEqual(
      savedMessageIds,
    );
    const draftRevision = (await snapshot(session.id))!.session.draft.revision;
    const followUp = await call('sendStudyTurn', {
      sessionId: session.id,
      requestId: randomUUID(),
      expectedDraftRevision: draftRevision,
      text: 'Could you explain it another way?',
      attachmentIds: [],
    });
    await vi.waitFor(() =>
      expect(
        db
          .select()
          .from(StudyTurnTable)
          .where(eq(StudyTurnTable.id, followUp.turnId))
          .get(),
      ).toMatchObject({ status: 'complete', errorCode: null }),
    );
    const resumedRequest = requestLearning.mock.calls[1]![0];
    if (resumedRequest.kind !== 'tutor-turn')
      throw new Error('Expected tutor turn');
    expect(
      resumedRequest.input.sources.some(
        ({ reference }) => reference.sourceId === learningNote.id,
      ),
    ).toBe(true);
    expect(
      resumedRequest.input.personalContext.preferences.map(({ id }) => id),
    ).toEqual(expect.arrayContaining([vocabulary.id, examples.id]));
    expect(resumedRequest.input.history.length).toBeGreaterThanOrEqual(2);
    expect((await snapshot(session.id))!.messages).toHaveLength(4);
  } finally {
    deleteMemory(context, {
      memoryId: vocabulary.id,
      expectedRevision: vocabulary.revision,
    });
    deleteMemory(context, {
      memoryId: examples.id,
      expectedRevision: examples.revision,
    });
  }
});
