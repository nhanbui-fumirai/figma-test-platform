import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { RunCreate, type Me, type ResultReport, type Run, type RunDetail } from "@figtest/contracts";
import { ZodPipe } from "../../common/zod.pipe";
import { CurrentUser } from "../auth/auth.decorators";
import { RunsService } from "./runs.service";

@Controller()
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get("projects/:slug/runs")
  list(@Param("slug") slug: string): Promise<Run[]> {
    return this.runs.list(slug);
  }

  @Post("projects/:slug/runs")
  create(@Param("slug") slug: string, @Body(new ZodPipe(RunCreate)) body: RunCreate, @CurrentUser() me: Me): Promise<Run> {
    return this.runs.create(slug, body, me.id);
  }

  @Get("runs/:id")
  get(@Param("id", ParseUUIDPipe) id: string): Promise<RunDetail> {
    return this.runs.get(id);
  }

  @Post("runs/:id/cancel")
  cancel(@Param("id", ParseUUIDPipe) id: string): Promise<Run> {
    return this.runs.cancel(id);
  }

  @Get("results/:id/report")
  report(@Param("id", ParseUUIDPipe) id: string): Promise<ResultReport> {
    return this.runs.report(id);
  }
}
