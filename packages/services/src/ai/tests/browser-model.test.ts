import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { courseDiscoverySchema } from '../schemas';
import { extractedAnnouncementsSchema } from '../resources/announcement';
import { extractedAssignmentsSchema } from '../resources/assignment';
import { extractedCoursesSchema } from '../resources/course';
import { extractedMaterialsSchema } from '../resources/material';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  object: vi.fn((options: unknown) => options),
  jsonSchema: vi.fn((schema: unknown, options?: unknown) => ({
    schema,
    options,
  })),
  getInferenceModel: vi.fn(() => 'server-selected-meta-standard-model'),
  requireModelCapability: vi.fn(),
}));
vi.mock('ai', () => ({
  generateText: mocks.generateText,
  Output: { object: mocks.object },
  jsonSchema: mocks.jsonSchema,
}));
vi.mock('../models/inference', () => ({
  getInferenceModel: mocks.getInferenceModel,
  evidenceBudgetTokens: 6000,
}));
vi.mock('../model-capabilities', () => ({
  requireModelCapability: mocks.requireModelCapability,
}));

import { generateBrowserModel } from '../browser-model';

const stagehandActionValues = [
  'click',
  'fill',
  'type',
  'press',
  'scrollTo',
  'nextChunk',
  'prevChunk',
  'selectOptionFromDropdown',
  'hover',
  'doubleClick',
  'dragAndDrop',
] as const;
const observeSchema = z.toJSONSchema(
  z.strictObject({
    elements: z.array(
      z.strictObject({
        elementId: z
          .string()
          .regex(/^\d+-\d+$/)
          .describe(
            'The complete frame ordinal and backend node ID copied from the accessibility tree, without square brackets.',
          ),
        description: z
          .string()
          .describe('A description of the accessible element and its purpose.'),
        method: z
          .enum(stagehandActionValues)
          .describe(
            'The supported browser interaction method for this element.',
          ),
        arguments: z
          .array(z.string())
          .describe(
            'The arguments to pass to the selected interaction method.',
          ),
      }),
    ),
  }),
);
const request = (
  schema: unknown = z.toJSONSchema(extractedAssignmentsSchema),
) => ({
  kind: 'browser-model' as const,
  messages: [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: '[1-23] link: Assignment details' },
      ],
    },
  ],
  systemPrompt: 'Return the entire answer to the assignment.',
  temperature: 0,
  stopSequences: ['stop'],
  responseFormat: {
    type: 'json_schema' as const,
    name: 'client_chosen_name',
    schema,
  },
});
const pinSourcePageUrls = (value: unknown, sourceUrl: string): void => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child) => pinSourcePageUrls(child, sourceUrl));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'sourceUrl')
      (value as Record<string, unknown>)[key] = {
        type: 'string',
        const: sourceUrl,
      };
    else pinSourcePageUrls(child, sourceUrl);
  }
};
const stagehandLinkReferenceDescription =
  'This field must be the element-ID in the form \'frameId-backendId\' (e.g. "0-432").';
const backslash = String.fromCharCode(92);
const stagehandDateTimeNoOffsetPattern = `^${(z.toJSONSchema(z.iso.date()).pattern ?? '').slice(1, -1)}T(?:(?:[01]${backslash}d|2[0-3]):[0-5]${backslash}d(?::[0-5]${backslash}d(?:${backslash}.${backslash}d+)?)?(?:Z))$`;
const convertToStagehandSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(convertToStagehandSchema);
  if (!value || typeof value !== 'object') return value;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'string' && schema.format === 'uri')
    return {
      type: 'string',
      pattern: '^\\d+-\\d+$',
      description: stagehandLinkReferenceDescription,
    };
  if (schema.type === 'string' && schema.format === 'date')
    return {
      type: 'string',
      allOf: [{ pattern: schema.pattern }, { pattern: schema.pattern }],
    };
  if (schema.type === 'string' && schema.format === 'date-time')
    return {
      type: 'string',
      allOf: [
        { pattern: stagehandDateTimeNoOffsetPattern },
        { pattern: z.toJSONSchema(z.iso.datetime({ offset: true })).pattern },
      ],
    };
  if (schema.type === 'string' && Array.isArray(schema.allOf))
    return { type: 'string', allOf: [{ type: 'string' }, {}, {}] };
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !(schema.type === 'array' && key === 'maxItems'))
      .map(([key, child]) => [key, convertToStagehandSchema(child)]),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateText.mockReset();
  mocks.generateText.mockResolvedValue({
    output: { assignments: [], coverage: 'complete' },
  });
});

