/**
 * Settings of the api and the worker: the shell environment, else the .env at the root of the repository (next to
 * pnpm-workspace.yaml), validated once. Relative paths (STORAGE_DIR) are relative to that root.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

/** The root of the repository: the first folder up from `from` that has pnpm-workspace.yaml. */
export function repoRoot(from = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(from);
    dir = up;
  }
}

const base64Key = z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
  message: "APP_SECRET must be 32 bytes in base64: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
});

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "DATABASE_URL: postgres://user:password@host:port/db"),
  APP_SECRET: base64Key,
  ADMIN_EMAIL: z.email().optional(),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD: at least 8 characters").optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  STORAGE_DIR: z.string().default("./storage"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** tests may open localhost / private addresses (a dev site, the fixture site); keep false on a shared server */
  ALLOW_PRIVATE_HOSTS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /** jobs of each queue run at the same time by one worker process */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** biggest .fig upload, in MB */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2000).default(500),
});

export type Env = z.infer<typeof EnvSchema> & { ROOT: string; STORAGE_PATH: string };

let cached: Env | null = null;

/** The validated settings; throws once with every problem listed. */
export function loadEnv(): Env {
  if (cached) return cached;
  const root = repoRoot();
  dotenv.config({ path: path.join(root, ".env"), quiet: true });
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Invalid settings (.env at ${root}):\n${lines.join("\n")}`);
  }
  cached = { ...parsed.data, ROOT: root, STORAGE_PATH: path.resolve(root, parsed.data.STORAGE_DIR) };
  return cached;
}
