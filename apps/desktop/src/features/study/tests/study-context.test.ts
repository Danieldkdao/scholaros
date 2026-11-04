import { describe, expect, it, vi } from 'vitest';
import type {
  AssistancePolicy,
  GradeSettings,
} from '@scholaros/services/learning/grade-contracts';
import type {
  SourceReference,
  SourcePassage,
} from '@scholaros/services/learning/context-contracts';
import type { AuthorizedContext } from '@scholaros/services/learning/product-contracts';
import type { SessionSnapshot } from '@scholaros/services/learning/study-contracts';
import {
  prepareStudyContext,
  type StudyContextDependencies,
} from '../services/study-context';

const now = '2026-11-03T12:00:00.000Z';
const courseReference = {
  sourceKind: 'course-material' as const,
  sourceId: 'material-a',
  versionId: 'version-a',
  courseId: 'course-a',
  locator: { kind: 'page' as const, page: 2 },
  title: 'Cell biology',
  provenance: 'connected-source' as const,
  observedAt: now,
  state: 'current' as const,
};
const uploadedReference = {
  sourceKind: 'context-version' as const,
  sourceId: 'context-a',
  versionId: 'context-version-a',
  courseId: null,
  locator: { kind: 'paragraph' as const, ordinal: 1 },
  title: 'My notes',
  provenance: 'user-uploaded' as const,
  observedAt: now,
  state: 'current' as const,
};
const passage = (reference: SourceReference, text: string): SourcePassage => ({
  reference,
  text,
  score: 1,
});
const policy: AssistancePolicy = {
  state: 'active',
  policyRevision: 7,
  consentRevision: 0,
  canonicalProtectionId: 'protection-a',
  allowedOperations: [
    'concept',
    'requirements',
    'bounded-hint',
    'distinct-practice',
  ],
  reasonCode: 'active-coursework',
  priorAssistanceSummary: '',
};
const grades: GradeSettings = {
  enabled: false,
  notes: '',
  revision: 0,
  collectedCount: 0,
  updatedAt: now,
};
const sessionSnapshot: SessionSnapshot = {
  session: {
    id: 'session-a',
    courseId: 'course-a',
    title: 'Mitochondria',
    activity: 'understand-topic',
    targetAssignmentId: null,
    topic: 'Mitochondria',
    status: 'in-progress',
    revision: 2,
    generationEpoch: 4,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    draft: { text: '', revision: 3 },
    timer: {
      deadlineAt: null,
      revision: 0,
      expiredRevision: null,
      resolvedExpiredRevision: null,
      finishedAt: null,
    },
  },
  messages: [
    {
      id: 'student-old',
      sessionId: 'session-a',
      sequence: 1,
      role: 'student',
      turnId: null,
      createdAt: now,
      parts: [{ kind: 'text', text: 'What is a mitochondrion?' }],
      status: 'accepted',
      gradeDerived: false,
      gradeConsentRevision: null,
    },
    {
      id: 'student-current',
      sessionId: 'session-a',
      sequence: 2,
      role: 'student',
      turnId: 'turn-a',
      createdAt: now,
      parts: [{ kind: 'text', text: 'Explain this section.' }],
      status: 'accepted',
      gradeDerived: false,
      gradeConsentRevision: null,
    },
    {
      id: 'tutor-old-grade',
      sessionId: 'session-a',
      sequence: 3,
      role: 'tutor',
      turnId: 'turn-old',
      createdAt: now,
      parts: [{ kind: 'text', text: 'Withheld grade feedback.' }],
      status: 'accepted',
      gradeDerived: true,
      gradeConsentRevision: 1,
    },
  ],
  hasMoreBefore: false,
  activeTurn: null,
  sourceReferences: [],
  revision: 3,
};
const authorizedContext: AuthorizedContext = {
  userId: 'student-a',
  epoch: 5,
  isCurrent: () => true,
  signal: new AbortController().signal,
};

