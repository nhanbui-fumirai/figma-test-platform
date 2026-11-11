/**
 * Progress and logs of a job, written by whoever runs it (the worker) and read by the api (REST + SSE). Log messages
 * are redacted: a registered secret never reaches the table, hence never the browser.
 */
import { redact } from "@figtest/core";
import type { DataSource } from "typeorm";
import { MoreThan } from "typeorm";
import { Job, JobLog, type JobStatus, type LogLevel } from "./entities/job.entity";

export class JobStore {
  constructor(private readonly ds: DataSource) {}

  private get jobs() {
    return this.ds.getRepository(Job);
  }

  private get logs() {
    return this.ds.getRepository(JobLog);
  }

  find(id: string) {
    return this.jobs.findOneBy({ id });
  }

  async create(fields: Pick<Job, "kind"> & Partial<Pick<Job, "projectId" | "payload" | "total" | "createdBy">>) {
    return this.jobs.save(this.jobs.create({ status: "queued", total: 0, done: 0, payload: {}, ...fields }));
  }

  async log(jobId: string, level: LogLevel, message: string, screenId: string | null = null) {
    await this.logs.insert({ jobId, level, message: redact(message), screenId });
  }

  async start(jobId: string, total?: number) {
    await this.jobs.update({ id: jobId }, { status: "running", startedAt: new Date(), ...(total !== undefined ? { total } : {}) });
  }

  async progress(jobId: string, done: number, total?: number) {
    await this.jobs.update({ id: jobId }, { done, ...(total !== undefined ? { total } : {}) });
  }

  async finish(jobId: string, status: Exclude<JobStatus, "queued" | "running">, error: string | null = null) {
    await this.jobs.update({ id: jobId }, { status, endedAt: new Date(), error: error ? redact(error) : null });
  }

  /** true when someone asked to stop it: the handler checks between its steps */
  async isCancelRequested(jobId: string) {
    return (await this.jobs.findOne({ where: { id: jobId }, select: { cancelRequested: true } }))?.cancelRequested ?? false;
  }

  async requestCancel(jobId: string) {
    await this.jobs.update({ id: jobId }, { cancelRequested: true });
    // a job still waiting in the queue stops right away
    await this.jobs.update({ id: jobId, status: "queued" }, { status: "cancelled", endedAt: new Date() });
  }

  /** log lines after `afterId` (SSE resume), oldest first */
  logsAfter(jobId: string, afterId = 0, limit = 500) {
    return this.logs.find({ where: { jobId, id: MoreThan(String(afterId)) }, order: { id: "ASC" }, take: limit });
  }
}
