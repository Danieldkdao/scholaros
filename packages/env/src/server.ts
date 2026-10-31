import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const nodeEnvValues = ['development', 'production', 'test'] as const;
export type NodeEnv = (typeof nodeEnvValues)[number];

export const nodeEnvSchema = z.enum(nodeEnvValues).default('development');
export type NodeEnvSchema = z.infer<typeof nodeEnvSchema>;

export const inferenceProviderValues = ['meta', 'baseten'] as const;
export type InferenceProvider = (typeof inferenceProviderValues)[number];
export const inferenceProviderSchema = z
  .enum(inferenceProviderValues)
  .default('baseten');
export type InferenceProviderSchema = z.infer<typeof inferenceProviderSchema>;

export const serverEnv = createEnv({
  server: {
    NODE_ENV: nodeEnvSchema,
    DATABASE_URL: z.url().min(1),
    DATABASE_URL_UNPOOLED: z.url().optional(),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    MAILJET_API_KEY: z.string().min(1),
    MAILJET_API_SECRET: z.string().min(1),
    SENDER_EMAIL: z.email(),
    TYPESAFE_API_KEY: z.string().min(1).optional(),
    BASETEN_API_KEY: z.string().min(1).optional(),
    META_API_KEY: z.string().min(1).optional(),
    INFERENCE_PROVIDER: inferenceProviderSchema,
    BASETEN_MODEL: z
      .string()
      .min(1)
      .default('meta-models/muse-spark-open-1026'),
    META_MODEL: z.string().min(1).default('muse-spark-1.3-contributor'),
  },
  runtimeEnvStrict: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    MAILJET_API_KEY: process.env.MAILJET_API_KEY,
    MAILJET_API_SECRET: process.env.MAILJET_API_SECRET,
    SENDER_EMAIL: process.env.SENDER_EMAIL,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    BASETEN_API_KEY: process.env.BASETEN_API_KEY,
    META_API_KEY: process.env.META_API_KEY,
    META_MODEL: process.env.META_MODEL,
    BASETEN_MODEL: process.env.BASETEN_MODEL,
    INFERENCE_PROVIDER: process.env.INFERENCE_PROVIDER,
  },
  emptyStringAsUndefined: true,
});
