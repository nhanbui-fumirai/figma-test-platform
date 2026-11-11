/**
 * Feature modules of M1-M7, each a controller (+ service) over @figtest/db, sending long work to the worker queues.
 */
import { Module } from "@nestjs/common";
import { FilesController } from "./files/files.controller";
import { ImportsController } from "./imports/imports.controller";
import { JobsModule } from "./jobs/jobs.module";
import { MocksController } from "./mocks/mocks.controller";
import { MocksService } from "./mocks/mocks.service";
import { ProjectsModule } from "./projects/projects.module";
import { RepositoryController } from "./repository/repository.controller";
import { RunsController } from "./runs/runs.controller";
import { RunsService } from "./runs/runs.service";
import { ScreensModule } from "./screens/screens.module";

@Module({
  imports: [ProjectsModule, JobsModule, ScreensModule],
  controllers: [ImportsController, FilesController, RunsController, MocksController, RepositoryController],
  providers: [RunsService, MocksService],
})
export class FeaturesModule {}
