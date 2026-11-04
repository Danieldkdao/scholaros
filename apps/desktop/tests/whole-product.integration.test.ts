import { existsSync, readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { extractPdfContent } from '../src/features/context/services/pdf-content';
import { createPdfFixture } from './fixtures/whole-product-runner';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

it('tracks every product and global rule without unsubstantiated passes', async () => {
  const releaseVerification = readFileSync(
    new URL('../../../docs/release-verification.md', import.meta.url),
    'utf8',
  );
  const match = releaseVerification.match(
    /<!-- release-evidence-manifest:begin -->\s*````json\s*([\s\S]*?)````/,
  );

  expect(match).not.toBeNull();
  if (!match) return;

  const manifest = JSON.parse(match[1]!) as {
    requirements: Record<
      string,
      {
        status: 'passed' | 'blocked' | 'failed';
        evidence_paths: string[];
        blocking: boolean;
        reason: string;
        workflow_override?: string | null;
      }
    >;
    tested_head_sha: string | null;
    checks: Array<{
      id: string;
      command_or_journey: string;
      result: 'passed' | 'blocked' | 'failed';
      evidence_path: string | null;
      blocking: boolean;
      reason: string;
    }>;
  };
  const masterPlan = readFileSync(
    new URL('../../../docs/master-plan.md', import.meta.url),
    'utf8',
  );
  const productRequirementIds = [
    ...new Set(masterPlan.match(/\bF\d{2}-(?:R\d{2}|AC\d{2})\b/g) ?? []),
  ].sort();
  const globalRuleIds = Array.from(
    { length: 126 },
    (_, index) => `G${String(index + 1).padStart(3, '0')}`,
  );
  const requirementIds = Object.keys(manifest.requirements).sort();

  expect(requirementIds).toEqual(
    [...productRequirementIds, ...globalRuleIds].sort(),
  );
  expect(manifest.checks.map((check) => check.id).sort()).toEqual(
    [
      'C001',
      'C002',
      'C003',
      'C004',
      'C005',
      'C006',
      'C007',
      'C008',
      'C009',
      'C010',
      'C011',
      'C012',
      'C013',
      'C014',
      'C015',
      'C016',
      'C017',
      'C018',
      'C019',
      'C020',
      'C021',
      'C022',
      'C023',
      'C024',
    ].sort(),
  );
  expect(manifest.requirements.G082.workflow_override).toContain(
    'NO local Reviewer stage',
  );
  expect(manifest.requirements.G091.workflow_override).toContain(
    'no Reviewer agent dispatched',
  );
  expect(manifest.requirements.G093.workflow_override).toContain(
    'CURRENT whole-product',
  );
  expect(manifest.requirements.G096.workflow_override).toContain(
    'controller alone ONE explicit Apex',
  );

  for (const [id, evidence] of Object.entries(manifest.requirements)) {
    expect(['passed', 'blocked', 'failed']).toContain(evidence.status);
    expect(Array.isArray(evidence.evidence_paths)).toBe(true);
    expect(typeof evidence.blocking).toBe('boolean');
    if (evidence.status === 'blocked' || evidence.status === 'failed')
      expect(evidence.reason).toBeTruthy();
    if (evidence.status === 'passed') {
      expect(evidence.evidence_paths.length).toBeGreaterThan(0);
      for (const evidencePath of evidence.evidence_paths)
        expect(existsSync(evidencePath), `${id}: ${evidencePath}`).toBe(true);
    }
  }

  expect(manifest.tested_head_sha).toBeNull();
  const runner = await loadWholeProductRunner();
  expect(runner).not.toBeNull();
  if (!runner) return;

  const validationErrors = runner.validateEvidenceManifest(manifest, {
    expectedHeadSha: null,
    expectedRequirementIds: requirementIds,
    fileExists: existsSync,
  });
  expect(validationErrors).toContain('F01-R01: blocking item is blocked');
  expect(validationErrors).toContain('C001: blocking check is blocked');
});

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
