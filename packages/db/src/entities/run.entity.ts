import { Column, Entity, Index, JoinColumn, ManyToOne, UpdateDateColumn } from "typeorm";
import { BaseEntity } from "./base";
import { Project } from "./project.entity";
import { Screen } from "./design.entity";

export type RunTarget = "site" | "storybook";

/**
 * A test run: one Job (progress, logs, cancel) and one Result per screen. Each screen is its own queue job (run.screen),
 * so several workers share a run; the last screen done ends the run job.
 */
@Entity("runs")
@Index(["projectId", "createdAt"])
export class Run extends BaseEntity {
  @ManyToOne(() => Project, { onDelete: "CASCADE" })
  @JoinColumn({ name: "project_id" })
  project: Project;

  @Column("uuid", { name: "project_id" })
  projectId: string;

  @Column("uuid", { name: "job_id" })
  jobId: string;

  @Column("text", { default: "site" })
  target: RunTarget;

  @Column("int", { default: 0 })
  total: number;

  @Column("int", { default: 0 })
  done: number;

  @Column("int", { default: 0 })
  passed: number;

  @Column("int", { default: 0 })
  failed: number;

  @Column("int", { default: 0 })
  blocked: number;

  @Column("int", { default: 0 })
  errors: number;

  @Column("uuid", { name: "created_by", nullable: true })
  createdBy: string | null;

  @Column("timestamptz", { name: "ended_at", nullable: true })
  endedAt: Date | null;
}

export type ResultStatusKind = "queued" | "running" | "passed" | "failed" | "blocked" | "error" | "skipped";

/** The test of one screen in a run, against the design revision it had then. */
@Entity("results")
@Index(["runId"])
@Index(["screenId", "createdAt"])
export class Result extends BaseEntity {
  @ManyToOne(() => Run, { onDelete: "CASCADE" })
  @JoinColumn({ name: "run_id" })
  run: Run;

  @Column("uuid", { name: "run_id" })
  runId: string;

  @ManyToOne(() => Screen, { onDelete: "CASCADE" })
  @JoinColumn({ name: "screen_id" })
  screen: Screen;

  @Column("uuid", { name: "screen_id" })
  screenId: string;

  @Column("uuid", { name: "revision_id", nullable: true })
  revisionId: string | null;

  @Column("text", { default: "queued" })
  status: ResultStatusKind;

  @Column("text", { nullable: true })
  url: string | null;

  @Column("text", { name: "final_url", nullable: true })
  finalUrl: string | null;

  /** 0..1 */
  @Column("real", { nullable: true })
  coverage: number | null;

  /** 0..100 */
  @Column("real", { name: "design_score", nullable: true })
  designScore: number | null;

  @Column("jsonb", { nullable: true })
  counts: Record<string, number> | null;

  @Column("text", { nullable: true })
  error: string | null;

  @Column("jsonb", { default: [] })
  unmocked: string[];

  @Column("int", { name: "viewport_w", nullable: true })
  viewportW: number | null;

  @Column("int", { name: "viewport_h", nullable: true })
  viewportH: number | null;

  @Column("text", { name: "screenshot_key", nullable: true })
  screenshotKey: string | null;

  /** CompareReport (gzip JSON) */
  @Column("text", { name: "report_key", nullable: true })
  reportKey: string | null;

  /** DomSnapshot (gzip JSON) */
  @Column("text", { name: "dom_key", nullable: true })
  domKey: string | null;

  @Column("int", { name: "duration_ms", nullable: true })
  durationMs: number | null;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;
}

export type MockOriginKind = "recorded" | "ai" | "manual";

/**
 * A mocked API call of a screen. The recorded body stays as recorded; the served body is recordedBody + ops (AI or hand
 * edits), recomputed and checked by the guards on every change.
 */
@Entity("mock_routes")
@Index(["screenId", "method", "host", "path"])
export class MockRoute extends BaseEntity {
  @ManyToOne(() => Screen, { onDelete: "CASCADE" })
  @JoinColumn({ name: "screen_id" })
  screen: Screen;

  @Column("uuid", { name: "screen_id" })
  screenId: string;

  @Column("text")
  method: string;

  @Column("text")
  host: string;

  @Column("text")
  path: string;

  @Column("jsonb", { default: {} })
  query: Record<string, string>;

  @Column("text", { name: "operation_name", nullable: true })
  operationName: string | null;

  @Column("jsonb", { nullable: true })
  variables: unknown;

  @Column("int", { default: 200 })
  status: number;

  @Column("text", { name: "content_type", default: "application/json" })
  contentType: string;

  @Column("jsonb", { name: "recorded_body", nullable: true })
  recordedBody: unknown;

  @Column("jsonb", { default: [] })
  ops: unknown[];

  /** served body (recordedBody + ops) */
  @Column("jsonb", { nullable: true })
  body: unknown;

  @Column("jsonb", { default: [] })
  violations: string[];

  @Column("text", { default: "recorded" })
  origin: MockOriginKind;

  @Column("boolean", { default: true })
  enabled: boolean;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;
}

/** The logged-in browser state of a project test account, reused until it expires (encrypted: it holds session cookies). */
@Entity("login_sessions")
export class LoginSession extends BaseEntity {
  @Column("uuid", { name: "project_id", unique: true })
  projectId: string;

  /** hash of the credential it was made with: a changed password makes it stale */
  @Column("text", { name: "credential_hash" })
  credentialHash: string;

  @Column("text")
  ciphertext: string;

  @Column("text")
  iv: string;

  @Column("text")
  tag: string;

  @Column("int", { name: "key_version" })
  keyVersion: number;

  @Column("timestamptz", { name: "expires_at" })
  expiresAt: Date;
}

export type RepoStatus = "none" | "syncing" | "ready" | "failed";

/** The source repository of a project, cloned read-only (bare, shallow, push disabled). The token is a credential. */
@Entity("repositories")
export class Repository extends BaseEntity {
  @Column("uuid", { name: "project_id", unique: true })
  projectId: string;

  @Column("text")
  url: string;

  @Column("text")
  branch: string;

  @Column("text", { default: "none" })
  status: RepoStatus;

  @Column("text", { name: "head_sha", nullable: true })
  headSha: string | null;

  @Column("timestamptz", { name: "last_synced_at", nullable: true })
  lastSyncedAt: Date | null;

  @Column("text", { nullable: true })
  error: string | null;

  @Column("uuid", { name: "job_id", nullable: true })
  jobId: string | null;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;
}

/** One call to an AI provider: what for, tokens and cost (never the key). */
@Entity("ai_calls")
@Index(["projectId", "createdAt"])
export class AiCall extends BaseEntity {
  @Column("uuid", { name: "project_id", nullable: true })
  projectId: string | null;

  @Column("uuid", { name: "job_id", nullable: true })
  jobId: string | null;

  @Column("text")
  purpose: string;

  @Column("text")
  model: string;

  @Column("int", { name: "input_tokens", default: 0 })
  inputTokens: number;

  @Column("int", { name: "output_tokens", default: 0 })
  outputTokens: number;

  @Column("real", { name: "cost_usd", nullable: true })
  costUsd: number | null;

  @Column("boolean", { default: true })
  ok: boolean;
}
