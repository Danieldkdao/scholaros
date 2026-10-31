import { describe, expect, it } from 'vitest';
import { createConnectionApprovalStore } from '../services/connection-approval';

describe('connection approval', () => {
  it('requires a fresh account-bound approval and consumes it once', () => {
    const store = createConnectionApprovalStore();
    const run = store.propose('student-a', [
      { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
    ]);
    expect(() => store.approve('student-b', run.id, run.candidates)).toThrow();
    store.approve('student-a', run.id, run.candidates);
    expect(store.consume('student-a', run.id)).toEqual({
      candidates: run.candidates,
    });
    expect(() => store.consume('student-a', run.id)).toThrow();
  });
  it('rejects changed approval lists and unsafe or credential-bearing URLs', () => {
    const store = createConnectionApprovalStore();
    expect(() =>
      store.propose('student-a', [
        { name: 'Unsafe', url: 'http://127.0.0.1/', provider: 'unknown' },
      ]),
    ).toThrow();
    expect(() =>
      store.propose('student-a', [
        {
          name: 'Unsafe',
          url: 'https://school.edu/login?token=secret',
          provider: 'unknown',
        },
      ]),
    ).toThrow();
    const run = store.propose('student-a', [
      { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
    ]);
    expect(() =>
      store.approve('student-a', run.id, [
        { name: 'Other', url: 'https://other.edu/', provider: 'unknown' },
      ]),
    ).toThrow();
    expect(() => store.approve('student-a', run.id, [])).toThrow();
  });
  it('invalidates a previous approval when a new proposal is created', () => {
    const store = createConnectionApprovalStore();
    const old = store.propose('student-a', [
      { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
    ]);
    store.approve('student-a', old.id, old.candidates);
    store.propose('student-a', [
      { name: 'Other', url: 'https://other.edu/', provider: 'unknown' },
    ]);
    expect(() => store.consume('student-a', old.id)).toThrow();
  });
});

it('approves a destination without requiring identity-provider configuration', () => {
  const store = createConnectionApprovalStore();
  const run = store.propose('student-a', [
    {
      name: 'Classroom',
      url: 'https://classroom.google.com/',
      provider: 'google',
    },
  ]);
  expect(run).not.toHaveProperty('traversalHosts');
  store.approve('student-a', run.id, run.candidates);
  expect(store.consume('student-a', run.id).candidates).toEqual(run.candidates);
});

it('requires review again when a student edits a proposal', () => {
  const store = createConnectionApprovalStore();
  const run = store.propose('student-a', [
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  const next = store.revise('student-a', run.id, [
    { name: 'Other', url: 'https://other.edu/', provider: 'unknown' },
  ]);
  expect(() => store.approve('student-a', run.id, run.candidates)).toThrow();
  expect(next.candidates[0]?.url).toBe('https://other.edu/');
  expect(() => store.consume('student-a', next.id)).toThrow();
});

it('revokes an earlier approval even when a revision is invalid', () => {
  const store = createConnectionApprovalStore();
  const run = store.propose('student-a', [
    { name: 'School', url: 'https://school.edu/', provider: 'unknown' },
  ]);
  store.approve('student-a', run.id, run.candidates);
  expect(() =>
    store.revise('student-a', run.id, [
      { name: 'Bad', url: 'http://127.0.0.1/', provider: 'unknown' },
    ]),
  ).toThrow();
  expect(() => store.consume('student-a', run.id)).toThrow();
});
