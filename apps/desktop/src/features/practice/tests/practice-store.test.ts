import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../../db/schema';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { JsonValue } from '@scholaros/services/learning/product-contracts';
import type { PracticeQuestionDTO } from '@scholaros/services/learning/practice-contracts';
import type {
  PracticeActionDependencies,
  PracticeAttemptCreationInput,
} from '../services/practice-actions';
import {
  createPracticeActions,
  createPracticeAttempt as createAuthorizedPracticeAttempt,
} from '../services/practice-actions';
import { createPracticeStore } from '../services/practice-store';

const timestamp = '2026-11-03T12:00:00.000Z';
const question: PracticeQuestionDTO = {
  id: 'question-1',
  kind: 'multiple-choice',
  prompt: 'Which option describes chromosome separation?',
  options: [
    { id: 'option-1', text: 'Chromosomes move toward opposite poles.' },
    { id: 'option-2', text: 'Chromosomes disappear.' },
  ],
  unit: null,
  objectiveIds: ['objective-1'],
  sourceReferences: [],
};
const hostAnswerKey: JsonValue = [
  {
    questionId: question.id,
    kind: 'multiple-choice',
    correctOptionId: 'option-1',
    acceptedAlternatives: [],
    explanation: 'Spindle fibers move chromosomes toward opposite poles.',
  },
];
const ids = {
  attempt: '00000000-0000-4000-8000-000000000001',
  answer: '00000000-0000-4000-8000-000000000002',
  submit: '00000000-0000-4000-8000-000000000003',
  retry: '00000000-0000-4000-8000-000000000004',
};

let directory: string;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
let store: ReturnType<typeof createPracticeStore>;

