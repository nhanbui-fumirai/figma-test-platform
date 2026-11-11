import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import {
  GroupUpdate, ScreenListQuery, ScreenUpdate, type Job, type Me, type Preview, type Screen, type ScreenGroup, type ScreenPage,
} from "@figtest/contracts";
import { ZodPipe } from "../../common/zod.pipe";
import { CurrentUser } from "../auth/auth.decorators";
import { JobsService, toJobDto } from "../jobs/jobs.service";
import { ProjectsService } from "../projects/projects.service";
import { ScreensService } from "./screens.service";

@Controller()
export class ScreensController {
  constructor(
    private readonly screens: ScreensService,
    private readonly projects: ProjectsService,
    private readonly jobs: JobsService,
  ) {}

  @Get("projects/:slug/groups")
  async groups(@Param("slug") slug: string): Promise<ScreenGroup[]> {
    return this.screens.groups((await this.projects.bySlug(slug)).id);
  }

  @Patch("groups/:id")
  updateGroup(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(GroupUpdate)) body: GroupUpdate): Promise<ScreenGroup> {
    return this.screens.setGroupHidden(id, body.hidden);
  }

  @Get("projects/:slug/screens")
  async list(@Param("slug") slug: string, @Query(new ZodPipe(ScreenListQuery)) query: ScreenListQuery): Promise<ScreenPage> {
    return this.screens.list((await this.projects.bySlug(slug)).id, query);
  }

  @Get("screens/:id")
  get(@Param("id", ParseUUIDPipe) id: string): Promise<Screen> {
    return this.screens.get(id);
  }

  @Patch("screens/:id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(ScreenUpdate)) body: ScreenUpdate): Promise<Screen> {
    return this.screens.update(id, body);
  }

  /** opens the page like a test would, without comparing (state, login, mocks, auth wall) */
  @Post("screens/:id/preview")
  async preview(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: Me): Promise<Job> {
    const s = await this.screens.byId(id);
    return toJobDto(await this.jobs.start("screen.preview", { projectId: s.projectId, createdBy: me.id }, { screenId: s.id }));
  }

  @Get("screens/:id/preview")
  async lastPreview(@Param("id", ParseUUIDPipe) id: string): Promise<Preview | null> {
    return this.screens.previewOf(await this.screens.byId(id));
  }
}
