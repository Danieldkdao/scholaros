import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractAcademicEvidence } from '../academic';

const { serverEnv } = vi.hoisted(() => ({
  serverEnv: {
    BASETEN_API_KEY: 'test-key',
    META_API_KEY: 'test-key',
    INFERENCE_PROVIDER: 'baseten',
    BASETEN_MODEL: 'meta-models/muse-spark-open-1026',
    META_MODEL: 'muse-spark-1.3-contributor',
  },
}));
vi.mock('@scholaros/env/server', () => ({ serverEnv }));
afterEach(() => vi.unstubAllGlobals());
const url = 'https://school.example/courses/1';
const evidence = { sourceUrl: url, excerpts: ['Biology'], targetIds: ['1'] };
const assignmentEvidence = {
  sourceUrl: url,
  excerpts: ['Biology assignment due November 3, 2026 at 11:59 pm.'],
  targetIds: ['1'],
};
const course = {
  name: 'Biology',
  code: null,
  section: null,
  term: null,
  description: null,
  instructors: [],
  sourceId: null,
  url,
  evidence,
};
describe.each(['baseten', 'meta'])('%s resource extraction', (provider) => {
  beforeEach(() => {
    serverEnv.INFERENCE_PROVIDER = provider;
  });
  it.each([
    ['courses', { courses: [course], coverage: 'detail' }],
    [
      'assignments',
      {
        assignments: [
          {
            title: 'Biology',
            description: null,
            kind: 'assignment',
            state: 'unknown',
            due: {
              kind: 'local',
              date: '2026-11-03',
              time: '23:59',
              original: 'November 3, 2026',
            },
            availableFrom: null,
            availableUntil: null,
            pointsPossible: null,
            url: null,
            sourceId: null,
            resources: [],
            evidence: assignmentEvidence,
          },
        ],
        coverage: 'partial',
      },
    ],
    [
      'announcements',
      {
        announcements: [
          {
            title: 'Biology',
            body: null,
            author: null,
            published: null,
            updated: null,
            url: null,
            sourceId: null,
            resources: [],
            evidence,
          },
        ],
        coverage: 'detail',
      },
    ],
  ] as const)(
    'uses the focused %s contract through the installed AI SDK',
    async (kind, output) => {
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
        if (String(init.body).includes('"oneOf"'))
          return Response.json(
            { error: { message: "'oneOf' is not permitted." } },
            { status: 400 },
          );
        if (JSON.parse(String(init.body)).reasoning_effort !== 'low')
          return Response.json({
            id: 'test',
            model: 'test',
            created: 1,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: null },
                finish_reason: 'length',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 6000,
              total_tokens: 6010,
              completion_tokens_details: { reasoning_tokens: 5998 },
            },
          });
        return Response.json({
          id: 'test',
          model: 'test',
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(output) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const result = await extractAcademicEvidence(
        {
          kind,
          goal: 'Read Biology',
          notes: '',
          pages: [
            {
              url,
              title: 'Biology',
              text: 'Biology assignment due November 3, 2026 at 11:59 pm.',
            },
          ],
          targets: [{ id: '1', label: 'Biology', url }],
        },
        new AbortController().signal,
      );
      expect(result).toEqual(output);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
});