const insertCourse = (userId = 'user-a', courseId = 'course-a') => {
  sqlite
    .prepare(
      `INSERT INTO courses (
        id, user_id, source_key, source_name, source_host, name, url,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      courseId,
      userId,
      `manual:${courseId}`,
      'Manual',
      '',
      'Biology',
      '',
      timestamp,
      timestamp,
    );
};

const insertSession = () => {
  sqlite
    .prepare(
      `INSERT INTO study_sessions (
        id, user_id, course_id, title, activity, status,
        created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'session-a',
      'user-a',
      'course-a',
      'Biology practice',
      'practice-knowledge',
      'saved',
      timestamp,
      timestamp,
      timestamp,
    );
};

const createAttempt = (overrides: Record<string, unknown> = {}) =>
  store.createPracticeAttempt('user-a', {
    requestId: ids.attempt,
    courseId: 'course-a',
    sessionId: null,
    artifactId: null,
    versionId: 'rubric-v1',
    objectiveIds: ['objective-1'],
    mode: 'exam',
    feedbackMode: 'end',
    rubricVersion: 'rubric-v1',
    questions: [question],
    hostAnswerKey,
    ...overrides,
  });

const authorizedContext = () => ({
  userId: 'user-a',
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const createInternalAttemptInput = (
  overrides: Record<string, unknown> = {},
): PracticeAttemptCreationInput => ({
  requestId: ids.attempt,
  courseId: 'course-a',
  sessionId: null,
  artifactId: null,
  versionId: 'rubric-v1',
  objectiveIds: ['objective-1'],
  mode: 'exam',
  feedbackMode: 'end',
  rubricVersion: 'rubric-v1',
  questions: [question],
  hostAnswerKey,
  ...overrides,
});

describe('practice store', () => {
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'scholaros-practice-store-'));
    sqlite = new Database(join(directory, 'fixture.sqlite'));
    sqlite.pragma('foreign_keys = ON');
    db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder: join(process.cwd(), 'src/db/migrations') });
    store = createPracticeStore({ db, now: () => timestamp });
  });

  beforeEach(() => {
    sqlite.prepare('DELETE FROM practice_answers').run();
    sqlite.prepare('DELETE FROM practice_attempts').run();
    sqlite.prepare('DELETE FROM study_sessions').run();
    sqlite.prepare('DELETE FROM courses').run();
    insertCourse();
  });

  afterAll(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps exam answer keys private and rejects forged score fields', () => {
    const attempt = createAttempt();

    expect(attempt.status).toBe('in-progress');
    expect(attempt.questions).toEqual([question]);
    expect(attempt.feedback).toEqual([]);
    expect(attempt).not.toHaveProperty('hostAnswerKey');
    expect(attempt).not.toHaveProperty('score');
    expect(() =>
      createAttempt({ officialGrade: 100, score: 100, mastery: true }),
    ).toThrow();
    expect(() => createAttempt({ mode: 'guided' })).toThrow();
  });

  it('persists immutable answer revisions and replays the same request idempotently', () => {
    const attempt = createAttempt();
    const answerInput = {
      attemptId: attempt.id,
      questionId: question.id,
      expectedRevision: attempt.revision,
      value: 'option-1',
      requestId: ids.answer,
    };
    const saved = store.savePracticeAnswer('user-a', answerInput);
    const replay = store.savePracticeAnswer('user-a', answerInput);

    expect(saved.revision).toBe(1);
    expect(saved.answers).toHaveLength(1);
    expect(saved.answers[0]?.revision).toBe(0);
    expect(replay.revision).toBe(saved.revision);
    expect(replay.answers).toEqual(saved.answers);
    const revised = store.savePracticeAnswer('user-a', {
      ...answerInput,
      expectedRevision: saved.revision,
      value: 'option-2',
      requestId: ids.submit,
    });
    expect(revised.answers[0]?.revision).toBe(1);
    expect(revised.answers[0]?.value).toBe('option-2');
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM practice_answers').get(),
    ).toEqual({ count: 2 });
  });

  it('resumes an incomplete saved attempt without exposing its answer key', () => {
    const attempt = createAttempt();
    const saved = store.savePracticeAnswer('user-a', {
      attemptId: attempt.id,
      questionId: question.id,
      expectedRevision: attempt.revision,
      value: 'option-1',
      requestId: ids.answer,
    });
    const restartedStore = createPracticeStore({ db, now: () => timestamp });
    const resumed = restartedStore.getPracticeAttempt('user-a', {
      attemptId: attempt.id,
    });

    expect(resumed?.status).toBe('in-progress');
    expect(resumed?.answers).toEqual(saved.answers);
    expect(resumed?.feedback).toEqual([]);
    expect(resumed).not.toHaveProperty('hostAnswerKey');
  });

  it('freezes the saved answer set on submission and reveals feedback only after evaluation', () => {
    const attempt = createAttempt();
    const saved = store.savePracticeAnswer('user-a', {
      attemptId: attempt.id,
      questionId: question.id,
      expectedRevision: attempt.revision,
      value: 'option-1',
      requestId: ids.answer,
    });
    const submitted = store.submitPracticeAttempt('user-a', {
      attemptId: attempt.id,
      expectedRevision: saved.revision,
      requestId: ids.submit,
    });

    expect(submitted.status).toBe('submitted');
    expect(submitted.feedback).toEqual([]);
    expect(() =>
      store.savePracticeAnswer('user-a', {
        attemptId: attempt.id,
        questionId: question.id,
        expectedRevision: submitted.revision,
        value: 'option-2',
        requestId: ids.retry,
      }),
    ).toThrow();

    const evaluation = {
      questionId: question.id,
      outcome: 'correct',
      explanation: 'The chromosomes move toward opposite poles.',
      acceptedAlternatives: [],
      sourceReferences: [],
      rubricVersion: 'rubric-v1',
      assisted: false,
    } as const;
    const evaluated = store.savePracticeEvaluations('user-a', {
      attemptId: attempt.id,
      final: true,
      evaluations: [{ questionId: question.id, answerRevision: 0, evaluation }],
    });

    expect(evaluated.status).toBe('evaluated');
    expect(evaluated.feedback).toEqual([evaluation]);
    expect(evaluated).not.toHaveProperty('hostAnswerKey');
    const replay = store.savePracticeEvaluations('user-a', {
      attemptId: attempt.id,
      final: true,
      evaluations: [{ questionId: question.id, answerRevision: 0, evaluation }],
    });
    expect(replay.revision).toBe(evaluated.revision);
    expect(replay.feedback).toEqual(evaluated.feedback);
    expect(() =>
      store.savePracticeEvaluations('user-a', {
        attemptId: attempt.id,
        final: true,
        evaluations: [
          {
            questionId: question.id,
            answerRevision: 0,
            evaluation: { ...evaluation, explanation: 'Changed after review.' },
          },
        ],
      }),
    ).toThrow();
  });

  it('starts directly guided attempts as assisted', () => {
    const guided = createAttempt({ mode: 'guided' });

    expect(guided.mode).toBe('guided');
    expect(guided.assisted).toBe(true);
  });

  it('marks a guided switch assisted before later answers can be saved', () => {
    const attempt = createAttempt({ mode: 'quiz', feedbackMode: 'end' });
    const guided = store.switchPracticeToGuided('user-a', {
      attemptId: attempt.id,
      expectedRevision: attempt.revision,
      requestId: ids.submit,
    });
    const answer = store.savePracticeAnswer('user-a', {
      attemptId: guided.id,
      questionId: question.id,
      expectedRevision: guided.revision,
      value: 'option-1',
      requestId: ids.answer,
    });

    expect(guided.mode).toBe('guided');
    expect(guided.assisted).toBe(true);
    expect(answer.assisted).toBe(true);
  });

  it('permits explicit per-answer feedback only for an ordinary quiz', () => {
    const attempt = createAttempt({ mode: 'quiz', feedbackMode: 'per-answer' });
    const saved = store.savePracticeAnswer('user-a', {
      attemptId: attempt.id,
      questionId: question.id,
      expectedRevision: attempt.revision,
      value: 'option-1',
      requestId: ids.answer,
    });
    const evaluation = {
      questionId: question.id,
      outcome: 'correct',
      explanation: 'The chromosomes move toward opposite poles.',
      acceptedAlternatives: [],
      sourceReferences: [],
      rubricVersion: 'rubric-v1',
      assisted: false,
    } as const;
    const reviewed = store.savePracticeEvaluations('user-a', {
      attemptId: attempt.id,
      final: false,
      evaluations: [{ questionId: question.id, answerRevision: 0, evaluation }],
    });

    expect(reviewed.status).toBe('in-progress');
    expect(reviewed.feedback).toEqual([evaluation]);
    expect(() =>
      createAttempt({ mode: 'exam', feedbackMode: 'per-answer' }),
    ).toThrow();
    expect(saved.feedback).toEqual([]);
  });

  it('creates a linked retry without overwriting the earlier attempt', () => {
    const attempt = createAttempt();
    expect(() =>
      store.retryPracticeAttempt('user-a', {
        attemptId: attempt.id,
        requestId: ids.retry,
      }),
    ).toThrow();
    const submitted = store.submitPracticeAttempt('user-a', {
      attemptId: attempt.id,
      expectedRevision: attempt.revision,
      requestId: ids.submit,
    });
    const retry = store.retryPracticeAttempt('user-a', {
      attemptId: attempt.id,
      requestId: ids.retry,
    });

    expect(retry.id).not.toBe(submitted.id);
    expect(retry.priorAttemptId).toBe(submitted.id);
    expect(retry.status).toBe('in-progress');
    expect(
      store.getPracticeAttempt('user-a', { attemptId: submitted.id })?.status,
    ).toBe('submitted');
  });

  it('scopes attempts to their account and detaches retained work by deleting session practice', () => {
    insertSession();
    const attempt = createAttempt({ sessionId: 'session-a' });

    expect(
      store.getPracticeAttempt('user-b', { attemptId: attempt.id }),
    ).toBeNull();
    expect(store.deletePracticeAttemptsForSession('user-a', 'session-a')).toBe(
      1,
    );
    expect(
      store.getPracticeAttempt('user-a', { attemptId: attempt.id }),
    ).toBeNull();
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM practice_answers WHERE attempt_id = ?',
        )
        .get(attempt.id),
    ).toEqual({ count: 0 });
  });

  it('requires P13 candidate approval before an internal attempt is persisted', async () => {
    const assessCandidate = vi.fn(async (..._args: unknown[]) => ({
      allowed: false,
    }));
    const candidateInput = createInternalAttemptInput();

    await expect(
      createAuthorizedPracticeAttempt(authorizedContext(), candidateInput, {
        store,
        assessCandidate,
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });

    expect(assessCandidate).toHaveBeenCalledOnce();
    expect(assessCandidate.mock.calls[0]?.[1]).toMatchObject({
      hostAnswerKey,
      questions: [question],
    });
    expect(
      store.getPracticeAttempt('user-a', { attemptId: ids.attempt }),
    ).toBeNull();
  });

  it('rechecks P13 before evaluating a previously approved attempt', async () => {
    await createAuthorizedPracticeAttempt(
      authorizedContext(),
      createInternalAttemptInput(),
      { store, assessCandidate: async () => ({ allowed: true }) },
    );
    const assessCandidate = vi.fn(async (..._args: unknown[]) => ({
      allowed: false,
    }));
    const evaluateAnswer = vi.fn(async () => ({
      questionId: question.id,
      outcome: 'correct',
      explanation: 'The selected option matches the concept.',
      acceptedAlternatives: [],
      sourceReferences: [],
      rubricVersion: 'rubric-v1',
      assisted: false,
    }));
    const actions = createPracticeActions({
      store,
      assessCandidate,
      canPublishFeedback: async () => true,
      evaluateAnswer,
      publish: vi.fn(),
    });
    const attempt = store.getPracticeAttempt('user-a', {
      attemptId: ids.attempt,
    })!;

    await expect(
      actions.submitPracticeAttempt(authorizedContext(), {
        attemptId: attempt.id,
        expectedRevision: attempt.revision,
        requestId: ids.submit,
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });

    expect(assessCandidate).toHaveBeenCalledOnce();
    expect(evaluateAnswer).not.toHaveBeenCalled();
    expect(
      store.getPracticeAttempt('user-a', { attemptId: attempt.id })?.status,
    ).toBe('submitted');
  });

  it('withholds stored feedback when P13 no longer permits the candidate', async () => {
    await createAuthorizedPracticeAttempt(
      authorizedContext(),
      createInternalAttemptInput(),
      { store, assessCandidate: async () => ({ allowed: true }) },
    );
    const assessCandidate = vi
      .fn<PracticeActionDependencies['assessCandidate']>()
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });
    const actions = createPracticeActions({
      store,
      assessCandidate,
      canPublishFeedback: async () => true,
      evaluateAnswer: async () => ({
        questionId: question.id,
        outcome: 'incorrect',
        explanation: 'Review the chromosome movement example.',
        acceptedAlternatives: [],
        sourceReferences: [],
        rubricVersion: 'rubric-v1',
        assisted: false,
      }),
      publish: vi.fn(),
    });
    const attempt = store.getPracticeAttempt('user-a', {
      attemptId: ids.attempt,
    })!;
    const evaluated = await actions.submitPracticeAttempt(authorizedContext(), {
      attemptId: attempt.id,
      expectedRevision: attempt.revision,
      requestId: ids.submit,
    });
    const suppressed = await actions.getPracticeAttempt(authorizedContext(), {
      attemptId: attempt.id,
    });

    expect(evaluated.feedback).toHaveLength(1);
    expect(suppressed.feedback).toEqual([]);
    expect(assessCandidate).toHaveBeenCalledTimes(2);
  });

  it('rejects forged activity scores before candidate assessment', async () => {
    const assessCandidate = vi.fn(async () => ({ allowed: true }));

    await expect(
      createAuthorizedPracticeAttempt(
        authorizedContext(),
        createInternalAttemptInput({
          officialGrade: 100,
          score: 100,
          mastery: true,
        }),
        {
          store,
          assessCandidate,
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });

    expect(assessCandidate).not.toHaveBeenCalled();
    await expect(
      createAuthorizedPracticeAttempt(
        authorizedContext(),
        createInternalAttemptInput({ priorAttemptId: ids.attempt }),
        { store, assessCandidate },
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(assessCandidate).not.toHaveBeenCalled();
    await expect(
      createAuthorizedPracticeAttempt(
        authorizedContext(),
        createInternalAttemptInput({
          mode: 'guided',
          feedbackMode: 'per-answer',
        }),
        { store, assessCandidate },
      ),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(assessCandidate).not.toHaveBeenCalled();
  });

  it('returns per-answer quiz feedback without publishing an OS-level settled event', async () => {
    const attempt = await createAuthorizedPracticeAttempt(
      authorizedContext(),
      createInternalAttemptInput({ mode: 'quiz', feedbackMode: 'per-answer' }),
      {
        store,
        assessCandidate: async () => ({ allowed: true }),
      },
    );
    const publish = vi.fn();
    const actions = createPracticeActions({
      store,
      assessCandidate: async () => ({ allowed: true }),
      canPublishFeedback: async () => true,
      evaluateAnswer: async () => ({
        questionId: question.id,
        outcome: 'correct',
        explanation: 'The selected option matches the concept.',
        acceptedAlternatives: [],
        sourceReferences: [],
        rubricVersion: 'rubric-v1',
        assisted: false,
      }),
      publish,
    });

    const reviewed = await actions.savePracticeAnswer(authorizedContext(), {
      attemptId: attempt.id,
      questionId: question.id,
      expectedRevision: attempt.revision,
      value: 'option-1',
      requestId: ids.answer,
    });

    expect(reviewed.feedback).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('submits before server evaluation and publishes only the settled outcome', async () => {
    await createAuthorizedPracticeAttempt(
      authorizedContext(),
      createInternalAttemptInput(),
      {
        store,
        assessCandidate: async () => ({ allowed: true }),
      },
    );
    const receivedKeys: unknown[] = [];
    const statusAtEvaluation: string[] = [];
    const statusAtPublication: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const actions = createPracticeActions({
      store,
      assessCandidate: async () => ({ allowed: true }),
      canPublishFeedback: async () => true,
      evaluateAnswer: async (_context, input) => {
        receivedKeys.push(input.answerKey);
        statusAtEvaluation.push(
          store.getPracticeAttempt('user-a', { attemptId: input.attemptId })
            ?.status ?? '',
        );
        return {
          questionId: question.id,
          outcome: 'incorrect',
          explanation: 'Review the chromosome movement example.',
          acceptedAlternatives: [],
          sourceReferences: [],
          rubricVersion: 'rubric-v1',
          assisted: false,
        };
      },
      publish: (event) => {
        events.push(event);
        statusAtPublication.push(
          typeof event.targetId === 'string'
            ? (store.getPracticeAttempt('user-a', {
                attemptId: event.targetId,
              })?.status ?? '')
            : '',
        );
      },
    });
    const beforeSubmit = await actions.getPracticeAttempt(authorizedContext(), {
      attemptId: ids.attempt,
    });
    const submitted = await actions.submitPracticeAttempt(authorizedContext(), {
      attemptId: ids.attempt,
      expectedRevision: beforeSubmit!.revision,
      requestId: ids.submit,
    });

    expect(beforeSubmit).not.toHaveProperty('hostAnswerKey');
    expect(beforeSubmit).not.toHaveProperty('hint');
    expect(beforeSubmit).not.toHaveProperty('solution');
    expect(JSON.stringify(beforeSubmit)).not.toContain(
      'Spindle fibers move chromosomes toward opposite poles.',
    );
    expect(beforeSubmit?.feedback).toEqual([]);
    expect(statusAtEvaluation).toEqual(['submitted']);
    expect(receivedKeys).toEqual([hostAnswerKey[0]]);
    expect(submitted.status).toBe('evaluated');
    expect(submitted.feedback).toHaveLength(1);
    expect(statusAtPublication).toEqual(['evaluated']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resource: 'study',
      targetId: ids.attempt,
      outcome: 'completed',
    });
    expect(events[0]).not.toHaveProperty('answer');
  });

  it('preserves submitted answers when evaluation fails and emits no false outcome', async () => {
    await createAuthorizedPracticeAttempt(
      authorizedContext(),
      createInternalAttemptInput(),
      { store, assessCandidate: async () => ({ allowed: true }) },
    );
    const publish = vi.fn();
    const actions = createPracticeActions({
      store,
      assessCandidate: async () => ({ allowed: true }),
      canPublishFeedback: async () => true,
      evaluateAnswer: async () => {
        throw new Error('unavailable');
      },
      publish,
    });
    const attempt = store.getPracticeAttempt('user-a', {
      attemptId: ids.attempt,
    })!;

    await expect(
      actions.submitPracticeAttempt(authorizedContext(), {
        attemptId: attempt.id,
        expectedRevision: attempt.revision,
        requestId: ids.submit,
      }),
    ).rejects.toMatchObject({ code: 'provider-failed' });

    const preserved = store.getPracticeAttempt('user-a', {
      attemptId: attempt.id,
    });
    expect(preserved?.status).toBe('submitted');
    expect(preserved?.answers[0]?.value).toBe('');
    expect(preserved?.feedback).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps submitted answers when feedback permission is revoked during evaluation', async () => {
    await createAuthorizedPracticeAttempt(
      authorizedContext(),
      createInternalAttemptInput(),
      { store, assessCandidate: async () => ({ allowed: true }) },
    );
    const canPublishFeedback = vi
      .fn<PracticeActionDependencies['canPublishFeedback']>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const publish = vi.fn();
    const actions = createPracticeActions({
      store,
      assessCandidate: async () => ({ allowed: true }),
      canPublishFeedback,
      evaluateAnswer: async () => ({
        questionId: question.id,
        outcome: 'incorrect',
        explanation: 'Review the chromosome movement example.',
        acceptedAlternatives: [],
        sourceReferences: [],
        rubricVersion: 'rubric-v1',
        assisted: false,
      }),
      publish,
    });
    const attempt = store.getPracticeAttempt('user-a', {
      attemptId: ids.attempt,
    })!;

    await expect(
      actions.submitPracticeAttempt(authorizedContext(), {
        attemptId: attempt.id,
        expectedRevision: attempt.revision,
        requestId: ids.submit,
      }),
    ).rejects.toMatchObject({ code: 'permission-revoked' });

    const preserved = store.getPracticeAttempt('user-a', {
      attemptId: attempt.id,
    });
    expect(preserved?.status).toBe('submitted');
    expect(preserved?.feedback).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('cancels evaluation when its owning session is aborted', async () => {
    await createAuthorizedPracticeAttempt(
      authorizedContext(),
      createInternalAttemptInput(),
      { store, assessCandidate: async () => ({ allowed: true }) },
    );
    const controller = new AbortController();
    const context = { ...authorizedContext(), signal: controller.signal };
    const publish = vi.fn();
    const actions = createPracticeActions({
      store,
      assessCandidate: async () => ({ allowed: true }),
      canPublishFeedback: async () => true,
      evaluateAnswer: async () => {
        controller.abort();
        return {
          questionId: question.id,
          outcome: 'incorrect',
          explanation: 'Review the chromosome movement example.',
          acceptedAlternatives: [],
          sourceReferences: [],
          rubricVersion: 'rubric-v1',
          assisted: false,
        };
      },
      publish,
    });
    const attempt = store.getPracticeAttempt('user-a', {
      attemptId: ids.attempt,
    })!;

    await expect(
      actions.submitPracticeAttempt(context, {
        attemptId: attempt.id,
        expectedRevision: attempt.revision,
        requestId: ids.submit,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(
      store.getPracticeAttempt('user-a', { attemptId: attempt.id })?.status,
    ).toBe('submitted');
    expect(publish).not.toHaveBeenCalled();
  });
});