describe('Stagehand browser model bridge', () => {
  it('uses a reviewed extraction profile and server-owned instructions', async () => {
    const result = await generateBrowserModel(
      request(),
      new AbortController().signal,
    );

    expect(result.structuredContent).toEqual({
      assignments: [],
      coverage: 'complete',
    });
    const generation = mocks.generateText.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(generation.model).toBe('server-selected-meta-standard-model');
    expect(generation.instructions).toMatch(/assignments/i);
    expect(generation.instructions).not.toBe(request().systemPrompt);
    expect(generation.temperature).toBeUndefined();
    expect(generation.maxOutputTokens).toBe(6000);
    expect(generation.reasoning).toBe('low');
    expect(generation.maxRetries).toBe(0);
    expect(generation.telemetry).toEqual({ isEnabled: false });
    expect(generation.providerOptions).toEqual({
      openai: {
        forceReasoning: true,
        systemMessageMode: 'developer',
        store: false,
        strictJsonSchema: true,
      },
    });
    expect(mocks.requireModelCapability).toHaveBeenCalledWith(
      'browser-extraction',
    );
  });

  it('accepts host-pinned HTTPS source URLs for reviewed extraction output', async () => {
    const sourceUrl = 'https://school.example/biology/assignments';
    const schema = z.toJSONSchema(extractedAssignmentsSchema);
    pinSourcePageUrls(schema, sourceUrl);
    mocks.generateText.mockResolvedValueOnce({
      output: { assignments: [], coverage: 'complete' },
    });

    await expect(
      generateBrowserModel(request(schema), new AbortController().signal),
    ).resolves.toMatchObject({
      structuredContent: { assignments: [], coverage: 'complete' },
    });
  });

  it('preserves the installed Stagehand observe callback with a read-only profile', async () => {
    mocks.generateText.mockResolvedValueOnce({
      output: {
        elements: [
          {
            elementId: '1-23',
            description: 'Open assignment details',
            method: 'click',
            arguments: [],
          },
        ],
      },
    });

    const result = await generateBrowserModel(
      request(observeSchema),
      new AbortController().signal,
    );

    expect(result.structuredContent).toEqual({
      elements: [
        {
          elementId: '1-23',
          description: 'Open assignment details',
          method: 'click',
          arguments: [],
        },
      ],
    });
    expect(mocks.requireModelCapability).toHaveBeenCalledWith(
      'browser-navigation',
    );
  });

  it('preserves Stagehand metadata callbacks with server-owned instructions', async () => {
    const metadataSchema = z.toJSONSchema(
      z.strictObject({
        progress: z
          .string()
          .describe(
            'progress of what has been extracted so far, as concise as possible',
          ),
        completed: z
          .boolean()
          .describe(
            'true if the goal is now accomplished. Use this conservatively, only when sure that the goal has been completed.',
          ),
      }),
    );
    mocks.generateText.mockResolvedValueOnce({
      output: { progress: 'Assignment details read.', completed: true },
    });

    const result = await generateBrowserModel(
      request(metadataSchema),
      new AbortController().signal,
    );

    expect(result.structuredContent).toEqual({
      progress: 'Assignment details read.',
      completed: true,
    });
    expect(mocks.requireModelCapability).toHaveBeenCalledWith(
      'browser-extraction',
    );
  });

  it('rejects an observation that selects a link not offered in Stagehand context', async () => {
    mocks.generateText.mockResolvedValueOnce({
      output: {
        elements: [
          {
            elementId: '9-99',
            description: 'Open an unoffered link',
            method: 'click',
            arguments: [],
          },
        ],
      },
    });

    await expect(
      generateBrowserModel(
        request(observeSchema),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/offered/i);
  });

  it('rejects Stagehand form actions despite the broader callback schema', async () => {
    mocks.generateText.mockResolvedValueOnce({
      output: {
        elements: [
          {
            elementId: '1-23',
            description: 'Fill the assignment response',
            method: 'fill',
            arguments: ['answer'],
          },
        ],
      },
    });

    await expect(
      generateBrowserModel(
        request(observeSchema),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/schema/i);
  });

  it('rejects arbitrary client schemas before inference', async () => {
    await expect(
      generateBrowserModel(
        request({
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unsupported/i);

    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('recognizes the installed Stagehand extraction schema transforms', async () => {
    const stagehandSchema = convertToStagehandSchema(
      z.toJSONSchema(extractedAssignmentsSchema),
    );

    await expect(
      generateBrowserModel(
        request(stagehandSchema),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      structuredContent: { assignments: [], coverage: 'complete' },
    });
    expect(mocks.requireModelCapability).toHaveBeenCalledWith(
      'browser-extraction',
    );
  });

  it('recognizes pinned source URLs after Stagehand rewrites extraction schemas', async () => {
    const pinnedSchema = z.toJSONSchema(extractedAssignmentsSchema);
    const sourceUrl = 'https://courses.example.edu/biology';
    pinSourcePageUrls(pinnedSchema, sourceUrl);
    const stagehandSchema = convertToStagehandSchema(
      z.toJSONSchema(z.fromJSONSchema(pinnedSchema)),
    );

    await expect(
      generateBrowserModel(
        request(stagehandSchema),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      structuredContent: { assignments: [], coverage: 'complete' },
    });
    const outputSchema = mocks.jsonSchema.mock.calls[0]?.[0] as {
      properties: {
        assignments: {
          maxItems: number;
          items: {
            properties: {
              evidence: { properties: { sourceUrl: { const: string } } };
            };
          };
        };
      };
    };
    expect(outputSchema.properties.assignments.maxItems).toBe(30);
    expect(
      outputSchema.properties.assignments.items.properties.evidence.properties
        .sourceUrl.const,
    ).toBe(sourceUrl);
  });

  it('rejects extraction links that Stagehand did not offer', async () => {
    const pinnedSchema = z.toJSONSchema(extractedAssignmentsSchema);
    pinSourcePageUrls(pinnedSchema, 'https://courses.example.edu/biology');
    const stagehandSchema = convertToStagehandSchema(
      z.toJSONSchema(z.fromJSONSchema(pinnedSchema)),
    );
    mocks.generateText.mockResolvedValueOnce({
      output: {
        assignments: [
          {
            title: 'Exam',
            description: null,
            kind: 'exam',
            state: 'active-unsubmitted',
            due: null,
            availableFrom: null,
            availableUntil: null,
            pointsPossible: null,
            url: '9-99',
            sourceId: null,
            resources: [],
            evidence: {
              sourceUrl: 'https://courses.example.edu/biology',
              excerpts: ['Exam details'],
              targetIds: ['1-23'],
            },
          },
        ],
        coverage: 'complete',
      },
    });

    await expect(
      generateBrowserModel(
        request(stagehandSchema),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unoffered target/i);
  });

  it.each([
    ['course discovery', courseDiscoverySchema],
    ['courses', extractedCoursesSchema],
    ['assignments', extractedAssignmentsSchema],
    ['announcements', extractedAnnouncementsSchema],
    ['materials', extractedMaterialsSchema],
  ] as const)(
    'recognizes the reviewed %s extraction schema',
    async (_, schema) => {
      const result =
        schema === courseDiscoverySchema
          ? { courseTargetIds: ['1-23'] }
          : schema === extractedCoursesSchema
            ? { courses: [], coverage: 'complete' }
            : schema === extractedAssignmentsSchema
              ? { assignments: [], coverage: 'complete' }
              : schema === extractedAnnouncementsSchema
                ? { announcements: [], coverage: 'complete' }
                : { materials: [], coverage: 'complete' };
      mocks.generateText.mockResolvedValueOnce({ output: result });

      await expect(
        generateBrowserModel(
          request(z.toJSONSchema(schema)),
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ structuredContent: result });
    },
  );

  it('rejects Stagehand output that does not match the reviewed schema', async () => {
    mocks.generateText.mockResolvedValueOnce({
      output: { assignments: [{ title: 'Unvalidated answer' }] },
    });

    await expect(
      generateBrowserModel(request(), new AbortController().signal),
    ).rejects.toThrow(/schema/i);
  });

  it('enforces the byte limit for multibyte Stagehand output', async () => {
    const sourceUrl = 'https://courses.example.edu/biology';
    const pinnedSchema = z.toJSONSchema(extractedAssignmentsSchema);
    pinSourcePageUrls(pinnedSchema, sourceUrl);
    const stagehandSchema = convertToStagehandSchema(
      z.toJSONSchema(z.fromJSONSchema(pinnedSchema)),
    );
    const assignment = {
      title: 'Exam',
      description: '🙂'.repeat(1_000),
      kind: 'exam',
      state: 'active-unsubmitted',
      due: null,
      availableFrom: null,
      availableUntil: null,
      pointsPossible: null,
      url: '1-23',
      sourceId: null,
      resources: [],
      evidence: {
        sourceUrl,
        excerpts: ['Exam details'],
        targetIds: ['1-23'],
      },
    };
    mocks.generateText.mockResolvedValueOnce({
      output: {
        assignments: Array.from({ length: 30 }, () => assignment),
        coverage: 'complete',
      },
    });

    await expect(
      generateBrowserModel(
        request(stagehandSchema),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/generated browser response/i);
  });

  it('serializes bounded Meta reasoning and strict JSON output through the installed adapter', async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const provider = createOpenAI({
      baseURL: 'https://api.meta.ai/v1',
      apiKey: 'test-only-meta-key',
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'muse-spark-1.3',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content:
                    '{"answer":"ok","evidence":{"sourceUrl":"https://courses.example.edu/biology"}}',
                },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const actualAi = await vi.importActual<typeof import('ai')>('ai');

    const result = await actualAi.generateText({
      model: provider.chat('muse-spark-1.3'),
      instructions: 'Server-owned extraction instruction.',
      messages: [{ role: 'user', content: 'Untrusted assignment page text.' }],
      output: actualAi.Output.object({
        schema: z.strictObject({
          answer: z.string(),
          evidence: z.strictObject({
            sourceUrl: z.literal('https://courses.example.edu/biology'),
          }),
        }),
        name: 'browser-extraction',
      }),
      reasoning: 'low',
      maxOutputTokens: 6000,
      providerOptions: {
        openai: {
          forceReasoning: true,
          systemMessageMode: 'developer',
          store: false,
          strictJsonSchema: true,
        },
      },
      maxRetries: 0,
      telemetry: { isEnabled: false },
    });

    expect(result.output).toEqual({
      answer: 'ok',
      evidence: { sourceUrl: 'https://courses.example.edu/biology' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(requests[0]?.body).toMatchObject({
      model: 'muse-spark-1.3',
      max_completion_tokens: 6000,
      reasoning_effort: 'low',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'browser-extraction', strict: true },
      },
      messages: [
        { role: 'developer', content: 'Server-owned extraction instruction.' },
        { role: 'user', content: 'Untrusted assignment page text.' },
      ],
    });
    expect(JSON.stringify(requests[0]?.body.response_format)).toContain(
      'https://courses.example.edu/biology',
    );
    expect(requests[0]?.body).not.toHaveProperty('temperature');
    expect(requests[0]?.body).toHaveProperty('store', false);
    expect(JSON.stringify(requests[0]?.body)).not.toContain(
      'test-only-meta-key',
    );
  });

  it('preserves cancellation and never retries provider requests', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      generateBrowserModel(request(), controller.signal),
    ).rejects.toThrow();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
