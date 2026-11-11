/**
 * Test runs: one Job row for progress / logs / cancel, one Result per screen and one run.screen queue job per screen,
 * so several workers share a run. The worker that finishes the last screen ends the run job.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Result as ResultDto, ResultReport, Run as RunDto, RunCreate, RunDetail } from "@figtest/contracts";
import { RunCreate as RunCreateSchema } from "@figtest/contracts";
import { fileUrl, gunzipJson, parsePayload, type BlobStore } from "@figtest/core";
import { Job, Result, Run, Screen, ScreenRevision, newId, type JobStore } from "@figtest/db";
import PgBoss from "pg-boss";
import { In, type DataSource } from "typeorm";
import { BLOB, BOSS, DATA_SOURCE, JOB_STORE } from "../../infra/tokens";
import { ProjectsService } from "../projects/projects.service";
import { ScreensService, type GroupIndex } from "../screens/screens.service";

/** absolute URL of a screen: as is, or a path of the project website */
export const resolveUrl = (baseUrl: string, url: string) => (/^https?:\/\//i.test(url) ? url : `${baseUrl.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`);

@Injectable()
export class RunsService {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(JOB_STORE) private readonly store: JobStore,
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(BLOB) private readonly blob: BlobStore,
    private readonly projects: ProjectsService,
    private readonly screens: ScreensService,
  ) {}

  async create(slug: string, raw: RunCreate, userId: string): Promise<RunDto> {
    const body = RunCreateSchema.parse(raw);
    const project = await this.projects.bySlug(slug);
    const idx = await this.screens.groupIndex(project.id);
    const repo = this.ds.getRepository(Screen);
    let screens = body.screenIds?.length
      ? await repo.findBy({ projectId: project.id, id: In(body.screenIds) })
      : (await repo.findBy({ projectId: project.id, hidden: false, missing: false, draft: false }))
        .filter((s) => !s.duplicateOf && !(s.groupId && idx.hidden.has(s.groupId)));
    screens = screens.filter((s) => !s.missing);
    if (body.target === "storybook") {
      if (!project.storybookUrl) throw new BadRequestException("set the Storybook URL of the project first");
      screens = screens.filter((s) => s.storyId);
    } else {
      screens = screens.filter((s) => s.url);
    }
    if (!screens.length) throw new BadRequestException(body.target === "storybook" ? "no screen has a story id" : "no screen to test: give the screens a URL first");
    screens.sort((a, b) => (idx.order.get(a.groupId ?? "") ?? -1) - (idx.order.get(b.groupId ?? "") ?? -1) || a.position - b.position);

    const job = await this.store.create({ kind: "run.screen", projectId: project.id, createdBy: userId, total: screens.length, payload: { target: body.target } });
    const run = await this.ds.getRepository(Run).save(this.ds.getRepository(Run).create({
      id: newId(), projectId: project.id, jobId: job.id, target: body.target, total: screens.length, createdBy: userId,
    }));
    const results = screens.map((s) => this.ds.getRepository(Result).create({
      id: newId(), runId: run.id, screenId: s.id, revisionId: s.currentRevisionId, status: "queued",
      url: body.target === "storybook" ? `${project.storybookUrl}/iframe.html?id=${encodeURIComponent(s.storyId!)}&viewMode=story` : resolveUrl(project.baseUrl, s.url!),
    }));
    await this.ds.getRepository(Result).save(results, { chunk: 200 });
    await this.store.log(job.id, "info", `run of ${screens.length} screen(s) on ${body.target === "storybook" ? project.storybookUrl : project.baseUrl}`);
    for (const r of results) {
      await this.boss.send("run.screen", parsePayload("run.screen", { jobId: job.id, runId: run.id, resultId: r.id }), { retryLimit: 0 });
    }
    return this.toRunDto(run, job);
  }

  async list(slug: string): Promise<RunDto[]> {
    const project = await this.projects.bySlug(slug);
    const runs = await this.ds.getRepository(Run).find({ where: { projectId: project.id }, order: { createdAt: "DESC" }, take: 100 });
    const jobs = runs.length ? await this.ds.getRepository(Job).findBy({ id: In(runs.map((r) => r.jobId)) }) : [];
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return runs.map((r) => this.toRunDto(r, byId.get(r.jobId)));
  }

  async byId(id: string) {
    const run = await this.ds.getRepository(Run).findOneBy({ id });
    if (!run) throw new NotFoundException(`run ${id} not found`);
    return run;
  }

  async get(id: string): Promise<RunDetail> {
    const run = await this.byId(id);
    const job = await this.store.find(run.jobId);
    const results = await this.ds.getRepository(Result).find({ where: { runId: id } });
    const idx = await this.screens.groupIndex(run.projectId);
    const dtos = await this.toResultDtos(results, idx);
    const order = new Map(dtos.map((d, i) => [d.id, i]));
    return { ...this.toRunDto(run, job ?? undefined), results: dtos.sort((a, b) => (order.get(a.id)! - order.get(b.id)!)) };
  }

  async cancel(id: string): Promise<RunDto> {
    const run = await this.byId(id);
    await this.store.requestCancel(run.jobId);
    await this.store.log(run.jobId, "warn", "cancel asked: the screens not started are skipped");
    return this.toRunDto(run, (await this.store.find(run.jobId)) ?? undefined);
  }

  async report(resultId: string): Promise<ResultReport> {
    const r = await this.ds.getRepository(Result).findOneBy({ id: resultId });
    if (!r) throw new NotFoundException(`result ${resultId} not found`);
    const run = await this.byId(r.runId);
    const [dto] = await this.toResultDtos([r], await this.screens.groupIndex(run.projectId));
    const report = r.reportKey && (await this.blob.exists(r.reportKey)) ? await gunzipJson<unknown>(await this.blob.get(r.reportKey)) : null;
    return { result: dto!, report, unmocked: r.unmocked ?? [], viewport: r.viewportW && r.viewportH ? { w: r.viewportW, h: r.viewportH } : null };
  }

  private toRunDto(r: Run, job?: Job): RunDto {
    return {
      id: r.id, jobId: r.jobId, target: r.target, status: job?.status ?? "queued", total: r.total, done: r.done,
      passed: r.passed, failed: r.failed, blocked: r.blocked, errors: r.errors,
      createdAt: r.createdAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? job?.endedAt?.toISOString() ?? null,
    };
  }

  private async toResultDtos(results: Result[], idx: GroupIndex): Promise<ResultDto[]> {
    if (!results.length) return [];
    const screens = await this.ds.getRepository(Screen).findBy({ id: In([...new Set(results.map((r) => r.screenId))]) });
    const sById = new Map(screens.map((s) => [s.id, s]));
    const revIds = [...new Set(results.map((r) => r.revisionId).filter((x): x is string => !!x))];
    const revs = revIds.length ? await this.ds.getRepository(ScreenRevision).findBy({ id: In(revIds) }) : [];
    const rById = new Map(revs.map((r) => [r.id, r]));
    const order = (r: Result) => {
      const s = sById.get(r.screenId);
      return [(s?.groupId ? idx.order.get(s.groupId) : -1) ?? -1, s?.position ?? 0] as const;
    };
    return [...results]
      .sort((a, b) => { const [ga, pa] = order(a); const [gb, pb] = order(b); return ga - gb || pa - pb; })
      .map((r) => {
        const s = sById.get(r.screenId);
        return {
          id: r.id, runId: r.runId, screenId: r.screenId, screenName: s?.name ?? "?", groupPath: idx.path(s?.groupId ?? null),
          url: r.url, finalUrl: r.finalUrl, status: r.status, coverage: r.coverage, designScore: r.designScore,
          counts: (r.counts as ResultDto["counts"]) ?? null, error: r.error, unmocked: r.unmocked?.length ?? 0, durationMs: r.durationMs,
          figmaUrl: fileUrl(r.revisionId ? rById.get(r.revisionId)?.imageKey : null), screenshotUrl: fileUrl(r.screenshotKey),
          createdAt: r.createdAt.toISOString(),
        };
      });
  }
}
