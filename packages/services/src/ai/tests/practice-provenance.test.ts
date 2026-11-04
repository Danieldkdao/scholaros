import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  issuePracticeProof,
  verifyPracticeProof,
  type PracticeProvenanceScope,
} from '../practice-provenance';
const secret = 'synthetic-server-secret-with-sufficient-entropy';
const now = 1_800_000_000_000;
const week = 7 * 24 * 60 * 60 * 1000;
const scope = (): PracticeProvenanceScope => ({
  accountId: 'account-private',
  courseId: 'course-private',
  sessionId: 'session-private',
  configurationRevision: 'config-3',
  rubricVersion: 'rubric-v1',
  question: {
    id: 'q1',
    prompt: 'Explain energy',
    sourceReferences: [{ id: 'source-1', version: 2 }],
  },
  answerKey: {
    questionId: 'q1',
    expected: ['mass', 'speed'],
    rubric: { tolerance: 0.01, credit: 2 },
  },
});
const forgePayload = (proof: string, patch: object) => {
  const changed = {
    ...JSON.parse(Buffer.from(proof.split('.')[1]!, 'base64url').toString()),
    ...patch,
  };
  const payload = Buffer.from(
    JSON.stringify(changed, Object.keys(changed).sort()),
  ).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', secret)
    .update('scholaros.practice-proof.v1.' + payload)
    .digest('base64url')}`;
};
describe('server-issued practice provenance', () => {
  it('verifies exact scope without exposing raw scope or content', () => {
    const proof = issuePracticeProof(scope(), secret, now);
    expect(verifyPracticeProof(scope(), proof, secret, now)).toBe(true);
    expect(proof.length).toBeLessThanOrEqual(4096);
    const decoded = Buffer.from(proof.split('.')[1]!, 'base64url').toString();
    for (const text of [
      'account-private',
      'course-private',
      'session-private',
      'Explain energy',
      'mass',
      'source-1',
    ])
      expect(decoded).not.toContain(text);
  });
  it.each([
    'accountId',
    'courseId',
    'sessionId',
    'configurationRevision',
    'rubricVersion',
  ] as const)('rejects changed %s', (field) => {
    const value = scope();
    const proof = issuePracticeProof(value, secret, now);
    value[field] += 'changed';
    expect(verifyPracticeProof(value, proof, secret, now)).toBe(false);
  });
  it('binds question, source references, answer and rubric', () => {
    const value = scope();
    const proof = issuePracticeProof(value, secret, now);
    for (const patch of [
      { question: { ...(value.question as object), prompt: 'new' } },
      {
        question: {
          ...(value.question as object),
          sourceReferences: [{ id: 'foreign' }],
        },
      },
      { answerKey: { ...(value.answerKey as object), expected: ['tamper'] } },
      {
        answerKey: { ...(value.answerKey as object), rubric: { credit: 100 } },
      },
    ])
      expect(
        verifyPracticeProof({ ...value, ...patch }, proof, secret, now),
      ).toBe(false);
  });
  it('canonicalizes keys but preserves array order', () => {
    const value = scope();
    const proof = issuePracticeProof(value, secret, now);
    expect(
      verifyPracticeProof(
        {
          ...value,
          question: {
            sourceReferences: [{ version: 2, id: 'source-1' }],
            prompt: 'Explain energy',
            id: 'q1',
          },
          answerKey: {
            rubric: { credit: 2, tolerance: 0.01 },
            expected: ['mass', 'speed'],
            questionId: 'q1',
          },
        },
        proof,
        secret,
        now,
      ),
    ).toBe(true);
    expect(
      verifyPracticeProof(
        {
          ...value,
          answerKey: {
            ...(value.answerKey as object),
            expected: ['speed', 'mass'],
          },
        },
        proof,
        secret,
        now,
      ),
    ).toBe(false);
  });
  it('ignores only top-level answerKey generationProof and does not mutate data', () => {
    const value = scope();
    const proof = issuePracticeProof(value, secret, now);
    const key = { ...(value.answerKey as object), generationProof: proof };
    expect(
      verifyPracticeProof({ ...value, answerKey: key }, proof, secret, now),
    ).toBe(true);
    expect(key.generationProof).toBe(proof);
    expect(
      verifyPracticeProof(
        {
          ...value,
          answerKey: {
            ...key,
            rubric: { credit: 2, tolerance: 0.01, generationProof: 'nested' },
          },
        },
        proof,
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      verifyPracticeProof(
        {
          ...value,
          question: {
            ...(value.question as object),
            generationProof: 'changed',
          },
        },
        proof,
        secret,
        now,
      ),
    ).toBe(false);
  });
  it('rejects payload/MAC tampering and rotated keys', () => {
    const proof = issuePracticeProof(scope(), secret, now);
    expect(verifyPracticeProof(scope(), proof, secret + 'rotation', now)).toBe(
      false,
    );
    expect(
      verifyPracticeProof(scope(), proof.slice(0, -3) + 'AAA', secret, now),
    ).toBe(false);
    const parts = proof.split('.');
    parts[1] = Buffer.from('{}').toString('base64url');
    expect(verifyPracticeProof(scope(), parts.join('.'), secret, now)).toBe(
      false,
    );
  });
  it('enforces exact seven-day expiry and future issuance', () => {
    const proof = issuePracticeProof(scope(), secret, now);
    expect(verifyPracticeProof(scope(), proof, secret, now + week - 1)).toBe(
      true,
    );
    expect(verifyPracticeProof(scope(), proof, secret, now + week)).toBe(false);
    expect(verifyPracticeProof(scope(), proof, secret, now - 1)).toBe(false);
  });
  it.each([
    null,
    undefined,
    {},
    [],
    true,
    42,
    '',
    'v2.a.b',
    'v1.!.bad',
    'x'.repeat(4097),
  ])('rejects malformed proof %#', (proof) =>
    expect(verifyPracticeProof(scope(), proof, secret, now)).toBe(false),
  );
  it.each(['', '   ', undefined, null])('requires secret %#', (key) => {
    expect(() => issuePracticeProof(scope(), key as string, now)).toThrow();
    expect(verifyPracticeProof(scope(), 'anything', key as string, now)).toBe(
      false,
    );
  });
  it.each([NaN, Infinity, -1, now + 0.5, Number.MAX_SAFE_INTEGER])(
    'rejects invalid clock %#',
    (time) => {
      expect(() => issuePracticeProof(scope(), secret, time)).toThrow();
      expect(verifyPracticeProof(scope(), 'anything', secret, time)).toBe(
        false,
      );
    },
  );
  it('rejects authenticated but invalid version/expiry/extra-key payloads', () => {
    const proof = issuePracticeProof(scope(), secret, now);
    for (const patch of [
      { v: 2 },
      { exp: now + week + 1 },
      { iat: now + 1, exp: now + week + 1 },
      { extra: true },
      { d: 'invalid' },
    ])
      expect(
        verifyPracticeProof(scope(), forgePayload(proof, patch), secret, now),
      ).toBe(false);
  });
  it('rejects ambiguous, cyclic, excessive and accessor JSON inputs safely', () => {
    const proof = issuePracticeProof(scope(), secret, now);
    const cycle: any = {};
    const sparse: unknown[] = [];
    sparse.length = 3;
    cycle.self = cycle;
    const getter = {
      get leaked() {
        throw new Error('getter must not execute');
      },
    };
    for (const bad of [
      undefined,
      NaN,
      Infinity,
      1n,
      () => null,
      new Date(),
      cycle,
      getter,
      { text: 'x'.repeat(1024 * 1024 + 1) },
      sparse,
    ]) {
      const value = { ...scope(), question: bad };
      expect(() => issuePracticeProof(value, secret, now)).toThrow();
      expect(verifyPracticeProof(value, proof, secret, now)).toBe(false);
    }
  });
  it('rejects empty scope fields and excessive depth', () => {
    for (const field of [
      'accountId',
      'courseId',
      'sessionId',
      'configurationRevision',
      'rubricVersion',
    ])
      expect(() =>
        issuePracticeProof({ ...scope(), [field]: '' }, secret, now),
      ).toThrow();
    let deep: any = {};
    for (let i = 0; i < 35; i++) deep = { deep };
    expect(() =>
      issuePracticeProof({ ...scope(), question: deep }, secret, now),
    ).toThrow();
  });
});
