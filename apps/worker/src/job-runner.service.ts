/**
 * Subscribes every handler to its queue (WORKER_CONCURRENCY jobs at a time per queue) and runs each job inside the
 * Job row lifecycle: running → succeeded | failed | cancelled, errors logged and kept on the job.
 */
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { parsePayload, type Env, type Logger, type QueueName } from "@figtest/core";
import type { JobStore } from "@figtest/db";
import PgBoss from "pg-boss";
import { BOSS, ENV, JOB_STORE, LOGGER } from "./tokens";
import { JOB_HANDLERS, JobCancelled, type JobContext, type JobHandler } from "./job-handler";


@Injectable()
export class JobRunnerService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(JOB_HANDLERS) private readonly handlers: JobHandler[],
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap() {
    for (const handler of this.handlers) {
      await this.boss.createQueue(handler.queue);
      const concurrency = handler.concurrency ?? this.env.WORKER_CONCURRENCY;
      for (let i = 0; i < concurrency; i++) {
        await this.boss.work(handler.queue, { batchSize: 1, pollingIntervalSeconds: 1 }, async ([job]) => {
          if (job) await this.execute(handler, job.data);
        });
      }
      this.log.info(`worker: ${handler.queue} (${concurrency} at a time)`);
    }
  }

  async onApplicationShutdown() {
    await this.boss.stop({ graceful: true, wait: true, timeout: 10_000 }).catch(() => {});
  }

  private async execute(handler: JobHandler, data: unknown) {
    const payload = parsePayload(handler.queue as QueueName, data);
    const jobId = payload.jobId;
    const job = await this.store.find(jobId);
    const ctx: JobContext = {
      jobId,
      log: (message, level = "info", screenId = null) => this.store.log(jobId, level, message, screenId),
      progress: (done, total) => this.store.progress(jobId, done, total),
      cancelled: () => this.store.isCancelRequested(jobId),
    };
    if (handler.sharedJob) {
      // the handler owns the lifecycle of the shared Job row (and records its own errors)
      if (!job) return;
      await handler.run(payload as never, ctx).catch((e) => this.log.error({ err: e, jobId, queue: handler.queue }, "shared job part failed"));
      return;
    }
    if (!job || job.status !== "queued") return; // cancelled while queued, or already run
    await this.store.start(jobId);
    try {
      await handler.run(payload as never, ctx);
      await this.store.finish(jobId, "succeeded");
    } catch (e) {
      if (e instanceof JobCancelled) {
        await ctx.log("cancelled", "warn");
        await this.store.finish(jobId, "cancelled");
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      this.log.error({ err: e, jobId, queue: handler.queue }, "job failed");
      await ctx.log(message, "error").catch(() => {});
      await this.store.finish(jobId, "failed", message);
    }
  }
}
