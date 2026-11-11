/**
 * The worker: the infrastructure (settings, database, queue, blob store, secrets), the services the jobs share (browser,
 * test login sessions, screen state, design) and the handlers. The api applies the migrations; the worker only connects.
 * New job kind = a handler class listed in HANDLERS.
 */
import path from "node:path";
import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createLogger, FsBlobStore, loadEnv, registerSecret, type Env, type Logger } from "@figtest/core";
import { createDataSource, CredentialStore, JobStore } from "@figtest/db";
import PgBoss from "pg-boss";
import type { DataSource } from "typeorm";
import { AiMocksHandler, AiStepsHandler } from "./handlers/ai.handler";
import { DemoHandler } from "./handlers/demo.handler";
import { FigmaImportHandler } from "./handlers/figma-import.handler";
import { GitSyncHandler } from "./handlers/git-sync.handler";
import { RunScreenHandler } from "./handlers/run-screen.handler";
import { MockRecordHandler, PreviewHandler } from "./handlers/screen-jobs.handler";
import { JOB_HANDLERS, type JobHandler } from "./job-handler";
import { JobRunnerService } from "./job-runner.service";
import { BrowserService } from "./services/browser.service";
import { DesignService } from "./services/design.service";
import { LoginService } from "./services/login.service";
import { ScreenStateService } from "./services/screen-state.service";
import { BLOB, BOSS, CREDENTIALS, DATA_SOURCE, ENV, JOB_STORE, LOGGER } from "./tokens";

const HANDLERS = [
  DemoHandler, FigmaImportHandler, PreviewHandler, RunScreenHandler, MockRecordHandler, AiStepsHandler, AiMocksHandler, GitSyncHandler,
];

@Module({
  providers: [
    { provide: ENV, useFactory: () => { const env = loadEnv(); registerSecret(env.APP_SECRET); return env; } },
    { provide: LOGGER, inject: [ENV], useFactory: (env: Env) => createLogger("worker", env.LOG_LEVEL) },
    { provide: DATA_SOURCE, inject: [ENV], useFactory: (env: Env) => createDataSource(env.DATABASE_URL, { poolSize: 8 }).initialize() },
    { provide: JOB_STORE, inject: [DATA_SOURCE], useFactory: (ds: DataSource) => new JobStore(ds) },
    { provide: CREDENTIALS, inject: [DATA_SOURCE, ENV], useFactory: (ds: DataSource, env: Env) => new CredentialStore(ds, env.APP_SECRET) },
    { provide: BLOB, inject: [ENV], useFactory: (env: Env) => new FsBlobStore(path.join(env.STORAGE_PATH, "blobs")) },
    {
      provide: BOSS,
      inject: [ENV, LOGGER],
      useFactory: async (env: Env, log: Logger) => {
        const boss = new PgBoss({ connectionString: env.DATABASE_URL, max: 4 });
        boss.on("error", (e) => log.error({ err: e }, "pg-boss"));
        await boss.start();
        return boss;
      },
    },
    BrowserService,
    LoginService,
    ScreenStateService,
    DesignService,
    ...HANDLERS,
    { provide: JOB_HANDLERS, inject: HANDLERS, useFactory: (...handlers: JobHandler[]) => handlers },
    JobRunnerService,
  ],
})
export class WorkerModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async onApplicationShutdown() {
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}
