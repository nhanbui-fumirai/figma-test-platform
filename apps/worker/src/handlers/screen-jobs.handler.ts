/**
 * Jobs on one screen that prepare it, apart from a test run:
 * - screen.preview: open it like a test would, screenshot, auth-wall check (no compare)
 * - mock.record: record its API calls as its mocks (recorded ones replaced, manual ones kept)
 */
import { Inject, Injectable } from "@nestjs/common";
import { fullPageScreenshot } from "@figtest/browser";
import { blobKeys, type BlobStore, type QueuePayload } from "@figtest/core";
import { MockRoute, Project, Screen } from "@figtest/db";
import { Not, type DataSource } from "typeorm";
import type { JobContext, JobHandler } from "../job-handler";
import { ScreenStateService } from "../services/screen-state.service";
import { BLOB, DATA_SOURCE } from "../tokens";

@Injectable()
export class PreviewHandler implements JobHandler<"screen.preview"> {
  readonly queue = "screen.preview" as const;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(BLOB) private readonly blob: BlobStore,
    private readonly state: ScreenStateService,
  ) {}

  async run({ screenId }: QueuePayload<"screen.preview">, ctx: JobContext) {
    const screens = this.ds.getRepository(Screen);
    const screen = await screens.findOneByOrFail({ id: screenId });
    const project = await this.ds.getRepository(Project).findOneByOrFail({ id: screen.projectId });
    const log = (m: string, level: "debug" | "info" | "warn" | "error" = "info") => ctx.log(m, level, screenId);
    const at = new Date().toISOString();
    try {
      const opened = await this.state.open(project, screen, { mocks: "replay" }, log);
      try {
        const key = blobKeys.preview(project.id, screen.id, ctx.jobId);
        await this.blob.put(key, await fullPageScreenshot(opened.page));
        await this.setPreview(screenId, {
          jobId: ctx.jobId, status: opened.blocked ? "blocked" : "ok", finalUrl: opened.finalUrl, reason: opened.reason, screenshotKey: key, unmocked: opened.unmocked, at,
        });
        if (opened.blocked) await log(`blocked: ${opened.reason}`, "warn");
        else await log(`opened ${opened.finalUrl}${opened.unmocked.length ? ` · unmocked: ${opened.unmocked.join(", ")}` : ""}`);
      } finally {
        await opened.close();
      }
    } catch (e) {
      await this.setPreview(screenId, { jobId: ctx.jobId, status: "error", finalUrl: null, reason: (e as Error).message, screenshotKey: null, unmocked: [], at });
      throw e;
    }
  }

  /** the last preview of the screen (jsonb, read by the api) */
  private async setPreview(screenId: string, preview: Record<string, unknown>) {
    await this.ds.query("UPDATE screens SET preview = $2 WHERE id = $1", [screenId, JSON.stringify(preview)]);
  }
}

@Injectable()
export class MockRecordHandler implements JobHandler<"mock.record"> {
  readonly queue = "mock.record" as const;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    private readonly state: ScreenStateService,
  ) {}

  async run({ screenId }: QueuePayload<"mock.record">, ctx: JobContext) {
    const screen = await this.ds.getRepository(Screen).findOneByOrFail({ id: screenId });
    const project = await this.ds.getRepository(Project).findOneByOrFail({ id: screen.projectId });
    const log = (m: string, level: "debug" | "info" | "warn" | "error" = "info") => ctx.log(m, level, screenId);
    const opened = await this.state.open(project, screen, { mocks: "none", record: true }, log);
    let calls;
    try {
      calls = await opened.recorder!.stop();
      if (opened.blocked) await log(`the page is blocked (${opened.reason}): what was recorded may be the login page's`, "warn");
    } finally {
      await opened.close();
    }
    const repo = this.ds.getRepository(MockRoute);
    await this.ds.transaction(async (tx) => {
      await tx.getRepository(MockRoute).delete({ screenId, origin: Not("manual") });
      for (const c of calls) {
        await tx.getRepository(MockRoute).save(repo.create({
          screenId, method: c.method, host: c.host, path: c.path, query: c.query, operationName: c.operationName, variables: c.variables ?? null,
          status: c.status, contentType: c.contentType, recordedBody: c.body ?? null, ops: [], body: c.body ?? null, violations: [], origin: "recorded", enabled: true,
        }));
      }
    });
    for (const c of calls.slice(0, 30)) await log(`${c.method} ${c.host}${c.path}${c.operationName ? ` op=${c.operationName}` : ""} → ${c.status}`);
    await log(`${calls.length} API call(s) recorded`);
  }
}
