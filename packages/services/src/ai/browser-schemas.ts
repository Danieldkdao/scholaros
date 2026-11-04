import { z } from 'zod';
import { browserNavigationModeSchema } from '@scholaros/env/browser-navigation';
import { configurationRevisionSchema } from './schemas';

const textPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().max(100_000),
    annotations: z
      .object({
        audience: z
          .array(z.enum(['user', 'assistant']))
          .max(2)
          .optional(),
        priority: z.number().finite().optional(),
        lastModified: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const browserModelRequestSchema = z
  .object({
    kind: z.literal('browser-model'),
    browserNavigationMode: browserNavigationModeSchema.optional(),
    configurationRevision: configurationRevisionSchema.optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.union([
              z.string().max(100_000),
              z.array(textPartSchema).max(32),
              textPartSchema.transform((part) => [part]),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    systemPrompt: z.string().max(10_000).optional(),
    temperature: z.number().finite().min(0).max(1).optional(),
    stopSequences: z.array(z.string().max(200)).max(8).optional(),
    responseFormat: z
      .object({
        type: z.literal('json_schema'),
        name: z.string().min(1).max(100),
        description: z.string().max(1000).optional(),
        schema: z.json(),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const messageSize = request.messages.reduce((size, message) => {
      const content = message.content;
      return (
        size +
        (typeof content === 'string'
          ? content.length
          : content.reduce((partSize, part) => partSize + part.text.length, 0))
      );
    }, 0);
    if (messageSize > 100_000)
      context.addIssue({
        code: 'custom',
        message: 'Browser model messages exceed the request limit.',
      });
  });
export type BrowserModelRequestSchema = z.infer<
  typeof browserModelRequestSchema
>;

export const browserModelResponseSchema = z
  .object({
    role: z.literal('assistant'),
    content: z
      .object({ type: z.literal('text'), text: z.string().max(80_000) })
      .strict(),
    outputFormat: z.literal('json_schema'),
    structuredContent: z.json(),
  })
  .strict();
export type BrowserModelResponseSchema = z.infer<
  typeof browserModelResponseSchema
>;
