import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Res } from "@nestjs/common";
import {
  AiStepsRequest, MockRouteCreate, MockRouteUpdate, ProjectSettings, type AiUsage, type Job, type Me, type MockRoute,
  type MockRouteSummary,
} from "@figtest/contracts";
import type { CredentialStore } from "@figtest/db";
import { AiCall, MockRoute as MockRow, Screen } from "@figtest/db";
import { exportStorybook } from "@figtest/mocks";
import type { Response } from "express";
import { In, type DataSource } from "typeorm";
import { ZodPipe } from "../../common/zod.pipe";
import { CREDENTIALS, DATA_SOURCE } from "../../infra/tokens";
import { CurrentUser } from "../auth/auth.decorators";
import { JobsService, toJobDto } from "../jobs/jobs.service";
import { ProjectsService } from "../projects/projects.service";
import { MocksService, toDto } from "./mocks.service";

const slugify = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "screen";

@Controller()
export class MocksController {
  constructor(
    private readonly mocks: MocksService,
    private readonly jobs: JobsService,
    private readonly projects: ProjectsService,
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(CREDENTIALS) private readonly credentials: CredentialStore,
  ) {}

  @Get("screens/:id/mocks")
  list(@Param("id", ParseUUIDPipe) id: string): Promise<MockRouteSummary[]> {
    return this.mocks.list(id);
  }

  @Post("screens/:id/mocks")
  create(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(MockRouteCreate)) body: MockRouteCreate): Promise<MockRoute> {
    return this.mocks.create(id, body);
  }

  @Get("mocks/:id")
  async get(@Param("id", ParseUUIDPipe) id: string): Promise<MockRoute> {
    return toDto(await this.mocks.byId(id));
  }

  @Patch("mocks/:id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(MockRouteUpdate)) body: MockRouteUpdate): Promise<MockRoute> {
    return this.mocks.update(id, body);
  }

  @Delete("mocks/:id")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.mocks.remove(id);
    return { ok: true };
  }

  /** records the API calls of the page as the mocks of the screen (replaces the recorded ones, keeps manual ones) */
  @Post("screens/:id/mocks/record")
  async record(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: Me): Promise<Job> {
    const s = await this.mocks.screen(id);
    if (!s.url) throw new BadRequestException("give the screen a URL first");
    return toJobDto(await this.jobs.start("mock.record", { projectId: s.projectId, createdBy: me.id }, { screenId: s.id }));
  }

  // ---- AI: prepare jobs only (a test run never calls the AI)
  private async aiReady(projectId: string) {
    const project = await this.projects.byId(projectId);
    if (!ProjectSettings.parse(project.settings ?? {}).ai) throw new BadRequestException("choose an AI provider and model in the project settings first");
    if (!(await this.credentials.has(projectId, "ai_key"))) throw new BadRequestException("add an AI key in the project settings first");
  }

  @Post("screens/:id/ai/steps")
  async aiSteps(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(AiStepsRequest)) body: AiStepsRequest, @CurrentUser() me: Me): Promise<Job> {
    const s = await this.mocks.screen(id);
    if (!s.url) throw new BadRequestException("give the screen a URL first");
    await this.aiReady(s.projectId);
    return toJobDto(await this.jobs.start("ai.steps", { projectId: s.projectId, createdBy: me.id }, { screenId: s.id, goal: body.goal }));
  }

  @Post("screens/:id/ai/mocks")
  async aiMocks(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: Me): Promise<Job> {
    const s = await this.mocks.screen(id);
    await this.aiReady(s.projectId);
    if (!(await this.ds.getRepository(MockRow).existsBy({ screenId: s.id }))) throw new BadRequestException("record the mocks of the screen first");
    return toJobDto(await this.jobs.start("ai.mocks", { projectId: s.projectId, createdBy: me.id }, { screenId: s.id }));
  }

  @Get("projects/:slug/ai/usage")
  async usage(@Param("slug") slug: string): Promise<AiUsage> {
    const p = await this.projects.bySlug(slug);
    const [row] = await this.ds.getRepository(AiCall).query(
      `SELECT count(*)::int AS calls, coalesce(sum(input_tokens), 0)::int AS "inputTokens", coalesce(sum(output_tokens), 0)::int AS "outputTokens",
              CASE WHEN count(cost_usd) = 0 THEN NULL ELSE sum(cost_usd) END AS "costUsd"
         FROM ai_calls WHERE project_id = $1`, [p.id],
    ) as AiUsage[];
    return row ?? { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
  }

  /** a zip of MSW handlers, fixtures and stories made from the enabled mocks of the visible screens */
  @Get("projects/:slug/storybook/export")
  async storybook(@Param("slug") slug: string, @Res() res: Response) {
    const p = await this.projects.bySlug(slug);
    const routes = await this.ds.getRepository(MockRow).createQueryBuilder("m")
      .innerJoin(Screen, "s", "s.id = m.screen_id").where("s.project_id = :pid AND m.enabled = true", { pid: p.id }).getMany();
    const screenIds = [...new Set(routes.map((r) => r.screenId))];
    const screens = screenIds.length ? await this.ds.getRepository(Screen).findBy({ id: In(screenIds) }) : [];
    if (!screens.length) throw new BadRequestException("no screen has mocks yet: record them first");
    const used = new Set<string>();
    const zip = await exportStorybook({
      project: { name: p.name, slug: p.slug },
      screens: screens.map((s) => {
        let slugName = slugify(s.name);
        for (let i = 2; used.has(slugName); i++) slugName = `${slugify(s.name)}-${i}`;
        used.add(slugName);
        return {
          id: s.id, name: s.name, slug: slugName, storyId: s.storyId, viewport: { w: s.viewportW, h: s.viewportH },
          routes: routes.filter((r) => r.screenId === s.id).map((r) => ({
            id: r.id, method: r.method, host: r.host, path: r.path, query: r.query ?? {}, operationName: r.operationName, variables: r.variables ?? null,
            status: r.status, contentType: r.contentType, body: r.body,
          })),
        };
      }),
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${p.slug}-storybook-mocks.zip"`);
    res.end(zip);
  }
}
