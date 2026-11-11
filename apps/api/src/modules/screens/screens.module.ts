import { Module } from "@nestjs/common";
import { JobsModule } from "../jobs/jobs.module";
import { ProjectsModule } from "../projects/projects.module";
import { ScreensController } from "./screens.controller";
import { ScreensService } from "./screens.service";

@Module({
  imports: [ProjectsModule, JobsModule],
  controllers: [ScreensController],
  providers: [ScreensService],
  exports: [ScreensService],
})
export class ScreensModule {}
