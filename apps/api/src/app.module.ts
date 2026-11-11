/**
 * The api: one module per feature (controller → service → @figtest/db), the infrastructure (settings, database, queue)
 * global. New feature = a module here; its long work = a queue in @figtest/core and a handler in apps/worker.
 */
import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ErrorsFilter } from "./common/errors.filter";
import { InfraModule } from "./infra/infra.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthController } from "./modules/health/health.controller";
import { JobsModule } from "./modules/jobs/jobs.module";
import { FeaturesModule } from "./modules/features.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { ScreensModule } from "./modules/screens/screens.module";

@Module({
  imports: [InfraModule, AuthModule, ProjectsModule, JobsModule, ScreensModule, FeaturesModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ErrorsFilter }],
})
export class AppModule {}
