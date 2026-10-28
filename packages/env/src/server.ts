import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const nodeEnvValues = ["development", "production", "test"] as const;
export type NodeEnv = (typeof nodeEnvValues)[number];

export const nodeEnvSchema = z.enum(nodeEnvValues).default("development");
export type NodeEnvSchema = z.infer<typeof nodeEnvSchema>;

export const serverEnv = createEnv({
  server: {
    NODE_ENV: nodeEnvSchema,
    DATABASE_URL: z.url().min(1),
  },
  runtimeEnvStrict: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
  },
  emptyStringAsUndefined: true,
});
