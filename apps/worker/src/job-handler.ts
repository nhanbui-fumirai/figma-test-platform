/**
 * A handler runs the jobs of one queue. It reports through its context: log lines, progress, and it checks
 * `cancelled()` between its steps (a cancelled job stops at the next check). Throwing fails the job with the message.
 *
 * A handler with `sharedJob` runs queue jobs that share one Job row (the screens of a run): the runner does not start or
 * end the Job row, the handler does (the last screen ends it), and an error never fails the whole run.
 */
import type { QueueName, QueuePayload } from "@figtest/core";
import type { LogLevel } from "@figtest/db";

export interface JobContext {
  jobId: string;
  log(message: string, level?: LogLevel, screenId?: string | null): Promise<void>;
  progress(done: number, total?: number): Promise<void>;
  cancelled(): Promise<boolean>;
}

export interface JobHandler<Q extends QueueName = QueueName> {
  readonly queue: Q;
  /** jobs of this queue one worker runs at the same time (default WORKER_CONCURRENCY) */
  readonly concurrency?: number;
  readonly sharedJob?: boolean;
  run(payload: QueuePayload<Q>, ctx: JobContext): Promise<void>;
}

/** Thrown by a handler that saw cancelled(): the job ends as cancelled, not failed. */
export class JobCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export const JOB_HANDLERS = Symbol("JOB_HANDLERS");
