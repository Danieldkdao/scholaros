import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const nodeEnvValues = ['development', 'production', 'test'] as const;
export type NodeEnv = (typeof nodeEnvValues)[number];

export const nodeEnvSchema = z.enum(nodeEnvValues).default('development');
export type NodeEnvSchema = z.infer<typeof nodeEnvSchema>;

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
    FACEBOOK_CLIENT_ID: z.string().min(1),
    FACEBOOK_CLIENT_SECRET: z.string().min(1),
    MAILJET_API_KEY: z.string().min(1),
    MAILJET_API_SECRET: z.string().min(1),
    SENDER_EMAIL: z.email(),
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
    FACEBOOK_CLIENT_ID: process.env.FACEBOOK_CLIENT_ID,
    FACEBOOK_CLIENT_SECRET: process.env.FACEBOOK_CLIENT_SECRET,
    MAILJET_API_KEY: process.env.MAILJET_API_KEY,
    MAILJET_API_SECRET: process.env.MAILJET_API_SECRET,
    SENDER_EMAIL: process.env.SENDER_EMAIL,
  },
  emptyStringAsUndefined: true,
});
