/**
 * Shapes of the feature APIs: credentials, Figma imports, screens, runs and results, mocks, repository.
 * Image fields are URLs of GET /api/files/<key> (session cookie), null when there is none yet.
 */
import { z } from "zod";
import { Cookies, MockOps, Steps, TestLogin } from "./domain";
import { JobStatus, iso } from "./schemas";

const uuid = z.uuid();
const httpUrl = z.url({ protocol: /^https?$/, message: "an http(s) URL" });

// ---------------------------------------------------------------- credentials (never returned, only a hint)
export const CredentialKind = z.enum(["figma_token", "github_token", "test_login", "ai_key"]);
export type CredentialKind = z.infer<typeof CredentialKind>;

export const CredentialInfo = z.object({
  kind: CredentialKind,
  /** last characters of a token, the user name of a login */
  hint: z.string(),
  /** non-secret fields: loginUrl of a test login */
  meta: z.record(z.string(), z.unknown()),
  updatedAt: iso,
});
export type CredentialInfo = z.infer<typeof CredentialInfo>;

export const CredentialPut = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("figma_token"), value: z.string().trim().min(10).max(500) }),
  z.object({ kind: z.literal("github_token"), value: z.string().trim().min(10).max(500) }),
  z.object({ kind: z.literal("ai_key"), value: z.string().trim().min(10).max(500) }),
  z.object({ kind: z.literal("test_login"), value: TestLogin }),
]);
export type CredentialPut = z.infer<typeof CredentialPut>;

// ---------------------------------------------------------------- Figma imports
export const ImportStats = z.object({
  pages: z.number().int(),
  sections: z.number().int(),
  frames: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  removed: z.number().int(),
  rendered: z.number().int(),
  renderFailed: z.number().int(),
});
export type ImportStats = z.infer<typeof ImportStats>;

export const FigmaImport = z.object({
  id: uuid,
  source: z.enum(["fig", "rest"]),
  fileName: z.string(),
  fileKey: z.string().nullable(),
  jobId: uuid.nullable(),
  status: JobStatus,
  stats: ImportStats.nullable(),
  createdAt: iso,
});
export type FigmaImport = z.infer<typeof FigmaImport>;

