import { serverEnv } from "@scholaros/env/server";
import { defineConfig } from "drizzle-kit";

const url = serverEnv.DATABASE_URL_UNPOOLED ?? serverEnv.DATABASE_URL;

if (new URL(url).hostname.includes("-pooler.")) {
  throw new Error(
    "Set DATABASE_URL_UNPOOLED to the direct connection URL for migrations.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dbCredentials: { url },
});
