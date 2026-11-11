/**
 * AI prepare jobs (a test run never calls the AI):
 * - ai.steps: the steps loop. Open the page (mocks replayed, no steps), then rounds of: accessibility tree → AI → run its
 *   steps one by one; the steps that worked become the steps of the screen.
 * - ai.mocks: for each JSON mock of the screen, ops that make the recorded body show the data of the design, applied with
 *   the guards (value kinds, distinct list items); refused ops are kept as violations.
 */
import { Inject, Injectable } from "@nestjs/common";
import { mockOps, nextSteps } from "@figtest/ai";
import { ariaSnapshot, runSteps, settle } from "@figtest/browser";
import type { MockOp, Step } from "@figtest/contracts";
import type { QueuePayload } from "@figtest/core";
import { MockRoute, Project, Screen } from "@figtest/db";
import { applyOpsChecked } from "@figtest/mocks";
import type { DataSource } from "typeorm";
import { JobCancelled, type JobContext, type JobHandler } from "../job-handler";
import { BrowserService } from "../services/browser.service";
import { DesignService } from "../services/design.service";
import { ScreenStateService } from "../services/screen-state.service";
import { DATA_SOURCE } from "../tokens";

const MAX_ROUNDS = 6;
const MAX_ROUTES = 12;

@Injectable()
export class AiStepsHandler implements JobHandler<"ai.steps"> {
  readonly queue = "ai.steps" as const;
  readonly concurrency = 1;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly state: ScreenStateService,
    private readonly design: DesignService,
    private readonly browsers: BrowserService,
  ) {}

  async run({ screenId, goal }: QueuePayload<"ai.steps">, ctx: JobContext) {
    const screens = this.ds.getRepository(Screen);
    const screen = await screens.findOneByOrFail({ id: screenId });
    const project = await this.ds.getRepository(Project).findOneByOrFail({ id: screen.projectId });
    const log = (m: string, level: "debug" | "info" | "warn" | "error" = "info") => ctx.log(m, level, screenId);
    const cfg = await this.design.aiConfig(project);
    const rev = await this.design.revision(screen.currentRevisionId);
    if (!rev) throw new Error("no design for this screen: import the Figma design first");
    const spec = await this.design.spec(rev);
    const designTexts = this.design.texts(spec);
    const designImage = await this.design.imageForAi(rev);
    const onUsage = this.design.usageLogger(project.id, ctx.jobId, "steps");
    const opened = await this.state.open(project, screen, { mocks: "replay", steps: false }, log);
    const kept: Step[] = [];
    const history: { step: Step; ok: boolean; error?: string }[] = [];
    try {
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (await ctx.cancelled()) throw new JobCancelled();
        await ctx.progress(round - 1, MAX_ROUNDS);
        const out = await nextSteps(cfg, {
          goal: goal || screen.prompt || "Bring the page to the state the design shows (open menus, tabs, selections, filled fields).",
          designTexts, designImage, url: opened.page.url(), ariaSnapshot: await ariaSnapshot(opened.page), history,
        }, onUsage);
        await log(`round ${round}: ${out.steps.length} step(s)${out.done ? ", done" : ""}${out.note ? ` · ${out.note}` : ""}`);
        if (!out.steps.length) break;
        for (const step of out.steps) {
          try {
            await runSteps(opened.page, [step], { baseUrl: opened.url, policy: this.browsers.policy, log });
            kept.push(step);
            history.push({ step, ok: true });
          } catch (e) {
            history.push({ step, ok: false, error: (e as Error).message });
            await log(`step failed: ${(e as Error).message}`, "warn");
            break;
          }
        }
        await settle(opened.page);
        if (out.done) break;
      }
    } finally {
      await opened.close();
    }
    await screens.update({ id: screenId }, { steps: kept });
    await ctx.progress(MAX_ROUNDS, MAX_ROUNDS);
    await log(`${kept.length} step(s) saved to the screen`);
  }
}

@Injectable()
export class AiMocksHandler implements JobHandler<"ai.mocks"> {
  readonly queue = "ai.mocks" as const;
  readonly concurrency = 1;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly design: DesignService,
  ) {}

  async run({ screenId }: QueuePayload<"ai.mocks">, ctx: JobContext) {
    const screen = await this.ds.getRepository(Screen).findOneByOrFail({ id: screenId });
    const project = await this.ds.getRepository(Project).findOneByOrFail({ id: screen.projectId });
    const log = (m: string, level: "debug" | "info" | "warn" | "error" = "info") => ctx.log(m, level, screenId);
    const cfg = await this.design.aiConfig(project);
    const rev = await this.design.revision(screen.currentRevisionId);
    if (!rev) throw new Error("no design for this screen: import the Figma design first");
    const spec = await this.design.spec(rev);
    const designTexts = this.design.texts(spec);
    const designImage = await this.design.imageForAi(rev);
    const onUsage = this.design.usageLogger(project.id, ctx.jobId, "mocks");
    const repo = this.ds.getRepository(MockRoute);
    const routes = (await repo.findBy({ screenId, enabled: true }))
      .filter((r) => /json/i.test(r.contentType) && r.recordedBody !== null && typeof r.recordedBody === "object")
      .slice(0, MAX_ROUTES);
    if (!routes.length) throw new Error("no JSON mock to edit: record the mocks of the screen first");
    await ctx.progress(0, routes.length);
    for (const [i, r] of routes.entries()) {
      if (await ctx.cancelled()) throw new JobCancelled();
      const label = `${r.method} ${r.path}${r.operationName ? ` op=${r.operationName}` : ""}`;
      try {
        const out = await mockOps(cfg, { route: { method: r.method, path: r.path, operationName: r.operationName }, body: r.recordedBody, designTexts, designImage }, onUsage);
        const checked = applyOpsChecked(r.recordedBody, out.ops as MockOp[]);
        await repo.update({ id: r.id }, { ops: out.ops, body: checked.body as object, violations: checked.violations, origin: "ai" });
        await log(`${label}: ${out.ops.length} edit(s)${checked.violations.length ? `, ${checked.violations.length} refused by the guards` : ""}${out.note ? ` · ${out.note}` : ""}`);
      } catch (e) {
        await log(`${label}: ${(e as Error).message}`, "warn");
      }
      await ctx.progress(i + 1, routes.length);
    }
  }
}
