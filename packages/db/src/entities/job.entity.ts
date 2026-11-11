import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { BaseEntity } from "./base";
import { Project } from "./project.entity";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * Every long operation (import, render, clone, record, AI, test run) is a Job: the worker runs it from its pg-boss queue
 * and reports progress (total / done) and log lines (JobLog) here; the api streams them to the browser (SSE).
 */
@Entity("jobs")
@Index(["projectId", "createdAt"])
export class Job extends BaseEntity {
  @ManyToOne(() => Project, { onDelete: "CASCADE", nullable: true })
  @JoinColumn({ name: "project_id" })
  project: Project | null;

  @Column("uuid", { name: "project_id", nullable: true })
  projectId: string | null;

  /** the pg-boss queue it runs on (@figtest/core QUEUES) */
  @Column("text")
  kind: string;

  @Column("text", { default: "queued" })
  status: JobStatus;

  @Column("int", { default: 0 })
  total: number;

  @Column("int", { default: 0 })
  done: number;

  @Column("jsonb", { default: {} })
  payload: Record<string, unknown>;

  @Column("text", { nullable: true })
  error: string | null;

  @Column("boolean", { name: "cancel_requested", default: false })
  cancelRequested: boolean;

  @Column("uuid", { name: "created_by", nullable: true })
  createdBy: string | null;

  @Column("timestamptz", { name: "started_at", nullable: true })
  startedAt: Date | null;

  @Column("timestamptz", { name: "ended_at", nullable: true })
  endedAt: Date | null;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** A log line of a job. Its id (ever growing) is the SSE event id: a reconnecting browser resumes after it. */
@Entity("job_logs")
@Index(["jobId", "id"])
export class JobLog {
  @PrimaryGeneratedColumn("increment", { type: "bigint" })
  id: string;

  @ManyToOne(() => Job, { onDelete: "CASCADE" })
  @JoinColumn({ name: "job_id" })
  job: Job;

  @Column("uuid", { name: "job_id" })
  jobId: string;

  /** the screen it is about, for per-screen logs of a run */
  @Column("uuid", { name: "screen_id", nullable: true })
  screenId: string | null;

  @Column("text")
  level: LogLevel;

  @Column("text")
  message: string;

  @Column("timestamptz", { default: () => "now()" })
  at: Date;
}
