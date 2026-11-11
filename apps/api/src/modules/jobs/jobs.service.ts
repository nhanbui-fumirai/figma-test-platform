/**
 * Jobs of the api side: create the Job row, send it to its pg-boss queue (apps/worker runs it), read progress and logs,
 * ask to cancel. Any feature that starts long work goes through start().
 */
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Job as JobDto, JobLogLine } from "@figtest/contracts";
import { parsePayload, type QueueName, type QueuePayload } from "@figtest/core";
import { Job, type JobLog, type JobStore } from "@figtest/db";
import PgBoss from "pg-boss";
import type { DataSource } from "typeorm";
import { BOSS, DATA_SOURCE, JOB_STORE } from "../../infra/tokens";

export const toJobDto = (j: Job): JobDto => ({
  id: j.id, projectId: j.projectId, kind: j.kind, status: j.status, total: j.total, done: j.done, error: j.error,
  createdAt: j.createdAt.toISOString(), startedAt: j.startedAt?.toISOString() ?? null, endedAt: j.endedAt?.toISOString() ?? null,
});

export const toLogDto = (l: JobLog): JobLogLine => ({ id: Number(l.id), level: l.level, message: l.message, at: l.at.toISOString() });

@Injectable()
export class JobsService {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  /** Creates the job and queues it; the payload gets its jobId. */
  async start<Q extends QueueName>(queue: Q, fields: { projectId: string | null; createdBy: string | null; total?: number },
    payload: Omit<QueuePayload<Q>, "jobId">) {
    const job = await this.store.create({ kind: queue, projectId: fields.projectId, createdBy: fields.createdBy, total: fields.total ?? 0, payload: payload as Record<string, unknown> });
    await this.boss.send(queue, parsePayload(queue, { ...payload, jobId: job.id }), { singletonKey: job.id, retryLimit: 0 });
    return job;
  }

  async get(id: string) {
    const job = await this.store.find(id);
    if (!job) throw new NotFoundException(`job ${id} not found`);
    return job;
  }

  listForProject(projectId: string, take = 50) {
    return this.ds.getRepository(Job).find({ where: { projectId }, order: { createdAt: "DESC" }, take });
  }

  logsAfter(id: string, after: number) {
    return this.store.logsAfter(id, after);
  }

  async cancel(id: string) {
    await this.get(id);
    await this.store.requestCancel(id);
    return this.get(id);
  }
}
