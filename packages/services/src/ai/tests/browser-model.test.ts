import { z } from 'zod';
import { extractedCoursesSchema } from '../resources/course';
import { extractedAnnouncementsSchema } from '../resources/announcement';
import { extractedMaterialsSchema } from '../resources/material';
import { extractedAssignmentsSchema } from '../resources/assignment';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  object: vi.fn((options: unknown) => options),
  jsonSchema: vi.fn((schema: unknown, options?: unknown) => ({
    schema,
    options,
  })),
  getInferenceModel: vi.fn(() => 'server-selected-model'),
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

import { generateBrowserModel } from '../browser-model';

const request = {
  kind: 'browser-model' as const,
  messages: [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Read this page.' }],
    },
  ],
  responseFormat: {
    type: 'json_schema' as const,
    name: 'extract_page',
    schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateText.mockResolvedValue({ output: { title: 'Biology' } });
});

describe('Stagehand browser model bridge', () => {
  it('normalizes redundant intersections from Stagehand date schema conversion', async () => {
    const schema = {
      type: 'object',
      properties: {
        title: { allOf: [{ type: 'string' }, {}, {}] },
      },
      required: ['title'],
    };
    await expect(
      generateBrowserModel(
        { ...request, responseFormat: { ...request.responseFormat, schema } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ structuredContent: { title: 'Biology' } });
    const meaningful = {
      ...schema,
      properties: { title: { type: 'string', allOf: [{ pattern: '.*' }] } },
    };
    await expect(
      generateBrowserModel(
        {
          ...request,
          responseFormat: { ...request.responseFormat, schema: meaningful },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unsupported/);
  });
  it('accepts Stagehand link-reference constraints and still validates their output', async () => {
    const schema = {
      type: 'object',
      properties: { link: { type: 'string', pattern: '^\\d+-\\d+$' } },
      required: ['link'],
      additionalProperties: false,
    };
    mocks.generateText.mockResolvedValue({ output: { link: '1-23' } });
    await expect(
      generateBrowserModel(
        { ...request, responseFormat: { ...request.responseFormat, schema } },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ structuredContent: { link: '1-23' } });
    mocks.generateText.mockResolvedValue({
      output: { link: 'https://invented.example' },
    });
    await expect(
      generateBrowserModel(
        { ...request, responseFormat: { ...request.responseFormat, schema } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/schema/);
  });
  it.each([
    ['assignments', extractedAssignmentsSchema],
    ['announcements', extractedAnnouncementsSchema],
    ['courses', extractedCoursesSchema],
    ['materials', extractedMaterialsSchema],
  ] as const)(
    'accepts the real %s extraction schema used by inout mode',
    async (kind, schema) => {
      const output = { [kind]: [], coverage: 'complete' };
      mocks.generateText.mockResolvedValue({ output });
      await expect(
        generateBrowserModel(
          {
            ...request,
            responseFormat: {
              ...request.responseFormat,
              schema: z.toJSONSchema(schema),
            },
          },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ structuredContent: output });
    },
  );

  it.each([
    [z.url(), 'not-a-url'],
    [z.iso.date(), '2026-02-30'],
    [z.iso.datetime({ offset: true }), '2026-11-01T25:00:00Z'],
    [z.string().regex(/^\d{2}:\d{2}(?::\d{2})?$/), 'tomorrow'],
  ])(
    'validates supported string constraints after inference',
    async (schema, value) => {
      mocks.generateText.mockResolvedValue({ output: { value } });
      await expect(
        generateBrowserModel(
          {
            ...request,
            responseFormat: {
              ...request.responseFormat,
              schema: z.toJSONSchema(z.object({ value: schema })),
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/schema/i);
    },
  );

  it('uses the server-selected model and returns Stagehand structured output', async () => {
    await expect(
      generateBrowserModel(request, new AbortController().signal),
    ).resolves.toEqual({
      role: 'assistant',
      content: { type: 'text', text: '{"title":"Biology"}' },
      outputFormat: 'json_schema',
      structuredContent: { title: 'Biology' },
    });

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'server-selected-model',
        temperature: 0,
        maxOutputTokens: 6000,
        reasoning: 'low',
        telemetry: { isEnabled: false },
        maxRetries: 0,
      }),
    );
    expect(mocks.jsonSchema).toHaveBeenCalledOnce();
  });

  it('rejects unsupported keywords and excessive schema depth before inference', async () => {
    const nestedSchema = (depth: number): Record<string, unknown> =>
      depth === 0
        ? { type: 'string' }
        : { type: 'object', properties: { child: nestedSchema(depth - 1) } };
    const unsupportedSchemas = [
      {
        type: 'object',
        properties: { value: { type: 'string', pattern: '.*' } },
      },
      nestedSchema(8),
    ];
    for (const schema of unsupportedSchemas) {
      await expect(
        generateBrowserModel(
          { ...request, responseFormat: { ...request.responseFormat, schema } },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/schema/i);
    }
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('rejects returned content that does not match the requested schema', async () => {
    mocks.generateText.mockResolvedValue({ output: { title: 42 } });
    await expect(
      generateBrowserModel(request, new AbortController().signal),
    ).rejects.toThrow(/schema/i);
  });

  it('rejects tool and image messages instead of forwarding them', async () => {
    const toolRequest = {
      ...request,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '1', name: 'click', input: {} }],
        },
      ],
    };
    await expect(
      generateBrowserModel(toolRequest, new AbortController().signal),
    ).rejects.toThrow();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it('preserves cancellation and bounds model calls to one attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateBrowserModel(request, controller.signal),
    ).rejects.toThrow();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
