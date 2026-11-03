import { describe, expect, it, vi } from 'vitest';
import type { GradeSettings } from '@scholaros/services/learning/grade-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import {
  runApprovedLearningEffects,
  validateLearningEffects,
  type LearningEffectHandlers,
  type LearningToolValidationContext,
} from '../services/learning-tools';

const reference = {
  sourceKind: 'course-material' as const,
  sourceId: 'material-a',
  versionId: 'version-1',
  courseId: 'course-a',
  locator: { kind: 'page' as const, page: 2 },
  title: 'Cell biology',
  provenance: 'connected-source' as const,
  observedAt: '2026-11-03T12:00:00.000Z',
  state: 'current' as const,
};

const validationContext: LearningToolValidationContext = {
  courseId: 'course-a',
  offeredReferences: [reference],
  studentMessage: 'Explain the mitochondria section.',
  policy: {
    state: 'active',
    policyRevision: 3,
    consentRevision: 0,
    canonicalProtectionId: null,
    allowedOperations: [
      'concept',
      'requirements',
      'bounded-hint',
      'distinct-practice',
    ],
    reasonCode: 'active-coursework',
    priorAssistanceSummary: '',
  },
};

const sourceSelector = {
  sourceKind: reference.sourceKind,
  sourceId: reference.sourceId,
  versionId: reference.versionId,
  locator: reference.locator,
};
const gradeSettings: GradeSettings = {
  enabled: false,
  notes: '',
  revision: 0,
  collectedCount: 0,
  updatedAt: '2026-11-03T12:00:00.000Z',
};
const authorizedContext: AuthorizedContext = {
  userId: 'student-a',
  epoch: 1,
  isCurrent: () => true,
  signal: new AbortController().signal,
};