/** a Figma file or frame link: https://www.figma.com/design/<key>/<name>?node-id=1-2 */
export const ImportLinkRequest = z.object({ url: z.url().regex(/figma\.com\/(file|design|proto)\//, "a figma.com file link") });
export type ImportLinkRequest = z.infer<typeof ImportLinkRequest>;

// ---------------------------------------------------------------- pages / sections and screens
export const ScreenGroup = z.object({
  id: uuid,
  parentId: uuid.nullable(),
  kind: z.enum(["page", "section"]),
  name: z.string(),
  position: z.number().int(),
  hidden: z.boolean(),
  /** screens directly in it (not hidden, not missing) */
  screens: z.number().int(),
});
export type ScreenGroup = z.infer<typeof ScreenGroup>;

export const GroupUpdate = z.object({ hidden: z.boolean() });
export type GroupUpdate = z.infer<typeof GroupUpdate>;

export const ResultStatus = z.enum(["queued", "running", "passed", "failed", "blocked", "error", "skipped"]);
export type ResultStatus = z.infer<typeof ResultStatus>;

export const ScreenTarget = z.enum(["site", "storybook"]);
export type ScreenTarget = z.infer<typeof ScreenTarget>;

export const Screen = z.object({
  id: uuid,
  groupId: uuid.nullable(),
  /** names of the page and sections it is in, outermost first */
  groupPath: z.array(z.string()),
  figmaNodeId: z.string(),
  name: z.string(),
  position: z.number().int(),
  /** frame box */
  width: z.number(),
  height: z.number(),
  /** height of its design (a scrolling frame goes down to the bottom of its content) */
  designHeight: z.number(),
  /** browser viewport of the test */
  viewport: z.object({ w: z.number().int(), h: z.number().int() }),
  scrolls: z.boolean(),
  /** a draft frame (name like "draft", "old", "copy", or out of the sections) */
  draft: z.boolean(),
  /** Figma node id of the frame it duplicates (same name and same content) */
  duplicateOf: z.string().nullable(),
  hidden: z.boolean(),
  /** gone from the design at the last import (kept for its reports) */
  missing: z.boolean(),
  url: z.string().nullable(),
  cookies: Cookies,
  requiresLogin: z.boolean(),
  steps: Steps,
  prompt: z.string().nullable(),
  target: ScreenTarget,
  storyId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  mocks: z.number().int(),
  lastResult: z
    .object({ id: uuid, runId: uuid, status: ResultStatus, coverage: z.number().nullable(), designScore: z.number().nullable(), at: iso })
    .nullable(),
  updatedAt: iso,
});
export type Screen = z.infer<typeof Screen>;

const yesNo = z.enum(["yes", "no"]);
export const ScreenListQuery = z.object({
  /** in the name or the URL */
  q: z.string().trim().max(200).optional(),
  groupId: uuid.optional(),
  hasUrl: yesNo.optional(),
  /** default: hidden screens (and the ones of hidden groups) left out */
  hidden: z.enum(["no", "yes", "all"]).default("no"),
  /** default: drafts and duplicates left out */
  drafts: z.enum(["hide", "show"]).default("hide"),
  status: z.enum(["passed", "failed", "blocked", "error", "none"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(48),
});
export type ScreenListQuery = z.input<typeof ScreenListQuery>;

export const ScreenPage = z.object({ items: z.array(Screen), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });
export type ScreenPage = z.infer<typeof ScreenPage>;

export const ScreenUpdate = z.object({
  /** absolute, or a path relative to the project website */
  url: z.string().trim().max(2000).nullable().optional(),
  cookies: Cookies.optional(),
  requiresLogin: z.boolean().optional(),
  steps: Steps.optional(),
  prompt: z.string().max(4000).nullable().optional(),
  hidden: z.boolean().optional(),
  target: ScreenTarget.optional(),
  storyId: z.string().trim().max(300).nullable().optional(),
});
export type ScreenUpdate = z.infer<typeof ScreenUpdate>;

/** The page of a screen opened like a test would, without comparing: does the state look right, is it blocked? */
export const Preview = z.object({
  jobId: uuid,
  status: z.enum(["ok", "blocked", "error"]),
  finalUrl: z.string().nullable(),
  reason: z.string().nullable(),
  screenshotUrl: z.string().nullable(),
  unmocked: z.array(z.string()),
  at: iso,
});
export type Preview = z.infer<typeof Preview>;

// ---------------------------------------------------------------- runs and results
export const RunCreate = z.object({
  /** default: the visible screens with a URL (or a story when target = storybook) */
  screenIds: z.array(uuid).max(2000).optional(),
  target: ScreenTarget.default("site"),
});
export type RunCreate = z.input<typeof RunCreate>;

export const Run = z.object({
  id: uuid,
  jobId: uuid,
  target: ScreenTarget,
  status: JobStatus,
  total: z.number().int(),
  done: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  blocked: z.number().int(),
  errors: z.number().int(),
  createdAt: iso,
  endedAt: iso.nullable(),
});
export type Run = z.infer<typeof Run>;

export const Counts = z.object({
  texts: z.number().int(),
  matched: z.number().int(),
  missing: z.number().int(),
  checks: z.number().int(),
  failed: z.number().int(),
});

export const Result = z.object({
  id: uuid,
  runId: uuid,
  screenId: uuid,
  screenName: z.string(),
  groupPath: z.array(z.string()),
  url: z.string().nullable(),
  finalUrl: z.string().nullable(),
  status: ResultStatus,
  coverage: z.number().nullable(),
  designScore: z.number().nullable(),
  counts: Counts.nullable(),
  error: z.string().nullable(),
  unmocked: z.number().int(),
  durationMs: z.number().int().nullable(),
  figmaUrl: z.string().nullable(),
  screenshotUrl: z.string().nullable(),
  createdAt: iso,
});
export type Result = z.infer<typeof Result>;

export const RunDetail = Run.extend({ results: z.array(Result) });
export type RunDetail = z.infer<typeof RunDetail>;

/** GET /api/results/:id/report: the result, its report (CompareReport of ./report, served as is) and the unmocked calls */
export const ResultReport = z.object({
  result: Result,
  report: z.unknown().nullable(),
  unmocked: z.array(z.string()),
  viewport: z.object({ w: z.number().int(), h: z.number().int() }).nullable(),
});
export type ResultReport = z.infer<typeof ResultReport>;

// ---------------------------------------------------------------- mocks
export const MockOrigin = z.enum(["recorded", "ai", "manual"]);

export const MockRouteSummary = z.object({
  id: uuid,
  screenId: uuid,
  method: z.string(),
  host: z.string(),
  path: z.string(),
  query: z.record(z.string(), z.string()),
  operationName: z.string().nullable(),
  status: z.number().int(),
  contentType: z.string(),
  origin: MockOrigin,
  enabled: z.boolean(),
  ops: z.number().int(),
  updatedAt: iso,
});
export type MockRouteSummary = z.infer<typeof MockRouteSummary>;

export const MockRoute = MockRouteSummary.extend({
  variables: z.unknown(),
  recordedBody: z.unknown(),
  opsList: MockOps,
  /** recordedBody + ops: what the page gets */
  body: z.unknown(),
  /** ops refused by the guards (value kinds, distinct list items), with the reason */
  violations: z.array(z.string()),
});
export type MockRoute = z.infer<typeof MockRoute>;

export const MockRouteUpdate = z.object({
  enabled: z.boolean().optional(),
  status: z.number().int().min(100).max(599).optional(),
  /** a hand edit of the whole body is one op: { op: "set", path: "", value } */
  ops: MockOps.optional(),
});
export type MockRouteUpdate = z.infer<typeof MockRouteUpdate>;

export const MockRouteCreate = z.object({
  method: z.string().trim().toUpperCase().regex(/^[A-Z]{3,7}$/),
  url: httpUrl,
  status: z.number().int().min(100).max(599).default(200),
  contentType: z.string().max(200).default("application/json"),
  body: z.unknown(),
});
export type MockRouteCreate = z.input<typeof MockRouteCreate>;

// ---------------------------------------------------------------- AI
export const AiStepsRequest = z.object({ goal: z.string().trim().max(2000).optional() });
export type AiStepsRequest = z.infer<typeof AiStepsRequest>;

export const AiUsage = z.object({
  calls: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number().nullable(),
});
export type AiUsage = z.infer<typeof AiUsage>;

// ---------------------------------------------------------------- repository (read-only clone)
export const Repository = z.object({
  url: z.string(),
  branch: z.string(),
  status: z.enum(["none", "syncing", "ready", "failed"]),
  headSha: z.string().nullable(),
  lastSyncedAt: iso.nullable(),
  error: z.string().nullable(),
  jobId: uuid.nullable(),
  hasToken: z.boolean(),
});
export type Repository = z.infer<typeof Repository>;

export const RepositoryPut = z.object({
  url: z.url({ protocol: /^https$/, message: "an https URL of the repository" }),
  branch: z.string().trim().min(1).max(250).regex(/^[\w./-]+$/, "a branch name").refine((b) => !b.startsWith("-") && !b.includes(".."), "a branch name"),
});
export type RepositoryPut = z.infer<typeof RepositoryPut>;

export const RepoEntry = z.object({ path: z.string(), name: z.string(), type: z.enum(["dir", "file"]), size: z.number().int().nullable() });
export type RepoEntry = z.infer<typeof RepoEntry>;

export const RepoFile = z.object({
  path: z.string(),
  size: z.number().int(),
  binary: z.boolean(),
  truncated: z.boolean(),
  content: z.string(),
});
export type RepoFile = z.infer<typeof RepoFile>;
