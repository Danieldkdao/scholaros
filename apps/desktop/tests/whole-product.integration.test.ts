import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { extractPdfContent } from '../src/features/context/services/pdf-content';
import {
  createPdfFixture,
  parseAcademicEndpointFile,
} from './fixtures/whole-product-runner';

it('reads service ownership metadata without passing it to transport requests', () => {
  expect(
    parseAcademicEndpointFile({
      version: 1,
      address: '/tmp/academic.sock',
      token: 'a'.repeat(64),
      instanceId: '11111111-1111-4111-8111-111111111111',
    }),
  ).toEqual({
    version: 1,
    address: '/tmp/academic.sock',
    token: 'a'.repeat(64),
  });
  expect(() =>
    parseAcademicEndpointFile({
      version: 1,
      address: '/tmp/academic.sock',
      token: 'a'.repeat(64),
      instanceId: 'invalid',
    }),
  ).toThrow();
});

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

const loadWholeProductRunner = async () =>
  import('./fixtures/whole-product-runner').catch(() => null);

it('does not let failed nonblocking evidence pass the release gate', async () => {
  const runner = await loadWholeProductRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  const commit = 'a'.repeat(40);
  const errors = runner.validateEvidenceManifest(
    {
      tested_head_sha: commit,
      requirements: {
        'F01-R01': {
          status: 'failed',
          evidence_paths: ['/evidence/failed-test.log'],
          blocking: false,
          reason: 'The test reproduced a failure.',
        },
      },
      checks: [
        {
          id: 'C001',
          command_or_journey: 'packaged service smoke',
          result: 'failed',
          evidence_path: '/evidence/failed-test.log',
          blocking: false,
          reason: 'The service did not start.',
        },
      ],
    },
    {
      expectedHeadSha: commit,
      expectedRequirementIds: ['F01-R01'],
      fileExists: () => true,
    },
  );

  expect(errors).toContain('F01-R01: failed result blocks release');
  expect(errors).toContain('C001: failed result blocks release');
});

it('requires actual evidence for a nonblocking external limitation', async () => {
  const runner = await loadWholeProductRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  const commit = 'b'.repeat(40);
  const manifest = {
    tested_head_sha: commit,
    requirements: {},
    checks: [
      {
        id: 'C019',
        command_or_journey: 'Windows hardware verification',
        result: 'blocked' as const,
        evidence_path: '/evidence/windows-limitation.md',
        blocking: false,
        reason: 'No Windows laptop was available for this run.',
      },
    ],
  };

  expect(
    runner.validateEvidenceManifest(manifest, {
      expectedHeadSha: commit,
      expectedRequirementIds: [],
      fileExists: () => true,
    }),
  ).toEqual([]);
  expect(
    runner.validateEvidenceManifest(manifest, {
      expectedHeadSha: commit,
      expectedRequirementIds: [],
      fileExists: () => false,
    }),
  ).toContain('C019: evidence path does not exist');
});

it('keeps blank PDF pages in their original form-feed positions', async () => {
  const result = await extractPdfContent(
    createPdfFixture(['First page', '', 'Third page']),
  );

  expect(result).toEqual({
    status: 'complete',
    pageCount: 3,
    text: 'First page\f\fThird page',
  });
});

it('reports partial when an exact character limit omits later pages', async () => {
  const result = await extractPdfContent(
    createPdfFixture(['First page', 'Later page']),
    { maxCharacters: 'First page'.length },
  );

  expect(result).toEqual({
    status: 'partial',
    pageCount: 2,
    text: 'First page',
  });
});