describe('learning tool admission', () => {
  it('accepts source references only when their exact offered version belongs to the selected course', () => {
    const effects = validateLearningEffects(
      [
        {
          kind: 'retrieve-source',
          references: [sourceSelector],
        },
      ],
      validationContext,
    );

    expect(effects).toEqual([
      {
        kind: 'retrieve-source',
        references: [sourceSelector],
      },
    ]);
  });

  it('rejects unknown tool names and extra arguments', () => {
    expect(() =>
      validateLearningEffects(
        [{ kind: 'shell', command: 'open file' }],
        validationContext,
      ),
    ).toThrow();
    expect(() =>
      validateLearningEffects(
        [
          {
            kind: 'retrieve-source',
            references: [reference],
            courseId: 'course-b',
          },
        ],
        validationContext,
      ),
    ).toThrow();
  });

  it('rejects activity and practice proposals that exceed the captured policy', () => {
    expect(() =>
      validateLearningEffects(
        [
          {
            kind: 'offer-practice',
            objective: 'Reconstruct the assigned answer.',
            references: [sourceSelector],
          },
        ],
        {
          ...validationContext,
          policy: {
            ...validationContext.policy,
            allowedOperations: ['concept'],
          },
        },
      ),
    ).toThrow();
  });

  it('rejects cross-course and unoffered source versions instead of resolving them by title', () => {
    const staleVersion = { ...sourceSelector, versionId: 'version-0' };

    expect(() =>
      validateLearningEffects(
        [{ kind: 'retrieve-source', references: [sourceSelector] }],
        {
          ...validationContext,
          offeredReferences: [{ ...reference, courseId: 'course-b' }],
        },
      ),
    ).toThrow();
    expect(() =>
      validateLearningEffects(
        [{ kind: 'retrieve-source', references: [staleVersion] }],
        validationContext,
      ),
    ).toThrow();
  });

  it('saves preferences only when the current student explicitly expressed them', () => {
    const explicit = validateLearningEffects(
      [
        {
          kind: 'remember-preference',
          preference: { field: 'explanation-length', value: 'concise' },
          evidence: 'I prefer concise explanations.',
        },
      ],
      {
        ...validationContext,
        studentMessage: 'Please remember that I prefer concise explanations.',
      },
    );
    expect(explicit).toHaveLength(1);

    expect(() =>
      validateLearningEffects(
        [
          {
            kind: 'remember-preference',
            preference: { field: 'explanation-length', value: 'concise' },
            evidence: 'concise explanations',
          },
        ],
        validationContext,
      ),
    ).toThrow();
  });

  it('rechecks policy immediately before executing a proposed effect', async () => {
    const createActivity = vi.fn(async () => ({
      artifactId: 'artifact-a',
      versionId: 'artifact-version-a',
      attemptId: 'attempt-a',
    }));
    const handlers: LearningEffectHandlers = {
      isTurnCurrent: vi.fn(async () => true),
      readContextRevision: vi.fn(async () => 11),
      resolveAssistancePolicy: vi.fn(async () => ({
        ...validationContext.policy,
        policyRevision: validationContext.policy.policyRevision + 1,
      })),
      getGradeSettings: vi.fn(async () => gradeSettings),
      rememberPreference: vi.fn(async () => {
        throw new Error('not used');
      }),
      createActivity,
      offerPractice: vi.fn(async () => ({ practiceAttemptId: 'practice-a' })),
    };

    const result = await runApprovedLearningEffects(
      {
        authorizedContext,
        sessionId: 'session-a',
        turnId: 'turn-a',
        generationEpoch: 1,
        contextRevision: 11,
        courseId: 'course-a',
        targetAssignmentId: null,
        studentMessage: 'Show a model of cell energy.',
        offeredReferences: [reference],
        policy: validationContext.policy,
        gradeAccessEnabled: false,
        gradeConsentRevision: 0,
      },
      [
        {
          kind: 'create-activity',
          objective: 'Illustrate cell energy.',
          references: [sourceSelector],
        },
      ],
      handlers,
    );

    expect(result.errorCode).toBe('permission-revoked');
    expect(createActivity).not.toHaveBeenCalled();
  });

  it('resolves selected source IDs to host-owned offered references before effects', async () => {
    const createActivity = vi.fn(async () => ({
      artifactId: 'artifact-a',
      versionId: 'artifact-version-a',
      attemptId: 'attempt-a',
    }));
    const handlers: LearningEffectHandlers = {
      isTurnCurrent: vi.fn(async () => true),
      readContextRevision: vi.fn(async () => 11),
      resolveAssistancePolicy: vi.fn(async () => validationContext.policy),
      getGradeSettings: vi.fn(async () => gradeSettings),
      rememberPreference: vi.fn(async () => {
        throw new Error('not used');
      }),
      createActivity,
      offerPractice: vi.fn(async () => ({ practiceAttemptId: 'practice-a' })),
    };
    const execution = {
      authorizedContext,
      sessionId: 'session-a',
      turnId: 'turn-a',
      generationEpoch: 1,
      contextRevision: 11,
      courseId: 'course-a',
      targetAssignmentId: null,
      studentMessage: 'Show a model of cell energy.',
      offeredReferences: [reference],
      policy: validationContext.policy,
      gradeAccessEnabled: false,
      gradeConsentRevision: 0,
    };
    const effects = [
      {
        kind: 'create-activity',
        objective: 'Illustrate cell energy.',
        references: [sourceSelector],
      },
    ];

    const first = await runApprovedLearningEffects(
      execution,
      effects,
      handlers,
    );
    const second = await runApprovedLearningEffects(
      execution,
      effects,
      handlers,
    );

    expect(createActivity).toHaveBeenCalledWith(
      authorizedContext,
      expect.objectContaining({ references: [reference] }),
    );
    expect(first.effects[0]?.idempotencyKey).toBe(
      second.effects[0]?.idempotencyKey,
    );
    expect(first.effects[0]?.parts).toEqual([
      {
        kind: 'activity',
        artifactId: 'artifact-a',
        versionId: 'artifact-version-a',
        attemptId: 'attempt-a',
      },
    ]);
  });
});
