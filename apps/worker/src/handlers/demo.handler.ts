import { Injectable } from "@nestjs/common";
import type { QueuePayload } from "@figtest/core";
import { JobCancelled, type JobContext, type JobHandler } from "../job-handler";

/** M0: writes a line per step, one step a second: tries the queue, the progress, cancel and the live logs. */
@Injectable()
export class DemoHandler implements JobHandler<"demo"> {
  readonly queue = "demo" as const;

  async run({ steps }: QueuePayload<"demo">, ctx: JobContext) {
    await ctx.log(`demo job: ${steps} step(s)`);
    for (let i = 1; i <= steps; i++) {
      if (await ctx.cancelled()) throw new JobCancelled();
      await new Promise((r) => setTimeout(r, 1000));
      await ctx.log(`step ${i}/${steps} done`);
      await ctx.progress(i, steps);
    }
    await ctx.log("demo job finished");
  }
}
