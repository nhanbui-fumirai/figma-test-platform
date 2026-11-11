/**
 * Infrastructure shared by every module: settings, logger, the database (migrations applied at start), the job store and
 * the pg-boss queue (the api only sends jobs; apps/worker runs them).
 */
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import path from "node:path";
import { createLogger, FsBlobStore, loadEnv, queueNames, registerSecret, type Env, type Logger } from "@figtest/core";
import { createDataSource, CredentialStore, JobStore } from "@figtest/db";
import PgBoss from "pg-boss";
import type { DataSource } from "typeorm";
import { BLOB, BOSS, CREDENTIALS, DATA_SOURCE, ENV, JOB_STORE, LOGGER } from "./tokens";

@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: () => {
        const env = loadEnv();
        registerSecret(env.APP_SECRET);
        registerSecret(env.ADMIN_PASSWORD);
        return env;
      },
    },
    { provide: LOGGER, inject: [ENV], useFactory: (env: Env) => createLogger("api", env.LOG_LEVEL) },
    {
      provide: DATA_SOURCE,
      inject: [ENV, LOGGER],
      useFactory: async (env: Env, log: Logger) => {
        const ds = await createDataSource(env.DATABASE_URL).initialize();
        const applied = await ds.runMigrations({ transaction: "each" });
        if (applied.length) log.info(`migrations applied: ${applied.map((m) => m.name).join(", ")}`);
        return ds;
      },
    },
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
        for (const q of queueNames) await boss.createQueue(q);
        return boss;
      },
    },
  ],
  exports: [ENV, LOGGER, DATA_SOURCE, JOB_STORE, BOSS, CREDENTIALS, BLOB],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  async onApplicationShutdown() {
    await this.boss.stop({ graceful: true, wait: false }).catch(() => {});
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}
