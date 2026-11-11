import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res } from "@nestjs/common";
import { DemoJobRequest, type Job, type JobEvent, type JobLogLine, type Me } from "@figtest/contracts";
import type { Request, Response } from "express";
import { ZodPipe } from "../../common/zod.pipe";
import { CurrentUser } from "../auth/auth.decorators";
import { ProjectsService } from "../projects/projects.service";
import { JobsService, toJobDto, toLogDto } from "./jobs.service";

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;
const ENDED = new Set(["succeeded", "failed", "cancelled"]);

@Controller()
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly projects: ProjectsService,
  ) {}

  @Get("projects/:slug/jobs")
  async listForProject(@Param("slug") slug: string): Promise<Job[]> {
    const project = await this.projects.bySlug(slug);
    return (await this.jobs.listForProject(project.id)).map(toJobDto);
  }

  /** M0: a job that only writes log lines, to try the queue, the worker and the live logs */
  @Post("projects/:slug/jobs/demo")
  async startDemo(@Param("slug") slug: string, @Body(new ZodPipe(DemoJobRequest)) body: DemoJobRequest, @CurrentUser() me: Me): Promise<Job> {
    const project = await this.projects.bySlug(slug);
    return toJobDto(await this.jobs.start("demo", { projectId: project.id, createdBy: me.id, total: body.steps }, { steps: body.steps }));
  }

  @Get("jobs/:id")
  async get(@Param("id", ParseUUIDPipe) id: string): Promise<Job> {
    return toJobDto(await this.jobs.get(id));
  }

  @Get("jobs/:id/logs")
  async logs(@Param("id", ParseUUIDPipe) id: string, @Query("after") after = "0"): Promise<JobLogLine[]> {
    await this.jobs.get(id);
    return (await this.jobs.logsAfter(id, Number(after) || 0)).map(toLogDto);
  }

  @Post("jobs/:id/cancel")
  async cancel(@Param("id", ParseUUIDPipe) id: string): Promise<Job> {
    return toJobDto(await this.jobs.cancel(id));
  }

  /**
   * Live logs and progress (text/event-stream). `log` events have the JobLog id as their SSE id: a reconnecting
   * EventSource sends Last-Event-ID and gets only the lines after it. A comment every 15 s keeps proxies from closing
   * an idle stream. The stream ends after the job ends and its last lines are sent.
   */
  @Get("jobs/:id/events")
  async events(@Param("id", ParseUUIDPipe) id: string, @Req() req: Request, @Res() res: Response) {
    let job = await this.jobs.get(id);
    let after = Number(req.headers["last-event-id"] ?? req.query.after ?? 0) || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (event: JobEvent, sseId?: number) => res.write(`${sseId !== undefined ? `id: ${sseId}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
    let closed = false;
    req.on("close", () => { closed = true; });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    let lastState = "";
    try {
      while (!closed) {
        for (const line of await this.jobs.logsAfter(id, after)) {
          after = Number(line.id);
          send({ type: "log", line: toLogDto(line) }, after);
        }
        job = await this.jobs.get(id);
        const state = `${job.status}:${job.done}:${job.total}`;
        if (state !== lastState) { send({ type: "job", job: toJobDto(job) }); lastState = state; }
        if (ENDED.has(job.status) && !(await this.jobs.logsAfter(id, after, )).length) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }
}