const createDependencies = (
  overrides: Partial<StudyContextDependencies> = {},
): StudyContextDependencies => ({
  getStudySession: vi.fn(async () => sessionSnapshot),
  readCourseSources: vi.fn(async () => ({
    passages: [passage(courseReference, 'Mitochondria convert energy.')],
    status: 'current' as const,
    lastSuccessfulAt: now,
  })),
  readSelectedSources: vi.fn(async () => ({
    passages: [
      passage(uploadedReference, 'My teacher emphasized cell energy.'),
    ],
    status: 'current' as const,
    lastSuccessfulAt: now,
  })),
  preparePersonalContext: vi.fn(async () => ({
    preferences: [],
    observations: [],
    revision: 2,
  })),
  readContextRevision: vi.fn(async () => 11),
  resolveAssistancePolicy: vi.fn(async () => policy),
  getGradeSettings: vi.fn(async () => grades),
  ...overrides,
});

describe('study context preparation', () => {
  it('uses the persisted one-course setup and combines only current course and selected upload evidence', async () => {
    const dependencies = createDependencies();
    const result = await prepareStudyContext(
      authorizedContext,
      {
        sessionId: 'session-a',
        turnId: 'turn-a',
        text: 'Explain this section.',
        attachmentIds: ['context-a'],
        contextRevision: 11,
        policyRevision: 7,
        gradeConsentRevision: 0,
      },
      dependencies,
    );

    expect(result.context.courseId).toBe('course-a');
    expect(result.context.topic).toBe('Mitochondria');
    expect(
      result.context.sourcePassages.map(({ reference }) => reference.sourceId),
    ).toEqual(['material-a', 'context-a']);
    expect(result.context.history).toEqual([
      { role: 'student', text: 'What is a mitochondrion?' },
    ]);
    expect(result.gradeDerived).toBe(false);
    expect(dependencies.readCourseSources).toHaveBeenCalledWith(
      authorizedContext,
      {
        sessionId: 'session-a',
        courseId: 'course-a',
        targetAssignmentId: null,
        gradeAccessEnabled: false,
        gradeConsentRevision: 0,
        query: 'Mitochondria\nExplain this section.',
      },
    );
    expect(dependencies.readSelectedSources).toHaveBeenCalledWith(
      authorizedContext,
      expect.objectContaining({
        sessionId: 'session-a',
        selectedIds: ['context-a'],
      }),
    );
  });

  it('fails closed when a selected source resolves to a different course', async () => {
    const dependencies = createDependencies({
      readSelectedSources: vi.fn(async () => ({
        passages: [
          passage(
            { ...uploadedReference, courseId: 'course-b' },
            'Foreign course content.',
          ),
        ],
        status: 'current' as const,
        lastSuccessfulAt: now,
      })),
    });

    await expect(
      prepareStudyContext(
        authorizedContext,
        {
          sessionId: 'session-a',
          turnId: 'turn-a',
          text: 'Explain this section.',
          attachmentIds: ['context-a'],
          contextRevision: 11,
          policyRevision: 7,
          gradeConsentRevision: 0,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'scope-denied' });
  });

  it('checks captured grade consent before starting source or upload reads', async () => {
    const readCourseSources = vi.fn(async () => ({
      passages: [],
      status: 'current' as const,
      lastSuccessfulAt: now,
    }));
    const readSelectedSources = vi.fn(async () => ({
      passages: [],
      status: 'current' as const,
      lastSuccessfulAt: now,
    }));
    const dependencies = createDependencies({
      readCourseSources,
      readSelectedSources,
      getGradeSettings: vi.fn(async () => ({ ...grades, revision: 1 })),
    });

    await expect(
      prepareStudyContext(
        authorizedContext,
        {
          sessionId: 'session-a',
          turnId: 'turn-a',
          text: 'Explain this section.',
          attachmentIds: ['context-a'],
          contextRevision: 11,
          policyRevision: 7,
          gradeConsentRevision: 0,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'permission-revoked' });
    expect(readCourseSources).not.toHaveBeenCalled();
    expect(readSelectedSources).not.toHaveBeenCalled();
  });

  it('excludes grade-derived sources and historical grade-derived messages when consent is off', async () => {
    const gradeReference: SourceReference = {
      ...courseReference,
      sourceKind: 'grade-evidence',
      sourceId: 'grade-a',
    };
    const dependencies = createDependencies({
      readCourseSources: vi.fn(async () => ({
        passages: [
          passage(courseReference, 'Current course passage.'),
          passage(gradeReference, 'Collected feedback.'),
        ],
        status: 'partial' as const,
        lastSuccessfulAt: now,
      })),
    });
    const result = await prepareStudyContext(
      authorizedContext,
      {
        sessionId: 'session-a',
        turnId: 'turn-a',
        text: 'Explain this section.',
        attachmentIds: [],
        contextRevision: 11,
        policyRevision: 7,
        gradeConsentRevision: 0,
      },
      dependencies,
    );

    expect(
      result.context.sourcePassages.map(({ reference }) => reference.sourceId),
    ).not.toContain('grade-a');
    expect(JSON.stringify(result.context.history)).not.toContain(
      'Withheld grade feedback.',
    );
    expect(result.context.freshness.status).toBe('partial');
  });

  it('reports missing course and selected-source reads as unavailable without inventing passages', async () => {
    const dependencies = createDependencies({
      readCourseSources: vi.fn(async () => null),
      readSelectedSources: vi.fn(async () => null),
    });

    const result = await prepareStudyContext(
      authorizedContext,
      {
        sessionId: 'session-a',
        turnId: 'turn-a',
        text: 'Explain this section.',
        attachmentIds: [],
        contextRevision: 11,
        policyRevision: 7,
        gradeConsentRevision: 0,
      },
      dependencies,
    );

    expect(result.context.sourcePassages).toEqual([]);
    expect(result.context.freshness.status).toBe('unavailable');
  });

  it('keeps cached stale sources labeled stale for a bounded explanation', async () => {
    const dependencies = createDependencies({
      readCourseSources: vi.fn(async () => ({
        passages: [passage(courseReference, 'Cached course passage.')],
        status: 'stale' as const,
        lastSuccessfulAt: now,
      })),
      readSelectedSources: vi.fn(async () => ({
        passages: [],
        status: 'current' as const,
        lastSuccessfulAt: now,
      })),
    });

    const result = await prepareStudyContext(
      authorizedContext,
      {
        sessionId: 'session-a',
        turnId: 'turn-a',
        text: 'Explain this section.',
        attachmentIds: [],
        contextRevision: 11,
        policyRevision: 7,
        gradeConsentRevision: 0,
      },
      dependencies,
    );

    expect(result.context.sourcePassages).toHaveLength(1);
    expect(result.context.freshness.status).toBe('stale');
  });

  it('rejects a session snapshot whose context ID does not match the requested session', async () => {
    const dependencies = createDependencies({
      getStudySession: vi.fn(async () => ({
        ...sessionSnapshot,
        session: { ...sessionSnapshot.session, id: 'session-b' },
      })),
    });

    await expect(
      prepareStudyContext(
        authorizedContext,
        {
          sessionId: 'session-a',
          turnId: 'turn-a',
          text: 'Explain this section.',
          attachmentIds: [],
          contextRevision: 11,
          policyRevision: 7,
          gradeConsentRevision: 0,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(dependencies.readCourseSources).not.toHaveBeenCalled();
  });

  it('includes grade-derived source context only with the captured consent revision', async () => {
    const gradeReference: SourceReference = {
      ...courseReference,
      sourceKind: 'grade-evidence',
      sourceId: 'grade-a',
    };
    const enabledGrades = { ...grades, enabled: true, revision: 3 };
    const enabledPolicy = {
      ...policy,
      consentRevision: 3,
      state: 'verified-completed' as const,
    };
    const dependencies = createDependencies({
      readCourseSources: vi.fn(async () => ({
        passages: [passage(gradeReference, 'Feedback about a missed concept.')],
        status: 'current' as const,
        lastSuccessfulAt: now,
      })),
      getGradeSettings: vi.fn(async () => enabledGrades),
      resolveAssistancePolicy: vi.fn(async () => enabledPolicy),
    });

    const result = await prepareStudyContext(
      authorizedContext,
      {
        sessionId: 'session-a',
        turnId: 'turn-a',
        text: 'Help me review the mistake.',
        attachmentIds: [],
        contextRevision: 11,
        policyRevision: enabledPolicy.policyRevision,
        gradeConsentRevision: enabledGrades.revision,
      },
      dependencies,
    );

    expect(result.gradeDerived).toBe(true);
    expect(result.gradeConsentRevision).toBe(enabledGrades.revision);
    expect(result.context.sourcePassages[0]?.reference.sourceKind).toBe(
      'grade-evidence',
    );
    expect(dependencies.readCourseSources).toHaveBeenCalledWith(
      authorizedContext,
      expect.objectContaining({
        gradeAccessEnabled: true,
        gradeConsentRevision: 3,
      }),
    );
  });
});
