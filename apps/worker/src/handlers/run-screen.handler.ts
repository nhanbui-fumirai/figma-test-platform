/**
 * run.screen: tests one screen of a run. Opens the page in the state of its design (cookies, login, mocks, steps), then
 * blocked (auth wall: no score) or collects the DOM and compares it with the spec of the revision the result was queued
 * with. Every screen of a run shares the run's Job row: the first one marks it running, the last one ends it.
 */
import { Inject, Injectable } from "@nestjs/common";
import { fullPageScreenshot } from "@figtest/browser";
import { collectDom, compareDesign, reportStatus } from "@figtest/compare";
import { blobKeys, gzipJson, type BlobStore, type QueuePayload } from "@figtest/core";
import { Job, Project, Result, Run, Screen, type JobStore } from "@figtest/db";
import type { DataSource } from "typeorm";
import type { JobContext, JobHandler } from "../job-handler";
import { DesignService } from "../services/design.service";
import { ScreenStateService } from "../services/screen-state.service";
import { BLOB, DATA_SOURCE, JOB_STORE } from "../tokens";

type Outcome = "passed" | "failed" | "blocked" | "error" | "skipped";

@Injectable()
export class RunScreenHandler implements JobHandler<"run.screen"> {
  readonly queue = "run.screen" as const;
  readonly sharedJob = true;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(BLOB) private readonly blob: BlobStore,
    @Inject(JOB_STORE) private readonly store: JobStore,
    private readonly state: ScreenStateService,
    private readonly design: DesignService,
  ) {}

  async run({ runId, resultId, jobId }: QueuePayload<"run.screen">, ctx: JobContext) {
    const results = this.ds.getRepository(Result);
    const result = await results.findOneBy({ id: resultId });
    if (!result || result.status !== "queued") return; // already done (redelivered)
    const screenLog = (m: string, level: "debug" | "info" | "warn" | "error" = "info") => ctx.log(m, level, result.screenId);

    if (await ctx.cancelled()) {
      await results.update({ id: resultId }, { status: "skipped" });
      return this.finishOne(runId, jobId, "skipped");
    }
    await this.ds.getRepository(Job).update({ id: jobId, status: "queued" }, { status: "running", startedAt: new Date() });
    await results.update({ id: resultId }, { status: "running" });
    const started = Date.now();
    let outcome: Outcome = "error";
    try {
      const run = await this.ds.getRepository(Run).findOneByOrFail({ id: runId });
      const project = await this.ds.getRepository(Project).findOneByOrFail({ id: run.projectId });
      const screen = await this.ds.getRepository(Screen).findOneByOrFail({ id: result.screenId });
      const rev = await this.design.revision(result.revisionId ?? screen.currentRevisionId);
      if (!rev) throw new Error("no design for this screen: import the Figma design first");
      const spec = await this.design.spec(rev);
      await screenLog(`${screen.name}: start`);
      const opened = await this.state.open(project, screen, { mocks: "replay", url: result.url ?? undefined }, screenLog);
      const keys = blobKeys.result(project.id, runId, resultId);
      try {
        await this.blob.put(keys.screenshot, await fullPageScreenshot(opened.page));
        const base = {
          finalUrl: opened.finalUrl, unmocked: opened.unmocked, screenshotKey: keys.screenshot, viewportW: screen.viewportW, viewportH: screen.viewportH,
        };
        if (opened.blocked) {
          outcome = "blocked";
          await results.update({ id: resultId }, { ...base, status: "blocked", error: opened.reason, durationMs: Date.now() - started });
          await screenLog(`${screen.name}: blocked (${opened.reason})`, "warn");
        } else {
          const dom = await collectDom(opened.page);
          const report = compareDesign(spec, dom, { url: opened.finalUrl });
          outcome = reportStatus(report);
          const s = report.summary;
          await this.blob.put(keys.report, await gzipJson(report));
          await this.blob.put(keys.dom, await gzipJson(dom));
          await results.update({ id: resultId }, {
            ...base, status: outcome, coverage: s.coverage, designScore: s.designScore, reportKey: keys.report, domKey: keys.dom,
            counts: { texts: s.texts, matched: s.matched, missing: s.missing, checks: s.checks, failed: s.failed }, durationMs: Date.now() - started,
          });
          await screenLog(`${screen.name}: ${outcome} · coverage ${Math.round(s.coverage * 100)}% · design ${Math.round(s.designScore)}%${opened.unmocked.length ? ` · ${opened.unmocked.length} unmocked call(s)` : ""}`, outcome === "passed" ? "info" : "warn");
        }
      } finally {
        await opened.close();
      }
    } catch (e) {
      outcome = "error";
      const message = (e as Error).message ?? String(e);
      await results.update({ id: resultId }, { status: "error", error: message.slice(0, 2000), durationMs: Date.now() - started });
      await screenLog(`error: ${message}`, "error");
    }
    await this.finishOne(runId, jobId, outcome);
  }

  /** counts one screen done; the last one ends the run job */
  private async finishOne(runId: string, jobId: string, outcome: Outcome) {
    const col = { passed: "passed", failed: "failed", blocked: "blocked", error: "errors", skipped: null }[outcome];
    type Counts = { done: number; total: number; passed: number; failed: number; blocked: number; errors: number };
    const res: unknown = await this.ds.query(
      `UPDATE runs SET done = done + 1${col ? `, ${col} = ${col} + 1` : ""} WHERE id = $1 RETURNING done, total, passed, failed, blocked, errors`, [runId],
    );
    // the postgres driver answers [rows, affected] for an UPDATE ... RETURNING
    const rows = (Array.isArray(res) && Array.isArray(res[0]) ? res[0] : res) as Counts[];
    const r = rows[0];
    if (!r) return;
    await this.store.progress(jobId, r.done, r.total);
    if (r.done >= r.total) {
      await this.ds.getRepository(Run).update({ id: runId }, { endedAt: new Date() });
      const cancelled = await this.store.isCancelRequested(jobId);
      await this.store.log(jobId, "info", `run done: ${r.passed} passed, ${r.failed} failed, ${r.blocked} blocked, ${r.errors} error(s)`);
      await this.store.finish(jobId, cancelled ? "cancelled" : "succeeded");
    }
  }
}
