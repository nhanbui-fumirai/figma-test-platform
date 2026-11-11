/**
 * Shapes of the API, one place for both sides: the api validates its input with them, the web parses the answers.
 * Dates travel as ISO strings.
 */
import { z } from "zod";
import { AiSettings } from "./domain";

export const iso = z.string();
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, "slug: a-z, 0-9 and -, 2 to 49 characters");

// ---- auth
export const LoginRequest = z.object({ email: z.email(), password: z.string().min(1) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Me = z.object({ id: z.uuid(), email: z.email(), role: z.enum(["admin", "member"]) });
export type Me = z.infer<typeof Me>;

// ---- projects
export const ProjectCreate = z.object({
  name: z.string().trim().min(1).max(100),
  slug,
  baseUrl: z.url({ protocol: /^https?$/, message: "baseUrl: the http(s) URL of the website" }),
});
export type ProjectCreate = z.infer<typeof ProjectCreate>;

/** Settings of a project, kept as jsonb: new fields get their default when read. */
export const ProjectSettings = z.object({
  /** URL globs of the API calls to record and mock ("**\/api/**", "**\/graphql"); empty: fetch/XHR of the site host */
  apiInclude: z.array(z.string().min(1).max(500)).max(50).default([]),
  /** screens of a run tested at the same time */
  runConcurrency: z.number().int().min(1).max(8).default(2),
  /** AI provider and model (the key is the ai_key credential) */
  ai: AiSettings.nullable().default(null),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const Project = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  baseUrl: z.string(),
  storybookUrl: z.string().nullable(),
  settings: ProjectSettings,
  createdAt: iso,
  updatedAt: iso,
});
export type Project = z.infer<typeof Project>;

export const ProjectUpdate = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  storybookUrl: z.url({ protocol: /^https?$/ }).nullable().optional(),
  /** only the fields given change */
  settings: z.object({
    apiInclude: z.array(z.string().min(1).max(500)).max(50),
    runConcurrency: z.number().int().min(1).max(8),
    ai: AiSettings.nullable(),
  }).partial().optional(),
});
export type ProjectUpdate = z.infer<typeof ProjectUpdate>;

// ---- jobs: every long operation (import, render, clone, record, AI, run) is a Job with log lines
export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  kind: z.string(),
  status: JobStatus,
  total: z.number().int(),
  done: z.number().int(),
  error: z.string().nullable(),
  createdAt: iso,
  startedAt: iso.nullable(),
  endedAt: iso.nullable(),
});
export type Job = z.infer<typeof Job>;

export const JobLogLine = z.object({
  id: z.number().int(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  at: iso,
});
export type JobLogLine = z.infer<typeof JobLogLine>;

/**
 * Server-sent events of GET /api/jobs/:id/events. `log` events carry the JobLog id as the SSE id: a reconnecting
 * EventSource sends it back (Last-Event-ID) and gets only the lines after it.
 */
export const JobEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), line: JobLogLine }),
  z.object({ type: z.literal("job"), job: Job }),
]);
export type JobEvent = z.infer<typeof JobEvent>;

export const DemoJobRequest = z.object({ steps: z.number().int().min(1).max(100).default(10) });
export type DemoJobRequest = z.infer<typeof DemoJobRequest>;

// ---- errors
export const ApiErrorBody = z.object({ statusCode: z.number(), message: z.string(), details: z.unknown().optional() });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;
