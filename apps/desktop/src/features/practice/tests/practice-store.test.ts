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
import type { MessagePart } from '@scholaros/services/learning/study-contracts';
import { createSessionStore } from '../../study/services/session-store';
import type {
  PracticeActionDependencies,
  PracticeAttemptCreationInput,
} from '../services/practice-actions';
import {
  createPracticeActions,
  createPracticeAttempt as createAuthorizedPracticeAttempt,
} from '../services/practice-actions';
import { createPracticeStore } from '../services/practice-store';

vi.mock('../../../db', () => ({ db: {} }));

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

const insertSession = (
  sessionId = 'session-a',
  userId = 'user-a',
  courseId = 'course-a',
) => {
  sqlite
    .prepare(
      `INSERT INTO study_sessions (
        id, user_id, course_id, title, activity, status,
        created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      userId,
      courseId,
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

const insertMessage = (
  id: string,
  sequence: number,
  parts: MessagePart[],
  overrides: Partial<typeof schema.StudyMessageTable.$inferInsert> = {},
) =>
  db
    .insert(schema.StudyMessageTable)
    .values({
      id,
      userId: 'user-a',
      sessionId: 'session-a',
      sequence,
      role: 'tutor',
      status: 'accepted',
      parts,
      createdAt: timestamp,
      ...overrides,
    })
    .run();

const authorizedContext = () => ({
  userId: 'user-a',
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
});

const createSubmittedSessionPractice = () => {
  insertSession();
  const attempt = createAttempt({ sessionId: 'session-a' });
  const submitted = store.submitPracticeAttempt('user-a', {
    attemptId: attempt.id,
    expectedRevision: attempt.revision,
    requestId: ids.submit,
  });
  insertMessage('practice-message', 0, [
    { kind: 'practice', practiceAttemptId: attempt.id },
  ]);
  return submitted;
};

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
    sqlite.prepare('DELETE FROM study_messages').run();
    sqlite.prepare('DELETE FROM study_sessions').run();
    sqlite.prepare('DELETE FROM courses').run();
    insertCourse();
  });

  afterAll(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['multiple-choice', 'numeric', 'short-explanation'] as const)(
    'persists opaque proof privately across SQLite reopen, evaluation and retry for %s',
    (kind) => {
      const proof = `v1.synthetic-opaque-${kind}.signature`;
      const item: PracticeQuestionDTO = {
        ...question,
        kind,
        options: kind === 'multiple-choice' ? question.options : null,
        unit: kind === 'numeric' ? 'm' : null,
      };
      const base = {
        questionId: item.id,
        kind,
        generationProof: proof,
        acceptedAlternatives: [],
        explanation: 'Bounded app-generated practice explanation.',
      };
      const key: JsonValue =
        kind === 'multiple-choice'
          ? { ...base, correctOptionId: 'option-1' }
          : kind === 'numeric'
            ? {
                ...base,
                acceptedValues: [{ value: 3, tolerance: 0.01, unit: 'm' }],
              }
            : {
                ...base,
                rubricCriteria: ['Explain the concept in your own words.'],
              };
      insertSession();
      const attempt = createAttempt({
        sessionId: 'session-a',
        questions: [item],
        hostAnswerKey: [key],
      });
      expect(
        store.getEvaluationWork('user-a', attempt.id)?.answerKeys[0],
      ).toMatchObject({ generationProof: proof });
      expect(
        JSON.stringify(
          store.getPracticeAttempt('user-a', { attemptId: attempt.id }),
        ),
      ).not.toContain(proof);
      sqlite.close();
      sqlite = new Database(join(directory, 'fixture.sqlite'));
      sqlite.pragma('foreign_keys = ON');
      db = drizzle({ client: sqlite, schema });
      store = createPracticeStore({ db, now: () => timestamp });
      const resumed = store.getPracticeAttempt('user-a', {
        attemptId: attempt.id,
      });
      expect(resumed).toEqual(attempt);
      expect(JSON.stringify(resumed)).not.toContain('generationProof');
      expect(resumed).not.toHaveProperty('hostAnswerKey');
      expect(store.getEvaluationWork('user-a', attempt.id)?.answerKeys).toEqual(
        [key],
      );
      expect(store.getEvaluationWork('user-b', attempt.id)).toBeNull();
      const saved = store.savePracticeAnswer('user-a', {
        attemptId: attempt.id,
        questionId: item.id,
        expectedRevision: attempt.revision,
        value:
          kind === 'multiple-choice'
            ? 'option-1'
            : kind === 'numeric'
              ? 3
              : 'My conceptual explanation.',
        requestId: ids.answer,
      });
      store.submitPracticeAttempt('user-a', {
        attemptId: attempt.id,
        expectedRevision: saved.revision,
        requestId: ids.submit,
      });
      const evaluation = {
        questionId: item.id,
        outcome: 'correct',
        explanation: 'A bounded explanation for this distinct practice.',
        acceptedAlternatives: [],
        sourceReferences: [],
        rubricVersion: 'rubric-v1',
        assisted: false,
      };
      const evaluated = store.savePracticeEvaluations('user-a', {
        attemptId: attempt.id,
        final: true,
        evaluations: [{ questionId: item.id, answerRevision: 0, evaluation }],
      });
      expect(evaluated.feedback).toEqual([evaluation]);
      expect(JSON.stringify(evaluated)).not.toContain(proof);
      expect(JSON.stringify(evaluated)).not.toContain('generationProof');
      const retry = store.retryPracticeAttempt('user-a', {
        attemptId: attempt.id,
        requestId: ids.retry,
      });
      expect(retry.priorAttemptId).toBe(attempt.id);
      expect(store.getEvaluationWork('user-a', retry.id)?.answerKeys).toEqual([
        key,
      ]);
      expect(JSON.stringify(retry)).not.toContain('generationProof');
      expect(JSON.stringify(retry)).not.toContain(proof);
    },
  );

  it('keeps historical keys without proof readable without fabricating a proof', () => {
    const attempt = createAttempt();
    const work = store.getEvaluationWork('user-a', attempt.id);
    expect(work?.answerKeys[0]).not.toHaveProperty('generationProof');
    expect(work?.answerKeys).toEqual(hostAnswerKey);
  });

  it.each([null, 42, {}, '', 'x'.repeat(4097)])(
    'rejects malformed or oversized private proof %#',
    (generationProof) => {
      const key = {
        ...(hostAnswerKey as Array<Record<string, JsonValue>>)[0],
        generationProof,
      };
      expect(() => createAttempt({ hostAnswerKey: [key] })).toThrow();
      expect(db.select().from(schema.PracticeAttemptTable).all()).toHaveLength(
        0,
      );
    },
  );

  it('retains the exact maximum opaque proof and rejects malformed stored proof on read', () => {
    const proof = 'p'.repeat(4096);
    const key = {
      ...(hostAnswerKey as Array<Record<string, JsonValue>>)[0],
      generationProof: proof,
    };
    const attempt = createAttempt({ hostAnswerKey: [key] });
    expect(
      store.getEvaluationWork('user-a', attempt.id)?.answerKeys[0],
    ).toMatchObject({ generationProof: proof });
    db.update(schema.PracticeAttemptTable)
      .set({ hostAnswerKey: [{ ...key, generationProof: null }] })
      .run();
    expect(store.getEvaluationWork('user-a', attempt.id)).toBeNull();
    expect(
      store.getPracticeAttempt('user-a', { attemptId: attempt.id }),
    ).toBeNull();
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

  it('reopens persisted practice parts on the retry while retaining earlier answers and messages', async () => {
    insertSession();
    const attempt = createAttempt({ sessionId: 'session-a' });
    const saved = store.savePracticeAnswer('user-a', {
      attemptId: attempt.id,
      questionId: question.id,
      expectedRevision: attempt.revision,
      value: 'option-1',
      requestId: ids.answer,
    });
    const revised = store.savePracticeAnswer('user-a', {
      attemptId: attempt.id,
      questionId: question.id,
      expectedRevision: saved.revision,
      value: 'option-2',
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    store.submitPracticeAttempt('user-a', {
      attemptId: attempt.id,
      expectedRevision: revised.revision,
      requestId: ids.submit,
    });
    const evaluated = store.savePracticeEvaluations('user-a', {
      attemptId: attempt.id,
      final: true,
      evaluations: [
        {
          questionId: question.id,
          answerRevision: 1,
          evaluation: {
            questionId: question.id,
            outcome: 'incorrect',
            explanation:
              'Chromosomes move toward opposite poles rather than disappearing.',
            acceptedAlternatives: [],
            sourceReferences: [],
            rubricVersion: 'rubric-v1',
            assisted: false,
          },
        },
      ],
    });
    const text = {
      kind: 'text',
      text: 'Try the chromosome exercise.',
    } as const;
    const unrelated = {
      kind: 'practice',
      practiceAttemptId: 'another-attempt',
    } as const;
    insertMessage('practice-message', 0, [
      text,
      { kind: 'practice', practiceAttemptId: attempt.id },
      unrelated,
      { kind: 'practice', practiceAttemptId: attempt.id },
    ]);
    insertMessage('second-practice-message', 1, [
      { kind: 'practice', practiceAttemptId: attempt.id },
    ]);
    insertMessage(
      'student-message',
      2,
      [{ kind: 'text', text: 'I want another try.' }],
      { role: 'student' },
    );
    const retryTimestamp = '2026-11-03T12:05:00.000Z';
    const retry = createPracticeStore({
      db,
      now: () => retryTimestamp,
    }).retryPracticeAttempt('user-a', {
      attemptId: attempt.id,
      requestId: ids.retry,
    });

    sqlite.close();
    sqlite = new Database(join(directory, 'fixture.sqlite'));
    sqlite.pragma('foreign_keys = ON');
    db = drizzle({ client: sqlite, schema });
    store = createPracticeStore({ db, now: () => timestamp });
    const reopened = await createSessionStore({
      database: db,
      now: () => Date.parse(retryTimestamp),
    }).getStudySession(authorizedContext(), { sessionId: 'session-a' });

    expect(reopened?.messages.map(({ id, parts }) => ({ id, parts }))).toEqual([
      {
        id: 'practice-message',
        parts: [
          text,
          { kind: 'practice', practiceAttemptId: retry.id },
          unrelated,
          { kind: 'practice', practiceAttemptId: retry.id },
        ],
      },
      {
        id: 'second-practice-message',
        parts: [{ kind: 'practice', practiceAttemptId: retry.id }],
      },
      {
        id: 'student-message',
        parts: [{ kind: 'text', text: 'I want another try.' }],
      },
    ]);
    expect(reopened?.session).toMatchObject({
      revision: 1,
      updatedAt: retryTimestamp,
      status: 'saved',
      generationEpoch: 0,
    });
    expect(reopened?.revision).toBe(1);
    expect(store.getPracticeAttempt('user-a', { attemptId: retry.id })).toEqual(
      retry,
    );
    expect(
      store.getPracticeAttempt('user-a', { attemptId: attempt.id }),
    ).toEqual(evaluated);
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM practice_answers WHERE attempt_id = ?',
        )
        .get(attempt.id),
    ).toEqual({ count: 2 });
    expect(retry.priorAttemptId).toBe(attempt.id);
    expect(retry.answers).toEqual([]);
  });

  it('replays a retry after guided and submitted changes without rolling back a newer retry link', async () => {
    insertSession();
    const attempt = createAttempt({ sessionId: 'session-a' });
    store.submitPracticeAttempt('user-a', {
      attemptId: attempt.id,
      expectedRevision: attempt.revision,
      requestId: ids.submit,
    });
    insertMessage('practice-message', 0, [
      { kind: 'practice', practiceAttemptId: attempt.id },
    ]);
    const retryInput = { attemptId: attempt.id, requestId: ids.retry };
    const retry = store.retryPracticeAttempt('user-a', retryInput);
    const sessionStore = createSessionStore({
      database: db,
      now: () => Date.parse(timestamp),
    });
    const afterRetry = await sessionStore.getStudySession(authorizedContext(), {
      sessionId: 'session-a',
    });
    expect(store.retryPracticeAttempt('user-a', retryInput)).toEqual(retry);
    expect(
      await sessionStore.getStudySession(authorizedContext(), {
        sessionId: 'session-a',
      }),
    ).toEqual(afterRetry);

    const guided = store.switchPracticeToGuided('user-a', {
      attemptId: retry.id,
      expectedRevision: retry.revision,
      requestId: ids.answer,
    });
    expect(store.retryPracticeAttempt('user-a', retryInput)).toEqual(guided);
    const submitted = store.submitPracticeAttempt('user-a', {
      attemptId: retry.id,
      expectedRevision: guided.revision,
      requestId: ids.submit,
    });
    const latest = store.retryPracticeAttempt('user-a', {
      attemptId: retry.id,
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    const beforeReplay = await sessionStore.getStudySession(
      authorizedContext(),
      { sessionId: 'session-a' },
    );

    expect(latest.priorAttemptId).toBe(retry.id);
    expect(latest.assisted).toBe(true);
    expect(store.retryPracticeAttempt('user-a', retryInput)).toEqual(submitted);
    const afterReplay = await sessionStore.getStudySession(
      authorizedContext(),
      { sessionId: 'session-a' },
    );
    expect(afterReplay).toEqual(beforeReplay);
    expect(afterReplay?.messages[0]?.parts).toEqual([
      { kind: 'practice', practiceAttemptId: latest.id },
    ]);
    expect(afterReplay?.revision).toBe(2);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM practice_attempts').get(),
    ).toEqual({ count: 3 });
  });

  it('relinks only matching parts in the account and owning session', () => {
    const attempt = createSubmittedSessionPractice();
    insertCourse('user-a', 'course-b');
    insertCourse('user-b', 'course-c');
    insertSession('session-b');
    insertSession('session-c', 'user-a', 'course-b');
    insertSession('session-d', 'user-b', 'course-c');
    const originalParts: MessagePart[] = [
      { kind: 'practice', practiceAttemptId: attempt.id },
    ];
    insertMessage('same-course-other-session', 0, originalParts, {
      sessionId: 'session-b',
    });
    insertMessage('other-course', 0, originalParts, { sessionId: 'session-c' });
    insertMessage('other-account', 0, originalParts, {
      userId: 'user-b',
      sessionId: 'session-d',
    });
    insertMessage('foreign-message-owner', 1, originalParts, {
      userId: 'user-b',
    });
    expect(() =>
      store.retryPracticeAttempt('user-b', {
        attemptId: attempt.id,
        requestId: ids.retry,
      }),
    ).toThrow(expect.objectContaining({ code: 'not-found' }));

    const retry = store.retryPracticeAttempt('user-a', {
      attemptId: attempt.id,
      requestId: ids.retry,
    });
    expect(
      sqlite.prepare('SELECT id, parts FROM study_messages ORDER BY id').all(),
    ).toEqual([
      { id: 'foreign-message-owner', parts: JSON.stringify(originalParts) },
      { id: 'other-account', parts: JSON.stringify(originalParts) },
      { id: 'other-course', parts: JSON.stringify(originalParts) },
      {
        id: 'practice-message',
        parts: JSON.stringify([
          { kind: 'practice', practiceAttemptId: retry.id },
        ]),
      },
      { id: 'same-course-other-session', parts: JSON.stringify(originalParts) },
    ]);
    expect(
      sqlite
        .prepare('SELECT id, revision FROM study_sessions ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'session-a', revision: 1 },
      { id: 'session-b', revision: 0 },
      { id: 'session-c', revision: 0 },
      { id: 'session-d', revision: 0 },
    ]);
  });

  it.each([
    [
      'session owner',
      "UPDATE study_sessions SET user_id = 'user-b'",
      'scope-denied',
    ],
    [
      'session course',
      "UPDATE study_sessions SET course_id = 'course-b'",
      'scope-denied',
    ],
    ['course owner', "UPDATE courses SET user_id = 'user-b'", 'not-found'],
    [
      'deleted session',
      `UPDATE study_sessions SET deleted_at = '${timestamp}', generation_epoch = 1`,
      'scope-denied',
    ],
    ['missing session', 'DELETE FROM study_sessions', 'scope-denied'],
  ])(
    'fences new retries and idempotent replay after a changed %s',
    (_label, mutation, code) => {
      const attempt = createSubmittedSessionPractice();
      const retryInput = { attemptId: attempt.id, requestId: ids.retry };
      store.retryPracticeAttempt('user-a', retryInput);
      sqlite.prepare(mutation).run();
      const sessionsBefore = sqlite
        .prepare('SELECT * FROM study_sessions')
        .all();
      const messagesBefore = sqlite
        .prepare('SELECT * FROM study_messages')
        .all();
      const attemptsBefore = sqlite
        .prepare('SELECT * FROM practice_attempts')
        .all();

      for (const requestId of [
        ids.retry,
        '00000000-0000-4000-8000-000000000005',
      ])
        expect(() =>
          store.retryPracticeAttempt('user-a', { ...retryInput, requestId }),
        ).toThrow(expect.objectContaining({ code }));

      expect(sqlite.prepare('SELECT * FROM study_sessions').all()).toEqual(
        sessionsBefore,
      );
      expect(sqlite.prepare('SELECT * FROM study_messages').all()).toEqual(
        messagesBefore,
      );
      expect(sqlite.prepare('SELECT * FROM practice_attempts').all()).toEqual(
        attemptsBefore,
      );
    },
  );

  it('rejects a replay request id used for a different predecessor without relinking either attempt', () => {
    const attempt = createSubmittedSessionPractice();
    const retryInput = { attemptId: attempt.id, requestId: ids.retry };
    store.retryPracticeAttempt('user-a', retryInput);
    const other = createAttempt({
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    store.submitPracticeAttempt('user-a', {
      attemptId: other.id,
      expectedRevision: other.revision,
      requestId: ids.submit,
    });
    const messagesBefore = sqlite.prepare('SELECT * FROM study_messages').all();
    expect(() =>
      store.retryPracticeAttempt('user-a', {
        ...retryInput,
        attemptId: other.id,
      }),
    ).toThrow(expect.objectContaining({ code: 'revision-conflict' }));
    expect(sqlite.prepare('SELECT * FROM study_messages').all()).toEqual(
      messagesBefore,
    );
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM practice_attempts').get(),
    ).toEqual({ count: 3 });
  });

  it.each([
    ['message relink', 'study_messages', 'parts'],
    ['session revision', 'study_sessions', 'revision'],
  ])(
    'rolls back retry creation and all links if %s fails',
    async (_label, table, column) => {
      const attempt = createSubmittedSessionPractice();
      const before = await createSessionStore({
        database: db,
        now: () => Date.parse(timestamp),
      }).getStudySession(authorizedContext(), { sessionId: 'session-a' });
      sqlite.exec(`CREATE TRIGGER fail_retry BEFORE UPDATE OF ${column} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'test retry failure'); END`);
      try {
        expect(() =>
          store.retryPracticeAttempt('user-a', {
            attemptId: attempt.id,
            requestId: ids.retry,
          }),
        ).toThrow(expect.objectContaining({ code: 'storage-failed' }));
      } finally {
        sqlite.exec('DROP TRIGGER fail_retry');
      }
      const after = await createSessionStore({
        database: db,
        now: () => Date.parse(timestamp),
      }).getStudySession(authorizedContext(), { sessionId: 'session-a' });
      expect(after).toEqual(before);
      expect(
        store.getPracticeAttempt('user-a', { attemptId: ids.retry }),
      ).toBeNull();
      expect(
        store.getPracticeAttempt('user-a', { attemptId: attempt.id }),
      ).toEqual(attempt);
    },
  );

  it('leaves the session revision unchanged when no matching part is persisted', async () => {
    insertSession();
    const attempt = createAttempt({ sessionId: 'session-a' });
    store.submitPracticeAttempt('user-a', {
      attemptId: attempt.id,
      expectedRevision: attempt.revision,
      requestId: ids.submit,
    });
    insertMessage('other-practice', 0, [
      { kind: 'practice', practiceAttemptId: 'another-attempt' },
    ]);
    const sessionStore = createSessionStore({
      database: db,
      now: () => Date.parse(timestamp),
    });
    const before = await sessionStore.getStudySession(authorizedContext(), {
      sessionId: 'session-a',
    });
    const retry = store.retryPracticeAttempt('user-a', {
      attemptId: attempt.id,
      requestId: ids.retry,
    });
    expect(retry.priorAttemptId).toBe(attempt.id);
    expect(
      await sessionStore.getStudySession(authorizedContext(), {
        sessionId: 'session-a',
      }),
    ).toEqual(before);
  });

  it('rejects a late retry when candidate approval races with session deletion', async () => {
    const attempt = createSubmittedSessionPractice();
    const publish = vi.fn();
    const actions = createPracticeActions({
      store,
      assessCandidate: async () => {
        sqlite
          .prepare(
            'UPDATE study_sessions SET deleted_at = ?, generation_epoch = 1',
          )
          .run(timestamp);
        sqlite.prepare('DELETE FROM study_messages').run();
        return { allowed: true };
      },
      canPublishFeedback: async () => true,
      evaluateAnswer: vi.fn(),
      publish,
    });
    await expect(
      actions.retryPracticeAttempt(authorizedContext(), {
        attemptId: attempt.id,
        requestId: ids.retry,
      }),
    ).rejects.toMatchObject({ code: 'scope-denied' });
    expect(
      store.getPracticeAttempt('user-a', { attemptId: ids.retry }),
    ).toBeNull();
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM study_messages').get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          'SELECT deleted_at, generation_epoch, revision FROM study_sessions',
        )
        .get(),
    ).toEqual({ deleted_at: timestamp, generation_epoch: 1, revision: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes one owning-session invalidation after relinking commits and none for replay or unmatched parts', async () => {
    const attempt = createSubmittedSessionPractice();
    const observations: unknown[] = [];
    const publish = vi.fn((event: unknown) => {
      observations.push({
        event,
        inTransaction: sqlite.inTransaction,
        parts: sqlite
          .prepare('SELECT parts FROM study_messages WHERE id = ?')
          .get('practice-message'),
        retry: store.getPracticeAttempt('user-a', { attemptId: ids.retry }),
      });
    });
    const actions = createPracticeActions({
      store,
      assessCandidate: async () => ({ allowed: true }),
      canPublishFeedback: async () => true,
      evaluateAnswer: vi.fn(),
      publish,
    });
    const input = { attemptId: attempt.id, requestId: ids.retry };
    const retry = await actions.retryPracticeAttempt(
      authorizedContext(),
      input,
    );
    expect(observations).toEqual([
      {
        event: {
          version: 1,
          accountId: 'user-a',
          resource: 'study',
          targetId: 'session-a',
          revision: 1,
          operationId: ids.retry,
        },
        inTransaction: false,
        parts: {
          parts: JSON.stringify([
            { kind: 'practice', practiceAttemptId: retry.id },
          ]),
        },
        retry,
      },
    ]);
    await actions.retryPracticeAttempt(authorizedContext(), input);
    await actions.retryPracticeAttempt(authorizedContext(), {
      ...input,
      requestId: '00000000-0000-4000-8000-000000000005',
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it('preserves the committed retry and relink when the invalidation subscriber fails', async () => {
    const attempt = createSubmittedSessionPractice();
    const publish = vi.fn(() => {
      throw new Error('subscriber unavailable');
    });
    const actions = createPracticeActions({
      store,
      assessCandidate: async () => ({ allowed: true }),
      canPublishFeedback: async () => true,
      evaluateAnswer: vi.fn(),
      publish,
    });
    const input = { attemptId: attempt.id, requestId: ids.retry };
    const retry = await actions.retryPracticeAttempt(
      authorizedContext(),
      input,
    );
    expect(retry.id).toBe(ids.retry);
    const reopened = await createSessionStore({
      database: db,
      now: () => Date.parse(timestamp),
    }).getStudySession(authorizedContext(), { sessionId: 'session-a' });
    expect(reopened?.messages[0]?.parts).toEqual([
      { kind: 'practice', practiceAttemptId: retry.id },
    ]);
    expect(reopened?.revision).toBe(1);
    expect(
      await actions.retryPracticeAttempt(authorizedContext(), input),
    ).toEqual(retry);
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each(['scope-denied', 'session-changed', 'cancelled'] as const)(
    'rejects retry with no durable mutation when approval settles as %s',
    async (code) => {
      const attempt = createSubmittedSessionPractice();
      let current = true;
      const controller = new AbortController();
      const context = {
        ...authorizedContext(),
        signal: controller.signal,
        isCurrent: () => current,
      };
      const publish = vi.fn();
      const actions = createPracticeActions({
        store,
        assessCandidate: async () => {
          if (code === 'session-changed') current = false;
          if (code === 'cancelled') controller.abort();
          return { allowed: code !== 'scope-denied' };
        },
        canPublishFeedback: async () => true,
        evaluateAnswer: vi.fn(),
        publish,
      });
      await expect(
        actions.retryPracticeAttempt(context, {
          attemptId: attempt.id,
          requestId: ids.retry,
        }),
      ).rejects.toMatchObject({ code });
      expect(
        store.getPracticeAttempt('user-a', { attemptId: ids.retry }),
      ).toBeNull();
      expect(
        sqlite.prepare('SELECT revision FROM study_sessions').get(),
      ).toEqual({ revision: 0 });
      expect(sqlite.prepare('SELECT parts FROM study_messages').get()).toEqual({
        parts: JSON.stringify([
          { kind: 'practice', practiceAttemptId: attempt.id },
        ]),
      });
      expect(publish).not.toHaveBeenCalled();
    },
  );

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
