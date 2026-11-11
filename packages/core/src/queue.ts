/**
 * The jobs the worker runs: one queue per kind, its payload validated on both sides. A new kind = an entry here, a
 * handler in apps/worker. Every payload carries the id of its Job row: progress and logs go there (JobLog), the SSE
 * stream of the api reads them.
 */
import { z } from "zod";

const id = z.uuid();

export const QUEUES = {
  /** M0: a job that only writes log lines, to try the queue, the logs and the SSE stream */
  demo: z.object({ jobId: id, steps: z.number().int().min(1).max(100).default(10) }),
  /** parse a .fig upload or read a Figma link, update pages / sections / screens, render the changed frames */
  "figma.import": z.object({ jobId: id, importId: id }),
  /** open a screen like a test would (state, login, mocks), screenshot, auth-wall check: no compare */
  "screen.preview": z.object({ jobId: id, screenId: id }),
  /** one screen of a run; all the screens of a run share the run's Job row (the last one ends it) */
  "run.screen": z.object({ jobId: id, runId: id, resultId: id }),
  /** record the API calls of a screen as its mocks */
  "mock.record": z.object({ jobId: id, screenId: id }),
  /** AI: steps that bring the page to the state of its design */
  "ai.steps": z.object({ jobId: id, screenId: id, goal: z.string().max(2000).optional() }),
  /** AI: edits of the recorded mocks so the page shows the data of the design */
  "ai.mocks": z.object({ jobId: id, screenId: id }),
  /** clone / fetch the read-only copy of the project repository */
  "git.sync": z.object({ jobId: id, projectId: id }),
} as const;

export type QueueName = keyof typeof QUEUES;
export type QueuePayload<Q extends QueueName> = z.infer<(typeof QUEUES)[Q]>;

export const queueNames = Object.keys(QUEUES) as QueueName[];

export function parsePayload<Q extends QueueName>(queue: Q, data: unknown): QueuePayload<Q> {
  return QUEUES[queue].parse(data) as QueuePayload<Q>;
}
